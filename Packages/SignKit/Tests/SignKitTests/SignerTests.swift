import XCTest
@testable import SignKit

/// Signs a real Mach-O library and checks the result by taking it apart again.
/// The same files are also checked with an outside tool (rcodesign) in `tools/verify-signature.sh`.
final class SignerTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
    static let candidates = [
        "/projects/sandbox/research/ipa/x/GBox/Payload/GBox.app/Frameworks/libswiftCoreImage.dylib",
        "/projects/sandbox/research/ipa/x/GBox/Payload/GBox.app/Frameworks/libswiftDarwin.dylib",
    ]

    func sampleBinary() throws -> Data {
        guard let path = SignerTests.candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("no sample Mach-O in this environment")
        }
        return try Data(contentsOf: URL(fileURLWithPath: path))
    }

    func identity() throws -> (RSAPrivateKey, Certificate) {
        let p = try PKCS12(url: SignerTests.fixtures.appendingPathComponent("testcert.p12"),
                           password: "hunter2")
        return (try XCTUnwrap(p.privateKey), try XCTUnwrap(p.identity))
    }

    /// Pulls the blobs back out of a signed slice.
    func blobs(in slice: MachOSlice) throws -> [UInt32: Data] {
        let sig = try XCTUnwrap(slice.existingSignature)
        XCTAssertEqual(sig.u32be(0), BlobMagic.embeddedSignature)
        var out = [UInt32: Data]()
        let count = Int(sig.u32be(8))
        for i in 0..<count {
            let slot = sig.u32be(12 + 8 * i)
            let off = Int(sig.u32be(16 + 8 * i))
            let len = Int(sig.u32be(off + 4))
            out[slot] = sig.sub(off, len)
        }
        return out
    }

    func testSignsAndReparses() throws {
        let data = try sampleBinary()
        let (key, cert) = try identity()
        let signer = MachOSigner(key: key, chain: [cert])
        let opts = MachOSigner.Options(identifier: "com.continuum.signer.test", teamID: cert.teamID)
        let signed = try signer.sign(data: data, options: opts)

        let file = try MachOFile(data: signed)
        let slice = file.slices[0]
        let b = try blobs(in: slice)
        XCTAssertNotNil(b[CSSlot.codeDirectory])
        XCTAssertNotNil(b[CSSlot.requirements])
        XCTAssertNotNil(b[CSSlot.signatureSlot])

        let cd = try XCTUnwrap(b[CSSlot.codeDirectory])
        XCTAssertEqual(cd.u32be(8), CodeDirectory.version)
        XCTAssertEqual(cd.u8(37), 2, "must be a SHA-256 code directory")
        let identOffset = Int(cd.u32be(20))
        let ident = cString(cd.sub(identOffset, 64))
        XCTAssertEqual(ident, "com.continuum.signer.test")

        // Every page hash in the directory must match the file we produced.
        let codeLimit = Int(cd.u32be(32))
        let hashOffset = Int(cd.u32be(16))
        let nCode = Int(cd.u32be(28))
        XCTAssertEqual(nCode, (codeLimit + 4095) / 4096)
        for i in 0..<nCode {
            let stored = cd.sub(hashOffset + i * 32, 32)
            let start = i * 4096
            let n = min(4096, codeLimit - start)
            XCTAssertEqual(stored, sha256(slice.data.sub(start, n)), "page \(i)")
        }
        // The signature sits at the very end of the file, nothing after it.
        let lc = try XCTUnwrap(slice.codeSignatureCommand)
        let off = Int(slice.data.u32le(lc.offset + 8)), size = Int(slice.data.u32le(lc.offset + 12))
        XCTAssertEqual(off + size, slice.data.count)
    }

    func testEntitlementsAreIncludedBothWays() throws {
        let data = try sampleBinary()
        let (key, cert) = try identity()
        let ents: [String: Any] = [
            "application-identifier": "ABCDE12345.com.continuum.signer",
            "com.apple.developer.team-identifier": "ABCDE12345",
            "get-task-allow": true,
            "keychain-access-groups": ["ABCDE12345.*"],
        ]
        let signer = MachOSigner(key: key, chain: [cert])
        let opts = MachOSigner.Options(identifier: "com.continuum.signer", teamID: "ABCDE12345",
                                       entitlements: ents)
        let signed = try signer.sign(data: data, options: opts)
        let slice = try MachOFile(data: signed).slices[0]
        let b = try blobs(in: slice)

        let xml = try XCTUnwrap(b[CSSlot.entitlements])
        XCTAssertEqual(xml.u32be(0), BlobMagic.entitlements)
        let plist = try PropertyListSerialization.propertyList(
            from: xml.sub(8, xml.count - 8), format: nil) as? [String: Any]
        XCTAssertEqual(plist?["application-identifier"] as? String, "ABCDE12345.com.continuum.signer")

        let der = try XCTUnwrap(b[CSSlot.derEntitlements])
        XCTAssertEqual(der.u32be(0), BlobMagic.derEntitlements)
        let node = try DERNode.parse(der.sub(8, der.count - 8))
        XCTAssertEqual(node.tag, 0x30)
        XCTAssertEqual(node.child(0)?.intValue, 1)

        // Both must be recorded in the code directory's special slots.
        let cd = try XCTUnwrap(b[CSSlot.codeDirectory])
        let hashOffset = Int(cd.u32be(16))
        func specialHash(_ slot: Int) -> Data { cd.sub(hashOffset - slot * 32, 32) }
        XCTAssertEqual(specialHash(Int(CSSlot.entitlements)), sha256(xml))
        XCTAssertEqual(specialHash(Int(CSSlot.derEntitlements)), sha256(der))
        XCTAssertEqual(specialHash(Int(CSSlot.requirements)), sha256(try XCTUnwrap(b[CSSlot.requirements])))
    }

    func testResigningAnAlreadySignedFile() throws {
        let data = try sampleBinary()
        let (key, cert) = try identity()
        let signer = MachOSigner(key: key, chain: [cert])
        let once = try signer.sign(data: data, options: .init(identifier: "a.b.c", teamID: cert.teamID))
        let twice = try signer.sign(data: once, options: .init(identifier: "a.b.c", teamID: cert.teamID))
        // Signing twice must not keep growing the file.
        XCTAssertEqual(once.count, twice.count)
        XCTAssertNotNil(try MachOFile(data: twice).slices[0].existingSignature)
    }

    func testAdhocSigningNeedsNoCertificate() throws {
        let data = try sampleBinary()
        let signer = MachOSigner(key: nil, chain: [])
        var opts = MachOSigner.Options(identifier: "a.b.c")
        opts.adhoc = true
        let signed = try signer.sign(data: data, options: opts)
        let slice = try MachOFile(data: signed).slices[0]
        let b = try blobs(in: slice)
        let cd = try XCTUnwrap(b[CSSlot.codeDirectory])
        XCTAssertEqual(cd.u32be(12) & CSFlags.adhoc, CSFlags.adhoc)
        XCTAssertEqual(try XCTUnwrap(b[CSSlot.signatureSlot]).count, 8, "ad-hoc carries an empty CMS blob")
    }

    func testInjectedLibrarySurvivesSigning() throws {
        let data = try sampleBinary()
        let (key, cert) = try identity()
        var file = try MachOFile(data: data)
        try file.forEachSlice { try $0.injectDylib("@executable_path/Frameworks/tweak.dylib") }
        let signer = MachOSigner(key: key, chain: [cert])
        let signed = try signer.sign(data: file.encoded(),
                                     options: .init(identifier: "a.b.c", teamID: cert.teamID))
        let slice = try MachOFile(data: signed).slices[0]
        XCTAssertTrue(slice.dylibs.contains("@executable_path/Frameworks/tweak.dylib"))
        XCTAssertNotNil(slice.existingSignature)
    }

    func testCMSSignatureVerifies() throws {
        let data = try sampleBinary()
        let (key, cert) = try identity()
        let signer = MachOSigner(key: key, chain: [cert])
        let signed = try signer.sign(data: data, options: .init(identifier: "a.b.c", teamID: cert.teamID))
        let slice = try MachOFile(data: signed).slices[0]
        let b = try blobs(in: slice)
        let cms = try XCTUnwrap(b[CSSlot.signatureSlot]).dropFirst(8)

        // Dig out the signed attributes and the signature, then check the maths.
        let top = try DERNode.parse(Data(cms))
        let signedData = try XCTUnwrap(top.child(1)?.child(0))
        let signerInfo = try XCTUnwrap(signedData.children.last?.child(0))
        let attrsNode = try XCTUnwrap(signerInfo.children.first { $0.tag == 0xa0 })
        let signature = try XCTUnwrap(signerInfo.children.last?.content)
        // The signature covers the attributes re-tagged as a SET.
        let asSet = DER.tlv(0x31, attrsNode.content)
        XCTAssertTrue(RSAPrivateKey.verify(signature: signature, message: asSet, .sha256,
                                           spki: cert.publicKeyDER))

        // And the message digest attribute must equal the code directory hash.
        let cd = try XCTUnwrap(b[CSSlot.codeDirectory])
        let digestAttr = try XCTUnwrap(attrsNode.children.first { $0.child(0)?.oid == OID.messageDigest })
        XCTAssertEqual(digestAttr.child(1)?.child(0)?.content, sha256(cd))
        XCTAssertEqual(sha256(cd), signer.cdhash(for: slice))
    }
}
