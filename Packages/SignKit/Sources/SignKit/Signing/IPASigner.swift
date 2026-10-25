import Foundation

/// The whole job: take an `.ipa`, change what the user asked for, sign it, pack it back up.
public final class IPASigner {
    public struct Identity {
        public let key: RSAPrivateKey
        public let chain: [Certificate]
        public let profile: ProvisioningProfile?

        public init(key: RSAPrivateKey, chain: [Certificate], profile: ProvisioningProfile?) {
            self.key = key
            self.chain = chain
            self.profile = profile
        }

        /// Reads a `.p12` and an optional `.mobileprovision` straight off disk.
        public static func load(p12: URL, password: String, profile: URL?) throws -> Identity {
            let store = try PKCS12(url: p12, password: password)
            guard let key = store.privateKey, let leaf = store.identity else {
                throw SignKitError.crypto("that .p12 file has no usable certificate inside")
            }
            let others = store.certificates.filter { $0.der != leaf.der }
            let prof = try profile.map { try ProvisioningProfile(url: $0) }
            return Identity(key: key, chain: [leaf] + others, profile: prof)
        }
    }

    public var onProgress: ((Double, String) -> Void)?
    private var warnings = [String]()

    public init() {}

    /// Signs an `.ipa` and writes a new one.
    public func sign(ipa: URL, to output: URL, identity: Identity?, options: SigningOptions) throws -> SigningResult {
        let started = Date()
        warnings.removeAll()
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("signkit-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        let inputSize = (try? fm.attributesOfItem(atPath: ipa.path)[.size] as? Int) ?? 0
        let freeSpace = (try? fm.attributesOfFileSystem(forPath: work.path)[.systemFreeSize] as? Int) ?? 0

        // 1. Open the zip and calculate the real peak space. A compressed 2 GB app
        // can unpack much larger; guessing from the .ipa size is not safe.
        onProgress?(0.02, "Opening the app")
        let reader = try ZipReader(url: ipa)
        let unpackedSize = reader.entries.reduce(Int64(0)) { total, entry in
            total.addingReportingOverflow(Int64(entry.uncompressedSize)).overflow
                ? Int64.max : total + Int64(entry.uncompressedSize)
        }
        let largestFile = Int64(reader.entries.map(\.uncompressedSize).max() ?? 0)
        let safety = max(Int64(256 << 20), Int64(inputSize / 10))
        let needed = unpackedSize.addingReportingOverflow(largestFile).overflow
            ? Int64.max : unpackedSize + largestFile + safety
        if freeSpace > 0, needed > Int64(freeSpace) {
            let needText = ByteCountFormatter.string(fromByteCount: needed, countStyle: .file)
            let haveText = ByteCountFormatter.string(fromByteCount: Int64(freeSpace), countStyle: .file)
            throw SignKitError.io("not enough room on the phone: this app needs about \(needText) free "
                                  + "while it is being signed, and there is \(haveText).")
        }

        try reader.extractAll(to: work) { f, name in
            self.onProgress?(0.02 + f * 0.25, "Unpacking \(name.split(separator: "/").last.map(String.init) ?? "")")
        }
        let payload = work.appendingPathComponent("Payload")
        guard let appName = (try? fm.contentsOfDirectory(atPath: payload.path))?
            .first(where: { $0.hasSuffix(".app") }) else {
            throw SignKitError.malformed("this file does not look like an iPhone app")
        }
        let app = payload.appendingPathComponent(appName)

        // 2. Modify
        onProgress?(0.3, "Applying your changes")
        try Modifier(options: options, warnings: { self.warnings.append($0) }).apply(to: app)

        // 3. Sign
        let info = try PropertyListSerialization.propertyList(
            from: try Data(contentsOf: app.appendingPathComponent("Info.plist")), format: nil) as? [String: Any] ?? [:]
        let bundleID = info["CFBundleIdentifier"] as? String ?? "unknown"

        var cdhash = Data()
        let signer = BundleSigner(key: identity?.key, chain: identity?.chain ?? [], profile: identity?.profile)
        signer.hashKind = options.hashKind
        signer.adhoc = options.adhoc || identity == nil
        signer.onProgress = { p in
            self.onProgress?(0.35 + p.fraction * 0.4, p.message)
        }
        var entitlements = identity?.profile?.entitlements(forBundleID: bundleID) ?? [:]
        for (k, v) in options.extraEntitlements { entitlements[k] = v }
        if let profile = identity?.profile, !profile.allows(bundleID: bundleID) {
            warnings.append("The certificate's profile is for \(profile.bundleIDPattern ?? "another app"), "
                            + "so this app's ID was left as \(bundleID). It may not install.")
        }
        cdhash = try signer.sign(bundle: app, entitlements: entitlements.isEmpty ? nil : entitlements)

        // 4. Pack back up
        onProgress?(0.8, "Packing the app back up")
        let writer = try ZipWriter(url: output)
        try writer.addTree(at: payload, prefix: "Payload/", compress: options.compressOutput,
                           removeAfterWriting: true) { f, name in
            self.onProgress?(0.8 + f * 0.19, "Packing \(name.split(separator: "/").last.map(String.init) ?? "")")
        }
        try writer.finish()
        onProgress?(1, "Done")

        let size = (try? fm.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
        return SigningResult(
            outputURL: output,
            bundleID: bundleID,
            displayName: (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String) ?? appName,
            version: (info["CFBundleShortVersionString"] as? String) ?? "",
            cdhash: cdhash,
            bytes: size,
            duration: Date().timeIntervalSince(started),
            warnings: warnings
        )
    }
}
