import SwiftUI
import SignKit

/// Installs a signed app, serving it to iOS from this phone.
struct InstallView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    @StateObject private var server = InstallServer()
    @StateObject private var device = DeviceInstaller()
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

                if case .downloading(let f) = server.stage {
                    Section { ProgressView(value: f) }
                }

                // A way out while iOS is copying. Closing the sheet used to be the only stop,
                // and on a big app the download keeps the phone busy for minutes.
                if busy {
                    Section {
                        Button(role: .destructive) {
                            server.stop()
                            store.installCancelled()
                        } label: {
                            Label("Stop installing", systemImage: "stop.circle")
                                .frame(maxWidth: .infinity)
                        }
                    }
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
                    .onAppear { store.installFinished(app) }
                }

                // SideStore's route, when a pairing file has been imported.
                if DeviceInstaller.hasPairingFile {
                    Section("Or the way SideStore does it") {
                        Button {
                            Task { await device.install(ipa: app.fileURL, bundleID: app.bundleID) }
                        } label: {
                            Text(device.busy ? "Working…" : "Install with the pairing file")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(device.busy || busy)
                        if device.busy || device.fraction > 0 {
                            ProgressView(value: device.fraction)
                        }
                        if !device.step.isEmpty {
                            Text(device.step).font(.caption).foregroundStyle(.secondary)
                        }
                        if device.done {
                            Label("iOS has it", systemImage: "checkmark.circle")
                                .font(.caption).foregroundStyle(.green)
                        }
                        if let problem = device.problem {
                            Label(problem, systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        Text("Talks to the service inside iOS that the Finder talks to, instead "
                             + "of serving a details file. Needs the address in Settings to be "
                             + "reachable - on a phone that means a tunnel app running.")
                            .font(.caption2).foregroundStyle(.secondary)
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
        case .downloading(let f): return "iOS is copying the app… \(Int(f * 100))%"
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
        let route: InstallServer.Route
        if useLocalHTTPS {
            // The on-phone route was switched on, so it is not silently swapped for the helper
            // while the screen still says nothing is uploaded.
            guard let p12 = localWebCertificate() else {
                server.stage = .failed("Doing everything on this phone needs a web certificate, and "
                                       + "there is not one in Settings → Installing yet. Add the .p12 "
                                       + "there, or turn the switch off to use the helper address.")
                return
            }
            route = .localHTTPS(p12: p12.data, password: p12.password, host: p12.host)
        } else if let url = URL(string: helperURL), !helperURL.isEmpty {
            route = .helper(url)
        } else {
            server.stage = .failed("No install method is set up yet. Open Settings → Installing.")
            return
        }
        // Reading the app for its icon took long enough to freeze the screen on a big one.
        // The library already has the icon, so only read the file when it does not.
        var iconPNG: Data?
        if app.iconURL == nil || !FileManager.default.fileExists(atPath: app.iconURL?.path ?? "") {
            let url = app.fileURL
            iconPNG = await Task.detached(priority: .userInitiated) {
                (try? IPAInfo.read(url))?.iconPNG
            }.value
        }
        await server.start(ipa: app.fileURL, bundleID: app.bundleID,
                           version: app.version.isEmpty ? "1.0" : app.version,
                           title: app.name, iconPNG: iconPNG, route: route)
        if case .handedOff = server.stage { store.installFinished(app) }
    }

    /// The web certificate used when everything is done on the phone.
    func localWebCertificate() -> (data: Data, password: String, host: String)? {
        let url = store.root.appendingPathComponent("local-https.p12")
        guard let data = try? Data(contentsOf: url) else { return nil }
        let password = SecretStore.get("localHTTPSPassword")
            ?? UserDefaults.standard.string(forKey: "localHTTPSPassword") ?? ""
        let host = UserDefaults.standard.string(forKey: "localHTTPSHost") ?? "127.0.0.1"
        return (data, password, host)
    }
}
