import Foundation

/// Looking inside an `.ipa` at the files themselves, without unpacking it: what is in the app,
/// and the contents of one small file at a time. Sixth on docs/FEATURES.md - editing a `.plist`
/// inside an app before signing it, which ESign and GBox both do.
public enum AppContents {
    public struct Entry: Hashable, Sendable, Identifiable {
        public var id: String { path }
        /// Path relative to the `.app` itself: "Info.plist", "Frameworks/Thing.framework/Thing".
        public let path: String
        public let bytes: Int
        /// A folder we worked out from the paths; zips do not have to list them.
        public let isFolder: Bool

        public var name: String {
            path.split(separator: "/").last.map(String.init) ?? path
        }
    }

    /// Everything inside the app, as a flat list of paths relative to the `.app`.
    public static func files(inIPA ipa: URL) throws -> [Entry] {
        let reader = try ZipReader(url: ipa)
        let appDir = try appDirectory(reader)
        var entries: [Entry] = []
        var folders = Set<String>()
        for entry in reader.entries {
            guard entry.name.hasPrefix(appDir), entry.name.count > appDir.count else { continue }
            let rel = String(entry.name.dropFirst(appDir.count))
            if rel.hasSuffix("/") {
                folders.insert(String(rel.dropLast()))
                continue
            }
            entries.append(Entry(path: rel, bytes: entry.uncompressedSize, isFolder: false))
            // Every folder on the way to this file.
            var parts = rel.split(separator: "/").map(String.init)
            parts.removeLast()
            var walked = ""
            for part in parts {
                walked = walked.isEmpty ? part : walked + "/" + part
                folders.insert(walked)
            }
        }
        for folder in folders {
            entries.append(Entry(path: folder, bytes: 0, isFolder: true))
        }
        return entries.sorted { $0.path.localizedCaseInsensitiveCompare($1.path) == .orderedAscending }
    }

    /// One file's contents. `limit` guards against opening something enormous by accident.
    public static func read(inIPA ipa: URL, path: String, limit: Int = 4 << 20) throws -> Data {
        let reader = try ZipReader(url: ipa)
        let appDir = try appDirectory(reader)
        guard let entry = reader.entries.first(where: { $0.name == appDir + path }) else {
            throw SignKitError.malformed("there is no \(path) inside this app")
        }
        guard entry.uncompressedSize <= limit else {
            throw SignKitError.io("\(path) is too big to open here "
                                  + "(\(entry.uncompressedSize) bytes)")
        }
        return try reader.data(for: entry)
    }

    /// Where the app sits inside the zip, "Payload/Something.app/".
    static func appDirectory(_ reader: ZipReader) throws -> String {
        guard let info = reader.entries.first(where: {
            $0.name.hasSuffix(".app/Info.plist") && $0.name.split(separator: "/").count == 3
        }) else {
            throw SignKitError.malformed("this file is not an iPhone app")
        }
        return String(info.name.dropLast("Info.plist".count))
    }

    /// A rough guess at whether a file can be shown as words, used to decide which editor to
    /// offer. A `.plist` can be either XML or Apple's packed form; both are editable.
    public static func kind(of path: String, firstBytes: Data?) -> Kind {
        let lower = path.lowercased()
        if lower.hasSuffix(".plist") || lower.hasSuffix(".strings") { return .plist }
        if ["json", "txt", "md", "xml", "html", "css", "js", "entitlements", "cfg", "conf", "ini",
            "log", "csv", "yml", "yaml", "svg", "sh"].contains(where: { lower.hasSuffix("." + $0) }) {
            return .text
        }
        if let data = firstBytes, !data.isEmpty {
            // Mostly printable, no zero bytes: treat it as words.
            let sample = data.prefix(512)
            if !sample.contains(0),
               sample.filter({ $0 >= 32 && $0 < 127 || $0 == 9 || $0 == 10 || $0 == 13 }).count
                   > (sample.count * 9) / 10 {
                return .text
            }
        }
        return .other
    }

    public enum Kind: Sendable { case plist, text, other }
}
