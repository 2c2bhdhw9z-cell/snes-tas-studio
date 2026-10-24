import Foundation
import SignKit

/// Where everything lives on disk, and the lists the screens read from.
@MainActor
final class Store: ObservableObject {
    static let shared = Store()

    @Published var certificates: [StoredCertificate] = []
    @Published var library: [LibraryApp] = []
    @Published var sources: [Source] = []
    @Published var selectedCertificateID: UUID?

    let root: URL
    var certificatesDir: URL { root.appendingPathComponent("Certificates") }
    var appsDir: URL { root.appendingPathComponent("Apps") }
    var importsDir: URL { root.appendingPathComponent("Imports") }
    var tweaksDir: URL { root.appendingPathComponent("Tweaks") }

    private init() {
        root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Signer")
        for dir in [certificatesDir, appsDir, importsDir, tweaksDir] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        load()
    }

    // MARK: - saved state

    private var stateURL: URL { root.appendingPathComponent("state.json") }

    struct State: Codable {
        var certificates: [StoredCertificate] = []
        var library: [LibraryApp] = []
        var sources: [Source] = []
        var selectedCertificateID: UUID?
    }

    func load() {
        guard let data = try? Data(contentsOf: stateURL),
              let state = try? JSONDecoder().decode(State.self, from: data) else { return }
        certificates = state.certificates
        library = state.library.filter { FileManager.default.fileExists(atPath: $0.fileURL.path) }
        sources = state.sources
        selectedCertificateID = state.selectedCertificateID ?? state.certificates.first?.id
    }

    func save() {
        let state = State(certificates: certificates, library: library,
                          sources: sources, selectedCertificateID: selectedCertificateID)
        try? JSONEncoder().encode(state).write(to: stateURL)
    }

    var selectedCertificate: StoredCertificate? {
        certificates.first { $0.id == selectedCertificateID } ?? certificates.first
    }

    // MARK: - certificates

    /// Imports a `.p12` (with its password) and an optional `.mobileprovision`.
    func importCertificate(p12: URL, password: String, profile: URL?, nickname: String?) throws -> StoredCertificate {
        let store = try PKCS12(url: p12, password: password)
        guard let cert = store.identity, store.privateKey != nil else {
            throw SignKitError.crypto("that file has no certificate we can sign with")
        }
        guard store.isUsableForSigning else {
            throw SignKitError.crypto("the certificate and its key do not match")
        }
        let prof = try profile.map { try ProvisioningProfile(url: $0) }
        if let prof, !prof.matches(certificate: cert) {
            throw SignKitError.crypto("that profile was not made for this certificate")
        }

        let id = UUID()
        let dir = certificatesDir.appendingPathComponent(id.uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: p12, to: dir.appendingPathComponent("cert.p12"))
        if let profile { try FileManager.default.copyItem(at: profile, to: dir.appendingPathComponent("profile.mobileprovision")) }

        let stored = StoredCertificate(
            id: id,
            nickname: nickname?.isEmpty == false ? nickname! : (cert.commonName.isEmpty ? "Certificate" : cert.commonName),
            commonName: cert.commonName,
            teamID: cert.teamID ?? prof?.teamID,
            appleID: cert.appleID,
            expires: cert.notAfter,
            profileExpires: prof?.expiry,
            profileName: prof?.name,
            deviceCount: prof?.isEnterprise == true ? nil : prof?.devices.count,
            bundleIDPattern: prof?.bundleIDPattern,
            password: password,
            sha256: cert.sha256Fingerprint
        )
        certificates.append(stored)
        if selectedCertificateID == nil { selectedCertificateID = stored.id }
        save()
        return stored
    }

    func deleteCertificate(_ cert: StoredCertificate) {
        try? FileManager.default.removeItem(at: certificatesDir.appendingPathComponent(cert.id.uuidString))
        certificates.removeAll { $0.id == cert.id }
        if selectedCertificateID == cert.id { selectedCertificateID = certificates.first?.id }
        save()
    }

    /// Loads the signing identity for a stored certificate.
    func identity(for cert: StoredCertificate) throws -> IPASigner.Identity {
        let dir = certificatesDir.appendingPathComponent(cert.id.uuidString)
        let profileURL = dir.appendingPathComponent("profile.mobileprovision")
        return try IPASigner.Identity.load(
            p12: dir.appendingPathComponent("cert.p12"),
            password: cert.password,
            profile: FileManager.default.fileExists(atPath: profileURL.path) ? profileURL : nil
        )
    }

    // MARK: - library

    func addToLibrary(_ app: LibraryApp) {
        library.removeAll { $0.fileURL == app.fileURL }
        library.insert(app, at: 0)
        save()
    }

    func deleteApp(_ app: LibraryApp) {
        try? FileManager.default.removeItem(at: app.fileURL)
        library.removeAll { $0.id == app.id }
        save()
    }
}
