import Foundation
import Security
import SignKit

/// Installing an app the way the Finder does, with a pairing file, instead of handing iOS a
/// details file over HTTPS. Tenth on docs/FEATURES.md - SideStore's route.
///
/// What happens: say hello to iOS's own install service, start a session using the pairing
/// file, put the `.ipa` in the phone's staging folder through the file service, then tell the
/// installer to install it from there. Every step says what it is doing in plain words, because
/// when this goes wrong it is usually at a particular step and that is the useful thing to know.
@MainActor
final class DeviceInstaller: ObservableObject {
    @Published var step = ""
    @Published var fraction: Double = 0
    @Published var problem: String?
    @Published var done = false
    @Published var busy = false
    /// What the service said when we only asked who it was.
    @Published var sawService: String?

    static let hostKey = "pairingHost"
    static let portKey = "pairingPort"
    static let fileKey = "pairingFileName"

    static var host: String {
        UserDefaults.standard.string(forKey: hostKey) ?? "127.0.0.1"
    }
    static var port: UInt16 {
        let saved = UserDefaults.standard.integer(forKey: portKey)
        return saved > 0 ? UInt16(saved) : 62078
    }
    /// Where the pairing file is kept once imported.
    static var pairingURL: URL { Paths.root.appendingPathComponent("pairing.plist") }

    static var hasPairingFile: Bool {
        FileManager.default.fileExists(atPath: pairingURL.path)
    }

    static func pairing() throws -> PairingFile {
        try PairingFile(data: try Data(contentsOf: pairingURL))
    }

