import Foundation

/// Small fixed-purpose big-number type: just what RSA needs.
/// Limbs are UInt32, least significant first.
public struct BigInt: Comparable, CustomStringConvertible {
    var limbs: [UInt32]

    public static let zero = BigInt(limbs: [])
    public static let one = BigInt(1)

    init(limbs: [UInt32]) {
        self.limbs = limbs
        normalize()
    }

    public init(_ v: UInt32) { limbs = v == 0 ? [] : [v]; }

    /// Big-endian bytes, as used by every crypto format.
    public init(bytes: Data) {
        var l = [UInt32]()
        var i = bytes.count
        while i > 0 {
            let lo = max(0, i - 4)
            var v: UInt32 = 0
            for j in lo..<i { v = v << 8 | UInt32(bytes[bytes.startIndex + j]) }
            l.append(v)
            i = lo
        }
        limbs = l
        normalize()
    }

    mutating func normalize() { while let l = limbs.last, l == 0 { limbs.removeLast() } }

    public var isZero: Bool { limbs.isEmpty }
    public var bitWidth: Int {
        guard let top = limbs.last else { return 0 }
        return (limbs.count - 1) * 32 + (32 - top.leadingZeroBitCount)
    }
    public var byteCount: Int { (bitWidth + 7) / 8 }

    public func bytes(padTo n: Int = 0) -> Data {
        var d = Data()
        for l in limbs.reversed() { d.put32be(l) }
        while d.count > 1 && d.first == 0 && d.count > byteCount { d = d.dropFirst() }
        if d.isEmpty { d = Data([0]) }
        if d.count < n { d = Data(count: n - d.count) + d }
        return d
    }

    public var description: String { "0x" + bytes().hex }

    func bit(_ i: Int) -> Bool {
        let w = i / 32
        guard w < limbs.count else { return false }
        return (limbs[w] >> UInt32(i % 32)) & 1 == 1
    }

    public static func < (a: BigInt, b: BigInt) -> Bool { compare(a, b) < 0 }
    public static func == (a: BigInt, b: BigInt) -> Bool { a.limbs == b.limbs }

    static func compare(_ a: BigInt, _ b: BigInt) -> Int {
        if a.limbs.count != b.limbs.count { return a.limbs.count < b.limbs.count ? -1 : 1 }
        var i = a.limbs.count - 1
        while i >= 0 {
            if a.limbs[i] != b.limbs[i] { return a.limbs[i] < b.limbs[i] ? -1 : 1 }
            i -= 1
        }
        return 0
    }

    public static func + (a: BigInt, b: BigInt) -> BigInt {
        var out = [UInt32](); out.reserveCapacity(max(a.limbs.count, b.limbs.count) + 1)
        var carry: UInt64 = 0
        for i in 0..<max(a.limbs.count, b.limbs.count) {
            let s = UInt64(i < a.limbs.count ? a.limbs[i] : 0) + UInt64(i < b.limbs.count ? b.limbs[i] : 0) + carry
            out.append(UInt32(s & 0xffff_ffff)); carry = s >> 32
        }
        if carry > 0 { out.append(UInt32(carry)) }
        return BigInt(limbs: out)
    }

    /// a - b, where a >= b.
    public static func - (a: BigInt, b: BigInt) -> BigInt {
        var out = [UInt32](); out.reserveCapacity(a.limbs.count)
        var borrow: Int64 = 0
        for i in 0..<a.limbs.count {
            var d = Int64(a.limbs[i]) - Int64(i < b.limbs.count ? b.limbs[i] : 0) - borrow
            if d < 0 { d += 0x1_0000_0000; borrow = 1 } else { borrow = 0 }
            out.append(UInt32(d))
        }
        return BigInt(limbs: out)
    }

    public static func * (a: BigInt, b: BigInt) -> BigInt {
        if a.isZero || b.isZero { return .zero }
        var out = [UInt32](repeating: 0, count: a.limbs.count + b.limbs.count)
        for i in 0..<a.limbs.count {
            var carry: UInt64 = 0
            let ai = UInt64(a.limbs[i])
            for j in 0..<b.limbs.count {
                let t = ai * UInt64(b.limbs[j]) + UInt64(out[i + j]) + carry
                out[i + j] = UInt32(t & 0xffff_ffff)
                carry = t >> 32
            }
            var k = i + b.limbs.count
            while carry > 0 {
                let t = UInt64(out[k]) + carry
                out[k] = UInt32(t & 0xffff_ffff); carry = t >> 32; k += 1
            }
        }
        return BigInt(limbs: out)
    }

    func shiftedLeft(bits: Int) -> BigInt {
        if isZero { return .zero }
        let words = bits / 32, rest = UInt32(bits % 32)
        var out = [UInt32](repeating: 0, count: words)
        if rest == 0 {
            out += limbs
        } else {
            var carry: UInt32 = 0
            for l in limbs {
                out.append(l << rest | carry)
                carry = l >> (32 - rest)
            }
            if carry > 0 { out.append(carry) }
        }
        return BigInt(limbs: out)
    }

    func shiftedRight(bits: Int) -> BigInt {
        let words = bits / 32, rest = UInt32(bits % 32)
        if words >= limbs.count { return .zero }
        var l = Array(limbs[words...])
        if rest > 0 {
            for i in 0..<l.count {
                l[i] = l[i] >> rest | (i + 1 < l.count ? l[i + 1] << (32 - rest) : 0)
            }
        }
        return BigInt(limbs: l)
    }

