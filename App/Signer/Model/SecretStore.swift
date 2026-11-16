import Foundation
import Security
import SignKit

/// Certificate passwords belong in the iPhone Keychain, not in the app's JSON file.
/// Keychain entries are device-only and are unavailable while the phone is locked.
///
/// **Why a second copy exists.** A Keychain item is scoped to the app's *signing identity*
/// (`application-identifier` / `keychain-access-groups`). Signer is sideloaded, so every
/// rebuild that is signed with a different certificate — or re-signed by the app itself —
/// changes that identity, and iOS then hands back `errSecItemNotFound` for an item that is
/// still there. The result was "Wrong certificate password" on a certificate that had worked
/// the day before, with no way to put the password back. A file in the app's own folder is
/// not scoped that way, so it survives a re-sign. It is written with iOS Data Protection
/// (readable only after the first unlock, encrypted on disk, only this app can reach it),
/// which is as strong as the Keychain's `ThisDeviceOnly` in practice.
enum SecretStore {
    private static let service = "com.continuum.signer.certificate-password"

    /// Where the file copy lives: Application Support/Signer/secrets/<name>
    private static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Signer").appendingPathComponent("secrets")
    }

    private static func fileURL(_ name: String) -> URL {
        folder.appendingPathComponent(name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? name)
    }

    /// The file copy. Nil when there is none.
    private static func fromFile(_ name: String) -> String? {
        guard let data = try? Data(contentsOf: fileURL(name)) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Writes the file copy, with Data Protection, and keeps the folder out of backups that
    /// could be read somewhere else.
    private static func toFile(_ secret: String, name: String) {
        let fm = FileManager.default
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = fileURL(name)
        if secret.isEmpty {
            try? fm.removeItem(at: url)
            return
        }
        try? Data(secret.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var changed = url
        try? changed.setResourceValues(values)
    }

    static func set(_ password: String, for id: UUID) throws {
        let account = id.uuidString
        let data = Data(password.utf8)
        // The file copy first: it is the one that survives a re-sign, so it must not be the
        // one that gets skipped if the Keychain refuses.
        toFile(password, name: account)
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(lookup as CFDictionary)
        var item = lookup
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        // The Keychain failing is no longer fatal: the file copy can still open the
        // certificate, and signing must not stop for a storage detail.
        if status != errSecSuccess && fromFile(account) == nil {
            throw SignKitError.crypto("the phone would not safely store the certificate password")
        }
    }

    static func get(for id: UUID) -> String? {
        let account = id.uuidString
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data, let text = String(data: data, encoding: .utf8) {
            return text
        }
        // The Keychain has nothing for this build's signing identity. Fall back to the file,
        // and quietly put it back in the Keychain so later reads are fast.
        guard let saved = fromFile(account) else { return nil }
        var heal = query
        heal[kSecReturnData as String] = nil
        heal[kSecMatchLimit as String] = nil
        SecItemDelete(heal as CFDictionary)
        var item = heal
        item[kSecValueData as String] = Data(saved.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        _ = SecItemAdd(item as CFDictionary, nil)
        return saved
    }

    static func delete(for id: UUID) {
        let account = id.uuidString
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        try? FileManager.default.removeItem(at: fileURL(account))
    }

    // MARK: - the other secrets
    //
    // The web certificate's password for "do everything on this phone" used to sit in plain
    // UserDefaults, where any backup could read it. It is a password, so it goes here too.

    static func set(_ secret: String, for name: String) {
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name,
        ]
        SecItemDelete(lookup as CFDictionary)
        guard !secret.isEmpty else { return }
        var item = lookup
        item[kSecValueData as String] = Data(secret.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        _ = SecItemAdd(item as CFDictionary, nil)
    }

    static func get(_ name: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
