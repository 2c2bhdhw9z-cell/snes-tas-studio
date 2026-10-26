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
    /// The breadcrumb file for the run happening now (SignKit's `Trace`), and the run before it.
    /// The run before is the one that matters after a crash: it is not overwritten by the next try.
    static var trace: URL { root.appendingPathComponent("trace.txt") }
    static var tracePrevious: URL { root.appendingPathComponent("trace-previous.txt") }

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
    /// Legacy builds stored this in JSON. New imports leave it nil and keep the
    /// password in the iPhone Keychain; optional keeps old saved state readable.
    var password: String? = nil
    var sha256: String
    /// The profile that goes with it, worked out automatically when either is imported.
    var profileID: UUID?
    var revocationState: RevocationState = .unknown
    var lastChecked: Date?

    enum RevocationState: String, Codable {
        case unknown, good, revoked, expired, offline
    }

    /// What Apple (or the check itself) said last time, in plain words, so a result that is not
    /// "Good" says why on the certificate's own screen.
    var lastCheckDetail: String?

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
        // Never asked, against asked-and-no-answer: two different things to a person.
        case .unknown: return (daysLeft ?? 1) < 0 ? "Expired" : (lastChecked == nil ? "Unchecked" : "No answer")
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
    /// Absolute path when the library points at the same file shown on the File tab.
    /// Older saved lists do not have this, so nil falls back to the private Apps folder.
    var filePath: String? = nil
    var isSigned: Bool
    var signedWithCertificateID: UUID?
    var added: Date
    var bytes: Int
    var iconFileName: String?

    var fileURL: URL {
        filePath.map { URL(fileURLWithPath: $0) } ?? Paths.apps.appendingPathComponent(fileName)
    }

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
