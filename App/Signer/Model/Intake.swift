import Foundation
import SwiftUI
import SignKit

/// Takes any file the user hands over — from a picker, the share sheet, Safari,
/// or the iPhone Files app — and puts it where it belongs.
///
/// Pickers accept everything, so nothing is ever greyed out; what a file actually is
/// gets worked out here, from the name and then from the contents.
///
/// Files that come from the iPhone Files app are locked until the app asks for them
/// by name ("security scoped"), which is why every read below is wrapped. Without that
/// wrapper, tapping Open appears to do nothing at all.
enum Intake {
    enum Kind { case certificate, profile, app, tweak, other }

    /// Runs `work` with permission to read a file the system handed us.
    static func withAccess<T>(to url: URL, _ work: (URL) throws -> T) throws -> T {
        let opened = url.startAccessingSecurityScopedResource()
        defer { if opened { url.stopAccessingSecurityScopedResource() } }
        return try work(url)
    }

    static func kind(of url: URL) -> Kind {
        switch url.pathExtension.lowercased() {
        case "p12", "pfx": return .certificate
        case "mobileprovision", "provisionprofile": return .profile
        case "ipa": return .app
        case "dylib", "deb", "framework": return .tweak
        default: break
        }
        // No useful name? Look inside.
        let head = (try? withAccess(to: url) { u -> Data in
            guard let handle = try? FileHandle(forReadingFrom: u) else { return Data() }
            let d = handle.readData(ofLength: 4096)
            try? handle.close()
            return d
        }) ?? Data()
        guard !head.isEmpty else { return .other }
        if head.starts(with: [0x50, 0x4b]) { return .app }                 // a zip, so probably an .ipa
        if head.starts(with: [0x30, 0x82]) { return .certificate }         // DER, so a .p12
        if head.find(Data("ProvisionedDevices".utf8)) != nil
            || head.find(Data("ProvisionsAllDevices".utf8)) != nil { return .profile }
        if MachOFile.isMachO(head) { return .tweak }
        return .other
    }

    /// Copies the file into Signer's own folder so it shows on the File tab.
    /// Copied a few megabytes at a time, so a 200 MB app never sits in memory.
    @discardableResult
    static func keep(_ url: URL, progress: ((Double) -> Void)? = nil) throws -> URL {
        let dest = Paths.files.appendingPathComponent(url.lastPathComponent)
        if dest.path == url.path { return dest }
        return try withAccess(to: url) { source in
            let fm = FileManager.default
            guard let input = try? FileHandle(forReadingFrom: source) else {
                throw SignKitError.io("cannot read \(source.lastPathComponent)")
            }
            defer { try? input.close() }
            try? fm.removeItem(at: dest)
            guard fm.createFile(atPath: dest.path, contents: nil),
                  let output = try? FileHandle(forWritingTo: dest) else {
                throw SignKitError.io("cannot save \(source.lastPathComponent) into the app")
            }
            defer { try? output.close() }
            let total = ((try? fm.attributesOfItem(atPath: source.path)[.size] as? Int) ?? 0) ?? 0
            var copied = 0
            while true {
                let chunk = input.readData(ofLength: 4 << 20)
                if chunk.isEmpty { break }
                try output.write(contentsOf: chunk)
                copied += chunk.count
                if total > 0 { progress?(min(1, Double(copied) / Double(total))) }
            }
            progress?(1)
            return dest
        }
    }
}

/// Handles every file that arrives, from anywhere in the app, and reports back in
/// plain English. A certificate needs its password, so this asks for it on the spot.
@MainActor
final class ImportCoordinator: ObservableObject {
    static let shared = ImportCoordinator()

    /// A certificate waiting for its password.
    @Published var pendingCertificate: URL?
    @Published var password = ""
    @Published var message: String?
    @Published var isError = false
    @Published var busy = false
    @Published var currentName = ""
    @Published var progress: Double = 0

    private init() {}

