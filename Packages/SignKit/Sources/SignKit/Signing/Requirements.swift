import Foundation

/// Builds the "designated requirement" — the rule iOS stores to recognise the app
/// later: this bundle ID, signed by Apple, by this team.
public enum Requirement {
    static let opFalse: UInt32 = 0
    static let opTrue: UInt32 = 1
    static let opIdent: UInt32 = 2
    static let opAppleAnchor: UInt32 = 3
    static let opAnd: UInt32 = 6
    static let opCertField: UInt32 = 11
    static let opCertGeneric: UInt32 = 14
    static let opAppleGenericAnchor: UInt32 = 15

    static let matchEqual: UInt32 = 1

    static func lengthPrefixed(_ d: Data) -> Data {
        var out = Data()
        out.put32be(UInt32(d.count))
        out.append(d)
        out.append(Data(count: align(d.count, 4) - d.count))   // pad to 4 bytes
        return out
    }

    static func string(_ s: String) -> Data { lengthPrefixed(Data(s.utf8)) }

    /// `identifier "X" and anchor apple generic and certificate leaf[subject.OU] = "TEAM"`
    public static func designated(identifier: String, teamID: String?) -> Blob {
        var expr = Data()
        expr.put32be(opAnd)
        expr.put32be(opIdent)
        expr.append(string(identifier))
        if let team = teamID, !team.isEmpty {
            expr.put32be(opAnd)
            expr.put32be(opAppleGenericAnchor)
            expr.put32be(opCertField)
            expr.put32be(UInt32(bitPattern: 0))        // leaf certificate
            expr.append(string("subject.OU"))
            expr.put32be(matchEqual)
            expr.append(string(team))
        } else {
            expr.put32be(opAppleGenericAnchor)
        }
        var body = Data()
        body.put32be(1)                                 // requirement kind: expression
        body.append(expr)
        return Blob(magic: BlobMagic.requirement, body: body)
    }

    /// An ad-hoc signature (no certificate) carries an empty requirement set.
    public static func emptySet() -> Blob {
        var body = Data()
        body.put32be(0)                                 // zero requirements
        return Blob(magic: BlobMagic.requirements, body: body)
    }

    /// Wraps one requirement as the "designated" entry of a requirement set.
    public static func set(designated: Blob) -> Blob {
        let inner = designated.encoded
        var body = Data()
        body.put32be(1)                                 // one entry
        body.put32be(3)                                 // kSecDesignatedRequirementType
        body.put32be(UInt32(12 + 8))                    // offset from the blob start
        body.append(inner)
        return Blob(magic: BlobMagic.requirements, body: body)
    }
}

/// Entitlements: the list of extra permissions the app is allowed to use.
/// iOS 15 and newer need them twice — once as the old XML, once as DER.
public enum Entitlements {
    public static func xmlBlob(_ dict: [String: Any]) throws -> Blob {
        let data = try PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
        return Blob(magic: BlobMagic.entitlements, body: data)
    }

    public static func derBlob(_ dict: [String: Any]) throws -> Blob {
        var items = [DER]()
        for key in dict.keys.sorted() {
            items.append(.seq([.utf8(key), try value(dict[key]!)]))
        }
        // The whole thing is a context-tagged sequence with a version number.
        let body = DER.seq([.intValue(1), .set(items)]).encoded
        return Blob(magic: BlobMagic.derEntitlements, body: body)
    }

    static func value(_ v: Any) throws -> DER {
        switch v {
        case let b as Bool: return .bool(b)
        case let n as NSNumber:
            #if canImport(ObjectiveC)
            if String(cString: n.objCType) == "c" { return .bool(n.boolValue) }
            #endif
            return .intValue(n.intValue)
        case let s as String: return .utf8(s)
        case let a as [Any]: return .seq(try a.map { try value($0) })
        case let d as [String: Any]:
            var items = [DER]()
            for key in d.keys.sorted() { items.append(.seq([.utf8(key), try value(d[key]!)])) }
            return .set(items)
        case let d as Data: return .octets(d)
        default: throw SignKitError.unsupported("entitlement value of an unknown kind")
        }
    }
}
