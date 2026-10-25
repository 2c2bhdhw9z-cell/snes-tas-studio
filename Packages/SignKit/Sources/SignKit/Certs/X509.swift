import Foundation

/// Reads the parts of an X.509 certificate that a signer actually needs.
public struct Certificate {
    public let der: Data
    public let tbs: Data                  // the signed part, needed for OCSP and chain checks
    public let serial: Data
    public let issuerDER: Data
    public let subjectDER: Data
    public let notBefore: Date?
    public let notAfter: Date?
    public let publicKeyDER: Data         // SubjectPublicKeyInfo
    public let subject: [String: String]
    public let issuer: [String: String]
    public let extensions: [String: Data]

    public init(der: Data) throws {
        self.der = der
        let cert = try DERNode.parse(der)
        guard let tbsNode = cert.child(0) else { throw SignKitError.malformed("certificate has no body") }
        tbs = tbsNode.raw
        var c = tbsNode.children
        // Optional [0] version
        if let first = c.first, first.tagClass == 0x80 { c.removeFirst() }
        guard c.count >= 6 else { throw SignKitError.malformed("certificate body is too short") }
        serial = c[0].unsignedInteger
        issuerDER = c[2].raw
        subjectDER = c[4].raw
        notBefore = c[3].child(0)?.date
        notAfter = c[3].child(1)?.date
        publicKeyDER = c[5].raw
        subject = Certificate.name(c[4])
        issuer = Certificate.name(c[2])
        var ext = [String: Data]()
        if c.count > 6, let extNode = c.dropFirst(6).first(where: { $0.tag == 0xa3 }) {
            for e in extNode.children.first?.children ?? [] {
                if let oid = e.child(0)?.oid {
                    ext[oid] = e.children.last?.content
                }
            }
        }
        extensions = ext
    }

    static func name(_ node: DERNode) -> [String: String] {
        var out = [String: String]()
        for rdn in node.children {
            for pair in rdn.children {
                if let oid = pair.child(0)?.oid, let v = pair.child(1)?.string {
                    out[oid] = v
                }
            }
        }
        return out
    }

    /// "Apple Development: Name (TEAMID)" or "iPhone Distribution: Company".
    public var commonName: String { subject[OID.commonName] ?? "" }
    /// The ten-character team ID Apple puts in the OU field.
    public var teamID: String? { subject[OID.orgUnit] }
    public var organization: String? { subject[OID.organization] }
    /// Apple puts the developer's Apple ID in the UID field.
    public var appleID: String? { subject[OID.userID] }

    public var isExpired: Bool {
        guard let na = notAfter else { return false }
        return na < Date()
    }
    public var daysLeft: Int? {
        guard let na = notAfter else { return nil }
        return Int(na.timeIntervalSinceNow / 86400)
    }

    /// A certificate that vouches for itself: a root.
    public var isSelfIssued: Bool { subjectDER == issuerDER }

    /// The identifier of this certificate's own key.
    public var subjectKeyID: Data? {
        guard let raw = extensions[OID.subjectKeyIdentifier],
              let node = try? DERNode.parse(raw), node.tag == 0x04 else { return nil }
        return node.content
    }

    /// The identifier of the key that signed this certificate.
    public var authorityKeyID: Data? {
        guard let raw = extensions[OID.authorityKeyIdentifier],
              let seq = try? DERNode.parse(raw),
              let id = seq.children.first(where: { $0.tag == 0x80 }) else { return nil }
        return id.content
    }

    /// Checks whether `issuer`'s key produced this certificate's signature.
    /// Only RSA issuers can be checked; anything else returns nil (unknown).
    public func isSigned(by issuer: Certificate) -> Bool? {
        guard let top = try? DERNode.parse(der), top.children.count >= 3,
              let algoOID = top.children[1].child(0)?.oid else { return nil }
        let kind: HashKind
        switch algoOID {
        case OID.sha256WithRSA: kind = .sha256
        case OID.sha1WithRSA: kind = .sha1
        default: return nil
        }
        guard (try? RSAPrivateKey.publicModulus(spki: issuer.publicKeyDER)) != nil else { return nil }
        return RSAPrivateKey.verify(signature: top.children[2].bitString, message: tbs, kind,
                                    spki: issuer.publicKeyDER)
    }

    /// Where to ask Apple whether this certificate has been pulled.
    public var ocspURL: URL? {
        guard let aia = extensions[OID.authorityInfoAccess],
              let seq = try? DERNode.parse(aia) else { return nil }
        for d in seq.children {
            if d.child(0)?.oid == OID.ocsp, let loc = d.child(1),
               let s = String(data: loc.content, encoding: .utf8) {
                return URL(string: s)
            }
        }
        return nil
    }

    public var sha1Fingerprint: String { sha1(der).hex }
    public var sha256Fingerprint: String { sha256(der).hex }
}

public enum PEM {
    /// Pulls out every DER block of the given type from a PEM text file.
    public static func blocks(_ text: String, type: String? = nil) -> [Data] {
        var out = [Data]()
        var collecting = false
        var b64 = ""
        var currentType = ""
        for line in text.split(whereSeparator: \.isNewline) {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("-----BEGIN") {
                currentType = l.replacingOccurrences(of: "-----BEGIN ", with: "")
                    .replacingOccurrences(of: "-----", with: "")
                collecting = true
                b64 = ""
            } else if l.hasPrefix("-----END") {
                collecting = false
                if type == nil || currentType.contains(type!), let d = Data(base64Encoded: b64) {
                    out.append(d)
                }
            } else if collecting {
                b64 += l
            }
        }
        return out
    }

    public static func first(_ text: String, type: String? = nil) -> Data? {
        blocks(text, type: type).first
    }

    public static func encode(_ der: Data, type: String) -> String {
        let b = der.base64EncodedString()
        var lines = [String]()
        var i = b.startIndex
        while i < b.endIndex {
            let j = b.index(i, offsetBy: 64, limitedBy: b.endIndex) ?? b.endIndex
            lines.append(String(b[i..<j]))
            i = j
        }
        return "-----BEGIN \(type)-----\n" + lines.joined(separator: "\n") + "\n-----END \(type)-----\n"
    }
}
