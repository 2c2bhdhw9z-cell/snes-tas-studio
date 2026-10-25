import SwiftUI
import Combine
import UniformTypeIdentifiers
import SignKit

/// Pick an app, choose what to change, sign it.
struct SignView: View {
    @EnvironmentObject var store: Store
    @StateObject private var runner = SigningRunner()
    @AppStorage("compressOutput") private var compressOutput = false

    @State private var app: LibraryApp?
    @State private var info: IPAInfo?

    // What the user can change
    @State private var name = ""
    @State private var bundleID = ""
    @State private var version = ""
    @State private var fileSharing = false
    @State private var proMotion = false
    @State private var removeExtensions = false
    @State private var removeWatch = false
    @State private var tweaks: [URL] = []
    @State private var installing: LibraryApp?

    init(preselected: LibraryApp? = nil) {
        _app = State(initialValue: preselected)
    }

    var body: some View {
        NavigationStack {
            Form {
                appSection
                if info != nil {
                    detailsSection
                    switchesSection
                    tweaksSection
                }
                certificateSection
                actionSection
            }
            .navigationTitle("Sign")
            .onAppear { if let app, info == nil { select(app) } }
            .sheet(item: $installing) { (app: LibraryApp) in
                InstallView(app: app)
            }
            .onReceive(NotificationCenter.default.publisher(for: .signThisApp)) { note in
                if let id = note.object as? UUID,
                   let found = store.library.first(where: { $0.id == id }) {
                    select(found)
                } else if let newest = store.library.first {
                    select(newest)
                }
            }
        }
    }

    // MARK: sections

    var appSection: some View {
        Section("App") {
            if let app, let info {
                HStack(spacing: 12) {
                    AppIcon(url: app.iconURL)
                    VStack(alignment: .leading) {
                        Text(info.name).font(.body.weight(.medium))
                        Text("\(info.version) · \(ByteCountFormatter.string(fromByteCount: Int64(info.bytes), countStyle: .file))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                ForEach(info.warnings, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Button("Pick a different app") { pickApp() }
            } else {
                Button {
                    pickApp()
                } label: {
                    Label("Choose an app file", systemImage: "folder")
                }
                if !store.library.isEmpty {
                    Picker("Or one from your list", selection: Binding(
                        get: { app?.id },
                        set: { id in
                            if let found = store.library.first(where: { $0.id == id }) { select(found) }
                        })) {
                        Text("None").tag(Optional<UUID>.none)
                        ForEach(store.library) { Text($0.name).tag(Optional($0.id)) }
                    }
                }
            }
        }
    }

    var detailsSection: some View {
        Section("Details") {
            LabeledContent("Name") {
                TextField("App name", text: $name).multilineTextAlignment(.trailing)
            }
            LabeledContent("App ID") {
                TextField("com.example.app", text: $bundleID)
                    .multilineTextAlignment(.trailing)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }
            LabeledContent("Version") {
                TextField("1.0", text: $version).multilineTextAlignment(.trailing)
            }
            if let pattern = pairedPattern, !pattern.hasSuffix("*") {
                Button("Use the ID my certificate allows") { bundleID = pattern }
                    .font(.caption)
                Text("Your profile only allows the ID \(pattern). Signer will use that ID for you, "
                     + "and remove any extras the profile can't cover.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    var switchesSection: some View {
        Section("Changes") {
            Toggle("Show this app's files in the Files app", isOn: $fileSharing)
            Toggle("Allow the smoother 120 Hz screen", isOn: $proMotion)
            Toggle("Remove the extras bundled with it", isOn: $removeExtensions)
            if info?.hasWatchApp == true {
                Toggle("Remove the Apple Watch app", isOn: $removeWatch)
            }
        }
    }

    var tweaksSection: some View {
        Section("Add-ons") {
            ForEach(tweaks, id: \.self) { url in
                Label(url.lastPathComponent, systemImage: "puzzlepiece.extension")
                    .font(.callout)
            }
            .onDelete { idx in idx.forEach { tweaks.remove(at: $0) } }
            Button {
                pickTweaks()
            } label: {
                Label("Add a .dylib or .deb", systemImage: "plus")
            }
        }
    }

    var certificateSection: some View {
        Section("Certificate") {
            if store.certificates.isEmpty {
                Text("No certificate yet. Open the File tab, tap your .p12 and choose Import, then tap "
                     + "your .mobileprovision and choose Import.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Picker("Sign with", selection: Binding(
                    get: { store.selectedCertificateID },
                    set: { store.selectedCertificateID = $0; store.save() })) {
                    ForEach(store.certificates) { cert in
                        Text("\(cert.title) — \(cert.statusWord)").tag(Optional(cert.id))
                    }
                }
                if let cert = store.selectedCertificate, !cert.isUsable {
                    Label("This certificate is no good any more. Apps signed with it will not open.",
                          systemImage: "xmark.octagon")
                        .font(.caption).foregroundStyle(.red)
                }
                if let cert = store.selectedCertificate, store.profile(for: cert) == nil {
                    Label("No profile paired with it yet — import the .mobileprovision too, or the app "
                          + "will not install.", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }

    var actionSection: some View {
        Section {
            if runner.isRunning {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: runner.fraction)
                    Text(runner.message).font(.caption).foregroundStyle(.secondary)
                }
            } else if let result = runner.finished {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Signed in \(String(format: "%.0f", result.duration)) seconds",
                          systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                    ForEach(result.warnings, id: \.self) {
                        Text($0).font(.caption).foregroundStyle(.orange)
                    }
                    Text("It is in My apps too.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let signed = store.library.first, signed.isSigned {
                    Button {
                        installing = signed
                    } label: {
                        Label("Install it now", systemImage: "arrow.down.app")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else if let message = runner.errorMessage {
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            }

            Button {
                Task { await sign() }
            } label: {
                Text(runner.isRunning ? "Working…" : "Sign this app")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(app == nil || runner.isRunning)
        }
    }

    var pairedPattern: String? {
        guard let cert = store.selectedCertificate else { return nil }
        return store.profile(for: cert)?.bundleIDPattern
    }

    // MARK: actions

    func pickApp() {
        DocumentPicker.present(multiple: false) { urls in
            guard let url = urls.first else { return }
            if let local = try? Intake.keep(url), let imported = try? SigningRunner.importIPA(local) {
                select(imported)
            } else {
                ImportCoordinator.shared.take([url])
            }
        }
    }

    func pickTweaks() {
        DocumentPicker.present { urls in
            tweaks.append(contentsOf: urls.compactMap { try? Intake.keep($0) })
        }
    }

    func select(_ app: LibraryApp) {
        self.app = app
        info = try? IPAInfo.read(app.fileURL)
        name = info?.name ?? app.name
        bundleID = info?.bundleID ?? app.bundleID
        version = info?.version ?? app.version
    }

    func sign() async {
        guard let app else { return }
        var options = SigningOptions()
        if name != info?.name { options.displayName = name }
        if bundleID != info?.bundleID { options.bundleID = bundleID }
        if version != info?.version { options.version = version }
        options.fileSharing = fileSharing
        options.proMotion = proMotion
        options.removeExtensions = removeExtensions
        options.removeWatchApp = removeWatch
        options.injectLibraries = tweaks
        options.compressOutput = compressOutput
        options.adhoc = store.selectedCertificate == nil
        await runner.run(ipa: app.fileURL, options: options, certificate: store.selectedCertificate)
    }
}
