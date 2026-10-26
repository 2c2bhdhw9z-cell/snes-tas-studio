import Foundation

/// Signs a whole app bundle: every framework, plug-in and extension inside it first,
/// then the resource list, then the app's own binary. That order matters — iOS checks
/// the inner items through the outer signature.
public final class BundleSigner {
    public struct Progress {
        public let fraction: Double
        public let message: String
    }

    public let key: RSAPrivateKey?
    public let chain: [Certificate]
    public let profile: ProvisioningProfile?
    public var hashKind: HashKind = .sha256
    public var adhoc = false
    /// Called with a 0–1 fraction and a short plain-English message.
    public var onProgress: ((Progress) -> Void)?

    public init(key: RSAPrivateKey?, chain: [Certificate], profile: ProvisioningProfile?) {
        self.key = key
        self.chain = chain
        self.profile = profile
    }

    /// Signs the bundle in place.
    /// - Returns: the code directory hash of the app's own binary.
    @discardableResult
    public func sign(bundle: URL, entitlements: [String: Any]? = nil) throws -> Data {
        let fm = FileManager.default
        guard fm.fileExists(atPath: bundle.appendingPathComponent("Info.plist").path) else {
            throw SignKitError.malformed("\(bundle.lastPathComponent) has no Info.plist")
        }
        let info = try infoPlist(of: bundle)
        guard let executable = info["CFBundleExecutable"] as? String else {
            throw SignKitError.malformed("\(bundle.lastPathComponent) does not say which file is its program")
        }
        let bundleID = info["CFBundleIdentifier"] as? String ?? "unknown"

        // 1. Everything nested inside, innermost first: bundles sign their own insides.
        let items = try nestedItems(in: bundle)
        let nested = items.bundles + items.loose
        var cdHashes = [String: Data]()
        for (i, rel) in nested.enumerated() {
            report(Double(i) / Double(max(nested.count, 1)) * 0.6, "Signing \(URL(fileURLWithPath: rel).lastPathComponent)")
            let url = bundle.appendingPathComponent(rel)
            if items.bundles.contains(rel) {
                let child = BundleSigner(key: key, chain: chain, profile: profile)
                child.hashKind = hashKind
                child.adhoc = adhoc
                // Extensions get their own app identifier, derived from the parent's.
                var childEnts: [String: Any]?
                let kind = url.pathExtension
                if kind == "appex" || kind == "app", let ents = entitlements,
                   let childInfo = try? infoPlist(of: url), let childID = childInfo["CFBundleIdentifier"] as? String {
                    // An extension normally carries its own app identifier. A profile made for one
                    // exact app ID does not cover the extension's own ID, so it shares the app's
                    // identifier instead — what zsign (so ESign and GBox) does, and what iOS
                    // accepts: its bundle id still sits under the app's, and its identifier
                    // matches the profile. Removing the extension instead would break any app
                    // that needs it (Continuum's JIT helper, a widget).
                    if let p = profile, p.allows(bundleID: childID) {
                        childEnts = p.entitlements(forBundleID: childID)
                    } else {
                        childEnts = ents
                    }
                }
                cdHashes[rel] = try child.sign(bundle: url, entitlements: childEnts)
            } else {
                cdHashes[rel] = try signLooseBinary(at: url, identifier: url.deletingPathExtension().lastPathComponent)
            }
        }

        // 2. The provisioning profile goes in the bundle (apps and extensions only).
        if let p = profile, bundle.pathExtension != "framework" {
            try p.der.write(to: bundle.appendingPathComponent("embedded.mobileprovision"))
        }

        // 3. The resource list.
        report(0.7, "Listing \(bundle.lastPathComponent) contents")
        let resourcesHash = try CodeResources.write(bundle: bundle, mainExecutable: executable,
                                                    nestedCDHashes: cdHashes, hashKind: hashKind)

        // 4. The app's own binary.
        report(0.85, "Signing \(bundle.lastPathComponent)")
        let infoData = try Data(contentsOf: bundle.appendingPathComponent("Info.plist"))
        let binary = bundle.appendingPathComponent(executable)
        var options = MachOSigner.Options(
            identifier: bundleID,
            teamID: adhoc ? nil : (chain.first?.teamID ?? profile?.teamID),
            entitlements: adhoc ? nil : (entitlements ?? profile?.entitlements(forBundleID: bundleID)),
            infoPlistHash: Hasher.hash(hashKind, infoData),
            resourcesHash: resourcesHash,
            hashKind: hashKind,
            adhoc: adhoc
        )
        if bundle.pathExtension == "framework" { options.entitlements = nil }

        // Signed on disk, so even a two-gigabyte binary never sits in memory.
        let signer = MachOFileSigner(key: adhoc ? nil : key, chain: adhoc ? [] : chain)
        let cdhash = try signer.sign(fileAt: binary, options: options) { [weak self] f in
            self?.report(0.85 + f * 0.14, "Signing \(bundle.lastPathComponent)")
        }
        report(1.0, "Signed \(bundle.lastPathComponent)")
        return cdhash
    }

