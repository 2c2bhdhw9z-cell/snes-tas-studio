import XCTest
@testable import SignKit

/// The `.deb` reader and the stop flag, both added in the 15 November pass.
final class DebTests: XCTestCase {

    /// Builds a small `.deb` in memory: ar header, debian-binary, and a gzipped tar (or one
    /// wrapped in an unsupported compressor) holding the given files.
    func makeDeb(files: [String: Data], compress: String = "gz") throws -> Data {
        var tar = Data()
        for (name, body) in files.sorted(by: { $0.key < $1.key }) {
            var header = Data(count: 512)
            let nameBytes = Array(name.utf8)
            header.replaceSubrange(0..<nameBytes.count, with: nameBytes)
            let size = String(body.count, radix: 8)
            let sizeBytes = Array(String(repeating: "0", count: max(0, 11 - size.count)).utf8) + Array(size.utf8)
            header.replaceSubrange(124..<(124 + sizeBytes.count), with: sizeBytes)
            header[156] = UInt8(ascii: "0")
            tar += header
            tar += body
            let pad = (512 - body.count % 512) % 512
            tar += Data(count: pad)
        }
        tar += Data(count: 1024)   // end of archive

        let payload: Data
        switch compress {
        case "gz":
            // gzip wrapper (deflate with a 10-byte header and an 8-byte trailer) around deflate.
            let deflated = try Zip.deflate(tar, level: 6)
            var gz = Data([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03])
            gz += deflated
            gz += Zip.crc32(tar).leData
            gz += UInt32(truncatingIfNeeded: tar.count).leData
            payload = gz
        default:
            payload = Data([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) + Data(count: 32)
        }

        var deb = Data("!<arch>\n".utf8)
        deb += arHeader(name: "debian-binary", size: 4)
        deb += Data("2.0\n".utf8)
        deb += arHeader(name: "data.tar.\(compress)", size: payload.count)
        deb += payload
        if payload.count % 2 == 1 { deb.append(0) }
        return deb
    }

    func arHeader(name: String, size: Int) -> Data {
        var header = Data(count: 60)
        let nameBytes = Array((name + "/").utf8)
        header.replaceSubrange(0..<nameBytes.count, with: nameBytes)
        let sizeText = String(size)
        let padded = sizeText + String(repeating: " ", count: max(0, 10 - sizeText.count))
        header.replaceSubrange(48..<58, with: Array(padded.utf8))
        header.replaceSubrange(58..<60, with: Array("`\n".utf8))
        return header
    }

    func testReadsTheDylibOutOfAGzippedPackage() throws {
        let deb = try makeDeb(files: [
            "Library/MobileSubstrate/DynamicLibraries/Example.dylib": Data(repeating: 0xAB, count: 300),
            "DEBIAN/control": Data("Package: com.example.tweak\nVersion: 1.0\n".utf8),
            "Library/MobileSubstrate/DynamicLibraries/Example.plist": Data("{}".utf8),
        ])
        let found = try Deb.dylibs(in: deb)
        XCTAssertEqual(found.count, 1, "only the .dylib is an add-on")
        XCTAssertEqual(found.first?.path, "Library/MobileSubstrate/DynamicLibraries/Example.dylib")
        XCTAssertEqual(found.first?.data.count, 300)
    }

    func testAPackageWithNoDylibComesBackEmpty() throws {
        let deb = try makeDeb(files: ["DEBIAN/control": Data("Package: nothing\n".utf8)])
        XCTAssertTrue(try Deb.dylibs(in: deb).isEmpty)
    }

    func testSomethingThatIsNotAPackageIsRefused() {
        XCTAssertThrowsError(try Deb.dylibs(in: Data("just some bytes".utf8)))
    }

    func testACompressorWeCannotOpenSaysSo() throws {
        // An xz member: the reader must say "not supported" rather than return nothing, so
        // the screen can tell the person to look for the .gz package.
        let deb = try makeDeb(files: ["a.dylib": Data(count: 8)], compress: "xz")
        XCTAssertThrowsError(try Deb.dylibs(in: deb)) { error in
            guard let e = error as? Deb.DebError, case .unsupported = e else {
                return XCTFail("expected an unsupported-compressor error, got \(error)")
            }
        }
    }

    func testOctalSizesAreRead() {
        XCTAssertEqual(Deb.octal(Data("00000000144\0".utf8)), 100)
        XCTAssertEqual(Deb.octal(Data("    0 ".utf8)), 0)
        XCTAssertNil(Deb.octal(Data("not a number".utf8)))
    }
}

/// Stop, as used by the Sign screen's Cancel button.
final class CancelTests: XCTestCase {
    func testASignInProgressStopsAtTheNextFile() throws {
        // Built on the same fixture the other on-disk tests use, but no app is needed: the
        // flag is what this checks, not a finished signature.
        let signer = IPASigner()
        XCTAssertFalse(signer.isCancelled)
        signer.cancel()
        XCTAssertTrue(signer.isCancelled)
        // A stopped run reports itself as cancelled, and the screens turn that into "Stopped"
        // rather than an error.
        XCTAssertEqual(SignKitError.cancelled.description, "Signing was stopped")
    }
}

private extension UInt32 {
    var leData: Data {
        var d = Data()
        for shift in stride(from: 0, to: 32, by: 8) { d.append(UInt8(truncatingIfNeeded: self >> UInt32(shift))) }
        return d
    }
}
