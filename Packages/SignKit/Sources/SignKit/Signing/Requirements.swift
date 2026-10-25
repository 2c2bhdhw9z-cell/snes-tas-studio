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

    static let matchExists: UInt32 = 0
    static let matchEqual: UInt32 = 1

    static func lengthPrefixed(_ d: Data) -> Data {
        var out = Data()
        out.put32be(UInt32(d.count))
        out.append(d)
        out.append(Data(count: align(d.count, 4) - d.count))   // pad to 4 bytes
        return out
    }

    static func string(_ s: String) -> Data { lengthPrefixed(Data(s.utf8)) }

    /// The marker Apple puts in its developer-relations certificates: 1.2.840.113635.100.6.2.1.
    static let wwdrMarker = Data([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x02, 0x01])

    /// The rule Apple's own tool writes, which is also what `zsign` writes:
    ///
    ///     identifier "X" and anchor apple generic
    ///         and certificate leaf[subject.CN] = "Apple Development: …"
    ///         and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */
    ///
    /// Checked byte for byte against the requirement inside the GBox app.
    public static func designated(identifier: String, subjectCN: String) -> Blob {
        var expr = Data()
        expr.put32be(opAnd)
        expr.put32be(opIdent)
        expr.append(string(identifier))
        expr.put32be(opAnd)
        expr.put32be(opAppleGenericAnchor)
        expr.put32be(opAnd)
        expr.put32be(opCertField)
        expr.put32be(0)                                 // certificate slot 0 = yours (the "leaf")
        expr.append(string("subject.CN"))
        expr.put32be(matchEqual)
        expr.append(string(subjectCN))
        expr.put32be(opCertGeneric)
        expr.put32be(1)                                 // certificate slot 1 = the one above yours
        expr.append(lengthPrefixed(wwdrMarker))
        expr.put32be(matchExists)
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

    /// Apple's DER form, version 1:
    ///
    ///     [APPLICATION 16] {            tag 0x70
    ///         INTEGER 1,                the format version
    ///         [CONTEXT 16] {            tag 0xB0, the dictionary
    ///             SEQUENCE { UTF8String key, value }, …   keys in sorted order
    ///         }
    ///     }
    ///
    /// Copied from the real signature in the GBox app and checked against the output of
    /// `rcodesign` and `zsign`. Getting any tag wrong makes iOS reject the whole signature.
    public static func derBlob(_ dict: [String: Any]) throws -> Blob {
        let version = DER.intValue(1).encoded
        let body = DER.tlv(0x70, version + (try dictionary(dict)))
        return Blob(magic: BlobMagic.derEntitlements, body: body)
    }

    static func dictionary(_ dict: [String: Any]) throws -> Data {
        // Sorted by the raw bytes of the key, which is how Apple orders them.
        let keys = dict.keys.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
        var inner = Data()
        for key in keys {
            let entry = DER.tlv(0x0c, Data(key.utf8)) + (try value(dict[key]!))
            inner.append(DER.tlv(0x30, entry))
        }
        return DER.tlv(0xb0, inner)
    }

    static func value(_ v: Any) throws -> Data {
        switch v {
        case let n as NSNumber:
            // A real boolean and the number 1 look alike to Swift; ask the number itself.
            let kind = String(cString: n.objCType)
            if kind == "c" || kind == "B" { return Data([0x01, 0x01, n.boolValue ? 0xff : 0x00]) }
            return integer(n.int64Value)
        case let b as Bool:
            return Data([0x01, 0x01, b ? 0xff : 0x00])
        case let i as Int:
            return integer(Int64(i))
        case let s as String:
            return DER.tlv(0x0c, Data(s.utf8))
        case let a as [Any]:
            var inner = Data()
            for item in a { inner.append(try value(item)) }
            return DER.tlv(0x30, inner)
        case let d as [String: Any]:
            return try dictionary(d)
        default:
            throw SignKitError.unsupported("an entitlement value of a kind that cannot be stored")
        }
    }

    /// Smallest two's-complement integer, as DER wants it.
    static func integer(_ v: Int64) -> Data {
        var bytes = [UInt8]()
        var x = v
        repeat {
            bytes.insert(UInt8(truncatingIfNeeded: x), at: 0)
            x >>= 8
        } while !(x == 0 && bytes[0] & 0x80 == 0) && !(x == -1 && bytes[0] & 0x80 != 0)
        return DER.tlv(0x02, Data(bytes))
    }

    /// Can this value be written in both the XML and the DER form?
    static func isStorable(_ v: Any) -> Bool {
        switch v {
        case is NSNumber, is Bool, is Int, is String: return true
        case let a as [Any]: return a.allSatisfy(isStorable)
        case let d as [String: Any]: return d.values.allSatisfy(isStorable)
        default: return false
        }
    }

    /// The entitlements with anything unstorable (raw data, dates, fractions) taken out,
    /// so the XML and DER copies always agree. Also returns what was dropped.
    public static func storable(_ dict: [String: Any]) -> (kept: [String: Any], dropped: [String]) {
        var kept = [String: Any](), dropped = [String]()
        for (key, value) in dict {
            if isStorable(value) { kept[key] = value } else { dropped.append(key) }
        }
        return (kept, dropped.sorted())
    }
}