    /// Signs a bare `.dylib` sitting in the bundle (a tweak, or a Swift runtime library).
    @discardableResult
    public func signLooseBinary(at url: URL, identifier: String) throws -> Data {
        var options = MachOSigner.Options(identifier: identifier,
                                          teamID: adhoc ? nil : (chain.first?.teamID ?? profile?.teamID))
        options.hashKind = hashKind
        options.adhoc = adhoc
        let signer = MachOFileSigner(key: adhoc ? nil : key, chain: adhoc ? [] : chain)
        return try signer.sign(fileAt: url, options: options)
    }

    // MARK: - helpers

    func report(_ f: Double, _ m: String) { onProgress?(Progress(fraction: f, message: m)) }

    func write(_ data: Data, to url: URL) throws {
        try data.write(to: url)
        MachOFileSigner.makeRunnable(url)
    }

    public func infoPlist(of bundle: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: bundle.appendingPathComponent("Info.plist"))
        guard let d = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
            throw SignKitError.malformed("\(bundle.lastPathComponent) has a damaged Info.plist")
        }
        return d
    }

    /// What is inside a bundle that needs its own signature: nested bundles (frameworks,
    /// extensions, watch apps) and loose program files — wherever they are.
    ///
    /// Emulator cores, plug-ins and helper libraries are often tucked into folders that are
    /// not the standard ones. `zsign` finds them by looking at every file; so do we.
    /// Anything inside a nested bundle is left for that bundle's own signing run.
    public func nestedItems(in bundle: URL) throws -> (bundles: [String], loose: [String]) {
        let fm = FileManager.default
        let nestedKinds: Set<String> = ["framework", "appex", "app", "xpc", "systemextension", "xctest"]
        let mainExec = (try? infoPlist(of: bundle))?["CFBundleExecutable"] as? String
        var bundles = [String](), loose = [String]()
        let base = bundle.standardizedFileURL.path
        guard let walker = fm.enumerator(at: bundle, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                                         options: []) else { return ([], []) }
        for case let url as URL in walker {
            let rel = String(url.standardizedFileURL.path.dropFirst(base.count + 1))
            let vals = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if vals?.isSymbolicLink == true { continue }
            let name = url.lastPathComponent
            if vals?.isDirectory == true {
                if name == "_CodeSignature" || name.hasSuffix(".dSYM") || name == "_WatchKitStub" || name == "SC_Info" {
                    walker.skipDescendants(); continue
                }
                if nestedKinds.contains(url.pathExtension), url != bundle {
                    bundles.append(rel)
                    walker.skipDescendants()
                }
                continue
            }
            if rel == mainExec { continue }
            if MachOFile.isSignable(url: url) { loose.append(rel) }
        }
        return (bundles, loose)
    }

    /// Kept for callers that want one flat list, deepest first.
    public func nestedCode(in bundle: URL) throws -> [String] {
        let items = try nestedItems(in: bundle)
        return (items.bundles + items.loose).sorted { $0.components(separatedBy: "/").count > $1.components(separatedBy: "/").count }
    }
}
