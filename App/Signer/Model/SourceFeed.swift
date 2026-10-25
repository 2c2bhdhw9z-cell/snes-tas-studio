import Foundation
import SignKit

/// One app offered by a source.
struct SourceApp: Identifiable, Hashable {
    var id: String { bundleID + version }
    var name: String
    var bundleID: String
    var version: String
    var versionDate: Date?
    var developer: String?
    var summary: String?
    var fullDescription: String?
    var iconURL: URL?
    var downloadURL: URL?
    var size: Int?
    var screenshots: [URL] = []

    var sizeText: String? {
        size.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
    }
}

/// A source's contents, once read.
struct SourceFeed {
    var name: String
    var identifier: String?
    var iconURL: URL?
    var apps: [SourceApp]
    var newsCount: Int = 0

    /// Reads the shapes real sources come in: the AltStore/SideStore/Feather layout,
    /// a plain `apps` list, and the older flat array.
    static func parse(_ data: Data, from url: URL) throws -> SourceFeed {
        let object = try JSONSerialization.jsonObject(with: data)

        // A bare array of apps.
        if let array = object as? [[String: Any]] {
            return SourceFeed(name: url.host ?? "Source", identifier: nil, iconURL: nil,
                              apps: array.compactMap(app(from:)))
        }
        guard let root = object as? [String: Any] else {
            throw SignKitError.malformed("that source did not send a list we can read")
        }
        let appsRaw = (root["apps"] as? [[String: Any]])
            ?? (root["data"] as? [[String: Any]])
            ?? (root["packages"] as? [[String: Any]])
            ?? []
        let name = (root["name"] as? String) ?? (root["title"] as? String) ?? url.host ?? "Source"
        let icon = (root["iconURL"] as? String) ?? (root["icon"] as? String)
        let news = (root["news"] as? [[String: Any]])?.count ?? 0
        let apps = appsRaw.compactMap(app(from:))
        guard !apps.isEmpty else {
            throw SignKitError.malformed("that source has no apps in it")
        }
        return SourceFeed(name: name,
                          identifier: root["identifier"] as? String,
                          iconURL: icon.flatMap(URL.init(string:)),
                          apps: apps,
                          newsCount: news)
    }

    static func app(from dict: [String: Any]) -> SourceApp? {
        // Newer sources put the download details in a "versions" list, newest first.
        let versions = dict["versions"] as? [[String: Any]] ?? []
        let newest = versions.first

        let name = (dict["name"] as? String) ?? (dict["displayName"] as? String)
        let bundleID = (dict["bundleIdentifier"] as? String) ?? (dict["bundleID"] as? String)
            ?? (dict["identifier"] as? String)
        guard let name, let bundleID else { return nil }

        let download = (newest?["downloadURL"] as? String) ?? (dict["downloadURL"] as? String)
            ?? (dict["url"] as? String)
        let size = (newest?["size"] as? Int) ?? (dict["size"] as? Int)
        let version = (newest?["version"] as? String) ?? (dict["version"] as? String) ?? ""
        let dateText = (newest?["date"] as? String) ?? (dict["versionDate"] as? String)

        return SourceApp(
            name: name,
            bundleID: bundleID,
            version: version,
            versionDate: dateText.flatMap(SourceFeed.date(from:)),
            developer: (dict["developerName"] as? String) ?? (dict["developer"] as? String),
            summary: (dict["subtitle"] as? String) ?? (dict["localizedDescription"] as? String)?
                .split(separator: "\n").first.map(String.init),
            fullDescription: (dict["localizedDescription"] as? String) ?? (dict["description"] as? String),
            iconURL: ((dict["iconURL"] as? String) ?? (dict["icon"] as? String)).flatMap(URL.init(string:)),
            downloadURL: download.flatMap(URL.init(string:)),
            size: size,
            screenshots: screenshots(dict)
        )
    }

    static func screenshots(_ dict: [String: Any]) -> [URL] {
        if let list = dict["screenshotURLs"] as? [String] {
            return list.compactMap(URL.init(string:))
        }
        if let list = dict["screenshots"] as? [String] {
            return list.compactMap(URL.init(string:))
        }
        if let list = dict["screenshots"] as? [[String: Any]] {
            return list.compactMap { ($0["imageURL"] as? String).flatMap(URL.init(string:)) }
        }
        if let byDevice = dict["screenshots"] as? [String: Any],
           let iphone = byDevice["iphone"] as? [[String: Any]] {
            return iphone.compactMap { ($0["imageURL"] as? String).flatMap(URL.init(string:)) }
        }
        return []
    }

    static func date(from text: String) -> Date? {
        let iso = ISO8601DateFormatter()
        if let d = iso.date(from: text) { return d }
        iso.formatOptions = [.withFullDate]
        if let d = iso.date(from: text) { return d }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        for format in ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd HH:mm:ss"] {
            f.dateFormat = format
            if let d = f.date(from: text) { return d }
        }
        return nil
    }
}

/// Fetches sources and downloads apps from them.
@MainActor
final class SourceLoader: ObservableObject {
    @Published var feeds: [UUID: SourceFeed] = [:]
    @Published var loading: Set<UUID> = []
    @Published var failures: [UUID: String] = [:]
    @Published var downloadProgress: Double?
    @Published var downloadName: String?

    func refresh(_ source: Source) async {
        loading.insert(source.id)
        failures[source.id] = nil
        defer { loading.remove(source.id) }
        do {
            var request = URLRequest(url: source.url)
            request.timeoutInterval = 30
            request.setValue("Signer", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                throw SignKitError.io("the source answered with code \(http.statusCode)")
            }
            feeds[source.id] = try SourceFeed.parse(data, from: source.url)
        } catch {
            failures[source.id] = (error as? SignKitError)?.description ?? error.localizedDescription
        }
    }

    func refreshAll(_ sources: [Source]) async {
        for source in sources { await refresh(source) }
    }

    /// Downloads one app from a source straight into the library.
    func download(_ app: SourceApp) async throws -> LibraryApp {
        guard let url = app.downloadURL else {
            throw SignKitError.io("that app has no download link")
        }
        downloadName = app.name
        downloadProgress = 0
        defer { downloadProgress = nil; downloadName = nil }

        // Foundation streams this straight to a temporary file. Do not turn it into
        // Data — source apps can be several gigabytes.
        downloadProgress = 0.05
        let (temp, response) = try await URLSession.shared.download(from: url)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw SignKitError.io("the download failed with code \(http.statusCode)")
        }
        downloadProgress = 0.9
        let clean = app.name.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        let named = Paths.files.appendingPathComponent("\(clean)-\(UUID().uuidString.prefix(6)).ipa")
        try? FileManager.default.removeItem(at: named)
        // The system already downloaded to a file in our sandbox; moving it into the
        // File tab is instant and never creates a second multi-gigabyte copy.
        try FileManager.default.moveItem(at: temp, to: named)
        downloadProgress = 1
        return try SigningRunner.importIPA(named)
    }
}
