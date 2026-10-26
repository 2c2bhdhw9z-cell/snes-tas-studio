import Foundation
import SignKit

/// Where everything lives on disk, and the lists the screens read from.
@MainActor
final class Store: ObservableObject {
    static let shared = Store()

    @Published var certificates: [StoredCertificate] = []
    @Published var profiles: [StoredProfile] = []
    @Published var library: [LibraryApp] = []
    @Published var sources: [Source] = []
    @Published var selectedCertificateID: UUID?

    var root: URL { Paths.root }
    var certificatesDir: URL { Paths.certificates }
    var profilesDir: URL { Paths.profiles }
    var appsDir: URL { Paths.apps }
    var filesDir: URL { Paths.files }
    var tweaksDir: URL { Paths.tweaks }

    /// Gigabytes freed at launch from a signing run iOS killed, if any. Shown in Settings
    /// so the space is not just silently reclaimed.
    @Published var leftoversFreed: Int64 = 0

    private init() {
        Paths.createAll()
        load()
    }

    // MARK: - saved state

    private var stateURL: URL { root.appendingPathComponent("state.json") }

    struct State: Codable {
        var certificates: [StoredCertificate] = []
        var profiles: [StoredProfile] = []
        var library: [LibraryApp] = []
        var sources: [Source] = []
        var selectedCertificateID: UUID?

        enum CodingKeys: String, CodingKey {
            case certificates, profiles, library, sources, selectedCertificateID
        }

        init(certificates: [StoredCertificate] = [], profiles: [StoredProfile] = [],
             library: [LibraryApp] = [], sources: [Source] = [], selectedCertificateID: UUID? = nil) {
            self.certificates = certificates
            self.profiles = profiles
            self.library = library
            self.sources = sources
            self.selectedCertificateID = selectedCertificateID
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            certificates = try c.decodeIfPresent([StoredCertificate].self, forKey: .certificates) ?? []
            profiles = try c.decodeIfPresent([StoredProfile].self, forKey: .profiles) ?? []
            library = try c.decodeIfPresent([LibraryApp].self, forKey: .library) ?? []
            sources = try c.decodeIfPresent([Source].self, forKey: .sources) ?? []
            selectedCertificateID = try c.decodeIfPresent(UUID.self, forKey: .selectedCertificateID)
        }
    }

    func load() {
        guard let data = try? Data(contentsOf: stateURL),
              let state = try? JSONDecoder().decode(State.self, from: data) else { return }
        certificates = state.certificates
        profiles = state.profiles
        library = state.library.filter { FileManager.default.fileExists(atPath: $0.fileURL.path) }
        sources = state.sources
        selectedCertificateID = state.selectedCertificateID ?? state.certificates.first?.id
    }

    func save() {
        let state = State(certificates: certificates, profiles: profiles, library: library,
                          sources: sources, selectedCertificateID: selectedCertificateID)
        try? JSONEncoder().encode(state).write(to: stateURL)
    }

    var selectedCertificate: StoredCertificate? {
        certificates.first { $0.id == selectedCertificateID } ?? certificates.first
    }

    func profile(for cert: StoredCertificate) -> StoredProfile? {
        if let id = cert.profileID, let found = profiles.first(where: { $0.id == id }) { return found }
        return profiles.first { $0.certificateFingerprints.contains(cert.sha256) }
    }

    // MARK: - importing, one file at a time (the quick way)

