import Foundation
import SignKit

/// Runs a signing job off the main thread and reports progress in plain English.
@MainActor
final class SigningRunner: ObservableObject {
    @Published var isRunning = false
    @Published var fraction: Double = 0
    @Published var message = ""
    @Published var finished: SigningResult?
    @Published var error: String?

    func run(ipa: URL, options: SigningOptions, certificate: StoredCertificate?) async {
        isRunning = true
        fraction = 0
        message = "Getting ready"
        error = nil
        finished = nil

        let store = Store.shared
        let outputName = "signed-\(UUID().uuidString.prefix(8)).ipa"
        let output = store.appsDir.appendingPathComponent(outputName)

        do {
            let identity = try certificate.map { try store.identity(for: $0) }
            let job = IPASigner()
            job.onProgress = { [weak self] f, m in
                Task { @MainActor in
                    self?.fraction = f
                    if !m.isEmpty { self?.message = m }
                }
            }
            let result = try await Task.detached(priority: .userInitiated) {
                try job.sign(ipa: ipa, to: output, identity: identity, options: options)
            }.value

            // Keep the icon next to the app so the library can show it.
            var iconName: String?
            if let info = try? IPAInfo.read(output), let png = info.iconPNG {
                iconName = outputName + ".png"
                try? png.write(to: store.appsDir.appendingPathComponent(iconName!))
            }
            store.addToLibrary(LibraryApp(
                id: UUID(), name: result.displayName, bundleID: result.bundleID,
                version: result.version, fileName: outputName, isSigned: true,
                signedWithCertificateID: certificate?.id, added: Date(),
                bytes: result.bytes, iconFileName: iconName
            ))
            finished = result
            message = "Signed"
            fraction = 1
        } catch {
            self.error = (error as? SignKitError)?.description ?? error.localizedDescription
            message = "Stopped"
        }
        isRunning = false
    }

    /// Imports an `.ipa` into the library without signing it.
    static func importIPA(_ url: URL) throws -> LibraryApp {
        let store = Store.shared
        let info = try IPAInfo.read(url)
        let name = "import-\(UUID().uuidString.prefix(8)).ipa"
        let dest = store.appsDir.appendingPathComponent(name)
        try FileManager.default.copyItem(at: url, to: dest)
        var iconName: String?
        if let png = info.iconPNG {
            iconName = name + ".png"
            try? png.write(to: store.appsDir.appendingPathComponent(iconName!))
        }
        let app = LibraryApp(id: UUID(), name: info.name, bundleID: info.bundleID,
                             version: info.version, fileName: name, isSigned: false,
                             signedWithCertificateID: nil, added: Date(),
                             bytes: info.bytes, iconFileName: iconName)
        store.addToLibrary(app)
        return app
    }
}
