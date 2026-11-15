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

    /// The running job, kept so Stop can reach it from the main thread while it works.
    private var job: IPASigner?
    /// A stop was asked for. Read by the job at its next file boundary.
    @Published private(set) var stopping = false

    /// Stops the run at the next file. A 4 GB app finishes unpacking within a second or two
    /// of this being pressed, and the half-written output is deleted instead of left behind.
    func cancel() {
        guard isRunning else { return }
        stopping = true
        message = "Stopping"
        job?.cancel()
    }

    /// One signing job at a time for the whole app. Two runs at once overwrite each other's
    /// trace file, Live Activity and output, and the phone only has room for one big app.
    static var jobInFlight = false

    func run(ipa: URL, options: SigningOptions, certificate: StoredCertificate?) async {
        guard !SigningRunner.jobInFlight else {
            errorMessage = "Another app is already being signed. Wait for it to finish."
            message = "Stopped"
            return
        }
        SigningRunner.jobInFlight = true
        defer { SigningRunner.jobInFlight = false }
        isRunning = true
        stopping = false
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

        // The Dynamic Island, so a long job can be watched with Signer closed. The name comes
        // from the library rather than from reading the zip again, which on a 4 GB game would
        // hold the screen up before anything had even started.
        let islandName = store.library.first {
            $0.fileURL.standardizedFileURL == ipa.standardizedFileURL
        }?.name ?? ipa.deletingPathExtension().lastPathComponent
        SigningIsland.shared.start(appName: islandName)

        do {
            let identity = try certificate.map { try store.identity(for: $0) }
            let job = IPASigner()
            self.job = job
            defer { self.job = nil }
            job.onProgress = { [weak self] f, m in
                Task { @MainActor in
                    self?.fraction = f
                    if !m.isEmpty { self?.message = m }
                    SigningIsland.shared.update(fraction: f, step: m.isEmpty ? (self?.message ?? "") : m)
                }
            }
            let result = try await Task.detached(priority: .userInitiated) {
                try job.sign(ipa: ipa, to: output, identity: identity, options: options)
            }.value

            // Do not report success or start installation until every selected add-on is
            // proven to be both linked from the app's main executable and present in the IPA.
            if !options.injectLibraries.isEmpty {
                let outputInfo = try IPAInfo.read(output)
                let linkedNames = Set(outputInfo.linkedTweaks.map {
                    URL(fileURLWithPath: $0).lastPathComponent
                })
                let archive = try ZipReader(url: output)
                let entryNames = archive.entries.map(\.name)
                for library in options.injectLibraries {
                    let name = library.lastPathComponent
                    guard linkedNames.contains(name) else {
                        throw SignKitError.unsupported(
                            "The signed app does not link the selected add-on \(name). No install was started.")
                    }
                    guard entryNames.contains(where: { $0.hasSuffix(".app/Frameworks/\(name)") }) else {
                        throw SignKitError.unsupported(
                            "The signed IPA links \(name), but does not contain it in the app's Frameworks folder.")
                    }
                }
            }

            // Keep the icon next to the app so the library can show it.
            var iconName: String?
            if let info = try? IPAInfo.read(output), let png = info.iconPNG {
                iconName = outputName + ".png"
                try? png.write(to: store.appsDir.appendingPathComponent(iconName!))
            }
            // If the app we signed came from a repository, the signed copy says so too.
            let origin = store.library.first {
                $0.fileURL.standardizedFileURL == ipa.standardizedFileURL
            }
            store.addToLibrary(LibraryApp(
                id: UUID(), name: result.displayName, bundleID: result.bundleID,
                version: result.version, fileName: outputName, isSigned: true,
                signedWithCertificateID: certificate?.id, added: Date(),
                bytes: result.bytes, iconFileName: iconName,
                sourceName: origin?.sourceName, sourceURL: origin?.sourceURL
            ))
            finished = result
            message = "Signed"
            fraction = 1
            SigningIsland.shared.end(failed: false, step: "Signed")
            // Straight into installing, the way ESign does, unless Settings says otherwise.
            if UserDefaults.standard.object(forKey: SigningRunner.installAfterKey) as? Bool ?? true,
               let justSigned = store.library.first(where: { $0.fileName == outputName }) {
                store.pendingInstall = justSigned
            }
        } catch {
            if let kit = error as? SignKitError, case .cancelled = kit {
                // Stopping is not a failure: say "Stopped" quietly and leave no output file.
                message = "Stopped"
                Trace.failed("stopped by hand")
                SigningIsland.shared.end(failed: false, step: "Stopped")
            } else {
                errorMessage = (error as? SignKitError)?.description ?? error.localizedDescription
                message = "Stopped"
                Trace.failed(errorMessage ?? "unknown")
                SigningIsland.shared.end(failed: true, step: "Stopped")
            }
        }
        isRunning = false
    }

    /// The Settings switch for the breadcrumb file.
    static let traceKey = "writeTrace"
    /// The Settings switch for going straight into installing after signing.
    static let installAfterKey = "installAfterSigning"

    /// Imports an `.ipa` into the library without signing it.
    static func importIPA(_ url: URL) throws -> LibraryApp {
        addToLibrary(url, info: try readApp(url))
    }

    /// The slow half of an import: reading the app's info, which can unpack a big icon
    /// catalogue. Kept apart so a screen can run it off the main thread and then add the
    /// result on the main one.
    nonisolated static func readApp(_ url: URL) throws -> IPAInfo {
        try IPAInfo.read(url)
    }

    /// The quick half: copy the file into place if needed, write the icon, add the entry.
    static func addToLibrary(_ url: URL, info: IPAInfo) -> LibraryApp {
        let store = Store.shared
        let inFileList = url.standardizedFileURL.path.hasPrefix(Paths.files.standardizedFileURL.path + "/")
        let name = inFileList ? url.lastPathComponent : "import-\(UUID().uuidString.prefix(8)).ipa"
        let dest = inFileList ? url : store.appsDir.appendingPathComponent(name)
        if !inFileList {
            try? FileManager.default.removeItem(at: dest)
            try? FileManager.default.copyItem(at: url, to: dest)
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
