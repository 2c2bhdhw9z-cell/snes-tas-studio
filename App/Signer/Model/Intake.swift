import Foundation
import SignKit

/// Takes any file the user hands over — from a picker, the share sheet, Safari,
/// or the iPhone Files app — and puts it where it belongs.
///
/// Pickers accept everything, so nothing is ever greyed out; what a file actually is
/// gets worked out here, from the name and then from the contents.
enum Intake {
    enum Kind { case certificate, profile, app, tweak, other }

    static func kind(of url: URL) -> Kind {
        switch url.pathExtension.lowercased() {
        case "p12", "pfx": return .certificate
        case "mobileprovision", "provisionprofile": return .profile
        case "ipa": return .app
        case "dylib", "deb", "framework": return .tweak
        default: break
        }
        // No useful name? Look inside.
        guard let handle = try? FileHandle(forReadingFrom: url) else { return .other }
        let head = handle.readData(ofLength: 4096)
        try? handle.close()
        if head.starts(with: [0x50, 0x4b]) { return .app }                 // a zip, so probably an .ipa
        if head.starts(with: [0x30, 0x82]) { return .certificate }         // DER, so a .p12
        if head.find(Data("<?xml".utf8)) != nil
            && head.find(Data("ProvisionedDevices".utf8)) != nil { return .profile }
        if MachOFile.isMachO(head) { return .tweak }
        return .other
    }

    /// Copies the file into Signer's own folder so it shows on the File tab.
    @discardableResult
    static func keep(_ url: URL) throws -> URL {
        let dest = Paths.files.appendingPathComponent(url.lastPathComponent)
        if dest != url {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.copyItem(at: url, to: dest)
        }
        return dest
    }

    /// Does the obvious thing with a file and says, in plain English, what happened.
    /// A certificate with a password still needs the password, so it is only filed away.
    @MainActor
    @discardableResult
    static func take(_ url: URL, password: String?) throws -> String {
        let saved = try keep(url)
        switch kind(of: saved) {
        case .app:
            let app = try SigningRunner.importIPA(saved)
            return "Added \(app.name)"
        case .profile:
            let profile = try Store.shared.importProfile(saved)
            return "Imported \(profile.name)"
        case .certificate:
            // An empty password is worth a try; most shared certificates have one.
            if let password {
                let cert = try Store.shared.importCertificate(p12: saved, password: password)
                return "Imported \(cert.commonName)"
            }
            if let cert = try? Store.shared.importCertificate(p12: saved, password: "") {
                return "Imported \(cert.commonName)"
            }
            return "\(saved.lastPathComponent) needs its password — tap it on the File tab"
        case .tweak:
            let dest = Paths.tweaks.appendingPathComponent(saved.lastPathComponent)
            try? FileManager.default.removeItem(at: dest)
            try? FileManager.default.copyItem(at: saved, to: dest)
            return "Saved the add-on \(saved.lastPathComponent)"
        case .other:
            return "Saved \(saved.lastPathComponent) to the File tab"
        }
    }
}
