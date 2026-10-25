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
    @State private var showWebCertPicker = false
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
                            showWebCertPicker = true
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
                    Toggle("Squeeze the finished app", isOn: $compressOutput)
                    Text(compressOutput
                         ? "Smaller file, slower signing."
                         : "Off is much faster, and the app installs exactly the same.")
                        .font(.caption).foregroundStyle(.secondary)
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
            .fileImporter(isPresented: $showWebCertPicker,
                          allowedContentTypes: [.item]) { result in
                if case .success(let url) = result,
                   let data = try? Data(contentsOf: url) {
                    try? data.write(to: store.root.appendingPathComponent("local-https.p12"))
                }
            }
            .onAppear {
                webCertPassword = UserDefaults.standard.string(forKey: "localHTTPSPassword") ?? ""
            }
        }
    }

    var hasWebCertificate: Bool {
        FileManager.default.fileExists(atPath: store.root.appendingPathComponent("local-https.p12").path)
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
