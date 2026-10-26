import XCTest
@testable import SignKit

final class OCSPTests: XCTestCase {
    /// Builds an answer the way a responder would, then reads it back.
    func makeResponse(statusTag: UInt8, revokedAt: Date? = nil) -> Data {
        let certID = DER.seq([
            .seq([.oid(OID.sha1), .null]),
            .octets(Data(repeating: 1, count: 20)),
            .octets(Data(repeating: 2, count: 20)),
            .int(Data([0x42])),
        ])
        let status: DER
        switch statusTag {
        case 0x80: status = .raw(Data([0x80, 0x00]))                       // good
        case 0xa1: status = .tagged(1, [.genTime(revokedAt ?? Date())])    // revoked
        default: status = .raw(Data([0x82, 0x00]))                         // unknown
        }
        let single = DER.seq([certID, status, .genTime(Date())])
        let tbs = DER.seq([
            .tagged(2, [.octets(Data(repeating: 9, count: 20))]),
            .genTime(Date()),
            .seq([single]),
        ])
        let basic = DER.seq([tbs, .seq([.oid(OID.sha256WithRSA), .null]), .bits(Data(repeating: 7, count: 32))])
        return DER.seq([
            .intValue(0),
            .tagged(0, [.seq([.oid(OID.ocspBasic), .octets(basic.encoded)])]),
        ]).encoded
    }

    func testReadsGoodAnswer() throws {
        let answer = try OCSP.parse(makeResponse(statusTag: 0x80))
        XCTAssertEqual(answer.status, .good)
        XCTAssertNil(answer.revokedAt)
        XCTAssertFalse(answer.detail.isEmpty)
    }

    func testReadsRevokedAnswer() throws {
        let when = Date(timeIntervalSince1970: 1_700_000_000)
        let answer = try OCSP.parse(makeResponse(statusTag: 0xa1, revokedAt: when))
        XCTAssertEqual(answer.status, .revoked)
        XCTAssertEqual(answer.revokedAt?.timeIntervalSince1970 ?? 0, when.timeIntervalSince1970, accuracy: 1)
        XCTAssertTrue(answer.detail.lowercased().contains("switched"), answer.detail)
    }

    func testReadsUnknownAnswer() throws {
        XCTAssertEqual(try OCSP.parse(makeResponse(statusTag: 0x82)).status, .unknown)
    }

    func testRefusedResponseIsNotTreatedAsGood() throws {
        let refused = DER.seq([.intValue(6)]).encoded       // 6 = unauthorized
        let answer = try OCSP.parse(refused)
        XCTAssertEqual(answer.status, .unknown)
    }

    /// The request is built from a real Apple certificate taken out of a shipping app's profile.
    func testBuildsRequestFromRealCertificate() throws {
        let path = "/projects/sandbox/research/ipa/x/ESign/Payload/ESign.app/embedded.mobileprovision"
        guard FileManager.default.fileExists(atPath: path) else { throw XCTSkip("no profile here") }
        let profile = try ProvisioningProfile(url: URL(fileURLWithPath: path))
        let cert = try XCTUnwrap(profile.certificates.first)
        // A real Apple signing certificate says where to check it.
        XCTAssertNotNil(cert.ocspURL, "an Apple certificate must carry its check address")
        XCTAssertTrue(cert.ocspURL?.host?.contains("apple.com") ?? false, cert.ocspURL?.absoluteString ?? "-")

        // Using the certificate as its own issuer is enough to check the shape of the request.
        let req = try OCSP.request(certificate: cert, issuer: cert)
        let node = try DERNode.parse(req)
        let certID = try XCTUnwrap(node.child(0)?.child(0)?.child(0)?.child(0))
        XCTAssertEqual(certID.child(0)?.child(0)?.oid, OID.sha1)
        XCTAssertEqual(certID.child(1)?.content.count, 20, "issuer name hash")
        XCTAssertEqual(certID.child(2)?.content.count, 20, "issuer key hash")
        XCTAssertEqual(certID.child(3)?.unsignedInteger, cert.serial)
    }

    /// A certificate that arrived on its own, with no issuer beside it: the issuer has to be
    /// found among Apple's own certificates, or the question built for Apple is meaningless and
    /// the answer comes back "unknown" (which is what the owner saw as "Unchecked").
    func testFindsTheIssuerForACertificateThatCameAlone() throws {
        let path = "/projects/sandbox/research/ipa/x/GBox/Payload/GBox.app/embedded.mobileprovision"
        guard FileManager.default.fileExists(atPath: path) else { throw XCTSkip("no profile here") }
        let profile = try ProvisioningProfile(url: URL(fileURLWithPath: path))
        let leaf = try XCTUnwrap(profile.certificates.first)

        // Nothing but the certificate itself, the way a "created via API" .p12 exports.
        let issuer = try XCTUnwrap(AppleChain.issuer(of: leaf, in: AppleChain.known),
                                   "Apple's own certificates are built in; the issuer must be found")
        XCTAssertEqual(issuer.subjectDER, leaf.issuerDER)
        XCTAssertNotEqual(issuer.der, leaf.der, "the certificate is not its own issuer")

        // And the question for Apple is built from that issuer, not from the certificate.
        let body = try OCSP.request(certificate: leaf, issuer: issuer)
        XCTAssertGreaterThan(body.count, 40)
        let wrong = try OCSP.request(certificate: leaf, issuer: leaf)
        XCTAssertNotEqual(body, wrong, "a wrong issuer must not produce the same question")
    }
}