    /// Called by every file picker in the app.
    func take(_ urls: [URL]) {
        Task { await handle(urls) }
    }

    func handle(_ urls: [URL]) async {
        busy = true
        KeepAwake.shared.begin("importing")
        defer {
            busy = false
            currentName = ""
            progress = 0
            KeepAwake.shared.end()
            NotificationCenter.default.post(name: .filesChanged, object: nil)
        }
        var notes = [String]()
        var failed = false

        for url in urls {
            do {
                currentName = url.lastPathComponent
                progress = 0
                let saved = try await Task.detached(priority: .userInitiated) {
                    try Intake.keep(url) { fraction in
                        Task { @MainActor in ImportCoordinator.shared.progress = fraction }
                    }
                }.value
                switch Intake.kind(of: saved) {
                case .app:
                    let app = try SigningRunner.importIPA(saved)
                    notes.append("Added \(app.name)")
                case .profile:
                    let profile = try Store.shared.importProfile(saved)
                    notes.append("Imported \(profile.name)")
                case .certificate:
                    // Try no password first; most need one, and then we ask.
                    if let cert = try? Store.shared.importCertificate(p12: saved, password: "") {
                        Store.shared.selectedCertificateID = cert.id
                        Store.shared.save()
                        notes.append("Imported \(cert.commonName)")
                    } else {
                        password = ""
                        pendingCertificate = saved
                    }
                case .tweak:
                    let dest = Paths.tweaks.appendingPathComponent(saved.lastPathComponent)
                    try? FileManager.default.removeItem(at: dest)
                    try? FileManager.default.copyItem(at: saved, to: dest)
                    notes.append("Saved the add-on \(saved.lastPathComponent)")
                case .other:
                    notes.append("Saved \(saved.lastPathComponent) to the File tab")
                }
            } catch let e as SignKitError {
                notes.append(e.description)
                failed = true
            } catch {
                notes.append(error.localizedDescription)
                failed = true
            }
        }

        if !notes.isEmpty {
            show(notes.count == 1 ? notes[0] : notes.joined(separator: " · "), error: failed)
        }
    }

    /// Finishes importing a certificate once the password is in.
    func finishCertificate() {
        guard let url = pendingCertificate else { return }
        pendingCertificate = nil
        do {
            let cert = try Store.shared.importCertificate(p12: url, password: password)
            Store.shared.selectedCertificateID = cert.id
            Store.shared.save()
            show("Imported successfully")
        } catch let e as SignKitError {
            show(e.description, error: true)
        } catch {
            show(error.localizedDescription, error: true)
        }
        password = ""
    }

    func show(_ text: String, error: Bool = false) {
        message = text
        isError = error
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if message == text { message = nil }
        }
    }
}

/// The message strip and the password prompt, shown over whatever screen you are on.
struct ImportOverlay: ViewModifier {
    @ObservedObject var coordinator = ImportCoordinator.shared

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if coordinator.busy {
                    VStack(spacing: 7) {
                        ProgressView(value: coordinator.progress)
                        Text("Importing \(coordinator.currentName)")
                            .font(.caption)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    .padding(.horizontal, 24)
                    .padding(.bottom, 58)
                } else if let message = coordinator.message {
                    Text(message)
                        .font(.callout)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .foregroundStyle(coordinator.isError ? Color.red : Color.primary)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 60)
                        .transition(.opacity)
                }
            }
            .alert("Certificate Password", isPresented: Binding(
                get: { coordinator.pendingCertificate != nil },
                set: { if !$0 { coordinator.pendingCertificate = nil } })) {
                SecureField("Please enter the certificate password", text: $coordinator.password)
                Button("Cancel", role: .cancel) { coordinator.pendingCertificate = nil }
                Button("OK") { coordinator.finishCertificate() }
            } message: {
                Text("Leave it empty if the certificate has no password.")
            }
    }
}

extension View {
    /// Adds the import message strip and password prompt to a screen.
    func importFeedback() -> some View { modifier(ImportOverlay()) }
}
