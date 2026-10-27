import XCTest
@testable import SignKit

/// Reading the files inside an app, and writing over them while signing - the editing the Sign
/// screen offers (`AppFilesView`).
final class AppContentsTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    func sample() throws -> URL {
        let paths = ["/projects/sandbox/research/ipa/Feather.ipa",
                     "/projects/sandbox/research/ipa/Ksign.ipa"]
        guard let found = paths.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("no sample .ipa in this environment")
        }
        return URL(fileURLWithPath: found)
    }

    func identity() throws -> IPASigner.Identity {
        try IPASigner.Identity.load(p12: AppContentsTests.fixtures.appendingPathComponent("testcert.p12"),
                                    password: "hunter2", profile: nil)
    }

    func temp() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("contents-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func testListsWhatIsInsideAnApp() throws {
        let entries = try AppContents.files(inIPA: try sample())
        XCTAssertTrue(entries.contains { $0.path == "Info.plist" && !$0.isFolder },
                      "every app has an Info.plist at its root")
        XCTAssertTrue(entries.contains { $0.isFolder }, "folders are worked out from the paths")
        XCTAssertFalse(entries.contains { $0.path.hasPrefix("Payload/") },
                       "paths are relative to the app itself")
        XCTAssertFalse(entries.contains { $0.path.hasSuffix("/") }, "no trailing slashes")
    }

    func testReadsOneFileOut() throws {
        let data = try AppContents.read(inIPA: try sample(), path: "Info.plist")
        let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        XCTAssertNotNil(info?["CFBundleIdentifier"])
        XCTAssertThrowsError(try AppContents.read(inIPA: try sample(), path: "not/there.plist"))
        // The size guard keeps a huge file from being opened by accident.
        XCTAssertThrowsError(try AppContents.read(inIPA: try sample(), path: "Info.plist", limit: 4))
    }

    func testTellsPlistsAndWordsFromEverythingElse() {
        XCTAssertEqual(AppContents.kind(of: "Info.plist", firstBytes: nil), .plist)
        XCTAssertEqual(AppContents.kind(of: "a/b/thing.json", firstBytes: nil), .text)
        XCTAssertEqual(AppContents.kind(of: "icon.png", firstBytes: Data([0x89, 0x50, 0, 1])), .other)
        XCTAssertEqual(AppContents.kind(of: "readme", firstBytes: Data("hello there".utf8)), .text)
    }

    func testEditedFilesGetSignedIn() throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let output = dir.appendingPathComponent("edited.ipa")

        // Edit the app's own settings file, and put a new file in.
        var info = try PropertyListSerialization.propertyList(
            from: try AppContents.read(inIPA: try sample(), path: "Info.plist"),
            format: nil) as? [String: Any] ?? [:]
        info["ContinuumWasHere"] = "yes"
        let edited = try PropertyListSerialization.data(fromPropertyList: info, format: .binary, options: 0)

        var options = SigningOptions()
        options.compressOutput = false
        options.replaceFiles = [
            "Info.plist": edited,
            "notes/hello.txt": Data("written while signing".utf8),
            // Must be ignored: it points outside the app.
            "../escaped.txt": Data("no".utf8),
        ]
        let result = try IPASigner().sign(ipa: try sample(), to: output,
                                          identity: try identity(), options: options)

        let names = try ZipReader(url: output).entries.map(\.name)
        XCTAssertTrue(names.contains { $0.hasSuffix(".app/notes/hello.txt") },
                      "a new file lands inside the app")
        XCTAssertFalse(names.contains { $0.contains("escaped.txt") },
                       "a path pointing outside the app is refused")

        let back = try PropertyListSerialization.propertyList(
            from: try AppContents.read(inIPA: output, path: "Info.plist"), format: nil) as? [String: Any]
        XCTAssertEqual(back?["ContinuumWasHere"] as? String, "yes", "the edit survived signing")

        // And the finished app still passes the installer-style check, which means the edited
        // file was hashed as it really is.
        XCTAssertTrue(result.warnings.isEmpty || !result.warnings.contains { $0.contains("Check failed") },
                      "\(result.warnings)")
    }
}
