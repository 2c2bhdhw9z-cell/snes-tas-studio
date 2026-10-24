import XCTest
@testable import SignKit

final class HashTests: XCTestCase {
    func testSHA1KnownAnswers() {
        XCTAssertEqual(sha1(Data()).hex, "da39a3ee5e6b4b0d3255bfef95601890afd80709")
        XCTAssertEqual(sha1(Data("abc".utf8)).hex, "a9993e364706816aba3e25717850c26c9cd0d89d")
        XCTAssertEqual(sha1(Data(repeating: 0x61, count: 1000)).hex,
                       "291e9a6c66994949b57ba5e650361e98fc36b1ba")
    }

    func testSHA256KnownAnswers() {
        XCTAssertEqual(sha256(Data()).hex,
                       "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(sha256(Data("abc".utf8)).hex,
                       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(sha256(Data(repeating: 0x61, count: 1000)).hex,
                       "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
    }

    func testStreamingMatchesOneShot() {
        let blob = Data((0..<5000).map { UInt8($0 % 251) })
        for kind in [HashKind.sha1, .sha256] {
            var h = Hasher(kind)
            var i = 0
            while i < blob.count {
                let n = min(97, blob.count - i)
                h.update(blob.sub(i, n))
                i += n
            }
            XCTAssertEqual(h.finish(), Hasher.hash(kind, blob))
        }
    }

    func testHMACKnownAnswers() {
        // RFC 2202 / RFC 4231 test case 2.
        let key = Data("Jefe".utf8), msg = Data("what do ya want for nothing?".utf8)
        XCTAssertEqual(hmac(.sha1, key: key, msg).hex, "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79")
        XCTAssertEqual(hmac(.sha256, key: key, msg).hex,
                       "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
    }
}

final class DERTests: XCTestCase {
    func testOIDRoundTrip() throws {
        for oid in [OID.rsaEncryption, OID.sha256, OID.appleCDHashes, OID.commonName, "1.2.3.4.5.123456"] {
            let node = try DERNode.parse(DER.oid(oid).encoded)
            XCTAssertEqual(node.oid, oid)
        }
    }

    func testSequenceAndLongLengths() throws {
        let payload = Data(repeating: 0x41, count: 400)
        let d = DER.seq([.octets(payload), .intValue(65537), .utf8("hello"), .null]).encoded
        let node = try DERNode.parse(d)
        XCTAssertEqual(node.tag, 0x30)
        XCTAssertEqual(node.children.count, 4)
        XCTAssertEqual(node.child(0)?.content, payload)
        XCTAssertEqual(node.child(1)?.intValue, 65537)
        XCTAssertEqual(node.child(2)?.string, "hello")
    }

    func testIntegerSignPadding() throws {
        let node = try DERNode.parse(DER.int(Data([0xff, 0x01])).encoded)
        XCTAssertEqual(node.content.hex, "00ff01")
        XCTAssertEqual(node.unsignedInteger.hex, "ff01")
    }

    func testSetOfIsSorted() throws {
        let d = DER.set([.octets(Data([0x05])), .octets(Data([0x01]))]).encoded
        let node = try DERNode.parse(d)
        XCTAssertEqual(node.children.map { $0.content.hex }, ["01", "05"])
    }
}
