import XCTest
@testable import SignKit

/// Known answers from the standards documents.
final class CipherTests: XCTestCase {
    func b(_ hex: String) -> [UInt8] { [UInt8](Data(hex: hex)!) }

    func testAESFIPS197() throws {
        let pt = b("00112233445566778899aabbccddeeff")
        let cases = [
            ("000102030405060708090a0b0c0d0e0f", "69c4e0d86a7b0430d8cdb78070b4c55a"),
            ("000102030405060708090a0b0c0d0e0f1011121314151617", "dda97ca4864cdfe06eaf70a0ec0d7191"),
            ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "8ea2b7ca516745bfeafc49904b496089"),
        ]
        for (key, ct) in cases {
            let aes = try AES(key: Data(hex: key)!)
            XCTAssertEqual(Data(aes.encryptBlock(pt)).hex, ct)
            XCTAssertEqual(Data(aes.decryptBlock(b(ct))).hex, Data(pt).hex)
        }
    }

    func testDESKnownAnswer() {
        let des = DES(key: b("133457799bbcdff1"))
        let ct = des.crypt(DES.toU64(b("0123456789abcdef")), decrypt: false)
        XCTAssertEqual(Data(DES.toBytes(ct)).hex, "85e813540f0ab405")
        XCTAssertEqual(Data(DES.toBytes(des.crypt(ct, decrypt: true))).hex, "0123456789abcdef")
    }

    func testTripleDESRoundTripAndDegenerate() throws {
        // With all three keys equal, Triple-DES must equal single DES.
        let k = "133457799bbcdff1"
        let t = try TripleDES(key: Data(hex: k + k + k)!)
        XCTAssertEqual(Data(t.encryptBlock(b("0123456789abcdef"))).hex, "85e813540f0ab405")
        let t2 = try TripleDES(key: Data(hex: "0123456789abcdeffedcba987654321089abcdef01234567")!)
        let msg = Data("Triple DES test message, longer than one block".utf8)
        let iv = Data(hex: "0001020304050607")!
        let enc = CBC.encrypt(t2, iv: iv, msg)
        XCTAssertEqual(try CBC.decrypt(t2, iv: iv, enc), msg)
    }

    func testRC2RFC2268() {
        let cases: [(String, Int, String, String)] = [
            ("0000000000000000", 63, "0000000000000000", "ebb773f993278eff"),
            ("ffffffffffffffff", 64, "ffffffffffffffff", "278b27e42e2f0d49"),
            ("3000000000000000", 64, "1000000000000001", "30649edf9be7d2c2"),
            ("88", 64, "0000000000000000", "61a8a244adacccf0"),
            ("88bca90e90875a", 64, "0000000000000000", "6ccf4308974c267f"),
            ("88bca90e90875a7f0f79c384627bafb2", 64, "0000000000000000", "1a807d272bbe5db1"),
            ("88bca90e90875a7f0f79c384627bafb2", 128, "0000000000000000", "2269552ab0f85ca6"),
        ]
        for (key, bits, pt, ct) in cases {
            let rc2 = RC2(key: Data(hex: key)!, effectiveBits: bits)
            XCTAssertEqual(Data(rc2.encryptBlock(b(pt))).hex, ct, "key \(key) bits \(bits)")
            XCTAssertEqual(Data(rc2.decryptBlock(b(ct))).hex, pt)
        }
    }

    func testCBCRejectsWrongKey() throws {
        let good = try AES(key: Data(repeating: 1, count: 16))
        let bad = try AES(key: Data(repeating: 2, count: 16))
        let iv = Data(repeating: 0, count: 16)
        let enc = CBC.encrypt(good, iv: iv, Data("secret certificate".utf8))
        XCTAssertEqual(try CBC.decrypt(good, iv: iv, enc), Data("secret certificate".utf8))
        // A wrong password almost always breaks the padding.
        XCTAssertThrowsError(try CBC.decrypt(bad, iv: iv, enc))
    }
}
