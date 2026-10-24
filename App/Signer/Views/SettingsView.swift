import SwiftUI
import UIKit
import UniformTypeIdentifiers
import SignKit

struct SettingsView: View {
    @EnvironmentObject var store: Store
    @StateObject private var udid = UDIDReader()
    @AppStorage("installHelperURL") private var helperURL = ""
    @AppStorage("installLocalHTTPS") private var useLocalHTTPS = false
    @AppStorage("compressOutput") private var compressOutput = true
    @State private var showWebCertPicker = false
    @State private var webCertPassword = ""

    var body: some View {
        NavigationStack {
            Form {
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
                        Text("Only the small details file goes through this address. The app itself is "
                             + "always served from your phone.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section("This phone") {
                    if let id = udid.udid {
                        LabeledContent("Phone ID", value: id)
                            .textSelection(.enabled)
                        if let serial = udid.serial {
                            LabeledContent("Serial", value: serial)
                        }
                        Button("Copy phone ID") {
                            UIPasteboard.general.string = id
                        }
                    } else {
                        Button {
                            Task { await udid.start() }
                        } label: {
                            if udid.isWaiting {
                                Label("Waiting for iOS…", systemImage: "hourglass")
                            } else {
                                Label("Read this phone's ID", systemImage: "iphone")
                            }
                        }
                        Text("Needed when someone adds your phone to a certificate. It is read on the "
                             + "phone itself and sent nowhere.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let e = udid.error {
                        Text(e).font(.caption).foregroundStyle(.red)
                    }
                }

                Section("Signing") {
                    Toggle("Squeeze the finished app (slower)", isOn: $compressOutput)
                    Text("Turning this off makes signing much quicker. The app still installs the same.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Storage") {
                    LabeledContent("Apps kept", value: "\(store.library.count)")
                    LabeledContent("Space used", value: storageText)
                    Button("Delete every app in the list", role: .destructive) {
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
                          allowedContentTypes: [UTType(filenameExtension: "p12") ?? .data]) { result in
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
