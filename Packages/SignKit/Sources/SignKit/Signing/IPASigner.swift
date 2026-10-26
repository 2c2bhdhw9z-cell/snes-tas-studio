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

        let inputSize = fileSize(of: ipa)
        let freeSpace = (try? fm.attributesOfFileSystem(forPath: work.path)[.systemFreeSize] as? Int) ?? 0
        Trace.note("file \(ipa.lastPathComponent), \(inputSize) bytes; free space \(freeSpace) bytes")
        Trace.note("certificate \(identity == nil ? "none (ad-hoc)" : "yes"), "
                   + "profile \(identity?.profile?.bundleIDPattern ?? "none")")

        // 1. Open the zip and calculate the real peak space. A compressed 2 GB app
        // can unpack much larger; guessing from the .ipa size is not safe.
        onProgress?(0.02, "Opening the app")
        Trace.phase("opening the app")
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

        Trace.note("\(reader.entries.count) files inside, \(unpackedSize) bytes unpacked")
        Trace.phase("unpacking")
        var unpacked = 0
        try reader.extractAll(to: work) { f, name in
            unpacked += 1
            Trace.step(unpacked - 1, of: reader.entries.count, name)
            self.onProgress?(0.02 + f * 0.25, "Unpacking \(name.split(separator: "/").last.map(String.init) ?? "")")
        }
        let payload = work.appendingPathComponent("Payload")
        guard let appName = (try? fm.contentsOfDirectory(atPath: payload.path))?
            .first(where: { $0.hasSuffix(".app") }) else {
            throw SignKitError.malformed("this file does not look like an iPhone app")
        }
        let app = payload.appendingPathComponent(appName)
        Trace.note("the app inside is \(appName)")

        // 2. Modify
        onProgress?(0.3, "Applying your changes")
        Trace.phase("applying the changes")
        var options = options
        if let profile = identity?.profile {
            let original = (try? BundleSigner(key: nil, chain: [], profile: nil).infoPlist(of: app))?["CFBundleIdentifier"] as? String
            let wanted = options.bundleID ?? original ?? ""
            // A profile made for one exact app ID only installs apps with that ID —
            // the same thing ESign does without asking. Wildcard profiles leave it alone.
            if !profile.isWildcard, let allowed = profile.bundleIDPattern, !profile.allows(bundleID: wanted) {
                options.bundleID = allowed
                warnings.append("Your profile only allows the app ID \(allowed), so the app was signed with that ID.")
            }
            // Extensions each have their own app ID, which a one-ID profile does not name.
            // They are KEPT anyway: their bundle ids move under the app's new id and they are
            // signed with the app's own identifier, which is what zsign (ESign, GBox) does and
            // what iOS accepts. Removing them used to break the apps that need them — a widget,
            // or Continuum's JIT helper, which iOS then reports as missing.
            if !profile.isWildcard, !options.removeExtensions, Modifier.hasExtensions(app) {
                warnings.append("Its extras (widgets, extensions) share the app's ID, because your profile "
                                + "allows only one. They are kept; turn on \"Remove the extras bundled with it\" "
                                + "if an app will not install.")
            }
        }
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

        // Look the finished app over the way the iPhone's installer will. When iOS refuses an
        // app it only ever says "integrity could not be verified"; this says what is actually
        // wrong. Very large apps skip re-reading every page, since the signer has just
        // computed those hashes from the final bytes.
        onProgress?(0.77, "Checking the finished app")
        Trace.phase("checking the finished app")
        let inspection = SignatureInspector.check(app: app, profile: identity?.profile,
                                                  deep: unpackedSize < 200 << 20)
        for problem in inspection.problems { warnings.append("Check failed — " + problem.description) }

        // 4. Pack back up
        onProgress?(0.8, "Packing the app back up")
        Trace.phase("packing the app back up")
        let writer = try ZipWriter(url: output)
        var packed = 0
        try writer.addTree(at: payload, prefix: "Payload/", compress: options.compressOutput,
                           removeAfterWriting: true) { f, name in
            packed += 1
            Trace.step(packed - 1, of: 0, name)
            self.onProgress?(0.8 + f * 0.19, "Packing \(name.split(separator: "/").last.map(String.init) ?? "")")
        }
        try writer.finish()
        onProgress?(1, "Done")
        Trace.finish("signed \(bundleID)")

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