    /// Asks the service who it is and nothing more. Safe, quick, and the thing to try first.
    func check() async {
        busy = true
        problem = nil
        sawService = nil
        step = "Saying hello to iOS's install service…"
        let host = DeviceInstaller.host
        let port = DeviceInstaller.port
        let outcome: (String?, String?) = await Task.detached(priority: .userInitiated) {
            let client = LockdownClient()
            defer { client.close() }
            do {
                try client.connect(host: host, port: port)
                let answer = try client.ask(LockdownWire.queryType())
                if let type = answer["Type"] as? String { return (type, nil) }
                if let error = LockdownWire.error(in: answer) { return (nil, error) }
                return (nil, "it answered something unexpected")
            } catch {
                return (nil, (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
        }.value
        busy = false
        step = ""
        if let type = outcome.0 {
            sawService = type
        } else {
            problem = outcome.1
        }
    }

    /// The whole thing.
    func install(ipa: URL, bundleID: String) async {
        guard !busy else { return }
        busy = true
        done = false
        problem = nil
        fraction = 0
        KeepAwake.shared.begin("installing")
        defer {
            KeepAwake.shared.end()
            busy = false
        }

        let pairing: PairingFile
        do {
            pairing = try DeviceInstaller.pairing()
        } catch {
            problem = "That pairing file could not be read. Import it again on the File tab."
            return
        }

        let host = DeviceInstaller.host
        let port = DeviceInstaller.port
        let name = "signer-\(UUID().uuidString.prefix(8)).ipa"
        let size = fileSize(of: ipa)

        step = "Talking to iOS's install service…"
        let stream = AsyncStream<Progress> { continuation in
            Task.detached(priority: .userInitiated) {
                let result = DeviceInstaller.run(ipa: ipa, remoteName: name, size: size,
                                                 bundleID: bundleID, pairing: pairing,
                                                 host: host, port: port) { progress in
                    continuation.yield(progress)
                }
                continuation.yield(result)
                continuation.finish()
            }
        }
        for await progress in stream {
            switch progress {
            case .step(let words, let amount):
                step = words
                if let amount { fraction = amount }
            case .finished:
                step = "iOS has it. Watch the home screen."
                fraction = 1
                done = true
            case .failed(let reason):
                problem = reason
                step = ""
            }
        }
    }

    enum Progress: Sendable {
        case step(String, Double?)
        case finished
        case failed(String)
    }

    /// Everything that talks to the phone, off the main thread.
    nonisolated static func run(ipa: URL, remoteName: String, size: Int, bundleID: String,
                                pairing: PairingFile, host: String, port: UInt16,
                                report: @escaping @Sendable (Progress) -> Void) -> Progress {
        let lockdown = LockdownClient()
        defer { lockdown.close() }
        var cleanups: [() -> Void] = []
        defer { cleanups.forEach { $0() } }

        do {
            report(.step("Talking to iOS's install service…", 0.02))
            try lockdown.connect(host: host, port: port)
            let hello = try lockdown.ask(LockdownWire.queryType())
            guard (hello["Type"] as? String)?.contains("lockdown") == true else {
                return .failed("Whatever answered at \(host):\(port) is not iOS's install service.")
            }

            report(.step("Showing iOS the pairing file…", 0.05))
            let session = try lockdown.ask(LockdownWire.startSession(hostID: pairing.hostID,
                                                                     systemBUID: pairing.systemBUID))
            if let error = LockdownWire.error(in: session) {
                return .failed(DeviceInstaller.plainWords(for: error))
            }

            var identity: SecIdentity?
            if LockdownWire.needsTLS(session) {
                report(.step("Setting up the secure link…", 0.08))
                let made = try PairingIdentity.make(from: pairing)
                identity = made.identity
                cleanups.append(made.cleanup)
                try lockdown.startTLS(identity: made.identity)
            }

            // The file service, on its own port.
            report(.step("Opening the phone's file area…", 0.1))
            let afcService = try lockdown.ask(LockdownWire.startService("com.apple.afc"))
            if let error = LockdownWire.error(in: afcService) {
                return .failed(DeviceInstaller.plainWords(for: error))
            }
            guard let afcPort = (afcService["Port"] as? NSNumber)?.uint16Value else {
                return .failed("iOS did not say where its file service is.")
            }
            let afc = LockdownClient()
            defer { afc.close() }
            try afc.connect(host: host, port: afcPort)
            if (afcService["EnableServiceSSL"] as? Bool) == true, let identity {
                try afc.startTLS(identity: identity)
            }

            // Put the app in the staging folder, a megabyte at a time.
            var packet: UInt64 = 0
            packet += 1
            try afc.sendRaw(AFC.makeDirectory(path: AFC.stagingFolder, packetNumber: packet))
            _ = try? afc.afcAnswer()

            packet += 1
            let remotePath = "\(AFC.stagingFolder)/\(remoteName)"
            try afc.sendRaw(AFC.openForWriting(path: remotePath, packetNumber: packet))
            let opened = try afc.afcAnswer()
            guard let fileHandle = opened.handle else {
                return .failed("iOS would not let a file be written to its staging folder.")
            }

            guard let reading = try? FileHandle(forReadingFrom: ipa) else {
                return .failed("The signed app file went missing.")
            }
            defer { try? reading.close() }
            var sent = 0
            let chunkSize = 1 << 20
            while true {
                let chunk = autoreleasepool { reading.readData(ofLength: chunkSize) }
                if chunk.isEmpty { break }
                packet += 1
                try afc.sendRaw(AFC.write(handle: fileHandle, bytes: chunk, packetNumber: packet))
                let status = try afc.afcAnswer()
                if let code = status.status, code != 0 {
                    return .failed("iOS stopped taking the app at \(sent) bytes (code \(code)).")
                }
                sent += chunk.count
                if size > 0 {
                    let share = Double(sent) / Double(size)
                    report(.step("Copying the app to the phone…", 0.1 + share * 0.75))
                }
            }
            packet += 1
            try afc.sendRaw(AFC.close(handle: fileHandle, packetNumber: packet))
            _ = try? afc.afcAnswer()
            afc.close()

            // And install it from there.
            report(.step("Asking iOS to install it…", 0.88))
            let installService = try lockdown.ask(
                LockdownWire.startService("com.apple.mobile.installation_proxy"))
            if let error = LockdownWire.error(in: installService) {
                return .failed(DeviceInstaller.plainWords(for: error))
            }
            guard let installPort = (installService["Port"] as? NSNumber)?.uint16Value else {
                return .failed("iOS did not say where its installer is.")
            }
            let installer = LockdownClient()
            defer { installer.close() }
            try installer.connect(host: host, port: installPort)
            if (installService["EnableServiceSSL"] as? Bool) == true, let identity {
                try installer.startTLS(identity: identity)
            }
            try installer.tell(LockdownWire.install(packagePath: remotePath, bundleID: bundleID))

            // It talks as it works: a percentage, then either Complete or an error.
            while true {
                let message = try installer.next()
                if let error = message["Error"] as? String {
                    let detail = message["ErrorDescription"] as? String
                    return .failed(detail ?? DeviceInstaller.plainWords(for: error))
                }
                if let percent = (message["PercentComplete"] as? NSNumber)?.doubleValue {
                    report(.step("iOS is installing it… \(Int(percent))%", 0.88 + percent / 100 * 0.12))
                }
                if let status = message["Status"] as? String {
                    if status == "Complete" { return .finished }
                    report(.step("iOS: \(status)", nil))
                }
            }
        } catch {
            let words = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return .failed(words)
        }
    }

    /// iOS's own words for what went wrong, in ordinary ones.
    nonisolated static func plainWords(for error: String) -> String {
        switch error {
        case "InvalidHostID":
            return "iOS does not recognise this pairing file. It was made for a different phone, "
                + "or the phone has forgotten it - make a new one."
        case "SessionActive":
            return "A session is already open. Close Signer and try again."
        case "PasswordProtected":
            return "Unlock the phone and try again."
        case "InvalidService", "ServiceProhibited":
            return "iOS would not start the service this needs."
        case "ApplicationVerificationFailed":
            return "iOS refused the app's signature. Sign it again with a certificate that is "
                + "still good."
        case "DeviceOSVersionTooLow":
            return "The app needs a newer iOS than this phone has."
        default:
            return "iOS said: \(error)."
        }
    }
}
