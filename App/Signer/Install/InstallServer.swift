import Foundation
import Network
import SignKit

/// Installs a signed app by serving it to iOS from the phone itself.
///
/// iOS only installs from an `itms-services://` link whose manifest comes over HTTPS,
/// so the app runs a tiny web server on the phone and hands iOS a link to it. Nothing
/// goes over the internet: the app never leaves the device.
@MainActor
final class InstallServer: ObservableObject {
    enum Stage: Equatable {
        case idle
        case serving
        case askedIOS
        case downloading(Double)
        case handedOff
        case failed(String)
    }

    @Published var stage: Stage = .idle
    @Published var log: [String] = []

    private var listener: NWListener?
    private var payload: Data?
    private var manifest: Data?
    private var icon: Data?
    private var port: UInt16 = 0
    private var bytesSent = 0
    private var connections: [NWConnection] = []

    /// How the manifest reaches iOS.
    enum Route {
        /// Everything local: the phone serves the manifest too. Needs a `.p12` web
        /// certificate for a name that points back at this phone (127.0.0.1).
        case localHTTPS(p12: Data, password: String, host: String)
        /// The app is served locally; only the tiny manifest goes through a helper
        /// site over HTTPS, because iOS insists on HTTPS for that one file.
        case remoteManifest(URL)
    }

    func start(ipa: URL, bundleID: String, version: String, title: String,
               iconPNG: Data?, route: Route) async {
        stop()
        do {
            let data = try Data(contentsOf: ipa, options: .mappedIfSafe)
            payload = data
            icon = iconPNG
            let p = try startListener(route: route)
            port = p
            let base: String
            switch route {
            case .localHTTPS(_, _, let host): base = "https://\(host):\(p)"
            // (the helper only ever receives a link back to this phone)
            case .remoteManifest: base = "http://127.0.0.1:\(p)"
            }
            manifest = InstallServer.manifest(ipaURL: "\(base)/app.ipa", bundleID: bundleID,
                                              version: version, title: title,
                                              iconURL: iconPNG == nil ? nil : "\(base)/icon.png")
            stage = .serving
            note("Serving \(title) from this phone on port \(p)")

            let manifestURL: String
            switch route {
            case .localHTTPS:
                manifestURL = "\(base)/manifest.plist"
            case .remoteManifest(let helper):
                // The helper only ever sees a link back to this phone, never the app.
                manifestURL = try await upload(manifest: manifest!, to: helper)
            }
            let link = "itms-services://?action=download-manifest&url="
                + manifestURL.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
            stage = .askedIOS
            note("Asked iOS to install")
            await open(link)
        } catch {
            stage = .failed(friendly(error))
            note("Could not start: \(friendly(error))")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        connections.forEach { $0.cancel() }
        connections.removeAll()
        payload = nil
        manifest = nil
        bytesSent = 0
    }

    // MARK: - the server

    private func startListener(route: Route) throws -> UInt16 {
        let params: NWParameters
        switch route {
        case .localHTTPS(let p12, let password, _):
            params = try InstallServer.tlsParameters(p12: p12, password: password)
        case .remoteManifest:
            params = .tcp
        }
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] conn in
            Task { @MainActor in self?.handle(conn) }
        }
        l.start(queue: .global(qos: .userInitiated))
        listener = l
        // Wait briefly for the port to be assigned.
        var waited = 0
        while l.port?.rawValue == nil && waited < 50 {
            usleep(20_000); waited += 1
        }
        guard let port = l.port?.rawValue else {
            throw SignKitError.io("the phone would not give us a port to serve on")
        }
        return port
    }

    private func handle(_ conn: NWConnection) {
        connections.append(conn)
        conn.start(queue: .global(qos: .userInitiated))
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else {
                conn.cancel(); return
            }
            let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            Task { @MainActor in self.respond(to: path, on: conn) }
        }
    }

    private func respond(to path: String, on conn: NWConnection) {
        func send(_ body: Data, _ type: String) {
            var head = "HTTP/1.1 200 OK\r\n"
            head += "Content-Type: \(type)\r\n"
            head += "Content-Length: \(body.count)\r\n"
            head += "Connection: close\r\n\r\n"
            conn.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in conn.cancel() })
        }

        switch path {
        case "/manifest.plist":
            note("iOS asked for the app details")
            send(manifest ?? Data(), "application/xml")
        case "/icon.png":
            send(icon ?? Data(), "image/png")
        case "/app.ipa":
            note("iOS is downloading the app")
            stage = .downloading(0)
            if let data = payload {
                var head = "HTTP/1.1 200 OK\r\n"
                head += "Content-Type: application/octet-stream\r\n"
                head += "Content-Length: \(data.count)\r\n"
                head += "Connection: close\r\n\r\n"
                conn.send(content: Data(head.utf8) + data, completion: .contentProcessed { [weak self] _ in
                    conn.cancel()
                    Task { @MainActor in
                        self?.stage = .handedOff
                        self?.note("The app was handed to iOS. Watch the home screen.")
                    }
                })
            } else {
                send(Data(), "application/octet-stream")
            }
        default:
            let body = Data("Signer".utf8)
            send(body, "text/plain")
        }
    }

    // MARK: - helpers

    static func manifest(ipaURL: String, bundleID: String, version: String,
                         title: String, iconURL: String?) -> Data {
        var assets: [[String: Any]] = [[
            "kind": "software-package",
            "url": ipaURL,
        ]]
        if let iconURL {
            assets.append(["kind": "display-image", "needs-shine": false, "url": iconURL])
            assets.append(["kind": "full-size-image", "needs-shine": false, "url": iconURL])
        }
        let plist: [String: Any] = [
            "items": [[
                "assets": assets,
                "metadata": [
                    "bundle-identifier": bundleID,
                    "bundle-version": version,
                    "kind": "software",
                    "title": title,
                ],
            ]],
        ]
        return (try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)) ?? Data()
    }

    static func tlsParameters(p12: Data, password: String) throws -> NWParameters {
        #if canImport(Security)
        let identity = try KeychainTLS.identity(p12: p12, password: password)
        let options = NWProtocolTLS.Options()
        sec_protocol_options_set_local_identity(options.securityProtocolOptions, identity)
        return NWParameters(tls: options)
        #else
        throw SignKitError.unsupported("local HTTPS needs iOS")
        #endif
    }

    private func upload(manifest: Data, to helper: URL) async throws -> String {
        var request = URLRequest(url: helper)
        request.httpMethod = "POST"
        request.setValue("application/xml", forHTTPHeaderField: "Content-Type")
        request.httpBody = manifest
        let (data, response) = try await URLSession.shared.upload(for: request, from: manifest)
        guard let http = response as? HTTPURLResponse, http.statusCode / 100 == 2,
              let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              text.hasPrefix("https://") else {
            throw SignKitError.io("the helper site would not take the app details")
        }
        return text
    }

    @MainActor
    private func open(_ link: String) async {
        #if canImport(UIKit)
        if let url = URL(string: link) {
            await UIApplication.shared.open(url)
        }
        #endif
    }

    private func note(_ s: String) {
        log.append(s)
        if log.count > 200 { log.removeFirst(log.count - 200) }
    }

    private func friendly(_ e: Error) -> String {
        (e as? SignKitError)?.description ?? e.localizedDescription
    }
}

#if canImport(UIKit)
import UIKit
#endif
