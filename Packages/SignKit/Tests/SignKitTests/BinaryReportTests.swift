import XCTest
@testable import SignKit

/// Reading what is inside a real app: its programs, what they link, and what the signature
/// already in them says.
final class BinaryReportTests: XCTestCase {
    func sample() throws -> URL {
        let paths = ["/projects/sandbox/research/ipa/Feather.ipa",
                     "/projects/sandbox/research/ipa/Ksign.ipa"]
        guard let found = paths.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("no sample .ipa in this environment")
        }
        return URL(fileURLWithPath: found)
    }

    func testReadsTheProgramsInsideARealApp() throws {
        let reports = try BinaryReport.read(ipa: try sample())
        XCTAssertFalse(reports.isEmpty, "a real app has at least its own program")

        let main = try XCTUnwrap(reports.first)
        XCTAssertTrue(main.isMainProgram, "the app's own program comes first")
        XCTAssertTrue(main.architectures.contains("arm64"), "\(main.architectures)")
        XCTAssertGreaterThan(main.bytes, 1024)
        XCTAssertFalse(main.links.isEmpty, "every program links something")
        XCTAssertTrue(main.links.contains { BinaryReport.isSystem($0) },
                      "iOS libraries are recognised as part of the system")

        // What came out of the App Store or another signer is signed, and the facts should read.
        let facts = try XCTUnwrap(main.signature, "the program in a shipped app is signed")
        XCTAssertFalse(facts.identifier.isEmpty, "a signature names what it signed")
        XCTAssertEqual(facts.hashKind, "SHA-256")
        XCTAssertGreaterThan(facts.pageHashes, 0)
    }

    func testReportsWhatWeSignedOurselves() throws {
        let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures")
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("report-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("signed.ipa")

        let identity = try IPASigner.Identity.load(
            p12: fixtures.appendingPathComponent("testcert.p12"), password: "hunter2", profile: nil)
        var options = SigningOptions()
        options.compressOutput = false
        options.extraEntitlements = ["get-task-allow": true]
        _ = try IPASigner().sign(ipa: try sample(), to: output, identity: identity, options: options)

        let main = try XCTUnwrap(try BinaryReport.read(ipa: output).first)
        let facts = try XCTUnwrap(main.signature)
        XCTAssertFalse(facts.isAdHoc, "it was signed with a certificate")
        XCTAssertTrue(facts.hasEntitlements, "the permissions are in there")
        XCTAssertEqual(facts.identifier, main.signature?.identifier)
        XCTAssertFalse(facts.identifier.isEmpty)
    }
}
