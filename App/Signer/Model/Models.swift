import Foundation
import SignKit

/// Where the app keeps its files. Plain functions so any part of the app can use them.
enum Paths {
    static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Signer")
    }
    /// The folder the File tab shows. Documents, so it also shows in the iPhone Files app.
    static var files: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    static var certificates: URL { root.appendingPathComponent("Certificates") }
    static var profiles: URL { root.appendingPathComponent("Profiles") }
    static var apps: URL { root.appendingPathComponent("Apps") }
    static var tweaks: URL { root.appendingPathComponent("Tweaks") }

    static func createAll() {
        for dir in [certificates, profiles, apps, tweaks] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }
}

/// A signing certificate (a `.p12`) the user imported.
struct StoredCertificate: Codable, Identifiable, Hashable {
    var id: UUID
    var commonName: String
    var teamID: String?
    var appleID: String?
    var expires: Date?
    var password: String
    var sha256: String
    /// The profile that goes with it, worked out automatically when either is imported.
    var profileID: UUID?
    var revocationState: RevocationState = .unknown
    var lastChecked: Date?

    enum RevocationState: String, Codable {
        case unknown, good, revoked, expired, offline
    }

    /// "iPhone Developer: Created via API (3KQD4FN5YL)" — the line Apple puts in the file.
    var title: String {
        if let team = teamID, !commonName.contains("(") {
            return "\(commonName) (\(team))"
        }
        return commonName
    }

    var daysLeft: Int? {
        guard let e = expires else { return nil }
        return Int(e.timeIntervalSinceNow / 86400)
    }

    /// One word, the way ESign shows it: Good, Revoked, Expired.
    var statusWord: String {
        switch revocationState {
        case .revoked: return "Revoked"
        case .expired: return "Expired"
        case .good: return "Good"
        case .offline: return (daysLeft ?? 1) < 0 ? "Expired" : "Not checked"
        case .unknown: return (daysLeft ?? 1) < 0 ? "Expired" : "Unchecked"
        }
    }

    var isUsable: Bool {
        revocationState != .revoked && (daysLeft ?? 1) >= 0
    }

    var expiryText: String {
        guard let e = expires else { return "no end date" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: e)
    }
}

/// A provisioning profile (a `.mobileprovision`) the user imported.
struct StoredProfile: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var teamID: String?
    var teamName: String?
    var bundleIDPattern: String?
    var expires: Date?
    var deviceCount: Int?        // nil means it works on any device
    /// Fingerprints of the certificates this profile was made for.
    var certificateFingerprints: [String]

    var daysLeft: Int? {
        guard let e = expires else { return nil }
        return Int(e.timeIntervalSinceNow / 86400)
    }

    var summary: String {
        var parts = [String]()
        if let pattern = bundleIDPattern { parts.append(pattern) }
        parts.append(deviceCount == nil ? "any device" : "\(deviceCount ?? 0) devices")
        if let d = daysLeft { parts.append(d < 0 ? "expired" : "\(d) days left") }
        return parts.joined(separator: " · ")
    }
}

/// An app in the library: either imported, or one we signed.
struct LibraryApp: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var bundleID: String
    var version: String
    var fileName: String
    var isSigned: Bool
    var signedWithCertificateID: UUID?
    var added: Date
    var bytes: Int
    var iconFileName: String?

    var fileURL: URL { Paths.apps.appendingPathComponent(fileName) }

    var iconURL: URL? {
        iconFileName.map { Paths.apps.appendingPathComponent($0) }
    }

    var sizeText: String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

/// An app repository ("source") the user added.
struct Source: Codable, Identifiable, Hashable {
    var id: UUID
    var url: URL
    var name: String
    var iconURL: URL?
    var lastRefreshed: Date?
    var appCount: Int = 0
}
