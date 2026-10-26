import Foundation
import Dispatch

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

        // Work out which files count, then hash them on every core at once.
        // Files inside nested frameworks and extensions are listed one by one,
        // their own signature file included. (Checked against Feather, GBox and ESign:
        // iPhone apps never use "cdhash" entries here, only plain file hashes.)
        var wanted = [String]()
        var symlinks = [(String, String)]()
        for rel in paths {
            if rel == mainExecutable { continue }
            if rel.hasPrefix("_CodeSignature/") || alwaysSkipped.contains(rel) { continue }
            if rel.hasSuffix("/.DS_Store") || rel.hasSuffix(".DS_Store") { continue }
            if rel.hasSuffix("locversion.plist") { continue }

            let url = bundle.appendingPathComponent(rel)
            let vals = try url.resourceValues(forKeys: [.isSymbolicLinkKey])
            if vals.isSymbolicLink == true {
                symlinks.append((rel, try fm.destinationOfSymbolicLink(atPath: url.path)))
            } else {
                wanted.append(rel)
            }
        }

        var hashes = [(Data, Data)](repeating: (Data(), Data()), count: wanted.count)
        let root = bundle
        Trace.note("\(wanted.count) files and \(symlinks.count) links to list in \(bundle.lastPathComponent)")
        Trace.phase("listing \(bundle.lastPathComponent)")
        // Small files go across all cores. Large files are streamed one at a time so
        // a bundle containing several gigabyte-sized game files cannot fill memory.
        let sizes = wanted.map { rel -> Int in
            (try? fm.attributesOfItem(atPath: root.appendingPathComponent(rel).path)[.size] as? Int) ?? 0
        }
        let small = wanted.indices.filter { sizes[$0] <= 8 << 20 }
        if small.count > 4 {
            hashes.withUnsafeMutableBufferPointer { out in
                let buffer = out
                let done = Locked(0)
                DispatchQueue.concurrentPerform(iterations: small.count) { n in
                    let i = small[n]
                    if Trace.isOn {
                        let n = done.withLock { v -> Int in v += 1; return v }
                        Trace.step(n - 1, of: wanted.count, wanted[i])
                    }
                    guard let data = try? Data(contentsOf: root.appendingPathComponent(wanted[i]),
                                               options: .mappedIfSafe) else { return }
                    buffer[i] = (sha1(data), sha256(data))
                }
            }
        } else {
            for (n, i) in small.enumerated() {
                Trace.step(n, of: wanted.count, wanted[i])
                let data = try Data(contentsOf: root.appendingPathComponent(wanted[i]), options: .mappedIfSafe)
                hashes[i] = (sha1(data), sha256(data))
            }
        }
        let big = wanted.indices.filter { sizes[$0] > 8 << 20 }
        if !big.isEmpty { Trace.phase("listing \(bundle.lastPathComponent)'s large files") }
        for (n, i) in big.enumerated() {
            Trace.note("large file \(n + 1) of \(big.count): \(wanted[i]) (\(sizes[i]) bytes)")
            hashes[i] = try hashesOfFile(root.appendingPathComponent(wanted[i]))
        }
        if let i = hashes.firstIndex(where: { $0.0.isEmpty || $0.1.isEmpty }) {
            throw SignKitError.io("could not read \(wanted[i]) while listing the app's files")
        }

        for (rel, target) in symlinks {
            var entry: [String: Any] = ["symlink": target]
            if rel.contains(".lproj/") { entry["optional"] = true }
            files2[rel] = entry
        }

        for (i, rel) in wanted.enumerated() {
            let (h1, h2) = hashes[i]
            let optional = rel.contains(".lproj/")

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

        Trace.note("writing the list of \(files.count) files")
        let plist: [String: Any] = [
            "files": files,
            "files2": files2,
            "rules": rules1,
            "rules2": rules2,
        ]
        return try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    }

    /// SHA-1 and SHA-256 in one streamed pass over a file.
    static func hashesOfFile(_ url: URL) throws -> (Data, Data) {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            throw SignKitError.io("cannot read \(url.lastPathComponent)")
        }
        defer { try? handle.close() }
        var h1 = Hasher(.sha1)
        var h2 = Hasher(.sha256)
        while true {
            let chunk = handle.readData(ofLength: 4 << 20)
            if chunk.isEmpty { break }
            h1.update(chunk)
            h2.update(chunk)
        }
        return (h1.finish(), h2.finish())
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
