import Foundation

/// A `.mobileprovision` provisioning profile: Apple's permission slip saying which
/// certificate may sign which app, on which devices, with which entitlements.
public struct ProvisioningProfile {
    public let der: Data                       // the whole signed file, copied into the app
    public let plist: [String: Any]

    public init(data: Data) throws {
        der = data
        // The file is a CMS signed blob; the plist sits in the content OCTET STRING.
        var payload: Data?
        if let top = try? DERNode.parse(data),
           let signedData = top.firstSequence(withOID: OID.pkcs7SignedData) ?? top.firstSequence(withOID: OID.pkcs7Data) {
            if let content = signedData.child(1)?.child(0),
               let dataInfo = content.firstSequence(withOID: OID.pkcs7Data),
               let wrap = dataInfo.child(1) {
                payload = wrap.isConstructed ? (wrap.child(0)?.octets ?? wrap.octets) : wrap.octets
            }
        }
        // Fall back to locating the plist text directly (some profiles are plain).
        if payload == nil || !(payload!.starts(with: Data("<?xml".utf8)) || payload!.starts(with: Data("bplist".utf8))) {
            if let start = data.find(Data("<?xml".utf8)),
               let end = data.find(Data("</plist>".utf8), from: start) {
                payload = data.sub(start, end + 8 - start)
            }
        }
        guard let p = payload,
              let dict = try PropertyListSerialization.propertyList(from: p, format: nil) as? [String: Any] else {
            throw SignKitError.malformed("this is not a provisioning profile")
        }
        plist = dict
    }

    public init(url: URL) throws { try self.init(data: try Data(contentsOf: url)) }

    public var name: String? { plist["Name"] as? String }
    public var uuid: String? { plist["UUID"] as? String }
    public var teamID: String? { (plist["TeamIdentifier"] as? [String])?.first }
    public var teamName: String? { plist["TeamName"] as? String }
    public var appIDName: String? { plist["AppIDName"] as? String }
    public var expiry: Date? { plist["ExpirationDate"] as? Date }
    public var creation: Date? { plist["CreationDate"] as? Date }
    public var platforms: [String] { plist["Platform"] as? [String] ?? [] }
    public var devices: [String] { plist["ProvisionedDevices"] as? [String] ?? [] }
    /// An enterprise (in-house) profile works on any device; a development one only on listed devices.
    public var isEnterprise: Bool { plist["ProvisionsAllDevices"] as? Bool ?? false }
    public var entitlements: [String: Any] { plist["Entitlements"] as? [String: Any] ?? [:] }

    /// The app identifier the profile allows, e.g. "ABCDE12345.com.example.app" or "ABCDE12345.*".
    public var applicationIdentifier: String? { entitlements["application-identifier"] as? String }

    /// The bundle ID part, with the team prefix removed.
    public var bundleIDPattern: String? {
        guard let appID = applicationIdentifier else { return nil }
        guard let dot = appID.firstIndex(of: ".") else { return appID }
        return String(appID[appID.index(after: dot)...])
    }

    public var isWildcard: Bool { bundleIDPattern?.hasSuffix("*") ?? false }

    public var isExpired: Bool {
        guard let e = expiry else { return false }
        return e < Date()
    }

    public var daysLeft: Int? {
        guard let e = expiry else { return nil }
        return Int(e.timeIntervalSinceNow / 86400)
    }

    /// The certificates the profile lists as allowed to sign with it.
    public var certificates: [Certificate] {
        (plist["DeveloperCertificates"] as? [Data] ?? []).compactMap { try? Certificate(der: $0) }
    }

    /// Does this profile allow the given bundle ID?
    public func allows(bundleID: String) -> Bool {
        guard let pattern = bundleIDPattern else { return false }
        if pattern == "*" { return true }
        if pattern.hasSuffix("*") { return bundleID.hasPrefix(String(pattern.dropLast())) }
        return pattern == bundleID
    }

    /// Does this profile go with the given signing certificate?
    public func matches(certificate: Certificate) -> Bool {
        certificates.contains { $0.der == certificate.der }
    }

    public func includes(deviceUDID: String) -> Bool {
        isEnterprise || devices.contains { $0.caseInsensitiveCompare(deviceUDID) == .orderedSame }
    }

    /// The entitlements to sign a bundle with.
    ///
    /// A wildcard profile (`TEAMID.*`) grants every app ID, so the app's own ID is used and each
    /// app gets its own identifier. A profile made for ONE exact app ID grants only that one: the
    /// app then keeps its own name and carries the profile's identifier, which is what zsign —
    /// so ESign and GBox — does. That is why several apps signed with one such certificate all
    /// install side by side instead of replacing each other.
    public func entitlements(forBundleID bundleID: String) -> [String: Any] {
        var e = entitlements
        // A profile grants some things as "any" (a bare *), for example associated domains.
        // That is a permission slip, not a value an app can carry, so it stays out.
        for (key, value) in e {
            if let s = value as? String, s == "*" { e[key] = nil }
            else if let a = value as? [String], !a.isEmpty, a.allSatisfy({ $0 == "*" }) { e[key] = nil }
        }
        guard let team = teamID else { return e }
        // The identifier has to be one the profile actually grants, or iOS refuses the install.
        let identifier = allows(bundleID: bundleID) ? "\(team).\(bundleID)"
                                                    : (applicationIdentifier ?? "\(team).\(bundleID)")
        e["application-identifier"] = identifier
        if e["com.apple.developer.team-identifier"] == nil { e["com.apple.developer.team-identifier"] = team }
        // Wildcards inside other entitlements (keychain groups, app groups) get the same treatment.
        for (key, value) in e {
            if let s = value as? String, s.hasSuffix("*"), s.hasPrefix(team) {
                e[key] = identifier
            } else if let arr = value as? [String] {
                e[key] = arr.map { $0.hasSuffix("*") && $0.hasPrefix(team) ? identifier : $0 }
            }
        }
        return e
    }

    /// Plain-English summary for the certificate screen.
    public var summary: String {
        var parts = [String]()
        if let n = name { parts.append(n) }
        if let t = teamName { parts.append(t) }
        if isEnterprise { parts.append("works on any device") } else { parts.append("\(devices.count) devices") }
        if let d = daysLeft { parts.append(d < 0 ? "expired" : "\(d) days left") }
        return parts.joined(separator: " · ")
    }
}