    /// Imports a `.p12`. Nothing else needed — just the password.
    @discardableResult
    func importCertificate(p12 url: URL, password: String) throws -> StoredCertificate {
        let data = try Data(contentsOf: url)
        let store = try PKCS12(data: data, password: password)
        guard let cert = store.identity, store.privateKey != nil, store.isUsableForSigning else {
            throw SignKitError.crypto("that file has no certificate we can sign with")
        }
        // Already have it? Just update the password and keep going.
        if let existing = certificates.firstIndex(where: { $0.sha256 == cert.sha256Fingerprint }) {
            try SecretStore.set(password, for: certificates[existing].id)
            certificates[existing].password = nil
            save()
            return certificates[existing]
        }

        let id = UUID()
        let dir = certificatesDir.appendingPathComponent(id.uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try data.write(to: dir.appendingPathComponent("cert.p12"))

        var stored = StoredCertificate(
            id: id,
            commonName: cert.commonName.isEmpty ? url.deletingPathExtension().lastPathComponent : cert.commonName,
            teamID: cert.teamID,
            appleID: cert.appleID,
            expires: cert.notAfter,
            password: nil,
            sha256: cert.sha256Fingerprint
        )
        try SecretStore.set(password, for: id)
        // Pair it with a profile already imported, if one matches.
        if let match = profiles.first(where: { $0.certificateFingerprints.contains(stored.sha256) }) {
            stored.profileID = match.id
        }
        certificates.append(stored)
        if selectedCertificateID == nil { selectedCertificateID = stored.id }
        save()
        return stored
    }

    /// Imports a `.mobileprovision` on its own and pairs it with whatever certificate it belongs to.
    @discardableResult
    func importProfile(_ url: URL) throws -> StoredProfile {
        let data = try Data(contentsOf: url)
        let profile = try ProvisioningProfile(data: data)
        let fingerprints = profile.certificates.map(\.sha256Fingerprint)

        if let existing = profiles.firstIndex(where: { $0.name == profile.name
            && $0.expires == profile.expiry && $0.teamID == profile.teamID }) {
            return profiles[existing]
        }

        let id = UUID()
        try data.write(to: profilesDir.appendingPathComponent("\(id.uuidString).mobileprovision"))
        let stored = StoredProfile(
            id: id,
            name: profile.name ?? url.deletingPathExtension().lastPathComponent,
            teamID: profile.teamID,
            teamName: profile.teamName,
            bundleIDPattern: profile.bundleIDPattern,
            expires: profile.expiry,
            deviceCount: profile.isEnterprise ? nil : profile.devices.count,
            certificateFingerprints: fingerprints
        )
        profiles.append(stored)
        // Pair with any certificate it was made for.
        for index in certificates.indices where fingerprints.contains(certificates[index].sha256) {
            certificates[index].profileID = stored.id
        }
        save()
        return stored
    }

    func deleteCertificate(_ cert: StoredCertificate) {
        SecretStore.delete(for: cert.id)
        try? FileManager.default.removeItem(at: certificatesDir.appendingPathComponent(cert.id.uuidString))
        certificates.removeAll { $0.id == cert.id }
        if selectedCertificateID == cert.id { selectedCertificateID = certificates.first?.id }
        save()
    }

    func deleteProfile(_ profile: StoredProfile) {
        try? FileManager.default.removeItem(
            at: profilesDir.appendingPathComponent("\(profile.id.uuidString).mobileprovision"))
        profiles.removeAll { $0.id == profile.id }
        for index in certificates.indices where certificates[index].profileID == profile.id {
            certificates[index].profileID = nil
        }
        save()
    }

    func p12URL(for cert: StoredCertificate) -> URL {
        certificatesDir.appendingPathComponent(cert.id.uuidString).appendingPathComponent("cert.p12")
    }

    func profileURL(for profile: StoredProfile) -> URL {
        profilesDir.appendingPathComponent("\(profile.id.uuidString).mobileprovision")
    }

    /// Loads the signing identity: the certificate plus its paired profile.
    func identity(for cert: StoredCertificate) throws -> IPASigner.Identity {
        let paired = profile(for: cert)
        let password = SecretStore.get(for: cert.id) ?? cert.password ?? ""
        // Migrate a password left by an older build into the Keychain.
        if SecretStore.get(for: cert.id) == nil, let legacy = cert.password {
            try? SecretStore.set(legacy, for: cert.id)
        }
        return try IPASigner.Identity.load(
            p12: p12URL(for: cert),
            password: password,
            profile: paired.map { profileURL(for: $0) }
        )
    }

    // MARK: - library

    /// An app that has just been signed and is waiting to be installed. The root screen shows
    /// the install sheet for it, so "Install as soon as it is signed" works whichever screen
    /// started the job and even if that screen has gone.
    @Published var pendingInstall: LibraryApp?

    func addToLibrary(_ app: LibraryApp) {
        library.removeAll { $0.fileURL == app.fileURL }
        library.insert(app, at: 0)
        save()
    }

    func deleteApp(_ app: LibraryApp) {
        // If My apps points at the same file shown on the File tab, removing the
        // library entry must not silently delete the user's file.
        if app.filePath == nil { try? FileManager.default.removeItem(at: app.fileURL) }
        if let icon = app.iconURL { try? FileManager.default.removeItem(at: icon) }
        library.removeAll { $0.id == app.id }
        save()
    }
}
