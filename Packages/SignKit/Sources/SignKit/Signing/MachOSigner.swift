import Foundation

/// Signs one Mach-O binary: builds the signature blobs and puts them in the file.
public struct MachOSigner {
    public struct Options {
        public var identifier: String
        public var teamID: String?
        public var entitlements: [String: Any]?
        public var infoPlistHash: Data?
        public var resourcesHash: Data?
        public var hashKind: HashKind = .sha256
        public var adhoc: Bool = false

        public init(identifier: String, teamID: String? = nil, entitlements: [String: Any]? = nil,
                    infoPlistHash: Data? = nil, resourcesHash: Data? = nil,
                    hashKind: HashKind = .sha256, adhoc: Bool = false) {
            self.identifier = identifier
            self.teamID = teamID
            self.entitlements = entitlements
            self.infoPlistHash = infoPlistHash
            self.resourcesHash = resourcesHash
            self.hashKind = hashKind
            self.adhoc = adhoc
        }
    }

    public let key: RSAPrivateKey?
    public let chain: [Certificate]

    public init(key: RSAPrivateKey?, chain: [Certificate]) {
        self.key = key
        self.chain = chain
    }

    /// Signs every slice of a Mach-O file and returns the new file bytes.
    public func sign(data: Data, options: Options) throws -> Data {
        var file = try MachOFile(data: data)
        for i in file.slices.indices {
            file.slices[i] = try signSlice(file.slices[i], options: options)
        }
        return file.encoded()
    }

    /// The code directory hash of a slice, as iOS would compute it (used for nested code).
    public func cdhash(for slice: MachOSlice) -> Data? {
        guard let sig = slice.existingSignature else { return nil }
        guard sig.count > 12, sig.u32be(0) == BlobMagic.embeddedSignature else { return nil }
        let count = Int(sig.u32be(8))
        for i in 0..<count {
            let slot = sig.u32be(12 + 8 * i)
            let off = Int(sig.u32be(16 + 8 * i))
            guard slot == CSSlot.codeDirectory, off + 8 <= sig.count else { continue }
            let len = Int(sig.u32be(off + 4))
            guard off + len <= sig.count else { continue }
            let cd = sig.sub(off, len)
            let kind: HashKind = cd.u8(37) == 1 ? .sha1 : .sha256
            return Hasher.hash(kind, cd)
        }
        return nil
    }

    func signSlice(_ input: MachOSlice, options: Options) throws -> MachOSlice {
        var slice = input
        slice.stripSignature()

        guard let linkedit = slice.segments.first(where: { $0.name == "__LINKEDIT" }) else {
            throw SignKitError.malformed("the app binary has no __LINKEDIT part")
        }

        // Reserve room for the signature, then add the load command pointing at it.
        // The size written into the load command is itself covered by the hashes, so
        // we settle on it first with a dry run, then build the real signature.
        let codeLimit = Int(linkedit.fileoff + linkedit.filesize)
        var estimate = estimateSize(codeLimit: codeLimit, options: options)
        for _ in 0..<3 {
            var trial = try buildTrial(slice, linkedit: linkedit, reserve: estimate, options: options)
            trial = align(trial + 16, 16)
            if trial == estimate { break }
            estimate = trial
        }
        var sigOffset = align(codeLimit, 16)

        var lc = Data()
        lc.put32le(LC.codeSignature)
        lc.put32le(16)
        lc.put32le(UInt32(sigOffset))
        lc.put32le(UInt32(estimate))
        try slice.appendLoadCommand(lc)

        // Pad the file out to where the signature starts.
        if slice.data.count < sigOffset {
            slice.data.append(Data(count: sigOffset - slice.data.count))
        } else if slice.data.count > sigOffset {
            sigOffset = slice.data.count
        }

        // __LINKEDIT has to cover the signature as well.
        let newLinkeditSize = UInt64(sigOffset + estimate) - linkedit.fileoff
        if let le = slice.segments.first(where: { $0.name == "__LINKEDIT" }) {
            slice.setSegmentSize(le, fileSize: newLinkeditSize)
        }

        let signature = try buildSignature(for: slice, codeLimit: sigOffset, options: options)
        guard signature.count <= estimate else {
            throw SignKitError.crypto("signature came out bigger than the space reserved")
        }
        var padded = signature
        padded.append(Data(count: estimate - signature.count))
        slice.data.append(padded)
        return slice
    }

