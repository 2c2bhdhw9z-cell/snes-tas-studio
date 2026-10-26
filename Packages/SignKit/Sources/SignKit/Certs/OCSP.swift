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
            // Apple's own words for the refusal, so the screen can say which one it was.
            let why: String
            switch responseStatus {
            case 1: why = "it said the question was malformed"
            case 2: why = "it hit an error of its own"
            case 3: why = "it asked to be tried again later"
            case 5: why = "it wants the question signed"
            case 6: why = "it will not answer about this certificate (unauthorised)"
            default: why = "it answered with code \(responseStatus)"
            }
            return Answer(status: .unknown, revokedAt: nil, checkedAt: Date(),
                          detail: "Apple would not answer: \(why). The certificate may still be fine; "
                                + "this only means Apple did not say.")
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

    /// The whole check, finding the certificate's real issuer itself: among the certificates that
    /// came with it, then among Apple's own, which are built in.
    ///
    /// A `.p12` exported as "created via API" usually holds the certificate alone, with no issuer
    /// beside it. A question built against the wrong issuer comes back "unknown" from Apple, which
    /// looks exactly like a check that never ran — the owner's certificate stayed "Unchecked"
    /// (26 October).
    public static func check(certificate: Certificate, chain: [Certificate] = [],
                             session: URLSession = .shared) async -> Answer {
        let pool = chain.filter { $0.der != certificate.der } + AppleChain.known
        var found = AppleChain.issuer(of: certificate, in: pool)
        // Not one of the Apple certificates built in: the certificate says where its issuer can
        // be downloaded, so a brand new Apple issuer works without waiting for an app update.
        if found == nil, let url = certificate.caIssuersURL,
           let downloaded = try? await session.data(from: url).0,
           let issuer = try? Certificate(der: downloaded), issuer.subjectDER == certificate.issuerDER {
            found = issuer
        }
        guard let issuer = found else {
            return Answer(status: .unknown, revokedAt: nil, checkedAt: Date(),
                          detail: "The Apple certificate that issued this one could not be found, "
                                + "so there is nothing to ask about")
        }
        return await check(certificate: certificate, issuer: issuer, session: session)
    }

    /// Does the whole check over the network against a known issuer.
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
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                return Answer(status: .unreachable, revokedAt: nil, checkedAt: Date(),
                              detail: "Apple's checking service answered \(code) instead of an answer "
                                    + "(\(url.host ?? url.absoluteString))")
            }
            return try parse(data)
        } catch let error as SignKitError {
            return Answer(status: .unknown, revokedAt: nil, checkedAt: Date(),
                          detail: "Apple's answer could not be read: \(error.description)")
        } catch {
            return Answer(status: .unreachable, revokedAt: nil, checkedAt: Date(),
                          detail: "Could not reach Apple to check: \(error.localizedDescription)")
        }
    }
}
