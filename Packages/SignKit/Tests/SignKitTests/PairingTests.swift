import XCTest
@testable import SignKit

/// The pairing file, and the shapes of the messages iOS's own install services expect.
/// None of this needs a phone: the wire formats are checked here, byte for byte.
final class PairingTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    /// A pairing file like the ones AltStore, SideStore and pymobiledevice3 write, built from
    /// the certificate already in the test fixtures.
    func madeUpPairingFile() throws -> Data {
        let certificate = try Data(contentsOf: PairingTests.fixtures.appendingPathComponent("testkey.crt"))
        let key = try Data(contentsOf: PairingTests.fixtures.appendingPathComponent("testkey.key"))
        let plist: [String: Any] = [
            "UDID": "00008120-001A2C3D4E5F6061",
            "HostID": "4A3B2C1D-1111-2222-3333-444455556666",
            "SystemBUID": "99887766-5544-3322-1100-AABBCCDDEEFF",
            "HostCertificate": certificate,
            "HostPrivateKey": key,
            "DeviceCertificate": certificate,
            "RootCertificate": certificate,
            "WiFiMACAddress": "aa:bb:cc:dd:ee:ff",
        ]
        return try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    }

    func testReadsAPairingFile() throws {
        let pairing = try PairingFile(data: try madeUpPairingFile())
        XCTAssertEqual(pairing.udid, "00008120-001A2C3D4E5F6061")
        XCTAssertEqual(pairing.hostID, "4A3B2C1D-1111-2222-3333-444455556666")
        XCTAssertEqual(pairing.systemBUID, "99887766-5544-3322-1100-AABBCCDDEEFF")
        XCTAssertEqual(pairing.wifiMAC, "aa:bb:cc:dd:ee:ff")
        XCTAssertNil(pairing.escrowBag, "no escrow bag is fine for installing")

        // The certificate and key come out as bytes whether the file keeps them as text or not.
        let der = try XCTUnwrap(pairing.hostCertificateDER)
        XCTAssertEqual(der.first, 0x30, "a certificate in bytes starts with a sequence")
        let certificate = try Certificate(der: der)
        XCTAssertFalse(certificate.commonName.isEmpty)
        XCTAssertNotNil(pairing.hostPrivateKeyDER)

        XCTAssertTrue(pairing.isFor(udid: "00008120-001a2c3d4e5f6061"), "matching ignores case")
        XCTAssertFalse(pairing.isFor(udid: "something-else"))
        XCTAssertFalse(pairing.summary.isEmpty)
    }

    func testRefusesSomethingThatIsNotAPairingFile() throws {
        XCTAssertThrowsError(try PairingFile(data: Data("hello".utf8)))
        let half: [String: Any] = ["HostID": "x"]
        let data = try PropertyListSerialization.data(fromPropertyList: half, format: .xml, options: 0)
        XCTAssertThrowsError(try PairingFile(data: data))
    }

    func testLockdownMessagesGoOutAndComeBack() throws {
        let framed = try LockdownWire.frame(LockdownWire.queryType())
        XCTAssertEqual(Int(framed.u32be(0)), framed.count - 4, "the length goes in front")

        var buffer = framed
        let back = try XCTUnwrap(try LockdownWire.unframe(&buffer))
        XCTAssertEqual(back["Request"] as? String, "QueryType")
        XCTAssertEqual(back["Label"] as? String, "Signer")
        XCTAssertTrue(buffer.isEmpty, "the message is taken off the front")

        // Two messages arriving at once, and one arriving in pieces.
        var pair = try LockdownWire.frame(LockdownWire.startService("com.apple.afc"))
        pair.append(try LockdownWire.frame(LockdownWire.install(packagePath: "PublicStaging/a.ipa",
                                                                bundleID: "com.example.app")))
        let first = try XCTUnwrap(try LockdownWire.unframe(&pair))
        XCTAssertEqual(first["Service"] as? String, "com.apple.afc")
        let second = try XCTUnwrap(try LockdownWire.unframe(&pair))
        XCTAssertEqual(second["Command"] as? String, "Install")
        XCTAssertEqual(second["PackagePath"] as? String, "PublicStaging/a.ipa")
        XCTAssertTrue(pair.isEmpty)

        var slice = framed.sub(0, framed.count - 3)
        XCTAssertNil(try LockdownWire.unframe(&slice), "an unfinished message waits")
    }

    func testReadsWhatAStartSessionAnswerMeans() {
        XCTAssertTrue(LockdownWire.needsTLS(["EnableSessionSSL": true]))
        XCTAssertFalse(LockdownWire.needsTLS(["EnableSessionSSL": false]))
        XCTAssertFalse(LockdownWire.needsTLS([:]))
        XCTAssertEqual(LockdownWire.error(in: ["Error": "InvalidHostID"]), "InvalidHostID")
        XCTAssertNil(LockdownWire.error(in: ["Request": "StartSession"]))
    }

    func testAFCPacketsAreBuiltTheWayTheServiceExpects() throws {
        let open = AFC.openForWriting(path: "PublicStaging/app.ipa", packetNumber: 1)
        XCTAssertEqual(open.sub(0, 8), AFC.magic)
        XCTAssertEqual(Int(open.u64le(8)), open.count, "the whole length is in the packet")
        XCTAssertEqual(open.u64le(24), 1, "the message number")
        XCTAssertEqual(open.u64le(32), 13, "file open")
        XCTAssertEqual(open.u64le(40), 3, "open for writing, making it if needed")

        let write = AFC.write(handle: 7, bytes: Data(repeating: 0xAB, count: 1024), packetNumber: 2)
        XCTAssertEqual(write.u64le(32), 16, "file write")
        XCTAssertEqual(Int(write.u64le(16)), 48, "the header part is the header plus the handle")
        XCTAssertEqual(Int(write.u64le(8)), 48 + 1024)
        XCTAssertEqual(write.u64le(40), 7, "the handle")

        let close = AFC.close(handle: 7, packetNumber: 3)
        XCTAssertEqual(close.u64le(32), 20)
    }

    func testAFCAnswersAreRead() throws {
        // A status answer saying "that worked".
        var ok = AFC.packet(operation: 1, packetNumber: 9, header: Data(), payload: AFC.le64(0))
        let answer = try XCTUnwrap(try AFC.answer(from: &ok))
        XCTAssertEqual(answer.operation, 1)
        XCTAssertEqual(answer.packetNumber, 9)
        XCTAssertEqual(answer.status, 0)
        XCTAssertTrue(ok.isEmpty)

        // A file-open answer, which hands back the number the phone gave the file.
        var opened = AFC.packet(operation: 2, packetNumber: 10, header: Data(), payload: AFC.le64(42))
        let handle = try XCTUnwrap(try AFC.answer(from: &opened))
        XCTAssertEqual(handle.handle, 42)

        // Half an answer waits; rubbish is refused.
        var partial = AFC.packet(operation: 1, packetNumber: 1, header: Data(), payload: AFC.le64(0))
        partial = partial.sub(0, partial.count - 2)
        XCTAssertNil(try AFC.answer(from: &partial))
        var rubbish = Data(repeating: 0x41, count: 64)
        XCTAssertThrowsError(try AFC.answer(from: &rubbish))
    }
}
