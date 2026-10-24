import SwiftUI
import UniformTypeIdentifiers
import SignKit

/// Pick an app, choose what to change, sign it.
struct SignView: View {
    @EnvironmentObject var store: Store
    @StateObject private var runner = SigningRunner()

    @State private var app: LibraryApp?
    @State private var info: IPAInfo?
    @State private var showPicker = false

    // What the user can change
    @State private var name = ""
    @State private var bundleID = ""
    @State private var version = ""
    @State private var fileSharing = false
    @State private var proMotion = false
    @State private var removeExtensions = false
    @State private var removeWatch = false
    @State private var tweaks: [URL] = []
    @State private var showTweakPicker = false

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
            .fileImporter(isPresented: $showPicker,
                          allowedContentTypes: [UTType(filenameExtension: "ipa") ?? .archive]) { result in
                if case .success(let url) = result {
                    if let imported = try? SigningRunner.importIPA(url) { select(imported) }
                }
            }
            .fileImporter(isPresented: $showTweakPicker,
                          allowedContentTypes: [UTType(filenameExtension: "dylib") ?? .data,
                                                UTType(filenameExtension: "deb") ?? .data],
                          allowsMultipleSelection: true) { result in
                if case .success(let urls) = result { tweaks.append(contentsOf: urls) }
            }
            .onAppear { if let app, info == nil { select(app) } }
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
                Button("Pick a different app") { showPicker = true }
            } else {
                Button {
                    showPicker = true
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
            if let pattern = store.selectedCertificate?.bundleIDPattern, !pattern.hasSuffix("*") {
                Text("Your certificate only allows the ID \(pattern). Anything else will not install.")
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
                showTweakPicker = true
            } label: {
                Label("Add a .dylib or .deb", systemImage: "plus")
            }
        }
    }

    var certificateSection: some View {
        Section("Certificate") {
            if store.certificates.isEmpty {
                Text("No certificate yet. Add one on the Certificates tab, or sign without one to test (the app will not install).")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Picker("Sign with", selection: Binding(
                    get: { store.selectedCertificateID },
                    set: { store.selectedCertificateID = $0; store.save() })) {
                    ForEach(store.certificates) { cert in
                        VStack(alignment: .leading) {
                            Text(cert.nickname)
                            Text(cert.statusLine).font(.caption).foregroundStyle(.secondary)
                        }.tag(Optional(cert.id))
                    }
                }
                if let cert = store.selectedCertificate, !cert.isUsable {
                    Label("This certificate is no good any more. Apps signed with it will not open.",
                          systemImage: "xmark.octagon")
                        .font(.caption).foregroundStyle(.red)
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
                    Text("It is in My apps, ready to install.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if let error = runner.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
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

    // MARK: actions

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
        options.adhoc = store.selectedCertificate == nil
        await runner.run(ipa: app.fileURL, options: options, certificate: store.selectedCertificate)
    }
}
