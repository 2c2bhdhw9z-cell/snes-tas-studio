import XCTest
@testable import SignKit

/// These tests compare our output against signatures that real iPhones accept:
/// the GBox app (signed by Apple's own tool) and the open-source `rcodesign`.
/// Every expected value below was read out of a real file, not made up.
final class AppleFormatTests: XCTestCase {
    // MARK: - the permissions block (DER entitlements)

    /// Byte-for-byte what Apple's tool wrote inside GBox 6.1.3.
    func testDERMatchesAppleOwnToolOnGBox() throws {
        let ents: [String: Any] = [
            "application-identifier": "UB92QP94WB.com.ncs.gbox",
            "com.apple.developer.team-identifier": "UB92QP94WB",
            "get-task-allow": false,
        ]
        let blob = try Entitlements.derBlob(ents).encoded
        XCTAssertEqual(blob.hex,
            "fade71720000008b708180020101b07b30310c166170706c69636174696f6e2d6964656e7469666965720c17"
            + "554239325150393457422e636f6d2e6e63732e67626f7830310c23636f6d2e6170706c652e646576656c6f"
            + "7065722e7465616d2d6964656e7469666965720c0a5542393251503934574230130c0e6765742d7461736b"
            + "2d616c6c6f77010100")
    }

    /// Byte-for-byte what rcodesign wrote for a richer set: booleans, numbers, empty and
    /// filled lists, strings. Covers the sort order and every value kind we use.
    func testDERMatchesRcodesignForARichSet() throws {
        let ents: [String: Any] = [
            "application-identifier": "ABCDE12345.com.test.app",
            "com.apple.developer.team-identifier": "ABCDE12345",
            "get-task-allow": true,
            "keychain-access-groups": ["ABCDE12345.com.test.app", "ABCDE12345.shared"],
            "com.apple.security.application-groups": [String](),
            "com.apple.developer.associated-domains": ["applinks:example.com"],
            "com.apple.developer.ubiquity-kvstore-identifier": "ABCDE12345.com.test.app",
            "com.example.number": 42,
        ]
        let blob = try Entitlements.derBlob(ents).encoded
        // The complete 424-byte block rcodesign produced for this same input.
        XCTAssertEqual(blob.hex,
            "fade7172000001a87082019c020101b082019530310c166170706c69636174696f6e2d6964656e746966696572"
            + "0c17414243444531323334352e636f6d2e746573742e61707030400c26636f6d2e6170706c652e646576656c6f"
            + "7065722e6173736f6369617465642d646f6d61696e7330160c146170706c696e6b733a6578616d706c652e636f"
            + "6d30310c23636f6d2e6170706c652e646576656c6f7065722e7465616d2d6964656e7469666965720c0a414243"
            + "44453132333435304a0c2f636f6d2e6170706c652e646576656c6f7065722e75626971756974792d6b7673746f"
            + "72652d6964656e7469666965720c17414243444531323334352e636f6d2e746573742e61707030290c25636f6d"
            + "2e6170706c652e73656375726974792e6170706c69636174696f6e2d67726f757073300030170c12636f6d2e65"
            + "78616d706c652e6e756d62657202012a30130c0e6765742d7461736b2d616c6c6f770101ff30460c166b657963"
            + "6861696e2d6163636573732d67726f757073302c0c17414243444531323334352e636f6d2e746573742e617070"
            + "0c11414243444531323334352e736861726564")
    }

