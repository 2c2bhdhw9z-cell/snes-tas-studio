import Foundation

/// An RSA private key, as read out of a `.p12` certificate file.
public struct RSAPrivateKey {
    public let n: BigInt, e: BigInt, d: BigInt
    public let p: BigInt, q: BigInt, dp: BigInt, dq: BigInt, qinv: BigInt
    public var modulusBytes: Int { (n.bitWidth + 7) / 8 }

    public init(n: BigInt, e: BigInt, d: BigInt, p: BigInt = .zero, q: BigInt = .zero,
                dp: BigInt = .zero, dq: BigInt = .zero, qinv: BigInt = .zero) {
        self.n = n; self.e = e; self.d = d
        self.p = p; self.q = q; self.dp = dp; self.dq = dq; self.qinv = qinv
    }

    /// PKCS#1 private key (RFC 8017 A.1.2), as found inside a PKCS#8 wrapper.
    public init(pkcs1 der: Data) throws {
        let seq = try DERNode.parse(der)
        let c = seq.children
        guard c.count >= 9 else { throw SignKitError.crypto("private key has unexpected shape") }
        n = BigInt(bytes: c[1].unsignedInteger)
        e = BigInt(bytes: c[2].unsignedInteger)
        d = BigInt(bytes: c[3].unsignedInteger)
        p = BigInt(bytes: c[4].unsignedInteger)
        q = BigInt(bytes: c[5].unsignedInteger)
        dp = BigInt(bytes: c[6].unsignedInteger)
        dq = BigInt(bytes: c[7].unsignedInteger)
        qinv = BigInt(bytes: c[8].unsignedInteger)
    }

    /// PKCS#8 PrivateKeyInfo wrapper around a PKCS#1 key.
    public init(pkcs8 der: Data) throws {
        let seq = try DERNode.parse(der)
        guard let algo = seq.child(1), algo.child(0)?.oid == OID.rsaEncryption,
              let keyOctets = seq.child(2) else {
            throw SignKitError.unsupported("only RSA certificates are supported")
        }
        try self.init(pkcs1: keyOctets.octets)
    }

    /// Raw private operation, using the Chinese remainder theorem when the extra values are present.
    func decrypt(_ m: BigInt) -> BigInt {
        guard !p.isZero, !q.isZero, !dp.isZero, !dq.isZero, !qinv.isZero else {
            return m.powMod(d, n)
        }
        let m1 = (m % p).powMod(dp, p)
        let m2 = (m % q).powMod(dq, q)
        var diff = m1
        if BigInt.compare(m1, m2) < 0 {
            // m1 - m2 mod p
            diff = p - ((m2 - m1) % p)
        } else {
            diff = m1 - m2
        }
        let h = diff.mulMod(qinv, p)
        return m2 + q * h
    }

    /// PKCS#1 v1.5 signature over the message, using the given digest.
    public func sign(_ message: Data, _ kind: HashKind) throws -> Data {
        let digest = Hasher.hash(kind, message)
        let digestInfo = DER.seq([
            .seq([.oid(kind == .sha1 ? OID.sha1 : OID.sha256), .null]),
            .octets(digest),
        ]).encoded
        let k = modulusBytes
        guard digestInfo.count + 11 <= k else { throw SignKitError.crypto("certificate key is too small") }
        var em = Data([0x00, 0x01])
        em.append(Data(repeating: 0xff, count: k - digestInfo.count - 3))
        em.append(0x00)
        em.append(digestInfo)
        let s = decrypt(BigInt(bytes: em))
        return s.bytes(padTo: k)
    }

    public var publicKeyDER: Data {
        DER.seq([
            .seq([.oid(OID.rsaEncryption), .null]),
            .bits(DER.seq([.int(n.bytes()), .int(e.bytes())]).encoded),
        ]).encoded
    }

    /// Checks that the key really belongs with the certificate's public key.
    public func matches(publicKey spki: Data) -> Bool {
        guard let parsed = try? RSAPrivateKey.publicModulus(spki: spki) else { return false }
        return parsed.0 == n && parsed.1 == e
    }

    static func publicModulus(spki: Data) throws -> (BigInt, BigInt) {
        let seq = try DERNode.parse(spki)
        guard let bits = seq.child(1) else { throw SignKitError.crypto("bad public key") }
        let inner = try DERNode.parse(bits.bitString)
        guard let n = inner.child(0), let e = inner.child(1) else { throw SignKitError.crypto("bad public key") }
        return (BigInt(bytes: n.unsignedInteger), BigInt(bytes: e.unsignedInteger))
    }

    /// Verifies one of our own signatures (used by tests and by the self-check after signing).
    public static func verify(signature: Data, message: Data, _ kind: HashKind, spki: Data) -> Bool {
        guard let (n, e) = try? publicModulus(spki: spki) else { return false }
        let m = BigInt(bytes: signature).powMod(e, n)
        let em = m.bytes(padTo: (n.bitWidth + 7) / 8)
        guard em.count > 11, em[em.startIndex] == 0, em[em.startIndex + 1] == 1 else { return false }
        guard let zero = em.find(Data([0x00]), from: 2) else { return false }
        guard let info = try? DERNode.parse(em.sub(zero + 1, em.count - zero - 1)),
              let digest = info.child(1)?.content else { return false }
        return digest == Hasher.hash(kind, message)
    }
}
