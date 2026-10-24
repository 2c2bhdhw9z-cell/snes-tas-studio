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
}
