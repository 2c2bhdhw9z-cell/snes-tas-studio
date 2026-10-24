import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

public enum HashKind: Sendable {
    case sha1, sha256

    public var size: Int { self == .sha1 ? 20 : 32 }
    var blockSize: Int { 64 }
    /// Code-directory hash type byte.
    var cdType: UInt8 { self == .sha1 ? 1 : 2 }
}

/// Streaming hasher. Uses CryptoKit on Apple devices (hardware accelerated),
/// and our own implementation elsewhere (Linux test sandbox).
public struct Hasher {
    let kind: HashKind
    #if canImport(CryptoKit)
    var s1 = Insecure.SHA1()
    var s256 = SHA256()
    #else
    var soft: SoftHash
    #endif

    public init(_ kind: HashKind) {
        self.kind = kind
        #if !canImport(CryptoKit)
        soft = kind == .sha1 ? SoftHash(sha1: ()) : SoftHash(sha256: ())
        #endif
    }

    public mutating func update(_ d: Data) {
        #if canImport(CryptoKit)
        if kind == .sha1 { s1.update(data: d) } else { s256.update(data: d) }
        #else
        soft.update(d)
        #endif
    }

    public mutating func update(_ p: UnsafeRawBufferPointer) {
        #if canImport(CryptoKit)
        if kind == .sha1 { s1.update(bufferPointer: p) } else { s256.update(bufferPointer: p) }
        #else
        soft.update(Data(p))
        #endif
    }

    public func finish() -> Data {
        #if canImport(CryptoKit)
        return kind == .sha1 ? Data(s1.finalize()) : Data(s256.finalize())
        #else
        var c = soft
        return c.finish()
        #endif
    }

    public static func hash(_ kind: HashKind, _ d: Data) -> Data {
        var h = Hasher(kind); h.update(d); return h.finish()
    }
}

public func sha1(_ d: Data) -> Data { Hasher.hash(.sha1, d) }
public func sha256(_ d: Data) -> Data { Hasher.hash(.sha256, d) }

public func hmac(_ kind: HashKind, key: Data, _ msg: Data) -> Data {
    var k = key
    if k.count > kind.blockSize { k = Hasher.hash(kind, k) }
    k.append(Data(count: kind.blockSize - k.count))
    let ipad = Data(k.map { $0 ^ 0x36 }), opad = Data(k.map { $0 ^ 0x5c })
    var inner = Hasher(kind); inner.update(ipad); inner.update(msg)
    var outer = Hasher(kind); outer.update(opad); outer.update(inner.finish())
    return outer.finish()
}

// MARK: - Software SHA-1 / SHA-256 (Linux fallback, also used by tests)

struct SoftHash {
    let isSHA1: Bool
    var h: [UInt32]
    var buffer = [UInt8]()
    var length: UInt64 = 0

    init(sha1: Void) {
        isSHA1 = true
        h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]
    }
    init(sha256: Void) {
        isSHA1 = false
        h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    }

    mutating func update(_ d: Data) {
        length += UInt64(d.count)
        var bytes = d.withUnsafeBytes { Array($0) }
        if !buffer.isEmpty {
            bytes = buffer + bytes
            buffer.removeAll(keepingCapacity: true)
        }
        let full = bytes.count / 64 * 64
        var i = 0
        bytes.withUnsafeBufferPointer { p in
            while i < full { block(p, i); i += 64 }
        }
        buffer.append(contentsOf: bytes[full...])
    }

    mutating func finish() -> Data {
        let bitLen = length * 8
        var pad: [UInt8] = [0x80]
        let rem = (buffer.count + 1) % 64
        pad += [UInt8](repeating: 0, count: rem <= 56 ? 56 - rem : 120 - rem)
        for i in (0..<8).reversed() { pad.append(UInt8((bitLen >> (UInt64(i) * 8)) & 0xff)) }
        let saved = length
        update(Data(pad))
        length = saved
        var out = Data()
        for v in h { out.put32be(v) }
        return out
    }

    @inline(__always) func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 { (x << n) | (x >> (32 - n)) }
    @inline(__always) func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }

    static let k256: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    mutating func block(_ p: UnsafeBufferPointer<UInt8>, _ o: Int) {
        var w = [UInt32](repeating: 0, count: isSHA1 ? 80 : 64)
        for i in 0..<16 {
            w[i] = UInt32(p[o + i * 4]) << 24 | UInt32(p[o + i * 4 + 1]) << 16 | UInt32(p[o + i * 4 + 2]) << 8 | UInt32(p[o + i * 4 + 3])
        }
        if isSHA1 {
            for i in 16..<80 { w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4]
            for i in 0..<80 {
                var f: UInt32, k: UInt32
                switch i {
                case 0..<20: f = (b & c) | (~b & d); k = 0x5A827999
                case 20..<40: f = b ^ c ^ d; k = 0x6ED9EBA1
                case 40..<60: f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC
                default: f = b ^ c ^ d; k = 0xCA62C1D6
                }
                let t = rotl(a, 5) &+ f &+ e &+ k &+ w[i]
                e = d; d = c; c = rotl(b, 30); b = a; a = t
            }
            h[0] &+= a; h[1] &+= b; h[2] &+= c; h[3] &+= d; h[4] &+= e
        } else {
            for i in 16..<64 {
                let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
                let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
            for i in 0..<64 {
                let S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let ch = (e & f) ^ (~e & g)
                let t1 = hh &+ S1 &+ ch &+ SoftHash.k256[i] &+ w[i]
                let S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let t2 = S0 &+ maj
                hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
            }
            h[0] &+= a; h[1] &+= b; h[2] &+= c; h[3] &+= d; h[4] &+= e; h[5] &+= f; h[6] &+= g; h[7] &+= hh
        }
    }
}