    /// Builds a throwaway signature just to learn how many bytes it needs.
    func buildTrial(_ input: MachOSlice, linkedit: Segment, reserve: Int, options: Options) throws -> Int {
        var slice = input
        var lc = Data()
        lc.put32le(LC.codeSignature)
        lc.put32le(16)
        lc.put32le(UInt32(align(Int(linkedit.fileoff + linkedit.filesize), 16)))
        lc.put32le(UInt32(reserve))
        try slice.appendLoadCommand(lc)
        let sig = try buildSignature(for: slice, codeLimit: align(slice.data.count, 16), options: options)
        return sig.count
    }

    func buildSignature(for slice: MachOSlice, codeLimit: Int, options: Options) throws -> Data {
        let textSegment = slice.segments.first { $0.name == "__TEXT" }
        var cd = CodeDirectory(identifier: options.identifier, teamID: options.teamID,
                               hashKind: options.hashKind, codeLimit: codeLimit)
        cd.execSegBase = textSegment?.fileoff ?? 0
        cd.execSegLimit = textSegment?.filesize ?? 0
        cd.execSegFlags = slice.isExecutable ? 1 : 0   // main binary flag
        cd.flags = options.adhoc ? CSFlags.adhoc : 0
        cd.hashCode(of: slice.data)

        // Special slots.
        let requirements = options.adhoc
            ? Requirement.emptySet()
            : Requirement.set(designated: Requirement.designated(identifier: options.identifier,
                                                                 teamID: options.teamID))
        cd.specialHashes[CSSlot.requirements] = Hasher.hash(options.hashKind, requirements.encoded)
        if let h = options.infoPlistHash { cd.specialHashes[CSSlot.infoPlist] = h }
        if let h = options.resourcesHash { cd.specialHashes[CSSlot.resourceDir] = h }

        var xmlBlob: Blob?
        var derBlob: Blob?
        if let ents = options.entitlements, !ents.isEmpty {
            xmlBlob = try Entitlements.xmlBlob(ents)
            derBlob = try Entitlements.derBlob(ents)
            cd.specialHashes[CSSlot.entitlements] = Hasher.hash(options.hashKind, xmlBlob!.encoded)
            cd.specialHashes[CSSlot.derEntitlements] = Hasher.hash(options.hashKind, derBlob!.encoded)
        }

        var sb = SuperBlob()
        sb.add(CSSlot.codeDirectory, cd.blob)
        sb.add(CSSlot.requirements, requirements)
        if let x = xmlBlob { sb.add(CSSlot.entitlements, x) }
        if let d = derBlob { sb.add(CSSlot.derEntitlements, d) }

        if let key = key, !chain.isEmpty, !options.adhoc {
            let cms = try CMS.sign(codeDirectories: [cd], key: key, chain: chain)
            sb.add(CSSlot.signatureSlot, Blob.wrapper(cms))
        } else {
            sb.add(CSSlot.signatureSlot, Blob.wrapper(Data()))
        }
        return sb.encoded()
    }

    func estimateSize(codeLimit: Int, options: Options) -> Int {
        let pages = (codeLimit + 4095) / 4096 + 1
        var size = 4096                                     // headers, identifier, requirements
        size += pages * options.hashKind.size
        size += 8 * options.hashKind.size                   // special slots
        if let e = options.entitlements, !e.isEmpty { size += 8192 }
        size += chain.reduce(0) { $0 + $1.der.count } + 8192  // CMS
        return align(size, 16)
    }
}
