import Foundation
import Network
#if canImport(Security)
import Security
#endif
import SignKit

/// Turns a `.p12` holding a web certificate into something the phone's own web server
/// can use for HTTPS. iOS insists the install manifest comes over HTTPS, so when the
/// whole job is done on the phone we need a certificate for a name that points at the phone.
enum KeychainTLS {
    #if canImport(Security)
    static func identity(p12: Data, password: String) throws -> sec_identity_t {
        var items: CFArray?
        let options: [String: Any] = [kSecImportExportPassphrase as String: password]
        let status = SecPKCS12Import(p12 as CFData, options as CFDictionary, &items)
        guard status == errSecSuccess, let array = items as? [[String: Any]],
              let raw = array.first?[kSecImportItemIdentity as String] else {
            throw SignKitError.crypto("the web certificate for local installing could not be read")
        }
        // swiftlint:disable:next force_cast
        let identity = raw as! SecIdentity
        guard let secIdentity = sec_identity_create(identity) else {
            throw SignKitError.crypto("the web certificate for local installing was rejected by iOS")
        }
        return secIdentity
    }
    #endif
}
