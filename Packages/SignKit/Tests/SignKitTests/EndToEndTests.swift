import XCTest
@testable import SignKit

/// A full rehearsal of what happens on the phone, using a stand-in certificate shaped like
/// the real thing ("iPhone Developer: Created via API", issued under Apple's real WWDR G3
/// intermediate, a profile for exactly one app ID, one listed phone, and a wildcard grant).
final class EndToEndTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
    static let sample = "/projects/sandbox/research/ipa/SideStore.ipa"   // has frameworks and an extension

    func identity(_ p12: String = "standin.p12") throws -> IPASigner.Identity {
        try IPASigner.Identity.load(p12: EndToEndTests.fixtures.appendingPathComponent(p12), password: "hunter2",
                                    profile: EndToEndTests.fixtures.appendingPathComponent("standin.mobileprovision"))
    }

    func temp() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("e2e-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    func testBothKindsOfP12OpenAndAgree() throws {
        let old = try identity("standin.p12"), new = try identity("standin-aes.p12")
        XCTAssertEqual(old.chain.first?.der, new.chain.first?.der, "same certificate in both files")
        XCTAssertEqual(old.key.n, new.key.n, "same key in both files")
        XCTAssertEqual(old.chain.first?.commonName, "iPhone Developer: Created via API (3KQD4FN5YL)")
        XCTAssertEqual(old.chain.first?.teamID, "3KQD4FN5YL")
        XCTAssertTrue(old.profile?.matches(certificate: old.chain[0]) == true, "profile pairs with the certificate")
    }

    func testProfileLeavesOutBareWildcardGrants() throws {
        let id = try identity()
        let ents = try XCTUnwrap(id.profile).entitlements(forBundleID: "app.sweetpotato2703.cancer3985")
        XCTAssertNil(ents["com.apple.developer.associated-domains"], "a bare * is a permission slip, not a value")
        XCTAssertEqual(ents["application-identifier"] as? String, "3KQD4FN5YL.app.sweetpotato2703.cancer3985")
        XCTAssertEqual(ents["keychain-access-groups"] as? [String], ["3KQD4FN5YL.app.sweetpotato2703.cancer3985"])
        XCTAssertEqual(ents["get-task-allow"] as? Bool, true)
    }

    func testFullSigningRunPassesTheInstallerStyleCheck() throws {
        guard FileManager.default.fileExists(atPath: EndToEndTests.sample) else { throw XCTSkip("no sample app") }
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("signed.ipa")

        var options = SigningOptions()
        options.compressOutput = false
        let result = try IPASigner().sign(ipa: URL(fileURLWithPath: EndToEndTests.sample), to: output,
                                          identity: try identity(), options: options)

        // The app ID switched to the one the profile allows, and the extension went.
        XCTAssertEqual(result.bundleID, "app.sweetpotato2703.cancer3985")
        XCTAssertFalse(result.warnings.contains { $0.hasPrefix("Check failed") }, "\(result.warnings)")

        // Unpack the finished file with an outside tool's view of it and run the checker again.
        let unpacked = dir.appendingPathComponent("out")
        try ZipReader(url: output).extractAll(to: unpacked)
        let app = unpacked.appendingPathComponent("Payload/SideStore.app")
        let report = SignatureInspector.check(app: app, profile: try identity().profile)
        XCTAssertTrue(report.isClean, report.summary)
        XCTAssertGreaterThanOrEqual(report.binariesChecked, 2)

        // Every program file inside the archive is marked runnable.
        let entries = try ZipReader(url: output).entries
        for e in entries where e.name.hasSuffix("/SideStore") || e.name.hasSuffix("OpenSSL.framework/OpenSSL") {
            XCTAssertEqual(e.unixMode & 0o777, 0o755, "\(e.name) must be rwxr-xr-x")
        }
        // No archive entry carries the invalid zero date any more.
        XCTAssertTrue(entries.allSatisfy { $0.modified != nil }, "every entry has a real date")
    }

    /// The signature carries Apple's certificates next to yours, as Apple's own tool does.
    func testSignatureCarriesAppleChain() throws {
        guard FileManager.default.fileExists(atPath: EndToEndTests.sample) else { throw XCTSkip("no sample app") }
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("signed.ipa")
        var options = SigningOptions()
        options.compressOutput = false
        _ = try IPASigner().sign(ipa: URL(fileURLWithPath: EndToEndTests.sample), to: output,
                                 identity: try identity(), options: options)

        let reader = try ZipReader(url: output)
        let main = try XCTUnwrap(reader.entries.first { $0.name == "Payload/SideStore.app/SideStore" })
        let slice = try MachOFile(data: try reader.data(for: main)).slices[0]
        let sig = try XCTUnwrap(slice.existingSignature)
        let certs = try certificates(inSignature: sig)
        XCTAssertEqual(certs.count, 3, "your certificate, Apple's intermediate and Apple's root")
        XCTAssertEqual(certs.filter(\.isSelfIssued).map(\.commonName), ["Apple Root CA"])
        XCTAssertTrue(certs.contains { $0.commonName.hasPrefix("iPhone Developer: Created via API") })
        XCTAssertTrue(certs.contains { $0.commonName == "Apple Worldwide Developer Relations Certification Authority" })
        // The chain for the stand-in leaf reaches Apple's root.
        let leaf = try XCTUnwrap(certs.first { $0.commonName.hasPrefix("iPhone Developer") })
        XCTAssertTrue(AppleChain.reachesRoot(AppleChain.parents(of: leaf), leaf: leaf))

        // Debuggable build, as the profile says (get-task-allow = true): both bits set.
        let blobs = try XCTUnwrap(SignatureInspector.parseBlobs(sig))
        let cd = try XCTUnwrap(blobs[CSSlot.codeDirectory])
        XCTAssertEqual(cd.u64be(80), 0x11, "main program + allow-unsigned")
    }

    /// The checker must actually catch trouble, not just say "fine".
    func testCheckerCatchesRealProblems() throws {
        guard FileManager.default.fileExists(atPath: EndToEndTests.sample) else { throw XCTSkip("no sample app") }
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("signed.ipa")
        var options = SigningOptions()
        options.compressOutput = false
        _ = try IPASigner().sign(ipa: URL(fileURLWithPath: EndToEndTests.sample), to: output,
                                 identity: try identity(), options: options)
        let unpacked = dir.appendingPathComponent("out")
        try ZipReader(url: output).extractAll(to: unpacked)
        let app = unpacked.appendingPathComponent("Payload/SideStore.app")
        let profile = try identity().profile

        // 1. Take away the run permission.
        let main = app.appendingPathComponent("SideStore")
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o644)], ofItemAtPath: main.path)
        var r = SignatureInspector.check(app: app, profile: profile)
        XCTAssertTrue(r.problems.contains { $0.kind == .permission }, "run permission removed")
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o755)], ofItemAtPath: main.path)
        XCTAssertTrue(SignatureInspector.check(app: app, profile: profile).isClean)

        // 2. Change one byte of the program.
        var bytes = try Data(contentsOf: main)
        bytes[4096] ^= 0xff
        try bytes.write(to: main)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o755)], ofItemAtPath: main.path)
        r = SignatureInspector.check(app: app, profile: profile)
        XCTAssertTrue(r.problems.contains { $0.kind == .hash }, "tampered program")
        bytes[4096] ^= 0xff
        try bytes.write(to: main)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o755)], ofItemAtPath: main.path)

        // 3. Change a resource after the list was made.
        let info = app.appendingPathComponent("Info.plist")
        let savedInfo = try Data(contentsOf: info)
        try (savedInfo + Data([0])).write(to: info)
        r = SignatureInspector.check(app: app, profile: profile)
        XCTAssertFalse(r.isClean, "Info.plist changed after signing")
        try savedInfo.write(to: info)

        // 4. Add a stray file the list does not mention.
        let stray = app.appendingPathComponent("stray.txt")
        try Data("hi".utf8).write(to: stray)
        r = SignatureInspector.check(app: app, profile: profile)
        XCTAssertTrue(r.problems.contains { $0.kind == .resources }, "stray file")
        try FileManager.default.removeItem(at: stray)

        // 5. A different app ID than the profile allows.
        var plist = try PropertyListSerialization.propertyList(from: try Data(contentsOf: info), format: nil) as! [String: Any]
        plist["CFBundleIdentifier"] = "com.someone.else"
        try PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0).write(to: info)
        r = SignatureInspector.check(app: app, profile: profile)
        XCTAssertTrue(r.problems.contains { $0.kind == .profile }, "wrong app ID")
        try savedInfo.write(to: info)
        XCTAssertTrue(SignatureInspector.check(app: app, profile: profile).isClean, "restored app is clean again")
    }

    /// Both copies of the permissions decode strictly and say the same thing.
    func testPermissionCopiesAgreeAndDecodeStrictly() throws {
        let ents: [String: Any] = ["application-identifier": "T.a.b", "get-task-allow": true,
                                   "keychain-access-groups": ["T.a.b", "T.c"], "n": 7, "empty": [String]()]
        let der = try Entitlements.derBlob(ents)
        let decoded = try SignatureInspector.decodeDER(der.body).get()
        let xml = try PropertyListSerialization.propertyList(from: try Entitlements.xmlBlob(ents).body, format: nil) as! [String: Any]
        XCTAssertEqual(decoded, xml.mapValues { SignatureInspector.E.from($0) })
    }
}
