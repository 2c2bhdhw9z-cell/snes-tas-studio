import Foundation

public enum SignKitError: Error, CustomStringConvertible {
    case malformed(String)
    case unsupported(String)
    case crypto(String)
    case io(String)
    case badPassword

    public var description: String {
        switch self {
        case .malformed(let s): return "Malformed data: \(s)"
        case .unsupported(let s): return "Not supported: \(s)"
        case .crypto(let s): return "Crypto error: \(s)"
        case .io(let s): return "File error: \(s)"
        case .badPassword: return "Wrong certificate password"
        }
    }
}

extension Data {
    @inline(__always) public func u8(_ o: Int) -> UInt8 { self[self.startIndex + o] }

    public func u16le(_ o: Int) -> UInt16 { UInt16(u8(o)) | UInt16(u8(o + 1)) << 8 }
    public func u32le(_ o: Int) -> UInt32 {
        UInt32(u8(o)) | UInt32(u8(o + 1)) << 8 | UInt32(u8(o + 2)) << 16 | UInt32(u8(o + 3)) << 24
    }
    public func u64le(_ o: Int) -> UInt64 { UInt64(u32le(o)) | UInt64(u32le(o + 4)) << 32 }
    public func u32be(_ o: Int) -> UInt32 {
        UInt32(u8(o)) << 24 | UInt32(u8(o + 1)) << 16 | UInt32(u8(o + 2)) << 8 | UInt32(u8(o + 3))
    }
    public func u64be(_ o: Int) -> UInt64 { UInt64(u32be(o)) << 32 | UInt64(u32be(o + 4)) }

    public func sub(_ o: Int, _ n: Int) -> Data {
        let s = startIndex + o
        return Data(self[s..<(s + n)])
    }

    mutating func put16le(_ v: UInt16) { append(UInt8(v & 0xff)); append(UInt8(v >> 8)) }
    mutating func set16le(_ o: Int, _ v: UInt16) {
        self[startIndex + o] = UInt8(v & 0xff)
        self[startIndex + o + 1] = UInt8(v >> 8)
    }
    mutating func put32le(_ v: UInt32) { for i in 0..<4 { append(UInt8((v >> (8 * UInt32(i))) & 0xff)) } }
    mutating func put64le(_ v: UInt64) { for i in 0..<8 { append(UInt8((v >> (8 * UInt64(i))) & 0xff)) } }
    mutating func put32be(_ v: UInt32) { for i in (0..<4).reversed() { append(UInt8((v >> (8 * UInt32(i))) & 0xff)) } }
    mutating func put64be(_ v: UInt64) { for i in (0..<8).reversed() { append(UInt8((v >> (8 * UInt64(i))) & 0xff)) } }

    mutating func set32le(_ o: Int, _ v: UInt32) {
        for i in 0..<4 { self[startIndex + o + i] = UInt8((v >> (8 * UInt32(i))) & 0xff) }
    }
    mutating func set64le(_ o: Int, _ v: UInt64) {
        for i in 0..<8 { self[startIndex + o + i] = UInt8((v >> (8 * UInt64(i))) & 0xff) }
    }
    mutating func set32be(_ o: Int, _ v: UInt32) {
        for i in 0..<4 { self[startIndex + o + i] = UInt8((v >> (8 * UInt32(3 - i))) & 0xff) }
    }

    public var hex: String { map { String(format: "%02x", $0) }.joined() }

    public init?(hex: String) {
        var d = Data()
        var it = hex.makeIterator()
        while let a = it.next() {
            guard let b = it.next(), let v = UInt8(String([a, b]), radix: 16) else { return nil }
            d.append(v)
        }
        self = d
    }

    /// Finds the first occurrence of `needle` starting at `from`.
    public func find(_ needle: Data, from: Int = 0) -> Int? {
        guard needle.count > 0, count >= needle.count else { return nil }
        return range(of: needle, in: (startIndex + from)..<endIndex).map { $0.lowerBound - startIndex }
    }
}

@inline(__always) func align(_ v: Int, _ a: Int) -> Int { (v + a - 1) / a * a }