    /// The decoded layout must be exactly [APPLICATION 16]{ INTEGER 1, [CONTEXT 16]{ entries } }.
    func testDERLayoutIsAppleVersionOne() throws {
        let blob = try Entitlements.derBlob(["get-task-allow": true, "a": "b"]).encoded
        let top = try DERNode.parse(blob.sub(8, blob.count - 8))
        XCTAssertEqual(top.tag, 0x70, "outer tag must be APPLICATION 16")
        let parts = top.children
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts[0].tag, 0x02)
        XCTAssertEqual(parts[0].intValue, 1)
        XCTAssertEqual(parts[1].tag, 0xb0, "dictionary must be CONTEXT 16")
        let entries = parts[1].children
        XCTAssertEqual(entries.map { $0.child(0)?.string }, ["a", "get-task-allow"], "keys sorted")
        XCTAssertEqual(entries[1].child(1)?.tag, 0x01)
        XCTAssertEqual(entries[1].child(1)?.content, Data([0xff]))
    }

    func testIntegersAreMinimalTwosComplement() {
        XCTAssertEqual(Entitlements.integer(0).hex, "020100")
        XCTAssertEqual(Entitlements.integer(42).hex, "02012a")
        XCTAssertEqual(Entitlements.integer(127).hex, "02017f")
        XCTAssertEqual(Entitlements.integer(128).hex, "02020080")
        XCTAssertEqual(Entitlements.integer(256).hex, "02020100")
        XCTAssertEqual(Entitlements.integer(-1).hex, "0201ff")
        XCTAssertEqual(Entitlements.integer(-129).hex, "0202ff7f")
    }

    func testUnstorableValuesAreDroppedFromBothCopies() {
        let r = Entitlements.storable(["keep": "yes", "blob": Data([1, 2, 3]), "when": Date()])
        XCTAssertEqual(Array(r.kept.keys), ["keep"])
        XCTAssertEqual(r.dropped, ["blob", "when"])
    }

    // MARK: - the rule block (designated requirement)

    /// The exact bytes inside GBox, built from its bundle ID and certificate name.
    func testRequirementMatchesGBox() {
        let blob = Requirement.set(designated: Requirement.designated(
            identifier: "com.ncs.gbox",
            subjectCN: "Apple Distribution: xiaoting Zhong (UB92QP94WB)")).encoded
        XCTAssertEqual(blob.hex,
            "fade0c01000000b0000000010000000300000014fade0c000000009c0000000100000006000000020000000c"
            + "636f6d2e6e63732e67626f78000000060000000f000000060000000b000000000000000a7375626a656374"
            + "2e434e0000000000010000002f4170706c6520446973747269627574696f6e3a207869616f74696e67205a"
            + "686f6e6720285542393251503934574229000000000e000000010000000a2a864886f76364060201000000"
            + "000000")
    }

    /// And a second real one, from the ESign-signed file.
    func testRequirementMatchesESignSignedFile() {
        let blob = Requirement.set(designated: Requirement.designated(
            identifier: "com.revoked.chiba1",
            subjectCN: "iPhone Distribution: CHIBA INSTITUTE OF TECHNOLOGY")).encoded
        XCTAssertEqual(blob.hex,
            "fade0c01000000bc000000010000000300000014fade0c00000000a800000001000000060000000200000012"
            + "636f6d2e7265766f6b65642e6368696261310000000000060000000f000000060000000b000000000000000a"
            + "7375626a6563742e434e000000000001000000326950686f6e6520446973747269627574696f6e3a20434849"
            + "424120494e53544954555445204f4620544543484e4f4c4f475900000000000e000000010000000a2a864886"
            + "f76364060201000000000000")
    }

    // MARK: - Apple's certificates

    func testAllEightAppleCertificatesLoad() {
        XCTAssertEqual(AppleChain.known.count, 8)
        for c in AppleChain.known { XCTAssertFalse(c.commonName.isEmpty) }
    }

    /// Apple's roots vouch for themselves; the developer-relations ones do not.
    func testRootsAreSelfIssued() {
        let roots = AppleChain.known.filter(\.isSelfIssued).map(\.commonName).sorted()
        XCTAssertEqual(roots, ["Apple Root CA", "Apple Root CA - G2", "Apple Root CA - G3"])
    }

    /// The certificate that signed GBox is a real Apple one, and the chain we build for it
    /// must be exactly the two certificates GBox's own signature carries.
    func testChainForARealAppleLeafMatchesWhatAppleEmbeds() throws {
        let path = "/projects/sandbox/research/ipa/x/GBox/Payload/GBox.app/GBox"
        guard FileManager.default.fileExists(atPath: path) else { throw XCTSkip("no GBox sample here") }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let slice = try MachOFile(data: data).slices[0]
        let sig = try XCTUnwrap(slice.existingSignature)
        let certs = try certificates(inSignature: sig)
        XCTAssertEqual(certs.count, 3, "Apple's own signature carries leaf + intermediate + root")
        let leaf = try XCTUnwrap(certs.first { !$0.isSelfIssued && $0.commonName.hasPrefix("Apple Distribution") })

        let parents = AppleChain.parents(of: leaf)
        XCTAssertEqual(parents.count, 2)
        XCTAssertTrue(AppleChain.reachesRoot(parents, leaf: leaf))
        // Same two certificates, byte for byte, as in Apple's signature.
        for parent in parents {
            XCTAssertTrue(certs.contains { $0.der == parent.der }, parent.commonName)
        }
        // And the intermediate really did sign the leaf (a true cryptographic check).
        XCTAssertEqual(leaf.isSigned(by: parents[0]), true)
    }

    /// Elliptic-curve intermediates chain to the G3 root, the RSA ones to the original root.
    func testEveryDeveloperRelationsCertificateFindsItsRoot() {
        for cert in AppleChain.known where !cert.isSelfIssued {
            let parents = AppleChain.parents(of: cert)
            XCTAssertEqual(parents.count, 1, cert.commonName)
            XCTAssertTrue(AppleChain.reachesRoot(parents, leaf: cert), cert.commonName)
        }
    }

    /// A certificate Apple did not issue must not pick up an Apple chain by accident.
    func testUnknownIssuerGetsNoParents() throws {
        let text = try String(contentsOf: RSATests.dir.appendingPathComponent("testkey.crt"), encoding: .utf8)
        let cert = try Certificate(der: try XCTUnwrap(PEM.first(text, type: "CERTIFICATE")))
        XCTAssertTrue(cert.isSelfIssued)
        XCTAssertEqual(AppleChain.parents(of: cert).count, 0)
    }

    // MARK: - the signature envelope

    func testCDHashPlistMatchesAppleText() {
        let hash = Data(hex: "66ed700b9c69a6d27f7751d33f895a346601b086")!
        let text = String(decoding: CMS.cdhashPlist([hash]), as: UTF8.self)
        XCTAssertEqual(text, """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
        \t<key>cdhashes</key>
        \t<array>
        \t\t<data>
        \t\tZu1wC5xpptJ/d1HTP4laNGYBsIY=
        \t\t</data>
        \t</array>
        </dict>
        </plist>

        """)
    }

    /// Our envelope must have the same shape as Apple's: five attributes in Apple's order,
    /// the 100.9.2 attribute as SET{SEQUENCE{OID,hash}}, and SHA-256-with-RSA labelling.
    func testEnvelopeHasAppleShape() throws {
        let p = try PKCS12(url: RSATests.dir.appendingPathComponent("testcert.p12"), password: "hunter2")
        let key = try XCTUnwrap(p.privateKey), leaf = try XCTUnwrap(p.identity)
        var cd = CodeDirectory(identifier: "a.b", teamID: "T", hashKind: .sha256, codeLimit: 4096)
        cd.codeHashes = [sha256(Data(count: 4096))]
        let cms = try CMS.sign(codeDirectories: [cd], key: key, chain: [leaf])

        let top = try DERNode.parse(cms)
        let signedData = try XCTUnwrap(top.child(1)?.child(0))
        let signerInfo = try XCTUnwrap(signedData.children.last?.child(0))
        let attrs = try XCTUnwrap(signerInfo.children.first { $0.tag == 0xa0 }).children
        let names = attrs.map { $0.child(0)?.oid ?? "?" }
        XCTAssertEqual(names, ["1.2.840.113549.1.9.3", "1.2.840.113549.1.9.5", "1.2.840.113549.1.9.4",
                               "1.2.840.113635.100.9.2", "1.2.840.113635.100.9.1"],
                       "five attributes, in the order Apple's tool writes them")

        // 100.9.2 = SET { SEQUENCE { OID sha256, OCTET STRING(32) } }
        let hashes = try XCTUnwrap(attrs[3].child(1))
        XCTAssertEqual(hashes.tag, 0x31)
        let entry = try XCTUnwrap(hashes.child(0))
        XCTAssertEqual(entry.tag, 0x30)
        XCTAssertEqual(entry.child(0)?.oid, OID.sha256)
        XCTAssertEqual(entry.child(1)?.content, cd.cdhash)

        // 100.9.1 = SET { OCTET STRING(plist) } holding the short hash
        let plistBytes = try XCTUnwrap(attrs[4].child(1)?.child(0)?.content)
        let plist = try PropertyListSerialization.propertyList(from: plistBytes, format: nil) as? [String: Any]
        XCTAssertEqual((plist?["cdhashes"] as? [Data])?.first, cd.truncatedCDHash)

        // Algorithm labels as Apple writes them.
        XCTAssertEqual(signerInfo.children[2].child(0)?.oid, OID.sha256)
        XCTAssertEqual(signerInfo.children[4].child(0)?.oid, OID.sha256WithRSAEncryption)
    }
}

/// The certificates a signature carries (Apple's tool writes yours plus Apple's two).
func certificates(inSignature sig: Data) throws -> [Certificate] {
    let count = Int(sig.u32be(8))
    for i in 0..<count where sig.u32be(12 + 8 * i) == CSSlot.signatureSlot {
        let off = Int(sig.u32be(16 + 8 * i))
        let blob = sig.sub(off + 8, Int(sig.u32be(off + 4)) - 8)
        let top = try DERNode.parse(blob)
        guard let signedData = top.child(1)?.child(0),
              let set = signedData.children.first(where: { $0.tag == 0xa0 }) else { return [] }
        return try set.children.map { try Certificate(der: $0.raw) }
    }
    return []
}