    /// Long division: returns (quotient, remainder).
    public static func divMod(_ a: BigInt, _ m: BigInt) -> (BigInt, BigInt) {
        precondition(!m.isZero, "divide by zero")
        if compare(a, m) < 0 { return (.zero, a) }
        var rem = BigInt.zero
        var quo = [UInt32](repeating: 0, count: a.limbs.count)
        var i = a.bitWidth - 1
        while i >= 0 {
            rem = rem.shiftedLeft(bits: 1)
            if a.bit(i) {
                if rem.limbs.isEmpty { rem.limbs = [1] } else { rem.limbs[0] |= 1 }
            }
            if compare(rem, m) >= 0 {
                rem = rem - m
                quo[i / 32] |= 1 << UInt32(i % 32)
            }
            i -= 1
        }
        return (BigInt(limbs: quo), rem)
    }

    public static func % (a: BigInt, m: BigInt) -> BigInt { divMod(a, m).1 }

    public func mulMod(_ b: BigInt, _ m: BigInt) -> BigInt { (self * b) % m }

    /// Modular exponentiation. Odd modulus (every RSA case) uses Montgomery
    /// multiplication, which avoids a long division per step.
    public func powMod(_ e: BigInt, _ m: BigInt) -> BigInt {
        if m == BigInt.one { return .zero }
        if e.isZero { return .one }
        if let mont = Montgomery(m) { return mont.powMod(self % m, e) }
        var result = BigInt.one
        var base = self % m
        for i in 0..<e.bitWidth {
            if e.bit(i) { result = result.mulMod(base, m) }
            base = base.mulMod(base, m)
        }
        return result
    }

    /// Modular inverse via the extended Euclidean algorithm (m must be odd for our use).
    public func inverseMod(_ m: BigInt) -> BigInt? {
        var (oldR, r) = (self % m, m)
        var (oldS, s) = (BigInt.one, BigInt.zero)
        var negOld = false, negS = false   // sign flags for the Bezout coefficient
        while !r.isZero {
            let (q, rem) = BigInt.divMod(oldR, r)
            (oldR, r) = (r, rem)
            // newS = oldS - q*s, tracking signs by hand
            let qs = q * s
            var newS: BigInt
            var newNeg: Bool
            if negOld == negS {
                if BigInt.compare(oldS, qs) >= 0 { newS = oldS - qs; newNeg = negOld }
                else { newS = qs - oldS; newNeg = !negOld }
            } else {
                newS = oldS + qs; newNeg = negOld
            }
            (oldS, s) = (s, newS)
            (negOld, negS) = (negS, newNeg)
        }
        guard oldR == BigInt.one else { return nil }
        return negOld ? m - (oldS % m) : oldS % m
    }
}

/// Montgomery arithmetic for an odd modulus: multiply-and-reduce with no division.
struct Montgomery {
    let m: [UInt32]          // modulus limbs
    let k: Int               // number of limbs
    let n0inv: UInt32        // -m^-1 mod 2^32
    let rr: BigInt           // R^2 mod m, for entering the Montgomery domain

    init?(_ modulus: BigInt) {
        guard let low = modulus.limbs.first, low & 1 == 1 else { return nil }  // must be odd
        m = modulus.limbs
        k = m.count
        // Newton iteration for the inverse of m[0] modulo 2^32
        var inv: UInt32 = 1
        for _ in 0..<5 { inv = inv &* (2 &- low &* inv) }
        n0inv = ~inv &+ 1       // -inv
        rr = BigInt(limbs: [UInt32](repeating: 0, count: 2 * k) + [1]) % modulus
    }

    var modulus: BigInt { BigInt(limbs: m) }

    /// CIOS Montgomery multiplication: returns a*b*R^-1 mod m.
    func mul(_ a: BigInt, _ b: BigInt) -> BigInt {
        var t = [UInt32](repeating: 0, count: k + 2)
        let al = a.limbs, bl = b.limbs
        for i in 0..<k {
            let ai = UInt64(i < al.count ? al[i] : 0)
            var carry: UInt64 = 0
            for j in 0..<k {
                let v = UInt64(t[j]) + ai * UInt64(j < bl.count ? bl[j] : 0) + carry
                t[j] = UInt32(truncatingIfNeeded: v)
                carry = v >> 32
            }
            var v = UInt64(t[k]) + carry
            t[k] = UInt32(truncatingIfNeeded: v)
            t[k + 1] = UInt32(truncatingIfNeeded: v >> 32)

            let u = t[0] &* n0inv
            carry = 0
            for j in 0..<k {
                let v2 = UInt64(t[j]) + UInt64(u) * UInt64(m[j]) + carry
                t[j] = UInt32(truncatingIfNeeded: v2)
                carry = v2 >> 32
            }
            v = UInt64(t[k]) + carry
            t[k] = UInt32(truncatingIfNeeded: v)
            t[k + 1] = t[k + 1] &+ UInt32(truncatingIfNeeded: v >> 32)
            // shift down one limb
            for j in 0...k { t[j] = t[j + 1] }
            t[k + 1] = 0
        }
        var out = BigInt(limbs: Array(t[0...k]))
        let mod = modulus
        if BigInt.compare(out, mod) >= 0 { out = out - mod }
        return out
    }

    func powMod(_ base: BigInt, _ e: BigInt) -> BigInt {
        let mod = modulus
        let one = BigInt.one
        var result = mul(one, rr)          // 1 in Montgomery form
        var b = mul(base % mod, rr)        // base in Montgomery form
        for i in 0..<e.bitWidth {
            if e.bit(i) { result = mul(result, b) }
            b = mul(b, b)
        }
        return mul(result, one)            // back out of Montgomery form
    }
}
