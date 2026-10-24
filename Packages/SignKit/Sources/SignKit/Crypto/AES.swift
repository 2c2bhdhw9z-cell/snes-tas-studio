import Foundation

/// AES-128/192/256 (FIPS-197), byte-oriented. Fast enough for certificate files.
struct AES: BlockCipher {
    let blockSize = 16
    let rounds: Int
    let roundKeys: [[UInt8]]   // rounds+1 keys of 16 bytes

    static let sbox: [UInt8] = {
        var s = [UInt8](repeating: 0, count: 256)
        for i in 0..<256 {
            let inv = i == 0 ? 0 : gfInverse(UInt8(i))
            var x = inv
            var r = inv
            for _ in 0..<4 {
                x = (x << 1) | (x >> 7)
                r ^= x
            }
            s[i] = r ^ 0x63
        }
        return s
    }()

    static let invSbox: [UInt8] = {
        var inv = [UInt8](repeating: 0, count: 256)
        for i in 0..<256 { inv[Int(sbox[i])] = UInt8(i) }
        return inv
    }()

    static func gfMul(_ a: UInt8, _ b: UInt8) -> UInt8 {
        var a = a, b = b, p: UInt8 = 0
        for _ in 0..<8 {
            if b & 1 != 0 { p ^= a }
            let hi = a & 0x80
            a <<= 1
            if hi != 0 { a ^= 0x1b }
            b >>= 1
        }
        return p
    }

    static func gfInverse(_ a: UInt8) -> UInt8 {
        // a^254 = a^-1 in GF(2^8)
        var result: UInt8 = 1
        var base = a
        var e = 254
        while e > 0 {
            if e & 1 != 0 { result = gfMul(result, base) }
            base = gfMul(base, base)
            e >>= 1
        }
        return result
    }

    init(key: Data) throws {
        let k = [UInt8](key)
        guard k.count == 16 || k.count == 24 || k.count == 32 else {
            throw SignKitError.crypto("bad AES key size")
        }
        let nk = k.count / 4
        rounds = nk + 6
        let total = 4 * (rounds + 1)
        var w = [[UInt8]]()
        for i in 0..<nk { w.append(Array(k[(4 * i)..<(4 * i + 4)])) }
        var rcon: UInt8 = 1
        for i in nk..<total {
            var t = w[i - 1]
            if i % nk == 0 {
                t = [t[1], t[2], t[3], t[0]].map { AES.sbox[Int($0)] }
                t[0] ^= rcon
                rcon = AES.gfMul(rcon, 2)
            } else if nk > 6 && i % nk == 4 {
                t = t.map { AES.sbox[Int($0)] }
            }
            w.append(zip(w[i - nk], t).map { $0 ^ $1 })
        }
        var keys = [[UInt8]]()
        for r in 0...rounds { keys.append(w[(4 * r)..<(4 * r + 4)].flatMap { $0 }) }
        roundKeys = keys
    }

    func encryptBlock(_ input: [UInt8]) -> [UInt8] {
        var s = zip(input, roundKeys[0]).map { $0 ^ $1 }
        for r in 1...rounds {
            s = s.map { AES.sbox[Int($0)] }
            // shift rows (state is column-major: s[row + 4*col])
            var t = s
            for row in 1..<4 { for col in 0..<4 { t[row + 4 * col] = s[row + 4 * ((col + row) % 4)] } }
            s = t
            if r != rounds {
                for c in 0..<4 {
                    let a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3]
                    s[4 * c] = AES.gfMul(a0, 2) ^ AES.gfMul(a1, 3) ^ a2 ^ a3
                    s[4 * c + 1] = a0 ^ AES.gfMul(a1, 2) ^ AES.gfMul(a2, 3) ^ a3
                    s[4 * c + 2] = a0 ^ a1 ^ AES.gfMul(a2, 2) ^ AES.gfMul(a3, 3)
                    s[4 * c + 3] = AES.gfMul(a0, 3) ^ a1 ^ a2 ^ AES.gfMul(a3, 2)
                }
            }
            s = zip(s, roundKeys[r]).map { $0 ^ $1 }
        }
        return s
    }

    func decryptBlock(_ input: [UInt8]) -> [UInt8] {
        var s = zip(input, roundKeys[rounds]).map { $0 ^ $1 }
        for r in stride(from: rounds - 1, through: 0, by: -1) {
            // inverse shift rows
            var t = s
            for row in 1..<4 { for col in 0..<4 { t[row + 4 * ((col + row) % 4)] = s[row + 4 * col] } }
            s = t.map { AES.invSbox[Int($0)] }
            s = zip(s, roundKeys[r]).map { $0 ^ $1 }
            if r != 0 {
                for c in 0..<4 {
                    let a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3]
                    s[4 * c] = AES.gfMul(a0, 14) ^ AES.gfMul(a1, 11) ^ AES.gfMul(a2, 13) ^ AES.gfMul(a3, 9)
                    s[4 * c + 1] = AES.gfMul(a0, 9) ^ AES.gfMul(a1, 14) ^ AES.gfMul(a2, 11) ^ AES.gfMul(a3, 13)
                    s[4 * c + 2] = AES.gfMul(a0, 13) ^ AES.gfMul(a1, 9) ^ AES.gfMul(a2, 14) ^ AES.gfMul(a3, 11)
                    s[4 * c + 3] = AES.gfMul(a0, 11) ^ AES.gfMul(a1, 13) ^ AES.gfMul(a2, 9) ^ AES.gfMul(a3, 14)
                }
            }
        }
        return s
    }
}
