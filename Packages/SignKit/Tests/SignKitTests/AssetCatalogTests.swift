import XCTest
@testable import SignKit

/// Reading Apple's compiled image set out of real apps: the names in it, the sizes, and how the
/// pixels are packed.
final class AssetCatalogTests: XCTestCase {
    /// Every sample app that has a compiled image set inside it.
    func catalogues() throws -> [(name: String, data: Data)] {
        let samples = ["Feather", "Ksign", "GBox", "SideStore"]
        var out: [(String, Data)] = []
        for name in samples {
            let ipa = URL(fileURLWithPath: "/projects/sandbox/research/ipa/\(name).ipa")
            guard FileManager.default.fileExists(atPath: ipa.path) else { continue }
            let reader = try ZipReader(url: ipa)
            let appDir = try AppContents.appDirectory(reader)
            guard let entry = reader.entries.first(where: { $0.name == appDir + "Assets.car" })
            else { continue }
            out.append((name, try reader.data(for: entry)))
        }
        if out.isEmpty { throw XCTSkip("no sample apps with a compiled image set here") }
        return out
    }

    func testReadsRealCatalogues() throws {
        for (name, data) in try catalogues() {
            let catalog = try AssetCatalog.read(data)
            XCTAssertFalse(catalog.renditions.isEmpty, "\(name) should have pictures in it")
            XCTAssertFalse(catalog.facets.isEmpty, "\(name) should name what it holds")
            XCTAssertTrue(catalog.facets.contains { $0.localizedCaseInsensitiveContains("icon") },
                          "\(name) names: \(catalog.facets.prefix(8))")

            for rendition in catalog.renditions {
                XCTAssertGreaterThanOrEqual(rendition.width, 0)
                XCTAssertLessThan(rendition.width, 20000, "\(name) \(rendition.name)")
                XCTAssertLessThan(rendition.height, 20000, "\(name) \(rendition.name)")
                XCTAssertFalse(rendition.name.contains("\u{0}"))
                // Sizes come in whole scales.
                XCTAssertTrue([0, 100, 200, 300].contains(rendition.scale),
                              "\(name) \(rendition.name) scale \(rendition.scale)")
            }

            // The icon is found, and it is a square one.
            let icon = try XCTUnwrap(catalog.bestIcon, "\(name) should have an icon")
            XCTAssertEqual(icon.width, icon.height, "\(name) icon \(icon.width)x\(icon.height)")
            XCTAssertGreaterThanOrEqual(icon.width, 60, "\(name)")
            XCTAssertGreaterThan(icon.payloadLength, 0, "\(name) icon has no pixels")
        }
    }

    func testSaysHowThePixelsArePacked() throws {
        // Every real catalogue here uses at least one of Apple's own packings, which is exactly
        // why the phone hands those to iOS instead of unpacking them itself.
        var sawApplePacking = false
        for (_, data) in try catalogues() {
            let catalog = try AssetCatalog.read(data)
            for rendition in catalog.renditions {
                if case .apple = rendition.packing { sawApplePacking = true }
                XCTAssertFalse(rendition.packing.label.isEmpty)
            }
        }
        XCTAssertTrue(sawApplePacking, "the packings Apple keeps to itself should be recognised")
    }

    func testRefusesSomethingThatIsNotACatalogue() {
        XCTAssertThrowsError(try AssetCatalog.read(Data("hello".utf8)))
        XCTAssertThrowsError(try AssetCatalog.read(Data(repeating: 0, count: 4096)))
    }

    func testWritesAPNGFromPlainPixels() throws {
        // Four pixels, blue-green-red-alpha the way Apple keeps them, one of them see-through.
        var pixels = Data()
        pixels.append(contentsOf: [255, 0, 0, 255])      // blue
        pixels.append(contentsOf: [0, 255, 0, 255])      // green
        pixels.append(contentsOf: [0, 0, 255, 255])      // red
        pixels.append(contentsOf: [0, 0, 0, 0])          // see-through
        let png = try XCTUnwrap(PNG.write(bgra: pixels, width: 2, height: 2, rowBytes: 8))
        XCTAssertEqual(Array(png.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        XCTAssertTrue(png.count > 40)
        // The size is in the first chunk, big-endian.
        XCTAssertEqual(png.u32be(16), 2)
        XCTAssertEqual(png.u32be(20), 2)
        XCTAssertNotNil(String(data: png.sub(12, 4), encoding: .utf8).map { $0 == "IHDR" })
    }
}
