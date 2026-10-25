import XCTest
@testable import SignKit

/// Builds a small app bundle around a real Mach-O library, signs it, and checks the result.
final class BundleTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
    static let machoCandidates = [
        "/projects/sandbox/research/ipa/x/GBox/Payload/GBox.app/Frameworks/libswiftCoreImage.dylib",
        "/projects/sandbox/research/ipa/x/GBox/Payload/GBox.app/Frameworks/libswiftDarwin.dylib",
    ]

    func machO() throws -> Data {
        guard let p = BundleTests.machoCandidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("no sample Mach-O in this environment")
        }
        return try Data(contentsOf: URL(fileURLWithPath: p))
    }

    func identity() throws -> (RSAPrivateKey, Certificate) {
        let p = try PKCS12(url: BundleTests.fixtures.appendingPathComponent("testcert.p12"), password: "hunter2")
        return (try XCTUnwrap(p.privateKey), try XCTUnwrap(p.identity))
    }

    /// Makes Demo.app with a framework, a loose dylib, a language folder and an icon.
    func makeBundle() throws -> URL {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("bundle-\(UUID().uuidString)")
        let app = root.appendingPathComponent("Demo.app")
        try fm.createDirectory(at: app.appendingPathComponent("Frameworks"), withIntermediateDirectories: true)
        try fm.createDirectory(at: app.appendingPathComponent("en.lproj"), withIntermediateDirectories: true)

        let binary = try machO()
        try binary.write(to: app.appendingPathComponent("Demo"))
        try write(["CFBundleIdentifier": "com.continuum.demo",
                   "CFBundleExecutable": "Demo",
                   "CFBundleName": "Demo",
                   "CFBundleShortVersionString": "1.0",
                   "CFBundleVersion": "1"],
                  to: app.appendingPathComponent("Info.plist"))
        try Data("icon".utf8).write(to: app.appendingPathComponent("Icon.png"))
        try Data("\"k\" = \"v\";".utf8).write(to: app.appendingPathComponent("en.lproj/Localizable.strings"))
        try Data("APPL????".utf8).write(to: app.appendingPathComponent("PkgInfo"))
        try binary.write(to: app.appendingPathComponent("Frameworks/libtweak.dylib"))

        // A framework inside the app, with its own Info.plist and binary.
        let fw = app.appendingPathComponent("Frameworks/Demo.framework")
        try fm.createDirectory(at: fw, withIntermediateDirectories: true)
        try binary.write(to: fw.appendingPathComponent("Demo"))
        try write(["CFBundleIdentifier": "com.continuum.demo.framework",
                   "CFBundleExecutable": "Demo",
                   "CFBundleName": "Demo"],
                  to: fw.appendingPathComponent("Info.plist"))
        return app
    }

    func write(_ d: [String: Any], to url: URL) throws {
        try PropertyListSerialization.data(fromPropertyList: d, format: .xml, options: 0).write(to: url)
    }

    func testSignsBundleWithNestedCode() throws {
        let app = try makeBundle()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        let (key, cert) = try identity()
        let signer = BundleSigner(key: key, chain: [cert], profile: nil)

        var messages = [String]()
        signer.onProgress = { messages.append($0.message) }
        let cdhash = try signer.sign(bundle: app)

        XCTAssertEqual(cdhash.count, 32)
        XCTAssertFalse(messages.isEmpty, "the user must get progress messages")

        // The resource list exists and has the exact rules Apple writes.
        let crURL = app.appendingPathComponent("_CodeSignature/CodeResources")
        XCTAssertTrue(FileManager.default.fileExists(atPath: crURL.path))
        let cr = try PropertyListSerialization.propertyList(from: try Data(contentsOf: crURL), format: nil) as? [String: Any]
        let files = try XCTUnwrap(cr?["files"] as? [String: Any])
        let files2 = try XCTUnwrap(cr?["files2"] as? [String: Any])
        XCTAssertEqual(Set((cr?["rules2"] as? [String: Any])?.keys ?? [:].keys).count, 10)

        // The app's own binary is never listed; its resources are.
        XCTAssertNil(files2["Demo"])
        XCTAssertNotNil(files2["Icon.png"])
        XCTAssertNotNil(files["Info.plist"], "Info.plist belongs in the old list")
        XCTAssertNil(files2["Info.plist"], "and must be left out of the new one")
        XCTAssertNil(files2["PkgInfo"])
        // Nested code is listed file by file, as on real apps.
        XCTAssertNotNil(files2["Frameworks/Demo.framework/Demo"])
        XCTAssertNotNil(files2["Frameworks/Demo.framework/_CodeSignature/CodeResources"])
        XCTAssertNotNil(files2["Frameworks/libtweak.dylib"])
        // Language files are marked optional.
        let lproj = files2["en.lproj/Localizable.strings"] as? [String: Any]
        XCTAssertEqual(lproj?["optional"] as? Bool, true)

        // Every listed hash must match the file on disk.
        for (name, value) in files2 {
            guard let dict = value as? [String: Any], let h = dict["hash2"] as? Data else { continue }
            let data = try Data(contentsOf: app.appendingPathComponent(name))
            XCTAssertEqual(h, sha256(data), name)
        }

        // The nested framework got its own signature.
        let fwBinary = try Data(contentsOf: app.appendingPathComponent("Frameworks/Demo.framework/Demo"))
        let fwSlice = try MachOFile(data: fwBinary).slices[0]
        XCTAssertNotNil(fwSlice.existingSignature)
        XCTAssertNotNil(try MachOFile(data: try Data(contentsOf: app.appendingPathComponent("Frameworks/libtweak.dylib"))).slices[0].existingSignature)

        // The app's signature records the Info.plist and resource hashes.
        let mainSlice = try MachOFile(data: try Data(contentsOf: app.appendingPathComponent("Demo"))).slices[0]
        let sig = try XCTUnwrap(mainSlice.existingSignature)
        let cdOffset = Int(sig.u32be(16))
        let cd = sig.sub(cdOffset, Int(sig.u32be(cdOffset + 4)))
        let hashOffset = Int(cd.u32be(16))
        func special(_ slot: Int) -> Data { cd.sub(hashOffset - slot * 32, 32) }
        XCTAssertEqual(special(Int(CSSlot.infoPlist)),
                       sha256(try Data(contentsOf: app.appendingPathComponent("Info.plist"))))
        XCTAssertEqual(special(Int(CSSlot.resourceDir)), sha256(try Data(contentsOf: crURL)))
    }

    /// Emulator cores and helper libraries are often tucked into folders that are not the
    /// standard ones. Every one of them must still be found and signed.
    func testProgramFilesInUnusualFoldersAreSignedToo() throws {
        let app = try makeBundle()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        let fm = FileManager.default
        let binary = try machO()
        // Loose libraries in made-up folders, a framework in a made-up folder, a nested bundle
        // with its own library, and a file named like a library that is not one.
        for path in ["Cores/gba_core.dylib", "Resources/libs/helper.dylib", "libroot.dylib", "Deep/er/x/lib.so"] {
            let url = app.appendingPathComponent(path)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try binary.write(to: url)
        }
        let odd = app.appendingPathComponent("Support/Odd.framework")
        try fm.createDirectory(at: odd, withIntermediateDirectories: true)
        try binary.write(to: odd.appendingPathComponent("Odd"))
        try write(["CFBundleIdentifier": "com.continuum.demo.odd", "CFBundleExecutable": "Odd", "CFBundleName": "Odd"],
                  to: odd.appendingPathComponent("Info.plist"))
        try Data("not a library".utf8).write(to: app.appendingPathComponent("Cores/readme.dylib"))
        try Data("!<arch>\n".utf8).write(to: app.appendingPathComponent("Cores/libstatic.a"))

        let items = try BundleSigner(key: nil, chain: [], profile: nil).nestedItems(in: app)
        XCTAssertTrue(items.bundles.contains("Support/Odd.framework"))
        XCTAssertTrue(items.bundles.contains("Frameworks/Demo.framework"))
        for rel in ["Cores/gba_core.dylib", "Resources/libs/helper.dylib", "libroot.dylib", "Deep/er/x/lib.so",
                    "Frameworks/libtweak.dylib"] {
            XCTAssertTrue(items.loose.contains(rel), "\(rel) must be found")
        }
        XCTAssertFalse(items.loose.contains("Cores/readme.dylib"), "text named .dylib is not a program")
        XCTAssertFalse(items.loose.contains("Cores/libstatic.a"))
        XCTAssertFalse(items.loose.contains("Demo"), "the app's own program is signed last, separately")
        XCTAssertFalse(items.loose.contains { $0.hasPrefix("Frameworks/Demo.framework/") }, "inside a bundle is left to it")

        let (key, cert) = try identity()
        let signer = BundleSigner(key: key, chain: [cert], profile: nil)
        try signer.sign(bundle: app)
        for rel in ["Cores/gba_core.dylib", "Resources/libs/helper.dylib", "libroot.dylib", "Deep/er/x/lib.so",
                    "Support/Odd.framework/Odd", "Frameworks/Demo.framework/Demo"] {
            let data = try Data(contentsOf: app.appendingPathComponent(rel))
            XCTAssertNotNil(try MachOFile(data: data).slices[0].existingSignature, "\(rel) must be signed")
        }
        // And the installer-style check agrees there is nothing unsigned left anywhere.
        let report = SignatureInspector.check(app: app, profile: nil)
        XCTAssertFalse(report.problems.contains { $0.kind == .structure }, report.summary)
    }

    func testNestedCodeIsFoundDeepestFirst() throws {
        let app = try makeBundle()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        let signer = BundleSigner(key: nil, chain: [], profile: nil)
        let nested = try signer.nestedCode(in: app)
        XCTAssertTrue(nested.contains("Frameworks/Demo.framework"))
        XCTAssertTrue(nested.contains("Frameworks/libtweak.dylib"))
    }

    func testAdhocBundleSigningWorksWithoutCertificate() throws {
        let app = try makeBundle()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        let signer = BundleSigner(key: nil, chain: [], profile: nil)
        signer.adhoc = true
        let cdhash = try signer.sign(bundle: app)
        XCTAssertEqual(cdhash.count, 32)
        let slice = try MachOFile(data: try Data(contentsOf: app.appendingPathComponent("Demo"))).slices[0]
        let sig = try XCTUnwrap(slice.existingSignature)
        let cdOffset = Int(sig.u32be(16))
        XCTAssertEqual(sig.u32be(cdOffset + 12) & CSFlags.adhoc, CSFlags.adhoc)
    }
}
