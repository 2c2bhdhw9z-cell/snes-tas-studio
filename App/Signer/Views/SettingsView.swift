import SwiftUI
import UIKit
import UniformTypeIdentifiers
import SignKit

struct SettingsView: View {
    @EnvironmentObject var store: Store
    @StateObject private var udid = UDIDReader()
    @AppStorage("installHelperURL") private var helperURL = InstallServer.defaultHelper
    @AppStorage("installLocalHTTPS") private var useLocalHTTPS = false
    @AppStorage("compressOutput") private var compressOutput = false
    @AppStorage("keepLongJobsRunning") private var keepLongJobsRunning = true
    @AppStorage(SigningRunner.traceKey) private var writeTrace = true
    @AppStorage("installAfterSigning") private var installAfterSigning = true
    @AppStorage(AppTheme.key) private var theme = AppTheme.system.rawValue
    @AppStorage(BackgroundRefresh.settingKey) private var checkInBackground = true
    @AppStorage(SigningIsland.settingKey) private var showIsland = true
    @AppStorage(DeviceInstaller.hostKey) private var pairingHost = "127.0.0.1"
    @AppStorage(DeviceInstaller.portKey) private var pairingPort = 62078
    @StateObject private var device = DeviceInstaller()
    @State private var webCertPassword = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        UDIDView(udid: udid)
                    } label: {
                        Text("Get Device UDID")
                    }
                    NavigationLink {
                        CertificatesView()
                    } label: {
                        HStack {
                            Text("Certificate Management")
                            Spacer()
                            if let cert = store.selectedCertificate {
                                Text(cert.statusWord)
                                    .font(.caption)
                                    .foregroundStyle(cert.isUsable ? .green : .red)
                            } else {
                                Text("none").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section("Appearance") {
                    Picker("Theme", selection: $theme) {
                        ForEach(AppTheme.allCases) { choice in
                            Label(choice.label, systemImage: choice.symbol).tag(choice.rawValue)
                        }
                    }
                    Text(AppTheme.named(theme) == .system
                         ? "Follows your phone's Light or Dark setting, including its night schedule."
                         : "Signer stays \(AppTheme.named(theme).label.lowercased()) whatever the phone is set to.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Installing") {
                    Toggle("Do everything on this phone", isOn: $useLocalHTTPS)
                    if useLocalHTTPS {
                        Button {
                            DocumentPicker.present(multiple: false) { urls in
                                if let url = urls.first, let data = try? Data(contentsOf: url) {
                                    try? data.write(to: store.root.appendingPathComponent("local-https.p12"))
                                }
                            }
                        } label: {
                            LabeledContent("Web certificate (.p12)",
                                           value: hasWebCertificate ? "added" : "choose")
                        }
                        SecureField("Its password", text: $webCertPassword)
                            .onSubmit { UserDefaults.standard.set(webCertPassword, forKey: "localHTTPSPassword") }
                        Text("iOS only installs from a secure address. Doing it all on the phone needs a "
                             + "web certificate for a name that points back here. Nothing is uploaded.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        LabeledContent("Helper address") {
                            TextField("https://…", text: $helperURL)
                                .multilineTextAlignment(.trailing)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        }
                        Text("Only the small details file goes through this address — the app's name, "
                             + "its ID and a link back to this phone. The app itself is always served "
                             + "from your phone. iOS insists that one file arrives over a secure link.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Put the usual address back") { helperURL = InstallServer.defaultHelper }
                    }
                }

                Section("Pairing file") {
                    LabeledContent("Pairing file",
                                   value: DeviceInstaller.hasPairingFile
                                   ? (UserDefaults.standard.string(forKey: DeviceInstaller.fileKey) ?? "kept")
                                   : "none yet")
                    LabeledContent("Address") {
                        TextField("127.0.0.1", text: $pairingHost)
                            .multilineTextAlignment(.trailing)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }
                    LabeledContent("Port") {
                        TextField("62078", value: $pairingPort, format: .number)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numberPad)
                    }
                    Button {
                        Task { await device.check() }
                    } label: {
                        if device.busy {
                            Label("Asking…", systemImage: "hourglass")
                        } else {
                            Label("Say hello to iOS's install service", systemImage: "hand.wave")
                        }
                    }
                    .disabled(device.busy)
                    if let saw = device.sawService {
                        Label("It answered: \(saw)", systemImage: "checkmark.circle")
                            .font(.caption).foregroundStyle(.green)
                    }
                    if let problem = device.problem {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Text("This is the way SideStore installs: instead of handing iOS a details "
                         + "file over the web, Signer talks to the service inside iOS that the "
                         + "Finder talks to. It needs a pairing file - tap yours on the File tab "
                         + "and choose \"Use as the pairing file\" - and it needs that service to "
                         + "be reachable at the address above, which on a phone means a tunnel "
                         + "app such as StosVPN running. Say hello first: if it answers, the "
                         + "rest will work.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Signing") {
                    Toggle("Show progress in the Dynamic Island", isOn: $showIsland)
                    Text("Puts the job in the island at the top of the screen and on the lock "
                         + "screen, so a long sign can be watched with Signer closed. Needs "
                         + "iOS 16.1 or newer.")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Install as soon as it is signed", isOn: $installAfterSigning)
                    Text("Goes straight to installing when signing finishes, the way ESign does. "
                         + "Off leaves the app in My apps for you to install when you like.")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Keep long jobs running", isOn: $keepLongJobsRunning)
                    Text("Keeps signing or installing a huge app alive if the screen locks or you "
                         + "switch away. It runs only while a job is active.")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Squeeze the finished app", isOn: $compressOutput)
                    Text(compressOutput
                         ? "Smaller file, slower signing."
                         : "Off is much faster, and the app installs exactly the same.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Sources") {
                    Toggle("Check my sources in the background", isOn: $checkInBackground)
                    Text("iOS gives Signer a moment now and then - usually while charging on "
                         + "Wi-Fi - to read your repositories and tell you if an app has a newer "
                         + "version waiting. Nothing is downloaded or signed on its own.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Shortcuts can also do it: \"Check my sources\", \"Updates waiting\", "
                         + "\"Sign an app\" and \"Install an app\" are all in the Shortcuts app "
                         + "and work with Siri.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .onChange(of: checkInBackground) { on in
                    Task {
                        if on { await BackgroundRefresh.askAboutNotifications() }
                        BackgroundRefresh.schedule()
                    }
                }

                Section("Troubleshooting") {
                    Toggle("Keep a trace while signing", isOn: $writeTrace)
                    Text("Writes a small file as it signs, a line at a time. If Signer closes on its "
                         + "own part-way through, that file still says which file and step it was on. "
                         + "It costs nothing noticeable and is kept only on this phone.")
                        .font(.caption).foregroundStyle(.secondary)
                    NavigationLink {
                        TraceView()
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Last run")
                            Text(lastRunSummary)
                                .font(.caption)
                                .foregroundStyle(lastRunLooksBad ? .red : .secondary)
                        }
                    }
                }

                Section("Storage") {
                    LabeledContent("Apps kept", value: "\(store.library.count)")
                    LabeledContent("Space used", value: storageText)
                    if store.leftoversFreed > 0 {
                        Text("Freed \(ByteCountFormatter.string(fromByteCount: store.leftoversFreed, countStyle: .file)) "
                             + "left over from a signing run that was cut short.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button("Delete every app in My apps", role: .destructive) {
                        store.library.forEach(store.deleteApp)
                    }
                }

                Section("About") {
                    LabeledContent("Version", value: appVersion)
                    Text("Signs apps on the phone with its own engine, written from scratch. "
                         + "No tracking, nothing sent anywhere.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                webCertPassword = UserDefaults.standard.string(forKey: "localHTTPSPassword") ?? ""
            }
        }
    }

    var hasWebCertificate: Bool {
        FileManager.default.fileExists(atPath: store.root.appendingPathComponent("local-https.p12").path)
    }

    /// How the last signing run ended, in plain words.
    var lastRunSummary: String {
        Trace.summary(of: Paths.trace) ?? Trace.summary(of: Paths.tracePrevious) ?? "nothing recorded yet"
    }

    var lastRunLooksBad: Bool {
        lastRunSummary.hasPrefix("closed unexpectedly") || lastRunSummary.hasPrefix("stopped: ")
    }

    var storageText: String {
        let total = store.library.reduce(0) { $0 + $1.bytes }
        return ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file)
    }

    var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }
}

/// Reads this phone's ID with no computer involved.
struct UDIDView: View {
    @ObservedObject var udid: UDIDReader

    var body: some View {
        List {
            if let id = udid.udid {
                Section {
                    Text(id).font(.footnote.monospaced()).textSelection(.enabled)
                    Button("Copy") { UIPasteboard.general.string = id }
                }
                if let serial = udid.serial {
                    Section("Serial") { Text(serial).font(.footnote.monospaced()) }
                }
            } else {
                Section {
                    Button {
                        Task { await udid.start() }
                    } label: {
                        if udid.isWaiting {
                            Label("Waiting for iOS…", systemImage: "hourglass")
                        } else {
                            Label("Read this phone's ID", systemImage: "iphone")
                        }
                    }
                } footer: {
                    Text("iOS will ask to install a small profile. It sends your phone's ID back to "
                         + "Signer on this phone and nowhere else. You can delete the profile afterwards.")
                }
            }
            if let e = udid.error {
                Section { Text(e).font(.caption).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Device UDID")
        .navigationBarTitleDisplayMode(.inline)
    }
}
