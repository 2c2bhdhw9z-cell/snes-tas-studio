import SwiftUI
import SignKit

/// Installs a signed app, serving it to iOS from this phone.
struct InstallView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    @StateObject private var server = InstallServer()
    @AppStorage("installHelperURL") private var helperURL = InstallServer.defaultHelper
    @AppStorage("installLocalHTTPS") private var useLocalHTTPS = false

    let app: LibraryApp

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        AppIcon(url: app.iconURL)
                        VStack(alignment: .leading) {
                            Text(app.name).font(.body.weight(.medium))
                            Text(app.bundleID).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                Section("What happens") {
                    Text(explanation).font(.callout)
                }

                Section {
                    Button {
                        Task { await start() }
                    } label: {
                        Text(buttonTitle).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                }

                if !server.log.isEmpty {
                    Section("Progress") {
                        ForEach(server.log.reversed(), id: \.self) { line in
                            Text(line).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                if case .failed(let message) = server.stage {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                        Text(hint).font(.caption).foregroundStyle(.secondary)
                    }
                }

                if case .handedOff = server.stage {
                    Section {
                        Label("Handed to iOS", systemImage: "checkmark.circle").foregroundStyle(.green)
                        Text("Look at your home screen: the app should be installing. If it says \"Waiting…\", "
                             + "close Signer fully (swipe it away) and the install will carry on.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Install")
            .toolbar {
                Button("Done") { server.stop(); dismiss() }
            }
            .onDisappear { server.stop() }
        }
    }

    var busy: Bool {
        switch server.stage {
        case .idle, .failed, .handedOff: return false
        default: return true
        }
    }

    var buttonTitle: String {
        switch server.stage {
        case .idle: return "Install now"
        case .serving: return "Starting…"
        case .askedIOS: return "Waiting for iOS…"
        case .downloading: return "iOS is copying the app…"
        case .handedOff: return "Install again"
        case .failed: return "Try again"
        }
    }

    var explanation: String {
        if useLocalHTTPS {
            return "Signer serves the app from your phone and asks iOS to install it. "
                + "Nothing is uploaded anywhere."
        }
        if helperURL.isEmpty {
            return "No install method is set yet. Open Settings → Installing and either put back the "
                + "helper address or turn on doing everything on this phone."
        }
        return "The app is served from your phone and installed straight from here. Only a tiny "
            + "details file (the app's name, ID and where to fetch it) goes through the helper "
            + "address, because iOS insists that one file arrives over a secure link. The app "
            + "itself never leaves your phone."
    }

    var hint: String {
        "If this keeps failing: check Settings for the install method, make sure you are not on a "
            + "network that blocks local addresses, and try again."
    }

    func start() async {
        let info = try? IPAInfo.read(app.fileURL)
        let route: InstallServer.Route
        if useLocalHTTPS, let p12 = localWebCertificate() {
            route = .localHTTPS(p12: p12.data, password: p12.password, host: p12.host)
        } else if let url = URL(string: helperURL), !helperURL.isEmpty {
            route = .helper(url)
        } else {
            server.stage = .failed("No install method is set up yet. Open Settings → Installing.")
            return
        }
        await server.start(ipa: app.fileURL, bundleID: app.bundleID,
                           version: app.version.isEmpty ? "1.0" : app.version,
                           title: app.name, iconPNG: info?.iconPNG, route: route)
    }

    /// The web certificate used when everything is done on the phone.
    func localWebCertificate() -> (data: Data, password: String, host: String)? {
        let url = store.root.appendingPathComponent("local-https.p12")
        guard let data = try? Data(contentsOf: url) else { return nil }
        let password = UserDefaults.standard.string(forKey: "localHTTPSPassword") ?? ""
        let host = UserDefaults.standard.string(forKey: "localHTTPSHost") ?? "127.0.0.1"
        return (data, password, host)
    }
}
