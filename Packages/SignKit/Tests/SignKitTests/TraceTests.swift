import XCTest
@testable import SignKit

/// The breadcrumb file: what Settings shows after the app is closed part-way through a job.
final class TraceTests: XCTestCase {
    func tempDir() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("trace-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    override func tearDown() {
        Trace.isOn = false
        super.tearDown()
    }

    /// Off by default: nothing is written and nothing costs anything.
    func testWritesNothingWhileOff() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("trace.txt")
        Trace.isOn = false
        Trace.start(at: file, what: "App.ipa")
        Trace.phase("listing")
        Trace.step(0, of: 10, "a/b.png")
        Trace.finish()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNil(Trace.summary(of: file))
    }

    /// A finished run says so; the lines name each phase in order.
    func testRecordsPhasesAndSaysItFinished() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("trace.txt")
        Trace.isOn = true
        Trace.start(at: file, what: "App.ipa")
        Trace.note("3 files inside")
        Trace.phase("unpacking")
        Trace.step(0, of: 3, "Payload/App.app/App")
        Trace.phase("signing")
        Trace.finish("signed com.example.app")

        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(text.contains("trace of App.ipa"))
        XCTAssertTrue(text.contains("3 files inside"))
        XCTAssertTrue(text.contains("--- unpacking"))
        XCTAssertTrue(text.contains("unpacking: 1 of 3 — Payload/App.app/App"))
        XCTAssertTrue(text.contains("=== signed com.example.app"))
        XCTAssertEqual(Trace.summary(of: file), "finished normally")
    }

    /// The point of the whole thing: killed part-way through, the file still names the last
    /// thing it was doing, and the summary says it was closed unexpectedly.
    func testAKilledRunStillNamesWhereItWas() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("trace.txt")
        Trace.isOn = true
        Trace.start(at: file, what: "PUBG MOBILE.ipa")
        Trace.phase("listing ShadowTrackerExtra.app: 120000 files, 1 links")
        Trace.step(83_213, of: 120_000, "cookeddata/Paks/group137/asset_0042.uasset")
        // No finish(): the app is gone.

        let summary = try XCTUnwrap(Trace.summary(of: file))
        XCTAssertTrue(summary.hasPrefix("closed unexpectedly at — "), summary)
        XCTAssertTrue(summary.contains("83214 of 120000"), summary)
        XCTAssertTrue(summary.contains("group137/asset_0042.uasset"), summary)
    }

    /// An error of its own is recorded as a reason, not as a crash.
    func testAnErrorIsRecordedAsAReason() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("trace.txt")
        Trace.isOn = true
        Trace.start(at: file, what: "App.ipa")
        Trace.failed("not enough room on the phone")
        XCTAssertEqual(Trace.summary(of: file), "stopped: not enough room on the phone")
    }

    /// A new run keeps the last one beside it, so starting again does not wipe the crash.
    func testTheRunBeforeIsKept() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("trace.txt")
        let previous = dir.appendingPathComponent("trace-previous.txt")
        Trace.isOn = true
        Trace.start(at: file, what: "First.ipa")
        Trace.phase("listing")
        Trace.step(5, of: 9, "the file it died on")
        Trace.start(at: file, what: "Second.ipa")
        Trace.finish()

        XCTAssertEqual(Trace.summary(of: file), "finished normally")
        let old = try XCTUnwrap(Trace.summary(of: previous))
        XCTAssertTrue(old.contains("the file it died on"), old)
        XCTAssertTrue(try String(contentsOf: previous, encoding: .utf8).contains("trace of First.ipa"))
    }

    /// Packing does not know how many files there are; the line then just counts.
    func testAnUnknownTotalJustCounts() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("trace.txt")
        Trace.isOn = true
        Trace.start(at: file, what: "App.ipa")
        Trace.phase("packing the app back up")
        Trace.step(41, of: 0, "Payload/App.app/thing.png")
        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(text.contains("packing the app back up: 42 — Payload/App.app/thing.png"), text)
        XCTAssertFalse(text.contains("of 0"))
    }

    /// Per-file lines are rate-limited, so a huge app costs a few hundred writes, not 120,000.
    func testPerFileLinesAreRateLimited() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("trace.txt")
        Trace.isOn = true
        Trace.start(at: file, what: "Big.ipa")
        Trace.phase("listing")
        for i in 0..<20_000 { Trace.step(i, of: 20_000, "file\(i)") }
        Trace.finish()
        let lines = try String(contentsOf: file, encoding: .utf8).split(separator: "\n").count
        XCTAssertLessThan(lines, 200, "one line per file would make the file useless and slow")
        // Even when the phase races through, every few thousand files leave a mark, so a crash
        // is narrowed to a couple of thousand rather than the whole app.
        XCTAssertGreaterThanOrEqual(lines, 20_000 / Trace.everyItems, "too coarse to be useful")
    }

    /// Several cores reporting at once must not tear the file or crash.
    func testManyThreadsAtOnce() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("trace.txt")
        Trace.isOn = true
        Trace.start(at: file, what: "Threads.ipa")
        Trace.phase("listing")
        DispatchQueue.concurrentPerform(iterations: 4000) { i in
            Trace.step(i, of: 4000, "file\(i)")
        }
        Trace.finish()
        let text = try String(contentsOf: file, encoding: .utf8)
        for line in text.split(separator: "\n") where !line.isEmpty {
            XCTAssertTrue(line.contains("s "), "every line keeps its time stamp: \(line)")
        }
        XCTAssertEqual(Trace.summary(of: file), "finished normally")
    }
}
