import SwiftUI
import Combine
import PhotosUI
import UIKit
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
    @State private var removeLibraries: [String] = []
    @State private var replaceFiles: [String: Data] = [:]
    @State private var removeFiles: [String] = []
    @State private var newIcon: Data?
    @State private var photo: PhotosPickerItem?
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
                iconSection
                switchesSection
                tweaksSection
                insideSection
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

    /// The icon: keep the app's own, use one of the app's other icons, or put in a picture.
    /// The engine has written every icon size an app needs since the start (Modifier.writeIcon);
    /// this is the screen for it.
    var iconSection: some View {
        Section("Icon") {
            HStack(spacing: 12) {
                if let newIcon, let image = UIImage(data: newIcon) {
                    Image(uiImage: image).resizable()
                        .frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                } else if let data = info?.iconPNG, let image = UIImage(data: data) {
                    Image(uiImage: image).resizable()
                        .frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                } else {
                    Image(systemName: "app.dashed").resizable()
                        .frame(width: 60, height: 60)
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(newIcon == nil ? "The app's own icon" : "Your picture")
                        .font(.callout)
                    Text("Every size iPhone asks for is written from this one picture.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            PhotosPicker(selection: $photo, matching: .images) {
                Label("Choose a picture", systemImage: "photo")
            }
            Button {
                DocumentPicker.present(multiple: false) { urls in
                    if let url = urls.first, let data = try? Data(contentsOf: url) {
                        newIcon = SignView.asPNG(data)
                    }
                }
            } label: {
                Label("Choose a picture file", systemImage: "doc")
            }
            if let alternates = info?.alternateIcons, !alternates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(alternates) { alt in
                            Button {
                                newIcon = alt.png
                            } label: {
                                VStack(spacing: 4) {
                                    if let image = UIImage(data: alt.png) {
                                        Image(uiImage: image).resizable()
                                            .frame(width: 48, height: 48)
                                            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                                    }
                                    Text(alt.name).font(.caption2).lineLimit(1).frame(maxWidth: 60)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Text("Icons this app already carries for itself. Tap one to make it the icon you see.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if newIcon != nil {
                Button("Put the app's own icon back", role: .destructive) { newIcon = nil }
            }
        }
        .onChange(of: photo) { item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    newIcon = SignView.asPNG(data)
                }
            }
        }
    }

    /// A photo is usually a JPEG and iPhone icons have to be PNG, so whatever is picked is
    /// turned into one. Also squares it off at 1024, the size Apple asks for.
    static func asPNG(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let side: CGFloat = 1024
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let square = UIGraphicsImageRenderer(size: CGSize(width: side, height: side),
                                             format: format).image { _ in
            // Fill the square with the picture, cropping the long side rather than squashing it.
            let scale = max(side / image.size.width, side / image.size.height)
            let width = image.size.width * scale
            let height = image.size.height * scale
            image.draw(in: CGRect(x: (side - width) / 2, y: (side - height) / 2,
                                  width: width, height: height))
        }
        return square.pngData() ?? image.pngData()
    }

    var insideSection: some View {
        Section("Inside the app") {
            NavigationLink {
                if let app {
                    InsideAppView(ipa: app.fileURL, removeLibraries: $removeLibraries)
                }
            } label: {
                HStack {
                    Text("Its programs and what they link")
                    Spacer()
                    Text(removeLibraries.isEmpty
                         ? "look inside" : "\(removeLibraries.count) to remove")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            NavigationLink {
                if let app {
                    AppFilesView(ipa: app.fileURL, replace: $replaceFiles, remove: $removeFiles)
                }
            } label: {
                HStack {
                    Text("Its files, and editing them")
                    Spacer()
                    Text(changeCount == 0 ? "look inside" : "\(changeCount) change"
                         + (changeCount == 1 ? "" : "s"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    var changeCount: Int { replaceFiles.count + removeFiles.count }

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
        options.icon = newIcon
        options.injectLibraries = tweaks
        options.removeLibraries = removeLibraries
        options.replaceFiles = replaceFiles
        options.removeFiles = removeFiles
        options.extraEntitlements = Dictionary(extras.map { ($0.key, $0.plistValue) },
                                               uniquingKeysWith: { _, last in last })
        options.compressOutput = compressOutput
        options.adhoc = store.selectedCertificate == nil
        await runner.run(ipa: app.fileURL, options: options, certificate: store.selectedCertificate)
        // Installing is started by the job itself and shown by the root screen (SignerApp), so it
        // happens even if this screen is gone by then.
    }
}
