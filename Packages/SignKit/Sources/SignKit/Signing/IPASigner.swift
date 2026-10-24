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

        // 1. Unpack
        onProgress?(0.02, "Opening the app")
        let reader = try ZipReader(url: ipa)
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
        try writer.addTree(at: payload, prefix: "Payload/", compress: options.compressOutput) { f, name in
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
            bytes: size ?? 0,
            duration: Date().timeIntervalSince(started),
            warnings: warnings
        )
    }
}
