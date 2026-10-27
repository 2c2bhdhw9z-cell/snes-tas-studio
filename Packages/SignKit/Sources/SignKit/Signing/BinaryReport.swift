import Foundation

/// What is actually inside an app: its programs, what each one links, and what the signature
/// already in it says. ABox shows this; it is the fifth thing on docs/FEATURES.md.
///
/// Everything here is read without unpacking the app: the load commands live at the front of a
/// program, so only the first part of each file is read, and the signature (which sits at the
/// end) is only read for files small enough to be worth it.
public struct BinaryReport: Identifiable, Hashable, Sendable {
    public var id: String { path }

    /// Where it is inside the app, for example "Payload/App.app/App".
    public var path: String
    public var name: String
    public var bytes: Int
    /// True for the app's own program, as opposed to a framework or an extension.
    public var isMainProgram: Bool
    public var architectures: [String]
    public var minimumOS: String?
    /// Still locked by the App Store: signing it will not make it run.
    public var isEncrypted: Bool
    /// Everything it links, in the order the program lists them.
    public var links: [String]
    public var rpaths: [String]
    public var signature: SignatureFacts?
    /// Set when the file was too big to read the signature out of here.
    public var signatureUnread = false

    public struct SignatureFacts: Hashable, Sendable {
        public var identifier: String
        public var teamID: String?
        public var hashKind: String
        /// Signed with no certificate at all.
        public var isAdHoc: Bool
        /// How many pieces of the program are hashed; it says how big the signed part is.
        public var pageHashes: Int
        public var hasEntitlements: Bool
        public var hasProfile: Bool
    }

    /// A link that is part of iOS, as opposed to something carried inside the app.
    public static func isSystem(_ link: String) -> Bool {
        link.hasPrefix("/usr/lib/") || link.hasPrefix("/System/")
    }

    /// Reads every program inside an `.ipa`.
    /// - Parameter signatureLimit: files bigger than this have their signature skipped, because
    ///   reading it means reading the whole file out of the zip.
    public static func read(ipa: URL, signatureLimit: Int = 200 << 20) throws -> [BinaryReport] {
        let reader = try ZipReader(url: ipa)
        guard let infoEntry = reader.entries.first(where: {
            $0.name.hasSuffix(".app/Info.plist") && $0.name.split(separator: "/").count == 3
        }) else {
            throw SignKitError.malformed("this file is not an iPhone app")
        }
        let appDir = String(infoEntry.name.dropLast("Info.plist".count))
        let info = try PropertyListSerialization.propertyList(
            from: try reader.data(for: infoEntry), format: nil) as? [String: Any] ?? [:]
        let mainName = (info["CFBundleExecutable"] as? String) ?? ""
        let mainPath = appDir + mainName

        var out: [BinaryReport] = []
        for entry in reader.entries {
            guard entry.name.hasPrefix(appDir), !entry.name.hasSuffix("/") else { continue }
            // Cheap filter first: only look at files that could be a program.
            let last = entry.name.split(separator: "/").last.map(String.init) ?? ""
            let looksLikeCode = last == mainName
                || last.hasSuffix(".dylib")
                || !last.contains(".")      // framework and extension programs have no extension
            guard looksLikeCode, entry.uncompressedSize > 1024 else { continue }
            guard let head = try? reader.head(of: entry, limit: 256 << 10),
                  MachOFile.isMachO(head), let file = try? MachOFile(data: head),
                  let slice = file.slices.first else { continue }

            var report = BinaryReport(
                path: entry.name,
                name: last,
                bytes: entry.uncompressedSize,
                isMainProgram: entry.name == mainPath,
                architectures: file.archNames,
                minimumOS: slice.minOS,
                isEncrypted: file.slices.contains { $0.isEncrypted },
                links: slice.dylibs,
                rpaths: slice.rpaths
            )

            if entry.uncompressedSize <= signatureLimit,
               let whole = try? reader.data(for: entry),
               let full = try? MachOFile(data: whole),
               let wholeSlice = full.slices.first {
                report.signature = facts(of: wholeSlice)
            } else if entry.uncompressedSize > signatureLimit {
                report.signatureUnread = true
            }
            out.append(report)
        }
        // The app's own program first, then the rest by name.
        return out.sorted {
            if $0.isMainProgram != $1.isMainProgram { return $0.isMainProgram }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    /// Pulls the facts out of a signature already in a program.
    static func facts(of slice: MachOSlice) -> SignatureFacts? {
        guard let sig = slice.existingSignature,
              let blobs = SignatureInspector.parseBlobs(sig),
              let cd = blobs[CSSlot.codeDirectory] else { return nil }
        // Everything in a code directory is big-endian.
        let flags = cd.u32be(12)
        let identOffset = Int(cd.u32be(20))
        var identifier = ""
        if identOffset > 0, identOffset < cd.count {
            var bytes = [UInt8]()
            var index = identOffset
            while index < cd.count, cd.u8(index) != 0 {
                bytes.append(cd.u8(index))
                index += 1
            }
            identifier = String(bytes: bytes, encoding: .utf8) ?? ""
        }
        return SignatureFacts(
            identifier: identifier,
            teamID: SignatureInspector.teamIdentifier(cd),
            hashKind: SignatureInspector.hashKind(ofDirectory: cd) == .sha1 ? "SHA-1" : "SHA-256",
            isAdHoc: flags & CSFlags.adhoc != 0,
            pageHashes: Int(cd.u32be(28)),
            hasEntitlements: blobs[CSSlot.entitlements] != nil,
            hasProfile: blobs[CSSlot.derEntitlements] != nil
        )
    }
}
