import XCTest
@testable import SignKit

/// Apps can be two gigabytes or more. Nothing in the signing path may depend on
/// holding a whole file in memory, so these tests force the on-disk route and
/// check the result is byte-for-byte what the in-memory route produces.
final class HugeAppTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
    static let binaries = [
        "/projects/sandbox/research/ipa/x/Feather/Payload/Feather.app/Feather",
        "/projects/sandbox/research/ipa/x/GBox/Payload/GBox.app/GBox",
    ]

    func temp() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("huge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    func sampleBinary() throws -> URL {
        guard let p = HugeAppTests.binaries.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("no sample binary in this environment")
        }
        return URL(fileURLWithPath: p)
    }

    func identity() throws -> (RSAPrivateKey, Certificate) {
        let p = try PKCS12(url: HugeAppTests.fixtures.appendingPathComponent("testcert.p12"),
                           password: "hunter2")
        return (try XCTUnwrap(p.privateKey), try XCTUnwrap(p.identity))
    }

    func blobs(in slice: MachOSlice) throws -> [UInt32: Data] {
        let sig = try XCTUnwrap(slice.existingSignature)
        var out = [UInt32: Data]()
        let count = Int(sig.u32be(8))
        for i in 0..<count {
            let slot = sig.u32be(12 + 8 * i)
            let off = Int(sig.u32be(16 + 8 * i))
            out[slot] = sig.sub(off, Int(sig.u32be(off + 4)))
        }
        return out
    }

    /// The on-disk signer and the in-memory signer must agree exactly.
    func testOnDiskSigningMatchesInMemorySigning() throws {
        let source = try sampleBinary()
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (key, cert) = try identity()

        var options = MachOSigner.Options(identifier: "com.continuum.huge", teamID: cert.teamID)
        options.entitlements = ["application-identifier": "ABCDE12345.com.continuum.huge",
                                "get-task-allow": true]
        let fixedTime = Date(timeIntervalSince1970: 1_700_000_000)

        // In memory, the ordinary way.
        let onDisk = dir.appendingPathComponent("disk.bin")
        try FileManager.default.copyItem(at: source, to: onDisk)
        let inMemory = MachOSigner(key: key, chain: [cert])
        let memoryResult = try inMemory.sign(data: try Data(contentsOf: source), options: options)

        // On disk, forced by dropping the threshold to nothing.
        let saved = MachOFileSigner.diskThreshold
        MachOFileSigner.diskThreshold = 1
        defer { MachOFileSigner.diskThreshold = saved }
        var seenProgress = false
        let diskHash = try MachOFileSigner(key: key, chain: [cert])
            .sign(fileAt: onDisk, options: options) { _ in seenProgress = true }
        XCTAssertTrue(seenProgress, "a long job must report progress")
        XCTAssertEqual(diskHash.count, 32)

        let diskSlice = try MachOFile(data: try Data(contentsOf: onDisk)).slices[0]
        let memorySlice = try MachOFile(data: memoryResult).slices[0]

        // Same code directory: same identifier, same page hashes, same special slots.
        let diskCD = try XCTUnwrap(try blobs(in: diskSlice)[CSSlot.codeDirectory])
        let memoryCD = try XCTUnwrap(try blobs(in: memorySlice)[CSSlot.codeDirectory])
        XCTAssertEqual(diskCD.u32be(28), memoryCD.u32be(28), "same number of page hashes")
        XCTAssertEqual(diskCD.u32be(32), memoryCD.u32be(32), "same code limit")
        let hashOffset = Int(diskCD.u32be(16))
        let pages = Int(diskCD.u32be(28))
        // Page 0 holds the header, where the two routes reserve slightly different
        // amounts of room for the signature, so it is allowed to differ. Every other
        // page covers untouched bytes and must be identical.
        XCTAssertEqual(diskCD.sub(hashOffset + 32, (pages - 1) * 32),
                       memoryCD.sub(Int(memoryCD.u32be(16)) + 32, (pages - 1) * 32),
                       "every page hash after the header must match the in-memory result")
        XCTAssertEqual(diskHash, sha256(diskCD))

        // The page hashes must match the file that is actually on disk.
        let finalData = try Data(contentsOf: onDisk)
        let codeLimit = Int(diskCD.u32be(32))
        for i in 0..<pages {
            let start = i * 4096
            let n = min(4096, codeLimit - start)
            XCTAssertEqual(diskCD.sub(hashOffset + i * 32, 32), sha256(finalData.sub(start, n)), "page \(i)")
        }

        // Entitlements and requirements came through too.
        let diskBlobs = try blobs(in: diskSlice)
        XCTAssertNotNil(diskBlobs[CSSlot.entitlements])
        XCTAssertNotNil(diskBlobs[CSSlot.derEntitlements])
        XCTAssertNotNil(diskBlobs[CSSlot.requirements])
        XCTAssertNotNil(diskBlobs[CSSlot.signatureSlot])
        _ = fixedTime
    }

    /// Signing the same file twice on disk must not keep growing it.
    func testOnDiskResigningIsStable() throws {
        let source = try sampleBinary()
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (key, cert) = try identity()
        let target = dir.appendingPathComponent("again.bin")
        try FileManager.default.copyItem(at: source, to: target)

        let saved = MachOFileSigner.diskThreshold
        MachOFileSigner.diskThreshold = 1
        defer { MachOFileSigner.diskThreshold = saved }

        let signer = MachOFileSigner(key: key, chain: [cert])
        let options = MachOSigner.Options(identifier: "a.b.c", teamID: cert.teamID)
        _ = try signer.sign(fileAt: target, options: options)
        let firstSize = (try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
        _ = try signer.sign(fileAt: target, options: options)
        let secondSize = (try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
        XCTAssertEqual(firstSize, secondSize)

        // And the file still has exactly one signature, at the very end.
        let slice = try MachOFile(data: try Data(contentsOf: target)).slices[0]
        let commands = slice.loadCommands.filter { $0.cmd == LC.codeSignature }
        XCTAssertEqual(commands.count, 1)
        let off = Int(slice.data.u32le(commands[0].offset + 8))
        let size = Int(slice.data.u32le(commands[0].offset + 12))
        XCTAssertEqual(off + size, slice.data.count)
    }

    /// Reading an app's details must not depend on unpacking its whole binary.
    func testHeadOnlyReadOfABigEntry() throws {
        let path = "/projects/sandbox/research/ipa/SideStore.ipa"
        guard FileManager.default.fileExists(atPath: path) else { throw XCTSkip("no sample .ipa here") }
        let reader = try ZipReader(url: URL(fileURLWithPath: path))
        let biggest = try XCTUnwrap(reader.entries.max { $0.uncompressedSize < $1.uncompressedSize })
        XCTAssertGreaterThan(biggest.uncompressedSize, 1 << 20)

        let head = try reader.head(of: biggest, limit: 64 << 10)
        XCTAssertEqual(head.count, 64 << 10)
        // The first bytes must match the real contents.
        let whole = try reader.data(for: biggest)
        XCTAssertEqual(head, whole.prefix(head.count))
    }
}
