import Foundation

/// Block ciphers used to lock `.p12` certificate files: AES, Triple-DES and RC2.
/// Written from the published standards (FIPS-197, FIPS 46-3, RFC 2268).
protocol BlockCipher {
    var blockSize: Int { get }
    func encryptBlock(_ b: [UInt8]) -> [UInt8]
    func decryptBlock(_ b: [UInt8]) -> [UInt8]
}

enum CBC {
    /// CBC decrypt + PKCS#7 padding removal. A wrong password shows up as bad padding.
    static func decrypt(_ cipher: BlockCipher, iv: Data, _ data: Data) throws -> Data {
        let bs = cipher.blockSize
        guard data.count % bs == 0, !data.isEmpty, iv.count == bs else { throw SignKitError.badPassword }
        var prev = [UInt8](iv)
        let bytes = [UInt8](data)
        var out = [UInt8]()
        out.reserveCapacity(bytes.count)
        var i = 0
        while i < bytes.count {
            let block = Array(bytes[i..<(i + bs)])
            let dec = cipher.decryptBlock(block)
            for j in 0..<bs { out.append(dec[j] ^ prev[j]) }
            prev = block
            i += bs
        }
        guard let pad = out.last, pad >= 1, Int(pad) <= bs,
              out.suffix(Int(pad)).allSatisfy({ $0 == pad }) else { throw SignKitError.badPassword }
        return Data(out.dropLast(Int(pad)))
    }

    /// CBC encrypt with PKCS#7 padding.
    static func encrypt(_ cipher: BlockCipher, iv: Data, _ data: Data) -> Data {
        let bs = cipher.blockSize
        var bytes = [UInt8](data)
        let pad = bs - bytes.count % bs
        bytes += [UInt8](repeating: UInt8(pad), count: pad)
        var prev = [UInt8](iv)
        var out = [UInt8]()
        var i = 0
        while i < bytes.count {
            var block = Array(bytes[i..<(i + bs)])
            for j in 0..<bs { block[j] ^= prev[j] }
            prev = cipher.encryptBlock(block)
            out += prev
            i += bs
        }
        return Data(out)
    }
}
