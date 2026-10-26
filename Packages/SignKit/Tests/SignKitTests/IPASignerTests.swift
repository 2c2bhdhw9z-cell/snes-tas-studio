import XCTest
@testable import SignKit

/// End-to-end: take a real `.ipa`, change things, sign it, and check the result.
final class IPASignerTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
    static let samples = [
        "/projects/sandbox/research/ipa/Feather.ipa",
        "/projects/sandbox/research/ipa/Ksign.ipa",
    ]

    func sample() throws -> URL {
        guard let p = IPASignerTests.samples.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("no sample .ipa in this environment")
        }
        return URL(fileURLWithPath: p)
    }

    func identity() throws -> IPASigner.Identity {
        try IPASigner.Identity.load(p12: IPASignerTests.fixtures.appendingPathComponent("testcert.p12"),
                                    password: "hunter2", profile: nil)
    }

    func temp() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("ipa-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    /// Reads one file out of a signed `.ipa`.
    func read(_ ipa: URL, _ suffix: String) throws -> Data {
        let r = try ZipReader(url: ipa)
        let entry = try XCTUnwrap(r.entries.first { $0.name.hasSuffix(suffix) }, "no \(suffix) in the output")
        return try r.data(for: entry)
    }

    func testSignsRealIPAWithChanges() throws {
        let input = try sample()
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("out.ipa")

        var options = SigningOptions()
        options.displayName = "Renamed App"
        options.bundleID = "com.continuum.renamed"
        options.version = "9.9"
        options.fileSharing = true
        options.proMotion = true
        options.removeWatchApp = true
        options.compressOutput = false      // quicker, same result

        var sawProgress = false
        let job = IPASigner()
        job.onProgress = { f, _ in if f > 0 { sawProgress = true } }
        let result = try job.sign(ipa: input, to: output, identity: try identity(), options: options)

        XCTAssertTrue(sawProgress)
        XCTAssertEqual(result.bundleID, "com.continuum.renamed")
        XCTAssertEqual(result.displayName, "Renamed App")
        XCTAssertEqual(result.version, "9.9")
        XCTAssertEqual(result.cdhash.count, 32)
        XCTAssertGreaterThan(result.bytes, 1_000_000)

        // The changes really landed in the app's Info.plist.
        let info = try PropertyListSerialization.propertyList(
            from: try read(output, ".app/Info.plist"), format: nil) as? [String: Any]
        XCTAssertEqual(info?["CFBundleIdentifier"] as? String, "com.continuum.renamed")
        XCTAssertEqual(info?["CFBundleDisplayName"] as? String, "Renamed App")
        XCTAssertEqual(info?["CFBundleShortVersionString"] as? String, "9.9")
        XCTAssertEqual(info?["UISupportsDocumentBrowser"] as? Bool, true)
        XCTAssertEqual(info?["CADisableMinimumFrameDurationOnPhone"] as? Bool, true)

        // The resource list and a fresh signature are both present.
        let cr = try PropertyListSerialization.propertyList(
            from: try read(output, ".app/_CodeSignature/CodeResources"), format: nil) as? [String: Any]
        XCTAssertNotNil(cr?["files2"])
        XCTAssertEqual((cr?["rules2"] as? [String: Any])?.count, 10)

        // No Watch app survived, and no old provisioning profile either.
        let names = try ZipReader(url: output).entries.map(\.name)
        XCTAssertFalse(names.contains { $0.contains("/Watch/") })
        XCTAssertTrue(names.contains { $0.hasSuffix(".app/_CodeSignature/CodeResources") })

        // Every file in the output is intact.
        let reader = try ZipReader(url: output)
        for e in reader.entries where !e.isDirectory && !e.isSymlink && e.uncompressedSize < 4_000_000 {
            XCTAssertEqual(Zip.crc32(try reader.data(for: e)), e.crc32, e.name)
        }
    }

    func testSignedBinaryCarriesOurSignature() throws {
        let input = try sample()
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("out.ipa")

        var options = SigningOptions()
        options.bundleID = "com.continuum.checked"
        options.compressOutput = false
        let result = try IPASigner().sign(ipa: input, to: output, identity: try identity(), options: options)

        // Find the app's own binary and check the signature we wrote.
        let reader = try ZipReader(url: output)
        let infoEntry = try XCTUnwrap(reader.entries.first {
            $0.name.hasSuffix(".app/Info.plist") && $0.name.split(separator: "/").count == 3
        })
        let info = try PropertyListSerialization.propertyList(
            from: try reader.data(for: infoEntry), format: nil) as? [String: Any] ?? [:]
        let appDir = String(infoEntry.name.dropLast("Info.plist".count))
        let exec = try XCTUnwrap(info["CFBundleExecutable"] as? String)
        let binary = try XCTUnwrap(reader.entries.first { $0.name == appDir + exec })
        let slice = try MachOFile(data: try reader.data(for: binary)).slices[0]

        let sig = try XCTUnwrap(slice.existingSignature)
        XCTAssertEqual(sig.u32be(0), BlobMagic.embeddedSignature)
        let signer = MachOSigner(key: nil, chain: [])
        XCTAssertEqual(signer.cdhash(for: slice), result.cdhash,
                       "the hash we reported must be the one in the file")

        // The identifier inside the signature follows the new app ID.
        let cdOffset = Int(sig.u32be(16))
        let cd = sig.sub(cdOffset, Int(sig.u32be(cdOffset + 4)))
        XCTAssertEqual(cString(cd.sub(Int(cd.u32be(20)), 64)), "com.continuum.checked")
    }

    func testAdhocSigningWithoutAnyCertificate() throws {
        let input = try sample()
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("adhoc.ipa")
        var options = SigningOptions()
        options.adhoc = true
        options.compressOutput = false
        let result = try IPASigner().sign(ipa: input, to: output, identity: nil, options: options)
        XCTAssertEqual(result.cdhash.count, 32)
        XCTAssertTrue(FileManager.default.fileExists(atPath: output.path))
    }

    /// A profile made for exactly one app ID: the app KEEPS its own ID and its extensions, and
    /// both carry the profile's identifier in their permissions. That is what zsign (so ESign and
    /// GBox) does, and it is why several apps signed with one such certificate install side by
    /// side. Taking the profile's ID instead made each new app replace the last one on the Home
    /// Screen, and removing the extensions broke Continuum's JIT helper (owner, 26 October).
    func testOneIDProfileKeepsTheAppIDAndItsExtensions() throws {
        let input = try sample()
        // The stand-in certificate's profile: one exact app ID, like a bought certificate's.
        let identity = try IPASigner.Identity.load(
            p12: IPASignerTests.fixtures.appendingPathComponent("standin.p12"), password: "hunter2",
            profile: IPASignerTests.fixtures.appendingPathComponent("standin.mobileprovision"))
        let profile = try XCTUnwrap(identity.profile)
        let allowed = try XCTUnwrap(profile.bundleIDPattern)
        XCTAssertFalse(allowed.hasSuffix("*"), "this test needs a one-ID profile")
        let team = try XCTUnwrap(profile.teamID)

        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }

        // The sample app with an extension added, standing in for a widget or a helper.
        let work = dir.appendingPathComponent("work")
        try ZipReader(url: input).extractAll(to: work)
        let payload = work.appendingPathComponent("Payload")
        let appName = try XCTUnwrap((try FileManager.default.contentsOfDirectory(atPath: payload.path))
            .first { $0.hasSuffix(".app") })
        let app = payload.appendingPathComponent(appName)
        let hostInfo = try PropertyListSerialization.propertyList(
            from: try Data(contentsOf: app.appendingPathComponent("Info.plist")), format: nil) as? [String: Any] ?? [:]
        let hostID = try XCTUnwrap(hostInfo["CFBundleIdentifier"] as? String)
        let hostExec = try XCTUnwrap(hostInfo["CFBundleExecutable"] as? String)
        let appex = app.appendingPathComponent("PlugIns/Helper.appex")
        try FileManager.default.createDirectory(at: appex, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: app.appendingPathComponent(hostExec),
                                         to: appex.appendingPathComponent("Helper"))
        let appexInfo: [String: Any] = [
            "CFBundleIdentifier": hostID + ".Helper",
            "CFBundleExecutable": "Helper",
            "CFBundleName": "Helper",
            "NSExtension": ["NSExtensionPointIdentifier": "com.apple.widgetkit-extension"],
        ]
        try PropertyListSerialization.data(fromPropertyList: appexInfo, format: .xml, options: 0)
            .write(to: appex.appendingPathComponent("Info.plist"))
        let withExtension = dir.appendingPathComponent("with-extension.ipa")
        let packer = try ZipWriter(url: withExtension)
        try packer.addTree(at: payload, prefix: "Payload/", compress: false)
        try packer.finish()

        let output = dir.appendingPathComponent("out.ipa")
        var options = SigningOptions()
        options.compressOutput = false
        let result = try IPASigner().sign(ipa: withExtension, to: output, identity: identity, options: options)

        XCTAssertEqual(result.bundleID, hostID, "the app keeps its own ID")
        XCTAssertNotEqual(result.bundleID, allowed)
        XCTAssertTrue(result.warnings.contains { $0.contains(allowed) }, "the user must be told")
        XCTAssertFalse(result.warnings.contains { $0.contains("Check failed") },
                       "the finished app must pass its own check: \(result.warnings)")

        let names = try ZipReader(url: output).entries.map(\.name)
        XCTAssertTrue(names.contains { $0.contains("Helper.appex/") }, "the extension must be kept")
        let info = try PropertyListSerialization.propertyList(
            from: try read(output, ".app/Info.plist"), format: nil) as? [String: Any]
        XCTAssertEqual(info?["CFBundleIdentifier"] as? String, hostID)
        // The extension keeps its own ID too ...
        let exInfo = try PropertyListSerialization.propertyList(
            from: try read(output, "Helper.appex/Info.plist"), format: nil) as? [String: Any]
        XCTAssertEqual(exInfo?["CFBundleIdentifier"] as? String, hostID + ".Helper")
        // ... and both carry the one identifier the profile allows.
        let reader = try ZipReader(url: output)
        let binary = try XCTUnwrap(reader.entries.first { $0.name.hasSuffix("Helper.appex/Helper") })
        let slice = try MachOFile(data: try reader.data(for: binary)).slices[0]
        let sig = try XCTUnwrap(slice.existingSignature)
        let blobs = try XCTUnwrap(SignatureInspector.parseBlobs(sig))
        let xml = try XCTUnwrap(blobs[CSSlot.entitlements])
        let ents = try PropertyListSerialization.propertyList(
            from: xml.sub(8, xml.count - 8), format: nil) as? [String: Any] ?? [:]
        XCTAssertEqual(ents["application-identifier"] as? String, "\(team).\(allowed)")

        // And the app's own program carries the same identifier.
        let hostBinary = try XCTUnwrap(reader.entries.first { $0.name.hasSuffix(".app/" + hostExec) })
        let hostSlice = try MachOFile(data: try reader.data(for: hostBinary)).slices[0]
        let hostBlobs = try XCTUnwrap(SignatureInspector.parseBlobs(try XCTUnwrap(hostSlice.existingSignature)))
        let hostXML = try XCTUnwrap(hostBlobs[CSSlot.entitlements])
        let hostEnts = try PropertyListSerialization.propertyList(
            from: hostXML.sub(8, hostXML.count - 8), format: nil) as? [String: Any] ?? [:]
        XCTAssertEqual(hostEnts["application-identifier"] as? String, "\(team).\(allowed)")
    }

    func testRefusesSomethingThatIsNotAnApp() throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let notAnIPA = dir.appendingPathComponent("junk.ipa")
        let w = try ZipWriter(url: notAnIPA)
        try w.add(name: "readme.txt", data: Data("hello".utf8))
        try w.finish()
        XCTAssertThrowsError(try IPASigner().sign(ipa: notAnIPA,
                                                  to: dir.appendingPathComponent("o.ipa"),
                                                  identity: try identity(),
                                                  options: SigningOptions())) { error in
            XCTAssertTrue("\(error)".lowercased().contains("iphone app"), "\(error)")
        }
    }

    /// A separate copy: the ID gets a random ending so iPhone installs it beside the original,
    /// and the app's extensions follow it. What other signers call PPQ protection.
    func testSeparateCopyGetsItsOwnID() throws {
        let input = try sample()
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("copy.ipa")
        var options = SigningOptions()
        options.separateCopy = true
        options.compressOutput = false
        let beforePlist = try PropertyListSerialization.propertyList(
            from: try read(input, ".app/Info.plist"), format: nil) as? [String: Any] ?? [:]
        let before = try XCTUnwrap(beforePlist["CFBundleIdentifier"] as? String)
        let result = try IPASigner().sign(ipa: input, to: output, identity: try identity(), options: options)
        XCTAssertTrue(result.bundleID.hasPrefix(before + "."), "\(result.bundleID) must sit under \(before)")
        XCTAssertEqual(result.bundleID.dropFirst(before.count + 1).count, 6)
        // Twice in a row gives two different copies.
        let second = dir.appendingPathComponent("copy2.ipa")
        let again = try IPASigner().sign(ipa: input, to: second, identity: try identity(), options: options)
        XCTAssertNotEqual(result.bundleID, again.bundleID)
    }
}
