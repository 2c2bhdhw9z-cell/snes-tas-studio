import XCTest
@testable import SignKit

/// These run against a real RSA key pair and X.509 certificate generated with
/// an independent tool (rcodesign), so the parsers are checked against real data.
final class RSATests: XCTestCase {
    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    func loadKey() throws -> RSAPrivateKey {
        let text = try String(contentsOf: RSATests.dir.appendingPathComponent("testkey.key"), encoding: .utf8)
        let der = try XCTUnwrap(PEM.first(text, type: "PRIVATE KEY"))
        return try RSAPrivateKey(pkcs8: der)
    }

    func loadCert() throws -> Certificate {
        let text = try String(contentsOf: RSATests.dir.appendingPathComponent("testkey.crt"), encoding: .utf8)
        return try Certificate(der: try XCTUnwrap(PEM.first(text, type: "CERTIFICATE")))
    }

    func testBigIntArithmetic() {
        let a = BigInt(bytes: Data(hex: "fedcba9876543210fedcba98")!)
        let b = BigInt(bytes: Data(hex: "1234567890abcdef")!)
        XCTAssertEqual((a + b - b), a)
        let (q, r) = BigInt.divMod(a, b)
        XCTAssertEqual(q * b + r, a)
        XCTAssertTrue(r < b)
        // 3^200 mod 1000000007 = 0x8200cd5 (cross-checked with Python's pow)
        let p = BigInt(3).powMod(BigInt(200), BigInt(bytes: Data(hex: "3b9aca07")!))
        XCTAssertEqual(p.bytes().hex, "08200cd5")
        // even modulus takes the slow path
        // 7^13 mod 1000 = 407 = 0x197
        XCTAssertEqual(BigInt(7).powMod(BigInt(13), BigInt(1000)).bytes().hex, "0197")
    }

    func testInverseMod() {
        let m = BigInt(bytes: Data(hex: "0d")!)   // 13
        let inv = BigInt(5).inverseMod(m)
        XCTAssertEqual(inv, BigInt(8))            // 5*8 = 40 = 1 mod 13
    }

    func testKeyParsesAndMatchesCertificate() throws {
        let key = try loadKey()
        let cert = try loadCert()
        XCTAssertEqual(key.n.bitWidth, 2048)
        XCTAssertEqual(key.e, BigInt(65537))
        XCTAssertTrue(key.matches(publicKey: cert.publicKeyDER),
                      "the private key must belong to the certificate")
    }

    func testSignatureVerifies() throws {
        let key = try loadKey()
        let cert = try loadCert()
        let msg = Data("the quick brown fox signs an app".utf8)
        for kind in [HashKind.sha256, .sha1] {
            let sig = try key.sign(msg, kind)
            XCTAssertEqual(sig.count, key.modulusBytes)
            XCTAssertTrue(RSAPrivateKey.verify(signature: sig, message: msg, kind, spki: cert.publicKeyDER))
            XCTAssertFalse(RSAPrivateKey.verify(signature: sig, message: msg + Data([1]), kind,
                                                spki: cert.publicKeyDER))
        }
    }

    func testCertificateFields() throws {
        let cert = try loadCert()
        XCTAssertTrue(cert.commonName.contains("SignKit Test"), cert.commonName)
        XCTAssertFalse(cert.isExpired)
        XCTAssertNotNil(cert.notBefore)
        XCTAssertNotNil(cert.notAfter)
        XCTAssertEqual(cert.sha1Fingerprint.count, 40)
        XCTAssertEqual(cert.sha256Fingerprint, "3b4bf936d7a05e8b2a54013925e902f5def29c260c6df96eed5505695f9a8770")
        XCTAssertGreaterThan(cert.daysLeft ?? 0, 300)
    }

    func testPEMRoundTrip() throws {
        let cert = try loadCert()
        let text = PEM.encode(cert.der, type: "CERTIFICATE")
        XCTAssertEqual(PEM.first(text, type: "CERTIFICATE"), cert.der)
    }
}
