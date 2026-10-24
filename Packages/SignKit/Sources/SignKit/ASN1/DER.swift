import Foundation

/// Minimal ASN.1 DER reader/writer, enough for X.509, PKCS#12, CMS and OCSP.
public struct DERNode {
    public let tag: UInt8
    public let content: Data      // value bytes
    public let raw: Data          // full TLV bytes

    public var isConstructed: Bool { tag & 0x20 != 0 }
    public var tagNumber: UInt8 { tag & 0x1f }
    public var tagClass: UInt8 { tag & 0xc0 }

    public var children: [DERNode] { (try? DERNode.parseAll(content)) ?? [] }
    public func child(_ i: Int) -> DERNode? { let c = children; return i < c.count ? c[i] : nil }

    public static func parse(_ d: Data) throws -> DERNode {
        var o = 0
        return try parse(d, &o)
    }

    public static func parseAll(_ d: Data) throws -> [DERNode] {
        var o = 0, out = [DERNode]()
        while o < d.count { out.append(try parse(d, &o)) }
        return out
    }

    static func parse(_ d: Data, _ o: inout Int) throws -> DERNode {
        let start = o
        guard o + 2 <= d.count else { throw SignKitError.malformed("DER truncated") }
        let tag = d.u8(o); o += 1
        var len = Int(d.u8(o)); o += 1
        if len == 0x80 {
            // BER indefinite length (some PKCS#12 files use it): scan to end-of-contents.
            let cs = o
            while true {
                guard o + 2 <= d.count else { throw SignKitError.malformed("BER EOC missing") }
                if d.u8(o) == 0 && d.u8(o + 1) == 0 { break }
                _ = try parse(d, &o)
            }
            let content = d.sub(cs, o - cs)
            o += 2
            return DERNode(tag: tag, content: content, raw: d.sub(start, o - start))
        }
        if len & 0x80 != 0 {
            let n = len & 0x7f
            guard n <= 4, o + n <= d.count else { throw SignKitError.malformed("DER length") }
            len = 0
            for _ in 0..<n { len = len << 8 | Int(d.u8(o)); o += 1 }
        }
        guard o + len <= d.count else { throw SignKitError.malformed("DER content truncated") }
        let content = d.sub(o, len)
        o += len
        return DERNode(tag: tag, content: content, raw: d.sub(start, o - start))
    }

    /// For BER constructed OCTET STRINGs (chunked), join all the pieces.
    public var octets: Data {
        if tag == 0x24 || (isConstructed && tagNumber == 4) {
            return children.reduce(Data()) { $0 + $1.octets }
        }
        return content
    }

    // MARK: value helpers

    public var oid: String? {
        guard tag == 0x06, !content.isEmpty else { return nil }
        var parts = [UInt64]()
        let first = content.u8(0)
        parts.append(UInt64(first / 40)); parts.append(UInt64(first % 40))
        var v: UInt64 = 0
        for i in 1..<content.count {
            let b = content.u8(i)
            v = v << 7 | UInt64(b & 0x7f)
            if b & 0x80 == 0 { parts.append(v); v = 0 }
        }
        return parts.map(String.init).joined(separator: ".")
    }

    public var string: String? {
        switch tag {
        case 0x0c, 0x13, 0x16, 0x14, 0x1a: return String(data: content, encoding: .utf8) ?? String(data: content, encoding: .isoLatin1)
        case 0x1e: return String(data: content, encoding: .utf16BigEndian)
        default: return nil
        }
    }

    /// Unsigned big-endian integer bytes with leading zeros stripped.
    public var unsignedInteger: Data {
        var c = content
        while c.count > 1 && c.first == 0 { c = c.dropFirst() }
        return Data(c)
    }

    public var intValue: Int {
        var v = 0
        for b in content { v = v << 8 | Int(b) }
        return v
    }

    public var date: Date? {
        guard let s = String(data: content, encoding: .ascii) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = tag == 0x17 ? "yyMMddHHmmss'Z'" : "yyyyMMddHHmmss'Z'"
        return f.date(from: s)
    }
}

