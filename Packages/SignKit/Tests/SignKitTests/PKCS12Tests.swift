import XCTest
@testable import SignKit

final class KDFTests: XCTestCase {
    func testPBKDF2RFC6070() {
        // RFC 6070 test vectors for PBKDF2-HMAC-SHA1.
        XCTAssertEqual(KDF.pbkdf2(password: Data("password".utf8), salt: Data("salt".utf8),
                                  iterations: 1, length: 20).hex,
                       "0c60c80f961f0e71f3a9b524af6012062fe037a6")
        XCTAssertEqual(KDF.pbkdf2(password: Data("password".utf8), salt: Data("salt".utf8),
                                  iterations: 4096, length: 20).hex,
                       "4b007901b765489abead49d926f721d065a429c1")
        XCTAssertEqual(KDF.pbkdf2(password: Data("passwordPASSWORDpassword".utf8),
                                  salt: Data("saltSALTsaltSALTsaltSALTsaltSALTsalt".utf8),
                                  iterations: 4096, length: 25).hex,
                       "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038")
    }

    func testPBKDF2SHA256RFC7914() {
        XCTAssertEqual(KDF.pbkdf2(password: Data("passwd".utf8), salt: Data("salt".utf8),
                                  iterations: 1, length: 64, hash: .sha256).hex,
                       "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc"
                       + "49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783")
    }
}

/// The `.p12` file here was made by an independent tool (rcodesign) and uses the
/// classic Apple layout: RC2-40 for the certificates, Triple-DES for the key.
final class PKCS12Tests: XCTestCase {
    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
    static let p12 = dir.appendingPathComponent("testcert.p12")

    func testOpensWithCorrectPassword() throws {
        let p = try PKCS12(url: PKCS12Tests.p12, password: "hunter2")
        XCTAssertEqual(p.certificates.count, 1)
        XCTAssertNotNil(p.privateKey)
        XCTAssertNotNil(p.identity)
        XCTAssertTrue(p.isUsableForSigning, "key and certificate must pair up")
        XCTAssertTrue(p.identity!.commonName.contains("SignKit Test"), p.identity!.commonName)
        XCTAssertEqual(p.privateKey?.n.bitWidth, 2048)
    }

    func testWrongPasswordIsReportedClearly() throws {
        do {
            _ = try PKCS12(url: PKCS12Tests.p12, password: "wrong")
            XCTFail("a wrong password must not open the file")
        } catch let e as SignKitError {
            XCTAssertEqual("\(e)", "Wrong certificate password")
        }
    }

    func testKeyFromP12CanSign() throws {
        let p = try PKCS12(url: PKCS12Tests.p12, password: "hunter2")
        let key = try XCTUnwrap(p.privateKey)
        let cert = try XCTUnwrap(p.identity)
        let msg = Data("app bundle digest".utf8)
        let sig = try key.sign(msg, .sha256)
        XCTAssertTrue(RSAPrivateKey.verify(signature: sig, message: msg, .sha256, spki: cert.publicKeyDER))
    }
}
