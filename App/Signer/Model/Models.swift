import Foundation
import SignKit

/// Where the app keeps its files. Plain functions so any part of the app can use them.
enum Paths {
    static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Signer")
    }
    static var certificates: URL { root.appendingPathComponent("Certificates") }
    static var apps: URL { root.appendingPathComponent("Apps") }
    static var imports: URL { root.appendingPathComponent("Imports") }
    static var tweaks: URL { root.appendingPathComponent("Tweaks") }

    static func createAll() {
        for dir in [certificates, apps, imports, tweaks] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }
}

/// A certificate the user imported, as shown on the Certificates screen.
struct StoredCertificate: Codable, Identifiable, Hashable {
    var id: UUID
    var nickname: String
    var commonName: String
    var teamID: String?
    var appleID: String?
    var expires: Date?
    var profileExpires: Date?
    var profileName: String?
    /// nil means an enterprise profile: works on any device.
    var deviceCount: Int?
    var bundleIDPattern: String?
    var password: String
    var sha256: String
    /// Filled in by the revocation check.
    var revocationState: RevocationState = .unknown
    var lastChecked: Date?

    enum RevocationState: String, Codable {
        case unknown, good, revoked, expired, offline
    }

    /// The soonest of the certificate's and the profile's end dates.
    var effectiveExpiry: Date? {
        [expires, profileExpires].compactMap { $0 }.min()
    }

    var daysLeft: Int? {
        guard let e = effectiveExpiry else { return nil }
        return Int(e.timeIntervalSinceNow / 86400)
    }

    /// One short line in plain English for the certificate row.
    var statusLine: String {
        switch revocationState {
        case .revoked: return "Dead — Apple turned this certificate off"
        case .expired: return "Out of date"
        case .good, .unknown, .offline:
            guard let d = daysLeft else { return "No end date" }
            if d < 0 { return "Out of date" }
            if d == 0 { return "Ends today" }
            if d == 1 { return "1 day left" }
            return "\(d) days left"
        }
    }

    var isUsable: Bool {
        revocationState != .revoked && (daysLeft ?? 1) >= 0
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
