import Foundation
import Network
import SignKit
#if canImport(UIKit)
import UIKit
#endif

/// Reads this phone's device ID (its "UDID") without a computer.
///
/// The trick, which ESign also uses: the app runs a tiny web server, hands iOS a
/// configuration profile that asks for the device ID, and iOS posts the answer back
/// to that server. Nothing leaves the phone — the address in the profile is 127.0.0.1.
@MainActor
final class UDIDReader: ObservableObject {
    @Published var udid: String?
    @Published var serial: String?
    @Published var isWaiting = false
    @Published var error: String?

    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private let port: UInt16 = 14_302

    func start() async {
        stop()
        error = nil
        isWaiting = true
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            guard let nwPort = NWEndpoint.Port(rawValue: port) else { return }
            let l = try NWListener(using: params, on: nwPort)
            l.newConnectionHandler = { [weak self] conn in
                Task { @MainActor in self?.handle(conn) }
            }
            l.start(queue: .global(qos: .userInitiated))
            listener = l
            #if canImport(UIKit)
            if let url = URL(string: "http://127.0.0.1:\(port)/profile") {
                await UIApplication.shared.open(url)
            }
            #endif
        } catch {
            isWaiting = false
            self.error = "Could not start the local reader: \(error.localizedDescription)"
        }
    }

    func stop() {
        listener?.cancel(); listener = nil
        connections.forEach { $0.cancel() }
        connections.removeAll()
        isWaiting = false
    }

    private func handle(_ conn: NWConnection) {
        connections.append(conn)
        conn.start(queue: .global(qos: .userInitiated))
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, _ in
            guard let self else { return }
            var all = buffer
            if let data { all.append(data) }
            let text = String(data: all.prefix(2048), encoding: .utf8) ?? ""
            let isPost = text.hasPrefix("POST")
            // Keep reading a POST until the body has arrived.
            if isPost, !complete, !all.contains(Data("</plist>".utf8)) {
                Task { @MainActor in self.receive(conn, buffer: all) }
                return
            }
            Task { @MainActor in self.respond(request: text, body: all, on: conn) }
        }
    }

    private func respond(request: String, body: Data, on conn: NWConnection) {
        func reply(_ data: Data, _ type: String) {
            var head = "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\n"
            head += "Content-Length: \(data.count)\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(head.utf8) + data, completion: .contentProcessed { _ in conn.cancel() })
        }

        if request.hasPrefix("POST") {
            // iOS posts a signed plist; the values we want sit inside it.
            if let start = body.find(Data("<?xml".utf8)),
               let end = body.find(Data("</plist>".utf8), from: start) {
                let plistData = body.sub(start, end + 8 - start)
                if let dict = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any] {
                    udid = dict["UDID"] as? String
                    serial = dict["SERIAL"] as? String
                    isWaiting = false
                }
            }
            reply(Data("<html><body>Done. Go back to Signer.</body></html>".utf8), "text/html")
            stop()
            return
        }

        if request.contains("/profile") {
            reply(UDIDReader.profile(port: port), "application/x-apple-aspen-config")
            return
        }
        reply(Data("Signer".utf8), "text/plain")
    }

    /// The configuration profile that asks iOS for the device ID.
    static func profile(port: UInt16) -> Data {
        let plist: [String: Any] = [
            "PayloadType": "Profile Service",
            "PayloadIdentifier": "com.continuum.signer.udid",
            "PayloadUUID": UUID().uuidString,
            "PayloadVersion": 1,
            "PayloadDisplayName": "Read this phone's ID",
            "PayloadDescription": "Sends this phone's ID back to the Signer app on this phone. Nothing leaves the device.",
            "PayloadOrganization": "Signer",
            "PayloadContent": [
                "URL": "http://127.0.0.1:\(port)/udid",
                "DeviceAttributes": ["UDID", "SERIAL", "PRODUCT", "VERSION"],
            ],
        ]
        return (try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)) ?? Data()
    }
}
