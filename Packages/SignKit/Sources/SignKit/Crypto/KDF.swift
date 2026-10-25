import Foundation

/// Password-to-key conversions used by `.p12` certificate files.
public enum KDF {
    /// PKCS#12 key derivation (RFC 7292 appendix B.2). `id` is 1 for a key,
    /// 2 for an IV, 3 for a MAC key.
    public static func pkcs12(password: String, salt: Data, iterations: Int,
                              id: UInt8, length: Int, hash: HashKind = .sha1) -> Data {
        // The password goes in as big-endian UTF-16 with a trailing null.
        var pw = Data()
        for u in Array(password.utf16) { pw.put16le(u.byteSwapped) }
        if !password.isEmpty || true { pw.append(contentsOf: [0, 0]) }

        let v = 64                     // block size for SHA-1/SHA-256
        let d = Data(repeating: id, count: v)

        func fill(_ src: Data) -> Data {
            guard !src.isEmpty else { return Data() }
            let n = v * ((src.count + v - 1) / v)
            var out = Data()
            while out.count < n { out.append(src) }
            return out.prefix(n)
        }
        let s = fill(salt)
        let p = fill(pw)
        var i = s + p

        var out = Data()
        while out.count < length {
            var a = Hasher.hash(hash, d + i)
            for _ in 1..<max(1, iterations) { a = Hasher.hash(hash, a) }
            out.append(a)
            if out.count >= length { break }

            // B = the first v bytes of A, repeated
            var b = Data()
            while b.count < v { b.append(a) }
            b = b.prefix(v)

            // I_j = I_j + B + 1, as big numbers, for every v-byte block of I
            var newI = Data()
            var j = 0
            while j < i.count {
                let block = i.sub(j, min(v, i.count - j))
                let sum = BigInt(bytes: block) + BigInt(bytes: b) + BigInt.one
                var bytes = sum.bytes()
                if bytes.count > block.count {
                    bytes = bytes.suffix(block.count)       // keep the low bytes
                } else if bytes.count < block.count {
                    bytes = Data(count: block.count - bytes.count) + bytes
                }
                newI.append(bytes)
                j += v
            }
            i = newI
        }
        return out.prefix(length)
    }

    /// PBKDF2 (RFC 8018), used by newer `.p12` files through PBES2.
    public static func pbkdf2(password: Data, salt: Data, iterations: Int,
                              length: Int, hash: HashKind = .sha1) -> Data {
        var out = Data()
        var block: UInt32 = 1
        while out.count < length {
            var salted = salt
            salted.put32be(block)
            var u = hmac(hash, key: password, salted)
            var t = u
            for _ in 1..<max(1, iterations) {
                u = hmac(hash, key: password, u)
                t = Data(zip(t, u).map { $0 ^ $1 })
            }
            out.append(t)
            block += 1
        }
        return out.prefix(length)
    }
}
