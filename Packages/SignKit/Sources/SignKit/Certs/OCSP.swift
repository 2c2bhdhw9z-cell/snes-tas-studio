import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking   // Linux keeps URLSession in a separate module
#endif

/// Asks Apple whether a signing certificate has been switched off ("revoked").
///
/// This is the check that tells you your apps are about to stop opening. Most signers
/// only look at the end date, which is why they say a dead certificate is fine.
public enum OCSP {
    public enum Status: String, Sendable {
        case good, revoked, unknown, unreachable
    }

    public struct Answer: Sendable {
        public let status: Status
        public let revokedAt: Date?
        public let checkedAt: Date
        public let detail: String
    }

    /// Builds the question to send: which certificate, as hashes of its issuer.
    public static func request(certificate: Certificate, issuer: Certificate) throws -> Data {
        let issuerNameHash = sha1(certificate.issuerDER)
        let issuerKey = try DERNode.parse(issuer.publicKeyDER)
        guard let bits = issuerKey.child(1) else { throw SignKitError.malformed("bad issuer key") }
        let issuerKeyHash = sha1(bits.bitString)

        let certID = DER.seq([
            .seq([.oid(OID.sha1), .null]),
            .octets(issuerNameHash),
            .octets(issuerKeyHash),
            .int(certificate.serial),
        ])
        let request = DER.seq([                      // OCSPRequest
            .seq([                                   // tbsRequest
                .seq([                               // requestList
                    .seq([certID]),                  // Request
                ]),
            ]),
        ])
        return request.encoded
    }

    /// Reads Apple's answer.
    public static func parse(_ data: Data) throws -> Answer {
        let top = try DERNode.parse(data)
        guard let statusNode = top.child(0) else { throw SignKitError.malformed("empty answer") }
        let responseStatus = statusNode.intValue
        guard responseStatus == 0 else {
            return Answer(status: .unknown, revokedAt: nil, checkedAt: Date(),
                          detail: "Apple would not answer (code \(responseStatus))")
        }
        // responseBytes [0] -> ResponseBytes -> OCTET STRING -> BasicOCSPResponse
        guard let bytes = top.child(1)?.child(0),
              bytes.child(0)?.oid == OID.ocspBasic,
              let basicOctets = bytes.child(1)?.octets,
              let basic = try? DERNode.parse(basicOctets),
              let tbsResponseData = basic.child(0) else {
            throw SignKitError.malformed("the answer was not in the expected shape")
        }
        // Find the single response entry: SEQUENCE { certID, certStatus, thisUpdate, ... }
        for node in tbsResponseData.children {
            guard node.tag == 0x30 || node.tag == 0xa0 else { continue }
            if let entry = findSingleResponse(node) {
                let statusNode = entry.children[1]
                switch statusNode.tag {
                case 0x80:
                    return Answer(status: .good, revokedAt: nil, checkedAt: Date(),
                                  detail: "Apple says this certificate is still live")
                case 0xa1:
                    let when = statusNode.child(0)?.date
                    return Answer(status: .revoked, revokedAt: when, checkedAt: Date(),
                                  detail: "Apple switched this certificate off"
                                      + (when.map { " on \(DateFormatter.localizedString(from: $0, dateStyle: .medium, timeStyle: .short))" } ?? ""))
                default:
                    return Answer(status: .unknown, revokedAt: nil, checkedAt: Date(),
                                  detail: "Apple did not say either way")
                }
            }
        }
        throw SignKitError.malformed("no answer for this certificate")
    }

    static func findSingleResponse(_ node: DERNode) -> DERNode? {
        // A SingleResponse starts with a CertID sequence and then the status tag.
        if node.tag == 0x30, node.children.count >= 2,
           node.children[0].tag == 0x30,
           [0x80, 0xa1, 0x82].contains(node.children[1].tag) {
            return node
        }
        for c in node.children {
            if let f = findSingleResponse(c) { return f }
        }
        return nil
    }

    /// Does the whole check over the network.
    public static func check(certificate: Certificate, issuer: Certificate,
                             session: URLSession = .shared) async -> Answer {
        if certificate.isExpired {
            return Answer(status: .revoked, revokedAt: certificate.notAfter, checkedAt: Date(),
                          detail: "This certificate ran out on its own")
        }
        guard let url = certificate.ocspURL else {
            return Answer(status: .unknown, revokedAt: nil, checkedAt: Date(),
                          detail: "This certificate does not say where to check")
        }
        do {
            let body = try request(certificate: certificate, issuer: issuer)
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/ocsp-request", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
            req.timeoutInterval = 15
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return Answer(status: .unreachable, revokedAt: nil, checkedAt: Date(),
                              detail: "Could not reach Apple to check")
            }
            return try parse(data)
        } catch {
            return Answer(status: .unreachable, revokedAt: nil, checkedAt: Date(),
                          detail: "Could not reach Apple to check")
        }
    }
}
