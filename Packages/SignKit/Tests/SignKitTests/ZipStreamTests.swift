import XCTest
@testable import SignKit

/// Big files must go through in chunks, never in one lump, or a phone runs out of memory.
final class ZipStreamTests: XCTestCase {
    func temp() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("zs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    /// 12 MB of patterned data, over the 8 MB line where streaming kicks in.
    func bigFile(at url: URL, mb: Int = 12) throws -> Data {
        var data = Data()
        data.reserveCapacity(mb << 20)
        var seed: UInt32 = 1
        for _ in 0..<(mb << 18) {          // 4 bytes at a time
            seed = seed &* 1_664_525 &+ 1_013_904_223
            data.put32le(seed)
        }
        try data.write(to: url)
        return data
    }

    func testStreamedWriteAndReadBack() throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("big.bin")
        let original = try bigFile(at: source)

        for compress in [false, true] {
            let zipURL = dir.appendingPathComponent("out-\(compress).zip")
            let w = try ZipWriter(url: zipURL)
            try w.addFile(name: "Payload/App.app/App", url: source, mode: 0o755, compress: compress)
            try w.add(name: "Payload/App.app/Info.plist", data: Data("<plist/>".utf8))
            try w.finish()

            let r = try ZipReader(url: zipURL)
            XCTAssertEqual(r.entries.count, 2)
            let entry = try XCTUnwrap(r.entries.first { $0.name.hasSuffix("/App") })
            XCTAssertEqual(entry.uncompressedSize, original.count)
            XCTAssertEqual(entry.method, compress ? 8 : 0)
            XCTAssertEqual(entry.crc32, Zip.crc32(original))
            XCTAssertEqual(entry.unixMode & 0o777, 0o755)
            // Read it back both ways: in one go, and streamed to disk.
            XCTAssertEqual(try r.data(for: entry), original)
            let out = dir.appendingPathComponent("back-\(compress).bin")
            try r.extract(entry, to: out)
            XCTAssertEqual(try Data(contentsOf: out), original)
        }
    }

    func testStreamedExtractionOfEveryBigEntryInARealIPA() throws {
        let path = "/projects/sandbox/research/ipa/SideStore.ipa"
        guard FileManager.default.fileExists(atPath: path) else { throw XCTSkip("no sample .ipa here") }
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let r = try ZipReader(url: URL(fileURLWithPath: path))
        let big = r.entries.filter { !$0.isDirectory && !$0.isSymlink && $0.uncompressedSize > 8 << 20 }
        guard !big.isEmpty else { throw XCTSkip("nothing big enough in the sample") }
        for entry in big {
            let dest = dir.appendingPathComponent("entry-\(abs(entry.name.hashValue)).bin")
            // extract() checks the checksum itself and throws if it does not match.
            try r.extract(entry, to: dest)
            let size = (try FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int) ?? 0
            XCTAssertEqual(size, entry.uncompressedSize, entry.name)
            try? FileManager.default.removeItem(at: dest)
        }
    }

    /// Signing a real app end to end still works with the streaming paths in play.
    func testSigningStillWorksWithStreaming() throws {
        let path = "/projects/sandbox/research/ipa/SideStore.ipa"
        guard FileManager.default.fileExists(atPath: path) else { throw XCTSkip("no sample .ipa here") }
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures")
        let identity = try IPASigner.Identity.load(p12: fixtures.appendingPathComponent("testcert.p12"),
                                                   password: "hunter2", profile: nil)
        let output = dir.appendingPathComponent("signed.ipa")
        var options = SigningOptions()
        options.compressOutput = false
        let result = try IPASigner().sign(ipa: URL(fileURLWithPath: path), to: output,
                                          identity: identity, options: options)
        XCTAssertEqual(result.cdhash.count, 32)

        // Everything in the finished app must still check out.
        let reader = try ZipReader(url: output)
        XCTAssertTrue(reader.entries.contains { $0.name.hasSuffix(".app/_CodeSignature/CodeResources") })
        for e in reader.entries where !e.isDirectory && !e.isSymlink {
            if e.uncompressedSize > 8 << 20 {
                let dest = dir.appendingPathComponent("check.bin")
                try reader.extract(e, to: dest)      // throws if the checksum is wrong
                try? FileManager.default.removeItem(at: dest)
            } else {
                XCTAssertEqual(Zip.crc32(try reader.data(for: e)), e.crc32, e.name)
            }
        }
    }
}
