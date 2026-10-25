import Foundation
import Dispatch

/// Signs a Mach-O binary **on disk**, never holding it in memory.
///
/// Some iPhone apps are two gigabytes or more, and their main binary can be most of
/// that. Reading one into memory to sign it gets the app killed by iOS, so this writes
/// the new header, streams the rest of the file through, hashes it in pages straight
/// from disk, and appends the signature at the end.
public struct MachOFileSigner {
    public let key: RSAPrivateKey?
    public let chain: [Certificate]
    /// Anything bigger than this is worth doing on disk rather than in memory.
    public static var diskThreshold = 64 << 20

    public init(key: RSAPrivateKey?, chain: [Certificate]) {
        self.key = key
        self.chain = chain
    }

    /// Changes only the load-command header of a large thin Mach-O in place. Dylib
    /// injection, removing a dylib and changing the minimum iOS all fit there; the
    /// remaining gigabytes never need to be read.
    public static func editHeader(fileAt url: URL,
                                  _ change: (inout MachOSlice) throws -> Void) throws {
        let fm = FileManager.default
        let size = (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        guard size >= 32 else { throw SignKitError.malformed("the app binary is too small") }
        guard let input = try? FileHandle(forReadingFrom: url) else {
            throw SignKitError.io("cannot read \(url.lastPathComponent)")
        }
        let head = input.readData(ofLength: min(256 << 10, size))
        try? input.close()
        let magic = head.u32be(0)
        guard magic != 0xcafebabe && magic != 0xcafebabf else {
            throw SignKitError.unsupported("changing a multi-architecture binary this large")
        }
        var slice = try MachOSlice(head)
        try change(&slice)
        guard slice.data.count == head.count else {
            throw SignKitError.crypto("the app header unexpectedly changed size")
        }
        guard let output = try? FileHandle(forWritingTo: url) else {
            throw SignKitError.io("cannot update \(url.lastPathComponent)")
        }
        try output.seek(toOffset: 0)
        try output.write(contentsOf: slice.data)
        try output.close()
    }

    /// Signs the file at `url` in place. Returns the code directory hash.
    @discardableResult
    public func sign(fileAt url: URL, options: MachOSigner.Options,
                     progress: ((Double) -> Void)? = nil) throws -> Data {
        let fm = FileManager.default
        let size = (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0

        // Small or fat binaries take the ordinary path: simpler, and memory is no issue.
        let thin = try isThin(url)
        if size < MachOFileSigner.diskThreshold || !thin {
            let signer = MachOSigner(key: key, chain: chain)
            let signed = try signer.sign(data: try Data(contentsOf: url, options: .mappedIfSafe),
                                         options: options)
            try signed.write(to: url)
            MachOFileSigner.makeRunnable(url)
            let slice = try MachOFile(data: signed).slices[0]
            return signer.cdhash(for: slice) ?? Data()
        }

        // 1. Read just the header region, and work out the new one there.
        let headerBytes = 64 << 10
        let head = try readRange(url, 0, min(headerBytes, size))
        var slice = try MachOSlice(head)
        let oldSignatureOffset = slice.codeSignatureCommand
            .map { Int(slice.data.u32le($0.offset + 8)) } ?? 0
        let bodyEnd = oldSignatureOffset > 0 ? oldSignatureOffset : size

        slice.stripSignatureKeepingData()
        guard let linkedit = slice.segments.first(where: { $0.name == "__LINKEDIT" }) else {
            throw SignKitError.malformed("the app binary has no __LINKEDIT part")
        }

        let codeLimit = align(bodyEnd, 16)
        var reserve = estimate(codeLimit: codeLimit, options: options)

        // 2. Write the header with the signature command, then stream the body across.
        let temp = url.appendingPathExtension("signing")
        try? fm.removeItem(at: temp)

        // The size written into the load command is itself covered by the hashes, so
        // settle on it first and then write the real thing — the same two passes the
        // in-memory signer does, so both routes produce identical bytes.
        for attempt in 0..<3 {
            try? fm.removeItem(at: temp)
            var header = slice
            var lc = Data()
            lc.put32le(LC.codeSignature)
            lc.put32le(16)
            lc.put32le(UInt32(codeLimit))
            lc.put32le(UInt32(reserve))
            try header.appendLoadCommand(lc)
            header.setSegmentSize(linkedit, fileSize: UInt64(codeLimit + reserve) - linkedit.fileoff)

            guard fm.createFile(atPath: temp.path, contents: nil),
                  let output = try? FileHandle(forWritingTo: temp),
                  let input = try? FileHandle(forReadingFrom: url) else {
                throw SignKitError.io("cannot write the signed binary")
            }

            // The changed header, then everything after it unchanged.
            let headerSize = header.headerSize + header.sizeofcmds
            try output.write(contentsOf: header.data.prefix(headerSize))
            try input.seek(toOffset: UInt64(headerSize))
            var copied = headerSize
            while copied < bodyEnd {
                let want = min(4 << 20, bodyEnd - copied)
                let chunk = input.readData(ofLength: want)
                if chunk.isEmpty { break }
                try output.write(contentsOf: chunk)
                copied += chunk.count
                progress?(Double(copied) / Double(bodyEnd) * 0.5)
            }
            if codeLimit > copied {
                try output.write(contentsOf: Data(count: codeLimit - copied))
            }
            try input.close()
            try output.close()

            // 3. Hash the file in pages, reading it back a few megabytes at a time.
            let signature = try buildSignature(for: temp, header: header, codeLimit: codeLimit,
                                               options: options, progress: progress)
            let tight = align(signature.count + 16, 16)
            if tight != reserve, attempt < 2 {
                reserve = tight
                continue
            }
            if signature.count <= reserve {
                guard let output = try? FileHandle(forWritingTo: temp) else {
                    throw SignKitError.io("cannot finish the signed binary")
                }
                try output.seek(toOffset: UInt64(codeLimit))
                try output.write(contentsOf: signature)
                if reserve > signature.count {
                    try output.write(contentsOf: Data(count: reserve - signature.count))
                }
                try output.close()

                // 4. Swap it in, keeping the file's permissions.
                try fm.removeItem(at: url)
                try fm.moveItem(at: temp, to: url)
                MachOFileSigner.makeRunnable(url)
                return Hasher.hash(options.hashKind, signatureCodeDirectory(signature) ?? Data())
            }
            // Not enough room reserved: try once more with the real size.
            guard attempt == 0 else {
                throw SignKitError.crypto("signature came out bigger than the space reserved")
            }
            reserve = align(signature.count + 64, 16)
        }
        throw SignKitError.crypto("could not fit the signature")
    }

    // MARK: - pieces

    /// iOS refuses an app whose program files are not marked runnable, and says only
    /// "integrity could not be verified". Every program file we sign gets rwxr-xr-x.
    static func makeRunnable(_ url: URL) {
        try? FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o755)],
                                               ofItemAtPath: url.path)
    }

    func isThin(_ url: URL) throws -> Bool {
        let head = try readRange(url, 0, 8)
        let be = head.u32be(0)
        return !(be == 0xcafebabe || be == 0xcafebabf)
    }

    func readRange(_ url: URL, _ offset: Int, _ count: Int) throws -> Data {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            throw SignKitError.io("cannot read \(url.lastPathComponent)")
        }
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        return handle.readData(ofLength: count)
    }

    func estimate(codeLimit: Int, options: MachOSigner.Options) -> Int {
        let pages = codeLimit / 4096 + 2
        var size = 8192
        size += pages * options.hashKind.size
        size += 8 * options.hashKind.size
        if let e = options.entitlements, !e.isEmpty { size += 16384 }
        size += chain.reduce(0) { $0 + $1.der.count } + 8192
        return align(size, 16)
    }

    /// Builds the whole signature by hashing the file from disk.
    func buildSignature(for file: URL, header: MachOSlice, codeLimit: Int,
                        options: MachOSigner.Options, progress: ((Double) -> Void)?) throws -> Data {
        var cd = CodeDirectory(identifier: options.identifier, teamID: options.teamID,
                               hashKind: options.hashKind, codeLimit: codeLimit)
        let text = header.segments.first { $0.name == "__TEXT" }
        cd.execSegBase = text?.fileoff ?? 0
        cd.execSegLimit = text?.filesize ?? 0
        cd.execSegFlags = MachOSigner.execSegFlags(isExecutable: header.isExecutable,
                                                   entitlements: options.entitlements)
        cd.flags = options.adhoc ? CSFlags.adhoc : 0
        cd.codeHashes = try hashPages(of: file, upTo: codeLimit, kind: options.hashKind,
                                      progress: progress)

        let requirements = options.adhoc
            ? Requirement.emptySet()
            : Requirement.set(designated: Requirement.designated(identifier: options.identifier,
                                                                 subjectCN: chain.first?.commonName ?? ""))
        cd.specialHashes[CSSlot.requirements] = Hasher.hash(options.hashKind, requirements.encoded)
        if let h = options.infoPlistHash { cd.specialHashes[CSSlot.infoPlist] = h }
        if let h = options.resourcesHash { cd.specialHashes[CSSlot.resourceDir] = h }

        var xmlBlob: Blob?
        var derBlob: Blob?
        if let ents = options.entitlements.map({ Entitlements.storable($0).kept }), !ents.isEmpty {
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
            sb.add(CSSlot.signatureSlot, Blob.wrapper(try CMS.sign(codeDirectories: [cd], key: key,
                                                                   chain: chain)))
        } else {
            sb.add(CSSlot.signatureSlot, Blob.wrapper(Data()))
        }
        return sb.encoded()
    }

    /// Reads the file a few megabytes at a time and hashes each 4 KB page,
    /// spreading the work across the phone's cores.
    func hashPages(of file: URL, upTo limit: Int, kind: HashKind,
                   progress: ((Double) -> Void)?) throws -> [Data] {
        guard let handle = try? FileHandle(forReadingFrom: file) else {
            throw SignKitError.io("cannot read the binary back")
        }
        defer { try? handle.close() }
        let pageSize = 4096
        let batchPages = 1024                       // 4 MB per read
        var hashes = [Data]()
        hashes.reserveCapacity(limit / pageSize + 1)
        var offset = 0
        try handle.seek(toOffset: 0)

        while offset < limit {
            let want = min(batchPages * pageSize, limit - offset)
            let chunk = handle.readData(ofLength: want)
            guard !chunk.isEmpty else { break }
            let pages = (chunk.count + pageSize - 1) / pageSize
            var batch = [Data](repeating: Data(), count: pages)
            chunk.withUnsafeBytes { raw in
                let base = raw.baseAddress!
                batch.withUnsafeMutableBufferPointer { out in
                    let buffer = out
                    DispatchQueue.concurrentPerform(iterations: pages) { i in
                        let start = i * pageSize
                        let count = min(pageSize, chunk.count - start)
                        var hasher = Hasher(kind)
                        hasher.update(UnsafeRawBufferPointer(start: base + start, count: count))
                        buffer[i] = hasher.finish()
                    }
                }
            }
            hashes.append(contentsOf: batch)
            offset += chunk.count
            progress?(0.5 + Double(offset) / Double(limit) * 0.5)
        }
        return hashes
    }

    /// Pulls the code directory back out of a finished signature, to report its hash.
    func signatureCodeDirectory(_ signature: Data) -> Data? {
        guard signature.count > 12, signature.u32be(0) == BlobMagic.embeddedSignature else { return nil }
        let count = Int(signature.u32be(8))
        for i in 0..<count where signature.u32be(12 + 8 * i) == CSSlot.codeDirectory {
            let off = Int(signature.u32be(16 + 8 * i))
            let len = Int(signature.u32be(off + 4))
            return signature.sub(off, len)
        }
        return nil
    }
}

extension MachOSlice {
    /// Removes the signature load command but leaves the file bytes alone, for the
    /// on-disk signer which never loads the whole binary.
    mutating func stripSignatureKeepingData() {
        guard let lc = codeSignatureCommand else { return }
        removeLoadCommand(lc)
    }
}
