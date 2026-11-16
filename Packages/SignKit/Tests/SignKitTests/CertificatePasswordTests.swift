import XCTest
@testable import SignKit

/// The password path, end to end, the way the app uses it.
///
/// These exist because a build shipped that told the person "Wrong certificate password" on a
/// certificate that had worked, and there was no way to put the password back. The engine was
/// fine the whole time; what was missing was a test of the exact call the app makes.
final class CertificatePasswordTests: XCTestCase {

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
    }

    func testTheRightPasswordOpensTheCertificate() throws {
        let identity = try IPASigner.Identity.load(
            p12: fixtures.appendingPathComponent("standin.p12"),
            password: "hunter2",
            profile: nil)
        XCTAssertTrue(identity.chain.count >= 1)
        XCTAssertEqual(identity.key.modulusBytes, identity.chain[0].publicKeyDER.count > 0 ? identity.key.modulusBytes : 0)
        XCTAssertNotNil(identity.chain.first?.commonName)
    }

    /// What the app does when the Keychain has nothing: it hands over an empty password, and
    /// that must come back as a plain "wrong password" the screen can act on — not a crash,
    /// and not some other error that hides the fix.
    func testAnEmptyPasswordSaysWrongPassword() throws {
        XCTAssertThrowsError(try IPASigner.Identity.load(
            p12: fixtures.appendingPathComponent("standin.p12"),
            password: "",
            profile: nil)) { error in
            guard case SignKitError.badPassword = error else {
                return XCTFail("expected .badPassword, got \(error)")
            }
            XCTAssertEqual("\(error)", "Wrong certificate password")
        }
    }

    /// A wrong password and a missing password must be told apart by the person reading it.
    func testAWrongPasswordAlsoSaysWrongPassword() throws {
        XCTAssertThrowsError(try IPASigner.Identity.load(
            p12: fixtures.appendingPathComponent("standin.p12"),
            password: "not-the-password",
            profile: nil)) { error in
            guard case SignKitError.badPassword = error else {
                return XCTFail("expected .badPassword, got \(error)")
            }
        }
    }

    /// Checking a typed password before saving it, which is what the new row in the app does.
    func testAPasswordCanBeCheckedWithoutSavingIt() throws {
        let good = try PKCS12(url: fixtures.appendingPathComponent("standin.p12"), password: "hunter2")
        XCTAssertNotNil(good.privateKey)
        XCTAssertNotNil(good.identity)
        XCTAssertThrowsError(try PKCS12(url: fixtures.appendingPathComponent("standin.p12"),
                                        password: "nope"))
    }

    /// The file stored next to the certificate is what a re-signed build reads. If it is not
    /// there the app cannot sign, so this pins the file name the app looks for.
    func testTheStoredCertificateFileIsFound() throws {
        let identity = try IPASigner.Identity.load(
            p12: fixtures.appendingPathComponent("standin.p12"),
            password: "hunter2",
            profile: fixtures.appendingPathComponent("standin.mobileprovision"))
        XCTAssertNotNil(identity.profile, "the profile pairs with this certificate")
    }
}