/// DER builder.
public indirect enum DER {
    case raw(Data)
    case seq([DER])
    case set([DER])
    case oid(String)
    case int(Data)          // unsigned big-endian
    case intValue(Int)
    case octets(Data)
    case bits(Data)
    case null
    case bool(Bool)
    case utf8(String)
    case printable(String)
    case ia5(String)
    case utcTime(Date)
    case genTime(Date)
    case tagged(UInt8, [DER])     // context-specific constructed [n]
    case implicit(UInt8, Data)    // context-specific primitive [n]

    public var encoded: Data {
        switch self {
        case .raw(let d): return d
        case .seq(let c): return DER.tlv(0x30, c.reduce(Data()) { $0 + $1.encoded })
        case .set(let c):
            // DER requires SET OF members sorted by their encodings.
            let enc = c.map(\.encoded).sorted { a, b in a.lexicographicallyPrecedes(b) }
            return DER.tlv(0x31, enc.reduce(Data(), +))
        case .oid(let s): return DER.tlv(0x06, DER.encodeOID(s))
        case .int(let d):
            var v = Data(d.drop(while: { $0 == 0 }))
            if v.isEmpty { v = Data([0]) }
            if v.first! & 0x80 != 0 { v.insert(0, at: 0) }
            return DER.tlv(0x02, v)
        case .intValue(let i):
            var v = Data()
            var x = i
            repeat { v.insert(UInt8(x & 0xff), at: 0); x >>= 8 } while x > 0
            if v.first! & 0x80 != 0 { v.insert(0, at: 0) }
            return DER.tlv(0x02, v)
        case .octets(let d): return DER.tlv(0x04, d)
        case .bits(let d): return DER.tlv(0x03, Data([0]) + d)
        case .null: return Data([0x05, 0x00])
        case .bool(let b): return Data([0x01, 0x01, b ? 0xff : 0x00])
        case .utf8(let s): return DER.tlv(0x0c, Data(s.utf8))
        case .printable(let s): return DER.tlv(0x13, Data(s.utf8))
        case .ia5(let s): return DER.tlv(0x16, Data(s.utf8))
        case .utcTime(let d): return DER.tlv(0x17, Data(DER.fmt(d, "yyMMddHHmmss'Z'").utf8))
        case .genTime(let d): return DER.tlv(0x18, Data(DER.fmt(d, "yyyyMMddHHmmss'Z'").utf8))
        case .tagged(let n, let c): return DER.tlv(0xa0 | n, c.reduce(Data()) { $0 + $1.encoded })
        case .implicit(let n, let d): return DER.tlv(0x80 | n, d)
        }
    }

    static func fmt(_ d: Date, _ f: String) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(identifier: "UTC")
        df.dateFormat = f
        return df.string(from: d)
    }

    public static func tlv(_ tag: UInt8, _ v: Data) -> Data {
        var d = Data([tag])
        d.append(lengthBytes(v.count))
        d.append(v)
        return d
    }

    static func lengthBytes(_ n: Int) -> Data {
        if n < 0x80 { return Data([UInt8(n)]) }
        var b = Data()
        var x = n
        while x > 0 { b.insert(UInt8(x & 0xff), at: 0); x >>= 8 }
        return Data([0x80 | UInt8(b.count)]) + b
    }

    static func encodeOID(_ s: String) -> Data {
        let p = s.split(separator: ".").compactMap { UInt64($0) }
        var d = Data([UInt8(p[0] * 40 + p[1])])
        for v in p.dropFirst(2) {
            var chunk = [UInt8(v & 0x7f)]
            var x = v >> 7
            while x > 0 { chunk.insert(UInt8(x & 0x7f) | 0x80, at: 0); x >>= 7 }
            d.append(contentsOf: chunk)
        }
        return d
    }
}

public enum OID {
    public static let rsaEncryption = "1.2.840.113549.1.1.1"
    public static let sha256WithRSA = "1.2.840.113549.1.1.11"
    public static let sha1WithRSA = "1.2.840.113549.1.1.5"
    public static let sha1 = "1.3.14.3.2.26"
    public static let sha256 = "2.16.840.1.101.3.4.2.1"
    public static let data = "1.2.840.113549.1.7.1"
    public static let signedData = "1.2.840.113549.1.7.2"
    public static let encryptedData = "1.2.840.113549.1.7.6"
    public static let contentType = "1.2.840.113549.1.9.3"
    public static let messageDigest = "1.2.840.113549.1.9.4"
    public static let signingTime = "1.2.840.113549.1.9.5"
    public static let friendlyName = "1.2.840.113549.1.9.20"
    public static let localKeyID = "1.2.840.113549.1.9.21"
    public static let appleCDHashes = "1.2.840.113635.100.9.1"
    public static let appleCDHashes2 = "1.2.840.113635.100.9.2"
    public static let commonName = "2.5.4.3"
    public static let organization = "2.5.4.10"
    public static let orgUnit = "2.5.4.11"
    public static let country = "2.5.4.6"
    public static let userID = "0.9.2342.19200300.100.1.1"
    public static let authorityInfoAccess = "1.3.6.1.5.5.7.1.1"
    public static let ocsp = "1.3.6.1.5.5.7.48.1"
    public static let ocspBasic = "1.3.6.1.5.5.7.48.1.1"
    // PKCS#12
    public static let keyBag = "1.2.840.113549.1.12.10.1.1"
    public static let shroudedKeyBag = "1.2.840.113549.1.12.10.1.2"
    public static let certBag = "1.2.840.113549.1.12.10.1.3"
    public static let x509Certificate = "1.2.840.113549.1.9.22.1"
    public static let pbeSHA1_3DES = "1.2.840.113549.1.12.1.3"
    public static let pbeSHA1_2DES = "1.2.840.113549.1.12.1.4"
    public static let pbeSHA1_RC2_128 = "1.2.840.113549.1.12.1.5"
    public static let pbeSHA1_RC2_40 = "1.2.840.113549.1.12.1.6"
    public static let pbes2 = "1.2.840.113549.1.5.13"
    public static let pbkdf2 = "1.2.840.113549.1.5.12"
    public static let hmacSHA1 = "1.2.840.113549.2.7"
    public static let hmacSHA256 = "1.2.840.113549.2.9"
    public static let aes128CBC = "2.16.840.1.101.3.4.1.2"
    public static let aes192CBC = "2.16.840.1.101.3.4.1.22"
    public static let aes256CBC = "2.16.840.1.101.3.4.1.42"
    public static let desEDE3CBC = "1.2.840.113549.3.7"
}
