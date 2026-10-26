import XCTest
@testable import SignKit

/// Checked against the real `embedded.mobileprovision` files inside shipping apps.
final class ProfileTests: XCTestCase {
    static let candidates = [
        "/projects/sandbox/research/ipa/x/ESign/Payload/ESign.app/embedded.mobileprovision",
        "/projects/sandbox/research/ipa/x/GBox/Payload/GBox.app/embedded.mobileprovision",
    ]

    func realProfiles() -> [URL] {
        ProfileTests.candidates.map { URL(fileURLWithPath: $0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    func testReadsRealProfiles() throws {
        let urls = realProfiles()
        guard !urls.isEmpty else { throw XCTSkip("no real profiles in this environment") }
        for url in urls {
            let p = try ProvisioningProfile(url: url)
            XCTAssertNotNil(p.uuid, url.path)
            XCTAssertNotNil(p.teamID)
            XCTAssertNotNil(p.expiry)
            XCTAssertFalse(p.entitlements.isEmpty)
            XCTAssertNotNil(p.applicationIdentifier)
            XCTAssertTrue(p.platforms.contains("iOS") || p.platforms.isEmpty)
            // The profile must list at least one signing certificate, and it must parse.
            XCTAssertFalse(p.certificates.isEmpty)
            for c in p.certificates { XCTAssertFalse(c.commonName.isEmpty) }
            // An enterprise profile has no device list; a development one does.
            if !p.isEnterprise { XCTAssertFalse(p.devices.isEmpty) }
            XCTAssertFalse(p.summary.isEmpty)
        }
    }

    func testBundleIDMatchingAndEntitlementRewrite() throws {
        let urls = realProfiles()
        guard let url = urls.first else { throw XCTSkip("no real profiles in this environment") }
        let p = try ProvisioningProfile(url: url)
        let team = try XCTUnwrap(p.teamID)
        let pattern = try XCTUnwrap(p.bundleIDPattern)

        if p.isWildcard {
            XCTAssertTrue(p.allows(bundleID: "com.anything.at.all"))
        } else {
            XCTAssertTrue(p.allows(bundleID: pattern))
            XCTAssertFalse(p.allows(bundleID: pattern + ".nope"))
        }

        // A wildcard profile grants every ID, so the app's own is used. A one-ID profile grants
        // only its own, so that is what goes in the permissions while the app keeps its name —
        // what zsign (ESign, GBox) does, and why apps signed with one certificate do not replace
        // each other.
        let rewritten = p.entitlements(forBundleID: "com.continuum.signer")
        let expected = p.isWildcard ? "\(team).com.continuum.signer" : "\(team).\(pattern)"
        XCTAssertEqual(rewritten["application-identifier"] as? String, expected)
        XCTAssertEqual(p.entitlements(forBundleID: pattern)["application-identifier"] as? String,
                       "\(team).\(pattern)", "its own ID always works")
        XCTAssertEqual(rewritten["com.apple.developer.team-identifier"] as? String, team)
        // No wildcard may survive the rewrite in the app identifier.
        XCTAssertFalse((rewritten["application-identifier"] as? String ?? "").hasSuffix("*"))
    }

    func testRejectsRubbish() {
        XCTAssertThrowsError(try ProvisioningProfile(data: Data("not a profile".utf8)))
    }
}
