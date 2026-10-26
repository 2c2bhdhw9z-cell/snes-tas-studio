import XCTest
@testable import SignKit

/// Telling a newer version from an older one, including the places plain text comparison
/// gets it wrong.
final class VersionTests: XCTestCase {
    func testNumbersNotLetters() {
        // The one that matters: text comparison says 1.10 < 1.9.
        XCTAssertTrue(Version.isNewer("1.10", than: "1.9"))
        XCTAssertFalse(Version.isNewer("1.9", than: "1.10"))
        XCTAssertTrue(Version.isNewer("2.0", than: "1.99.99"))
        XCTAssertTrue(Version.isNewer("1.0.1", than: "1.0"))
        XCTAssertFalse(Version.isNewer("1.0", than: "1.0.0"))
    }

    func testSame() {
        XCTAssertEqual(Version.compare("1.2.3", "1.2.3"), .orderedSame)
        XCTAssertEqual(Version.compare("1.2.0", "1.2"), .orderedSame)
        XCTAssertFalse(Version.isNewer("3.4", than: "3.4"))
    }

    func testBetasComeBeforeTheRealThing() {
        XCTAssertTrue(Version.isNewer("1.0", than: "1.0-beta2"))
        XCTAssertFalse(Version.isNewer("1.0-beta2", than: "1.0"))
        XCTAssertTrue(Version.isNewer("1.0-beta3", than: "1.0-beta2"))
    }

    func testOddShapes() {
        XCTAssertTrue(Version.isNewer("234", than: "233"))
        XCTAssertTrue(Version.isNewer("v2.1", than: "v2.0"))
        XCTAssertFalse(Version.isNewer("", than: "1.0"))
        XCTAssertTrue(Version.isNewer("1.0", than: ""))
        XCTAssertFalse(Version.isNewer("", than: ""))
        XCTAssertTrue(Version.isNewer("10.0.1", than: "9.9.9"))
    }
}
