import XCTest
@testable import SignKit

/// Work folders a killed signing run leaves behind, and that clearing them touches nothing else.
final class LeftoverTests: XCTestCase {
    func testClearsOnlyOurOwnWorkFolders() throws {
        let fm = FileManager.default
        let temp = fm.temporaryDirectory
        let mine = temp.appendingPathComponent("signkit-\(UUID().uuidString)")
        try fm.createDirectory(at: mine.appendingPathComponent("Payload/App.app"),
                               withIntermediateDirectories: true)
        try Data(repeating: 7, count: 300_000).write(to: mine.appendingPathComponent("Payload/App.app/big.bin"))
        let other = temp.appendingPathComponent("someone-else-\(UUID().uuidString)")
        try fm.createDirectory(at: other, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: other.appendingPathComponent("file.txt"))

        let freed = IPASigner.clearLeftovers()

        XCTAssertFalse(fm.fileExists(atPath: mine.path), "our leftover work folder should be gone")
        XCTAssertTrue(fm.fileExists(atPath: other.path), "someone else's folder must be left alone")
        XCTAssertGreaterThanOrEqual(freed, 300_000, "should report what it freed")
        try? fm.removeItem(at: other)
    }
}
