import XCTest
@testable import SignKit

/// Reading and writing the codes signers pass around to share a whole list of repositories.
///
/// The ESign code below was worked out separately, outside Swift, from the key published on
/// FlareStore's Repository Decoder page - so this pins our flipping against theirs byte for
/// byte, not just against itself.
final class ShareCodeTests: XCTestCase {
    let urls = ["https://repo.example.com/apps.json",
                "https://feather.example.org/source.json"]

    func testReadsAnESignCode() throws {
        let code = "source[5GHxhb1U7Lcumpoh+isTdMmoc0QL0rsGT73znG670uVqL33PXzB5oH/7fTM27L61OtVyoo3e2t6YMEjDJmIPrCBWjD3Nc7rVn8U=]"
        let found = try XCTUnwrap(ShareCode.decode(code))
        XCTAssertEqual(found.format, .esign)
        XCTAssertEqual(found.urls.map(\.absoluteString), urls)
    }

    func testWritesTheSameESignCode() {
        let made = ShareCode.encode(urls.compactMap(URL.init(string:)), as: .esign)
        XCTAssertEqual(made,
                       "source[5GHxhb1U7Lcumpoh+isTdMmoc0QL0rsGT73znG670uVqL33PXzB5oH/7fTM27L61OtVyoo3e2t6YMEjDJmIPrCBWjD3Nc7rVn8U=]")
    }

    func testTheKeyIsTheRightOne() {
        // 5056 bytes, and it must not be all zeroes or a stub.
        XCTAssertEqual(ShareCode.esignKey.count, 5056)
        XCTAssertEqual(ShareCode.esignKey.first, 140)
        XCTAssertEqual(ShareCode.esignKey.last, 230)
    }

    func testTheOtherSignersCodes() throws {
        let flare = "aHR0cHM6Ly9yZXBvLmV4YW1wbGUuY29tL2FwcHMuanNvbltGJF1odHRwczovL2ZlYXRoZXIuZXhhbXBsZS5vcmcvc291cmNlLmpzb24="
        let found = try XCTUnwrap(ShareCode.decode(flare))
        XCTAssertEqual(found.format, .flareStore)
        XCTAssertEqual(found.urls.count, 2)

        for format in [ShareCode.Format.kravaSign, .mapleSign, .flareStore, .base64, .plain] {
            let code = ShareCode.encode(urls.compactMap(URL.init(string:)), as: format)
            let back = try XCTUnwrap(ShareCode.decode(code), "\(format) did not come back")
            XCTAssertEqual(back.urls.map(\.absoluteString), urls, "\(format)")
            if format != .base64 {
                XCTAssertEqual(back.format, format, "the format should be recognised")
            }
        }
    }

    func testPlainTextAndMess() throws {
        let messy = """
        Here are my repos:
          https://one.example.com/apps.json , https://two.example.com/repo.json
        (https://three.example.com/x.json)
        not-a-url  ftp://nope.example.com/a.json
        """
        let found = try XCTUnwrap(ShareCode.decode(messy))
        XCTAssertEqual(found.format, .plain)
        XCTAssertEqual(found.urls.map(\.absoluteString),
                       ["https://one.example.com/apps.json",
                        "https://two.example.com/repo.json",
                        "https://three.example.com/x.json"])
    }

    func testNoRepeats() throws {
        let found = try XCTUnwrap(ShareCode.decode("https://a.example.com/r.json https://a.example.com/r.json"))
        XCTAssertEqual(found.urls.count, 1)
    }

    func testRubbishIsRefused() {
        XCTAssertNil(ShareCode.decode(""))
        XCTAssertNil(ShareCode.decode("hello there"))
        XCTAssertNil(ShareCode.decode("source[not base64 at all!!]"))
        // A code flipped with the wrong key: no addresses come out, so it is refused.
        XCTAssertNil(ShareCode.decode("source[" + Data(repeating: 7, count: 64).base64EncodedString() + "]"))
    }
}
