import Foundation

/// Builds `_CodeSignature/CodeResources`: the list of hashes for everything in the
/// app bundle that is not code. The rules below were read off real signed apps
/// (ESign 5.0.2, GBox 6.1.3, Feather 2.9.0) so our file matches what Apple writes.
public enum CodeResources {
    /// The old-style rules (`rules`), used by `files`.
    static var rules1: [String: Any] {
        [
            "^version.plist$": true,
            "^.*": true,
            "^.*\\.lproj/": ["optional": true, "weight": 1000.0],
            "^.*\\.lproj/locversion.plist$": ["omit": true, "weight": 1100.0],
            "^Base\\.lproj/": ["weight": 1010.0],
        ]
    }

    /// The modern rules (`rules2`), used by `files2`. These are exactly the ten rules
    /// Apple writes for an iPhone app — the extra "nested" rules are a Mac-only thing.
    static var rules2: [String: Any] {
        [
            "^.*": true,
            ".*\\.dSYM($|/)": ["weight": 11.0],
            "^(.*/)?\\.DS_Store$": ["omit": true, "weight": 2000.0],
            "^Info\\.plist$": ["omit": true, "weight": 20.0],
            "^version\\.plist$": ["weight": 20.0],
            "^embedded\\.provisionprofile$": ["weight": 20.0],
            "^PkgInfo$": ["omit": true, "weight": 20.0],
            "^.*\\.lproj/": ["optional": true, "weight": 1000.0],
            "^.*\\.lproj/locversion.plist$": ["omit": true, "weight": 1100.0],
            "^Base\\.lproj/": ["weight": 1010.0],
        ]
    }

    /// Files Apple never lists.
    static let alwaysSkipped: Set<String> = [
        "_CodeSignature/CodeResources", "CodeResources", ".DS_Store", "PkgInfo",
    ]

    /// Builds the file for one bundle.
    /// - Parameters:
    ///   - bundle: the `.app` (or `.framework`/`.appex`) directory.
    ///   - mainExecutable: the bundle's own binary, which is never listed.
    ///   - nestedCDHashes: for each nested code item (relative path), its code directory hash.
    public static func build(bundle: URL, mainExecutable: String,
                             nestedCDHashes: [String: Data] = [:]) throws -> Data {
        let fm = FileManager.default
        var files = [String: Any]()
        var files2 = [String: Any]()

        var paths = [String]()
        if let it = fm.enumerator(at: bundle, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                                  options: [], errorHandler: nil) {
            for case let url as URL in it {
                let rel = url.path.replacingOccurrences(of: bundle.path + "/", with: "")
                let vals = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                if vals.isDirectory == true && vals.isSymbolicLink != true { continue }
                paths.append(rel)
            }
        }
        paths.sort()

        for rel in paths {
            if rel == mainExecutable { continue }
            if rel.hasPrefix("_CodeSignature/") || alwaysSkipped.contains(rel) { continue }
            if rel.hasSuffix("/.DS_Store") || rel.hasSuffix(".DS_Store") { continue }
            if rel.hasSuffix("locversion.plist") { continue }

            // Files inside nested frameworks and extensions are listed one by one,
            // their own signature file included. (Checked against Feather, GBox and ESign:
            // iPhone apps never use "cdhash" entries here, only plain file hashes.)
            let url = bundle.appendingPathComponent(rel)
            let vals = try url.resourceValues(forKeys: [.isSymbolicLinkKey])
            let optional = rel.contains(".lproj/")

            if vals.isSymbolicLink == true {
                let target = try fm.destinationOfSymbolicLink(atPath: url.path)
                var entry: [String: Any] = ["symlink": target]
                if optional { entry["optional"] = true }
                files2[rel] = entry
                continue
            }

            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            let h1 = sha1(data), h2 = sha256(data)

            // `files` keeps the old SHA-1 list; Info.plist and PkgInfo appear here only.
            if optional {
                files[rel] = ["hash": h1, "optional": true]
            } else {
                files[rel] = h1
            }
            if rel == "Info.plist" || rel == "PkgInfo" { continue }   // omitted from files2
            if optional {
                files2[rel] = ["hash2": h2, "optional": true]
            } else {
                files2[rel] = ["hash2": h2]
            }
        }

        let plist: [String: Any] = [
            "files": files,
            "files2": files2,
            "rules": rules1,
            "rules2": rules2,
        ]
        return try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    }

    /// Writes the file into the bundle and returns its hash for the signature's slot 3.
    @discardableResult
    public static func write(bundle: URL, mainExecutable: String,
                             nestedCDHashes: [String: Data] = [:],
                             hashKind: HashKind = .sha256) throws -> Data {
        let data = try build(bundle: bundle, mainExecutable: mainExecutable, nestedCDHashes: nestedCDHashes)
        let dir = bundle.appendingPathComponent("_CodeSignature")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try data.write(to: dir.appendingPathComponent("CodeResources"))
        return Hasher.hash(hashKind, data)
    }
}
