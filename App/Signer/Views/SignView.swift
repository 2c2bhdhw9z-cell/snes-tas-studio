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
    @State private var separateCopy = false
    @State private var removeWatch = false
    @State private var tweaks: [URL] = []
    @State private var extras: [ExtraEntitlement] = []
    @AppStorage("installAfterSigning") private var installAfterSigning = true

    init(preselected: LibraryApp? = nil) {
        _app = State(initialValue: preselected)
    }

    // Opened from My apps, so it is pushed into that screen's stack — no stack of its own,
    // and installing is the root screen's single sheet (`Store.pendingInstall`).
    var body: some View {
        Form {
            appSection
            if info != nil {
                detailsSection
                switchesSection
                tweaksSection
                permissionsSection
            }
            certificateSection
            actionSection
        }
        .navigationTitle("Sign")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if let app, info == nil { select(app) } }
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
                Text("Your certificate allows one app ID (\(pattern)). The app keeps its own ID above "
                     + "and uses that one for its permissions, so it installs beside your other apps. "
                     + "Only change the ID above if you want a second copy of the same app.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    var switchesSection: some View {
        Section("Changes") {
            Toggle("Show this app's files in the Files app", isOn: $fileSharing)
            Toggle("Allow the smoother 120 Hz screen", isOn: $proMotion)
            Toggle("Install as a separate copy", isOn: $separateCopy)
            Text(separateCopy
                 ? "Gives the app a new ID, so it installs beside the original instead of over it. "
                 + "Its saves and logins start fresh."
                 : "Signs the app with its own ID, so it replaces that same app if you have it.")
                .font(.caption).foregroundStyle(.secondary)
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

    var permissionsSection: some View {
        Section("Permissions") {
            NavigationLink {
                EntitlementsView(extras: $extras)
            } label: {
                HStack {
                    Text("What the app is allowed to do")
                    Spacer()
                    Text(extras.isEmpty ? "as the certificate says" : "\(extras.count) added")
                        .font(.caption).foregroundStyle(.secondary)
                }
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
                    Text(installAfterSigning
                         ? "It is in My apps too. Installing starts on its own; if the sheet is gone, use the button below."
                         : "It is in My apps too.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let signed = store.library.first, signed.isSigned {
                    Button {
                        store.pendingInstall = signed
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
        options.separateCopy = separateCopy
        options.removeWatchApp = removeWatch
        options.injectLibraries = tweaks
        options.extraEntitlements = Dictionary(extras.map { ($0.key, $0.plistValue) },
                                               uniquingKeysWith: { _, last in last })
        options.compressOutput = compressOutput
        options.adhoc = store.selectedCertificate == nil
        await runner.run(ipa: app.fileURL, options: options, certificate: store.selectedCertificate)
        // Installing is started by the job itself and shown by the root screen (SignerApp), so it
        // happens even if this screen is gone by then.
    }
}
