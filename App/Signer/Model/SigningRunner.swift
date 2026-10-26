import Foundation
import SignKit

/// Runs a signing job off the main thread and reports progress in plain English.
@MainActor
final class SigningRunner: ObservableObject {
    @Published var isRunning = false
    @Published var fraction: Double = 0
    @Published var message = ""
    @Published var finished: SigningResult?
    @Published var errorMessage: String?

    func run(ipa: URL, options: SigningOptions, certificate: StoredCertificate?) async {
        isRunning = true
        KeepAwake.shared.begin("signing")
        defer { KeepAwake.shared.end() }
        fraction = 0
        message = "Getting ready"
        errorMessage = nil
        finished = nil

        let store = Store.shared
        let outputName = "signed-\(UUID().uuidString.prefix(8)).ipa"
        let output = store.appsDir.appendingPathComponent(outputName)

        // The breadcrumb file (Settings, Troubleshooting). If iOS closes the app part-way
        // through — out of memory, say — this is all that is left to say where it was.
        Trace.isOn = UserDefaults.standard.object(forKey: SigningRunner.traceKey) as? Bool ?? true
        Trace.start(at: Paths.trace, what: ipa.lastPathComponent)

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
            // Straight into installing, the way ESign does, unless Settings says otherwise.
            if UserDefaults.standard.object(forKey: SigningRunner.installAfterKey) as? Bool ?? true,
               let justSigned = store.library.first(where: { $0.fileName == outputName }) {
                store.pendingInstall = justSigned
            }
        } catch {
            errorMessage = (error as? SignKitError)?.description ?? error.localizedDescription
            message = "Stopped"
            Trace.failed(errorMessage ?? "unknown")
        }
        isRunning = false
    }

    /// The Settings switch for the breadcrumb file.
    static let traceKey = "writeTrace"
    /// The Settings switch for going straight into installing after signing.
    static let installAfterKey = "installAfterSigning"

    /// Imports an `.ipa` into the library without signing it.
    static func importIPA(_ url: URL) throws -> LibraryApp {
        let store = Store.shared
        let info = try IPAInfo.read(url)
        let inFileList = url.standardizedFileURL.path.hasPrefix(Paths.files.standardizedFileURL.path + "/")
        let name = inFileList ? url.lastPathComponent : "import-\(UUID().uuidString.prefix(8)).ipa"
        let dest = inFileList ? url : store.appsDir.appendingPathComponent(name)
        if !inFileList {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.copyItem(at: url, to: dest)
        }
        var iconName: String?
        if let png = info.iconPNG {
            iconName = name + ".png"
            try? png.write(to: store.appsDir.appendingPathComponent(iconName!))
        }
        let app = LibraryApp(id: UUID(), name: info.name, bundleID: info.bundleID,
                             version: info.version, fileName: name,
                             filePath: inFileList ? dest.path : nil, isSigned: false,
                             signedWithCertificateID: nil, added: Date(),
                             bytes: info.bytes, iconFileName: iconName)
        store.addToLibrary(app)
        return app
    }
}
