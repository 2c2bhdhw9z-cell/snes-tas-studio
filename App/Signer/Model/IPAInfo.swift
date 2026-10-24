import Foundation
import SignKit

/// Reads the basics out of an `.ipa` without unpacking the whole thing:
/// name, bundle ID, version, icon, and a few warnings worth showing first.
struct IPAInfo {
    var name: String
    var bundleID: String
    var version: String
    var build: String
    var minimumOS: String?
    var iconPNG: Data?
    var bytes: Int
    var architectures: [String]
    var isEncrypted: Bool
    var hasExtensions: Bool
    var hasWatchApp: Bool
    var linkedTweaks: [String]

    static func read(_ url: URL) throws -> IPAInfo {
        let reader = try ZipReader(url: url)
        guard let infoEntry = reader.entries.first(where: {
            $0.name.hasSuffix(".app/Info.plist") && $0.name.split(separator: "/").count == 3
        }) else {
            throw SignKitError.malformed("this file is not an iPhone app")
        }
        let info = try PropertyListSerialization.propertyList(
            from: try reader.data(for: infoEntry), format: nil) as? [String: Any] ?? [:]
        let appDir = String(infoEntry.name.dropLast("Info.plist".count))

        // The app's own binary tells us the architectures and whether it is still locked.
        var archs = [String]()
        var encrypted = false
        var tweaks = [String]()
        if let exec = info["CFBundleExecutable"] as? String,
           let binary = reader.entries.first(where: { $0.name == appDir + exec }),
           let file = try? MachOFile(data: try reader.data(for: binary)) {
            archs = file.archNames
            encrypted = file.slices.contains { $0.isEncrypted }
            tweaks = file.slices.first?.dylibs.filter {
                !$0.hasPrefix("/usr/lib") && !$0.hasPrefix("/System/")
            } ?? []
        }

        // The biggest icon we can find.
        var iconData: Data?
        let iconNames = iconCandidates(info)
        let iconEntries = reader.entries.filter { e in
            guard e.name.hasPrefix(appDir), e.name.hasSuffix(".png") else { return false }
            let file = String(e.name.dropFirst(appDir.count))
            guard !file.contains("/") else { return false }
            return iconNames.contains { file.hasPrefix($0) } || file.lowercased().contains("appicon")
        }.sorted { $0.uncompressedSize > $1.uncompressedSize }
        if let best = iconEntries.first { iconData = try? reader.data(for: best) }

        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        return IPAInfo(
            name: (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String)
                ?? String(appDir.split(separator: "/").last?.dropLast(4) ?? "App"),
            bundleID: info["CFBundleIdentifier"] as? String ?? "unknown",
            version: info["CFBundleShortVersionString"] as? String ?? "",
            build: info["CFBundleVersion"] as? String ?? "",
            minimumOS: info["MinimumOSVersion"] as? String,
            iconPNG: iconData,
            bytes: size ?? 0,
            architectures: archs,
            isEncrypted: encrypted,
            hasExtensions: reader.entries.contains { $0.name.contains("/PlugIns/") },
            hasWatchApp: reader.entries.contains { $0.name.contains("/Watch/") },
            linkedTweaks: tweaks
        )
    }

    static func iconCandidates(_ info: [String: Any]) -> [String] {
        var names = [String]()
        if let icons = info["CFBundleIcons"] as? [String: Any],
           let primary = icons["CFBundlePrimaryIcon"] as? [String: Any] {
            names += primary["CFBundleIconFiles"] as? [String] ?? []
            if let n = primary["CFBundleIconName"] as? String { names.append(n) }
        }
        names += info["CFBundleIconFiles"] as? [String] ?? []
        if let n = info["CFBundleIconFile"] as? String { names.append(n) }
        return names.isEmpty ? ["AppIcon"] : names
    }

    /// Things worth telling the user before they sign.
    var warnings: [String] {
        var out = [String]()
        if isEncrypted {
            out.append("This app is still locked by the App Store, so signing it will not make it run. "
                       + "You need a decrypted copy.")
        }
        if !linkedTweaks.isEmpty {
            out.append("This app already has add-ons built in: " + linkedTweaks
                .map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))
        }
        if hasWatchApp {
            out.append("There is an Apple Watch app inside. If the install fails, try removing it.")
        }
        return out
    }
}
