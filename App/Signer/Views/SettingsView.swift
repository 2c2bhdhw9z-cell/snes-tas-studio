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

                Section("Signing") {
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
