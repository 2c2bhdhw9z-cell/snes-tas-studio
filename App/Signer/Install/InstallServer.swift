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
    /// The helper that serves the tiny details file over HTTPS. It only ever sees the
    /// app's name, its ID and a link back to this phone.
    static let defaultHelper = "https://api.palera.in/genPlist"
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
    private var payloadURL: URL?
    private var payloadSize = 0
    private var manifest: Data?
    private var icon: Data?
    private var port: UInt16 = 0
    private var bytesSent = 0
    private var connections: [NWConnection] = []
    private var keepingAwake = false

    /// How the manifest reaches iOS.
    enum Route {
        /// Everything local: the phone serves the manifest too. Needs a `.p12` web
        /// certificate for a name that points back at this phone (127.0.0.1).
        case localHTTPS(p12: Data, password: String, host: String)
        /// The app is served from the phone; only the tiny details file comes from a
        /// helper address over HTTPS, because iOS insists on HTTPS for that one file.
        case helper(URL)
    }

    func start(ipa: URL, bundleID: String, version: String, title: String,
               iconPNG: Data?, route: Route) async {
        stop()
        KeepAwake.shared.begin("installing")
        keepingAwake = true
        do {
            payloadURL = ipa
            payloadSize = (try? FileManager.default.attributesOfItem(atPath: ipa.path)[.size] as? Int) ?? 0
            icon = iconPNG
            let p = try await startListener(route: route)
            port = p
            let base: String
            switch route {
            case .localHTTPS(_, _, let host): base = "https://\(host):\(p)"
            case .helper: base = "http://127.0.0.1:\(p)"
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
            case .helper(let helper):
                // The helper is handed a link back to this phone; the app never leaves it.
                manifestURL = try await helperManifestURL(helper, ipaURL: "\(base)/app.ipa",
                                                          bundleID: bundleID, version: version, title: title)
            }
            let link = "itms-services://?action=download-manifest&url="
                + manifestURL.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
            stage = .askedIOS
            note("Asked iOS to install")
            await open(link)
        } catch {
            stage = .failed(friendly(error))
            note("Could not start: \(friendly(error))")
            stop()
        }
    }

    func stop() {
        if keepingAwake {
            KeepAwake.shared.end()
            keepingAwake = false
        }
        listener?.cancel()
        listener = nil
        connections.forEach { $0.cancel() }
        connections.removeAll()
        payloadURL = nil
        manifest = nil
        bytesSent = 0
    }

    // MARK: - the server

    private func startListener(route: Route) async throws -> UInt16 {
        let params: NWParameters
        switch route {
        case .localHTTPS(let p12, let password, _):
            params = try InstallServer.tlsParameters(p12: p12, password: password)
        case .helper:
            params = .tcp
        }
        params.allowLocalEndpointReuse = true

        // A fixed, known port (with a few spares) rather than "any port". Before the
        // listener is ready, iOS reports its port as 0, and build 16 handed iOS
        // "127.0.0.1:0" — an address nothing listens on. Now we only carry on once
        // the listener says it is ready, and the port is one we chose ourselves.
        var lastError: Error?
        for candidate in InstallServer.ports {
            guard let port = NWEndpoint.Port(rawValue: candidate) else { continue }
            do {
                let l = try NWListener(using: params, on: port)
                l.newConnectionHandler = { [weak self] conn in
                    Task { @MainActor in self?.handle(conn) }
                }
                if try await InstallServer.waitUntilReady(l) {
                    listener = l
                    return candidate
                }
                l.cancel()
            } catch {
                lastError = error
            }
        }
        throw SignKitError.io("the phone would not let Signer serve the app"
                              + (lastError.map { " (\($0.localizedDescription))" } ?? ""))
    }

    /// Ports tried in order. Several, in case another app is already using one.
    static let ports: [UInt16] = [41_234, 41_235, 41_236, 52_731, 52_732, 60_101]

    /// Starts the listener and waits until it is actually accepting connections.
    /// Returns false if that port could not be used.
    static func waitUntilReady(_ listener: NWListener) async throws -> Bool {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Bool, Error>) in
            let once = OnceFlag()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if once.claim() { cont.resume(returning: true) }
                case .failed, .cancelled:
                    if once.claim() { cont.resume(returning: false) }
                case .waiting:
                    // Port busy or not allowed: give up on this one, try the next.
                    if once.claim() { cont.resume(returning: false) }
                default:
                    break
                }
            }
            listener.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                if once.claim() { cont.resume(returning: false) }
            }
        }
    }

    private func handle(_ conn: NWConnection) {
        connections.append(conn)
        conn.start(queue: .global(qos: .userInitiated))
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else {
                conn.cancel(); return
            }
            let firstLine = request.split(separator: "\n").first.map(String.init) ?? "GET / HTTP/1.1"
            let pieces = firstLine.split(separator: " ")
            let method = pieces.first.map(String.init) ?? "GET"
            let path = pieces.count > 1 ? String(pieces[1]) : "/"
            Task { @MainActor in self.respond(method: method, to: path, request: request, on: conn) }
        }
    }

    private func respond(method: String, to path: String, request: String, on conn: NWConnection) {
        func send(_ body: Data, _ type: String) {
            var head = "HTTP/1.1 200 OK\r\n"
            head += "Content-Type: \(type)\r\n"
            head += "Content-Length: \(body.count)\r\n"
            head += "Connection: close\r\n\r\n"
            let content = method == "HEAD" ? Data(head.utf8) : Data(head.utf8) + body
            conn.send(content: content, completion: .contentProcessed { _ in conn.cancel() })
        }

        switch path {
        case "/manifest.plist":
            note("iOS asked for the app details")
            send(manifest ?? Data(), "application/xml")
        case "/icon.png":
            send(icon ?? Data(), "image/png")
        case "/app.ipa":
            note(method == "HEAD" ? "iOS checked the app's size" : "iOS is downloading the app")
            if method != "HEAD" { stage = .downloading(0) }
            sendPayload(on: conn, request: request, headOnly: method == "HEAD")
        default:
            let body = Data("Signer".utf8)
            send(body, "text/plain")
        }
    }

    /// Sends the app a megabyte at a time, so even a very large app never has to sit
    /// in memory all at once.
    private func sendPayload(on conn: NWConnection, request: String, headOnly: Bool) {
        guard let url = payloadURL, let handle = try? FileHandle(forReadingFrom: url) else {
            conn.cancel()
            stage = .failed("The signed app file went missing")
            KeepAwake.shared.end()
            return
        }
        let requested = byteRange(in: request, total: payloadSize)
        let start = requested?.lowerBound ?? 0
        let end = requested?.upperBound ?? max(0, payloadSize - 1)
        var remaining = max(0, end - start + 1)
        try? handle.seek(toOffset: UInt64(start))

        var head = requested == nil ? "HTTP/1.1 200 OK\r\n" : "HTTP/1.1 206 Partial Content\r\n"
        head += "Content-Type: application/octet-stream\r\n"
        head += "Accept-Ranges: bytes\r\n"
        head += "Content-Length: \(remaining)\r\n"
        if requested != nil { head += "Content-Range: bytes \(start)-\(end)/\(payloadSize)\r\n" }
        head += "Connection: close\r\n\r\n"
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
        if headOnly {
            try? handle.close()
            conn.send(content: nil, isComplete: true, completion: .contentProcessed { _ in conn.cancel() })
            return
        }

        let chunkSize = 1 << 20
        var sent = 0
        func pump() {
            let chunk = handle.readData(ofLength: min(chunkSize, remaining))
            if chunk.isEmpty || remaining == 0 {
                try? handle.close()
                conn.send(content: nil, isComplete: true, completion: .contentProcessed { _ in conn.cancel() })
                Task { @MainActor in
                    // A partial request may be followed by another one. Only call it
                    // handed off once iOS reached the end of the app.
                    if end + 1 >= self.payloadSize {
                        self.stage = .handedOff
                        self.note("The app was handed to iOS. Watch the home screen.")
                        self.stop()
                    }
                }
                return
            }
            conn.send(content: chunk, completion: .contentProcessed { [weak self] error in
                guard error == nil else {
                    try? handle.close()
                    conn.cancel()
                    Task { @MainActor in
                        self?.stage = .failed("iOS stopped downloading the app")
                        self?.stop()
                    }
                    return
                }
                remaining -= chunk.count
                sent += chunk.count
                Task { @MainActor in
                    guard let self else { return }
                    self.bytesSent = start + sent
                    if self.payloadSize > 0 {
                        self.stage = .downloading(min(1, Double(self.bytesSent) / Double(self.payloadSize)))
                    }
                    pump()
                }
            })
        }
        pump()
    }

    /// Reads `Range: bytes=start-end`, which iOS uses to resume large downloads.
    private func byteRange(in request: String, total: Int) -> ClosedRange<Int>? {
        guard total > 0 else { return nil }
        for rawLine in request.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.lowercased().hasPrefix("range:") else { continue }
            guard let marker = line.range(of: "bytes=", options: .caseInsensitive) else { return nil }
            let value = line[marker.upperBound...].split(separator: ",").first ?? ""
            let halves = value.split(separator: "-", omittingEmptySubsequences: false)
            guard halves.count == 2 else { return nil }
            if halves[0].isEmpty, let suffix = Int(halves[1]) {
                let start = max(0, total - suffix)
                return start...(total - 1)
            }
            guard let start = Int(halves[0]), start >= 0, start < total else { return nil }
            let end = halves[1].isEmpty ? total - 1 : min(Int(halves[1]) ?? (total - 1), total - 1)
            guard end >= start else { return nil }
            return start...end
        }
        return nil
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

    /// Builds the helper link that serves the details file, and checks it answers.
    private func helperManifestURL(_ helper: URL, ipaURL: String, bundleID: String,
                                   version: String, title: String) async throws -> String {
        var components = URLComponents(url: helper, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "bundleid", value: bundleID),
            URLQueryItem(name: "name", value: title),
            URLQueryItem(name: "version", value: version.isEmpty ? "1.0" : version),
            URLQueryItem(name: "fetchurl", value: ipaURL),
        ]
        guard let url = components?.url else {
            throw SignKitError.io("that helper address does not look right")
        }
        // Make sure it answers before we hand the link to iOS, so a dead helper
        // shows a clear message instead of a spinner that never finishes.
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              data.count > 100, String(data: data.prefix(200), encoding: .utf8)?.contains("plist") == true else {
            throw SignKitError.io("the helper address did not answer properly, so iOS has nothing to read")
        }
        note("The helper is ready")
        return url.absoluteString
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

/// Makes sure a continuation is resumed exactly once, whichever callback fires first.
final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
