import XCTest
@testable import SignKit

final class ZipTests: XCTestCase {
    /// A real `.ipa` if one is available in the sandbox; the tests skip quietly without it.
    static let sampleIPA = URL(fileURLWithPath: "/projects/sandbox/research/ipa/Feather.ipa")

    func tempDir() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("signkit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    func testCRC32AndDeflateRoundTrip() throws {
        XCTAssertEqual(Zip.crc32(Data("123456789".utf8)), 0xCBF43926)
        let blob = Data((0..<200_000).map { UInt8($0 % 97) })
        let packed = try Zip.deflate(blob)
        XCTAssertLessThan(packed.count, blob.count)
        XCTAssertEqual(try Zip.inflate(packed, expected: blob.count), blob)
    }

    func testWriteThenReadBack() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let zipURL = dir.appendingPathComponent("test.zip")

        let big = Data((0..<300_000).map { UInt8($0 % 251) })
        let w = try ZipWriter(url: zipURL)
        try w.addDirectory("Payload")
        try w.add(name: "Payload/Info.plist", data: Data("<plist/>".utf8))
        try w.add(name: "Payload/App", data: big, mode: 0o755)
        try w.add(name: "Payload/stored.bin", data: big, compress: false)
        try w.add(name: "Payload/link", data: Data("App".utf8), mode: 0o755, isSymlink: true)
        try w.finish()

        let r = try ZipReader(url: zipURL)
        XCTAssertEqual(r.entries.count, 5)
        let byName = Dictionary(uniqueKeysWithValues: r.entries.map { ($0.name, $0) })
        XCTAssertTrue(byName["Payload/"]?.isDirectory == true)
        XCTAssertEqual(try r.data(for: byName["Payload/Info.plist"]!), Data("<plist/>".utf8))
        XCTAssertEqual(try r.data(for: byName["Payload/App"]!), big)
        XCTAssertEqual(byName["Payload/App"]?.method, 8, "big files should be compressed")
        XCTAssertEqual(byName["Payload/stored.bin"]?.method, 0)
        XCTAssertEqual(try r.data(for: byName["Payload/stored.bin"]!), big)
        XCTAssertEqual((byName["Payload/App"]?.unixMode ?? 0) & 0o777, 0o755)
        XCTAssertTrue(byName["Payload/link"]?.isSymlink == true)
    }

    /// An .ipa handed over as a link (a shortcut to the real file) reads exactly like the file:
    /// the reader measures the file the link points to, not the few bytes of the link itself.
    func testReadsAnIPAThroughALink() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let real = dir.appendingPathComponent("real.ipa")
        let program = Data((0..<70_000).map { UInt8($0 % 13) })
        let w = try ZipWriter(url: real)
        try w.add(name: "Payload/App.app/App", data: program, mode: 0o755)
        try w.add(name: "Payload/App.app/Info.plist", data: Data("x".utf8))
        try w.finish()
        let link = dir.appendingPathComponent("link.ipa")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

        XCTAssertEqual(fileSize(of: link), fileSize(of: real))
        let r = try ZipReader(url: link)
        XCTAssertEqual(r.entries.count, 2)
        let app = try XCTUnwrap(r.entries.first { $0.name == "Payload/App.app/App" })
        XCTAssertEqual(try r.data(for: app), program)
    }

    /// A file packed through a link is stored with the bytes it points to, and its stored size
    /// matches them (before, the size came from the link and the archive came out broken).
    func testPacksAFileThroughALink() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let real = dir.appendingPathComponent("data.bin")
        let bytes = Data((0..<100_000).map { UInt8($0 % 241) })
        try bytes.write(to: real)
        let link = dir.appendingPathComponent("data-link.bin")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

        let zipURL = dir.appendingPathComponent("out.zip")
        let w = try ZipWriter(url: zipURL)
        try w.addFile(name: "data.bin", url: link, mode: 0o644, compress: true)
        try w.finish()
        let r = try ZipReader(url: zipURL)
        let e = try XCTUnwrap(r.entries.first)
        XCTAssertEqual(e.uncompressedSize, bytes.count)
        XCTAssertEqual(try r.data(for: e), bytes)
    }

    func testExtractAndRepackKeepsPermissions() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let src = dir.appendingPathComponent("a.zip")
        let w = try ZipWriter(url: src)
        try w.add(name: "Payload/App.app/App", data: Data(repeating: 7, count: 5000), mode: 0o755)
        try w.add(name: "Payload/App.app/Info.plist", data: Data("x".utf8))
        try w.finish()

        let out = dir.appendingPathComponent("out")
        try ZipReader(url: src).extractAll(to: out)
        let binary = out.appendingPathComponent("Payload/App.app/App")
        XCTAssertTrue(FileManager.default.fileExists(atPath: binary.path))
        let perms = try FileManager.default.attributesOfItem(atPath: binary.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(perms?.uint16Value, 0o755)

        let repacked = dir.appendingPathComponent("b.ipa")
        let w2 = try ZipWriter(url: repacked)
        try w2.addTree(at: out.appendingPathComponent("Payload"), prefix: "Payload/")
        try w2.finish()
        let r2 = try ZipReader(url: repacked)
        XCTAssertTrue(r2.entries.contains { $0.name == "Payload/App.app/App" && $0.unixMode & 0o777 == 0o755 })
    }

    func testReadsRealIPA() throws {
        guard FileManager.default.fileExists(atPath: ZipTests.sampleIPA.path) else {
            throw XCTSkip("no sample .ipa in this environment")
        }
        let r = try ZipReader(url: ZipTests.sampleIPA)
        XCTAssertGreaterThan(r.entries.count, 10)
        let info = try XCTUnwrap(r.entries.first { $0.name.hasSuffix(".app/Info.plist") })
        let d = try r.data(for: info)
        XCTAssertEqual(Zip.crc32(d), info.crc32, "decompressed bytes must match the stored checksum")
        let plist = try PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any]
        XCTAssertNotNil(plist?["CFBundleIdentifier"])
        // Every entry's checksum must come out right.
        for e in r.entries where !e.isDirectory && e.uncompressedSize < 2_000_000 && !e.isSymlink {
            XCTAssertEqual(Zip.crc32(try r.data(for: e)), e.crc32, e.name)
        }
    }
}
