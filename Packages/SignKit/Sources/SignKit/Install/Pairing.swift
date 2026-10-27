import Foundation

/// A pairing file: what a computer keeps after a phone has trusted it once.
///
/// Tenth on docs/FEATURES.md. SideStore installs apps this way: instead of handing iOS a
/// details file over HTTPS and hoping, it talks to the service inside iOS that the Finder
/// talks to (lockdownd), which only answers someone holding one of these.
///
/// The file is a plist written by AltStore, SideStore, Jitterbug, pymobiledevice3 or Apple's
/// own tools, holding the certificates the phone agreed to and the two names it knows the
/// computer by.
public struct PairingFile: Sendable {
    public var udid: String?
    public var hostID: String
    public var systemBUID: String
    /// The certificate the phone issued for the computer, with its private key: this is what
    /// proves to the phone that it has met us before.
    public var hostCertificate: Data
    public var hostPrivateKey: Data
    /// The phone's own certificate, and the root that signed both.
    public var deviceCertificate: Data?
    public var rootCertificate: Data?
    public var rootPrivateKey: Data?
    /// The bag that unlocks the phone's data while it is locked. Not needed to install.
    public var escrowBag: Data?
    public var wifiMAC: String?

    public init(data: Data) throws {
        guard let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let dict = plist as? [String: Any] else {
            throw SignKitError.malformed("that is not a pairing file")
        }
        func text(_ key: String) -> String? { dict[key] as? String }
        func bytes(_ key: String) -> Data? {
            if let data = dict[key] as? Data { return data }
            // Some writers put the certificates in as text.
            if let string = dict[key] as? String { return Data(string.utf8) }
            return nil
        }
        guard let hostID = text("HostID") ?? text("hostId"),
              let systemBUID = text("SystemBUID") ?? text("systemBuid") else {
            throw SignKitError.malformed("that pairing file has no host name in it")
        }
        guard let hostCertificate = bytes("HostCertificate"),
              let hostPrivateKey = bytes("HostPrivateKey") else {
            throw SignKitError.malformed("that pairing file has no certificate for this computer")
        }
        self.hostID = hostID
        self.systemBUID = systemBUID
        self.hostCertificate = hostCertificate
        self.hostPrivateKey = hostPrivateKey
        udid = text("UDID") ?? text("udid")
        deviceCertificate = bytes("DeviceCertificate")
        rootCertificate = bytes("RootCertificate")
        rootPrivateKey = bytes("RootPrivateKey")
        escrowBag = dict["EscrowBag"] as? Data
        wifiMAC = text("WiFiMACAddress")
    }

    /// What the file says, in plain words, for the screen.
    public var summary: [String] {
        var out: [String] = []
        if let udid { out.append("Phone: \(udid)") }
        out.append("Host name: \(hostID)")
        if let certificate = try? Certificate(der: hostCertificate) {
            out.append("Certificate: \(certificate.commonName)")
            if let expiry = certificate.notAfter {
                out.append("Ends: \(expiry.formatted(date: .abbreviated, time: .omitted))")
            }
        }
        out.append(escrowBag == nil ? "No escrow bag (fine for installing)" : "Has an escrow bag")
        return out
    }

    /// True when this file is for the phone with that identifier.
    public func isFor(udid wanted: String) -> Bool {
        guard let udid else { return true }
        return udid.compare(wanted, options: .caseInsensitive) == .orderedSame
    }

    /// The certificate as raw bytes, whichever shape the file keeps it in. Most writers use
    /// the text form with the dashed header; iOS wants the bytes.
    public var hostCertificateDER: Data? { PairingFile.der(hostCertificate, type: "CERTIFICATE") }
    public var hostPrivateKeyDER: Data? { PairingFile.der(hostPrivateKey, type: "PRIVATE KEY") }
    public var deviceCertificateDER: Data? {
        deviceCertificate.flatMap { PairingFile.der($0, type: "CERTIFICATE") }
    }
    public var rootCertificateDER: Data? {
        rootCertificate.flatMap { PairingFile.der($0, type: "CERTIFICATE") }
    }

    static func der(_ data: Data, type: String) -> Data? {
        // Already bytes: a DER block starts with 0x30 (a sequence).
        if let first = data.first, first == 0x30 { return data }
        guard let text = String(data: data, encoding: .utf8) else { return data }
        return PEM.first(text, type: type) ?? PEM.first(text) ?? data
    }
}
