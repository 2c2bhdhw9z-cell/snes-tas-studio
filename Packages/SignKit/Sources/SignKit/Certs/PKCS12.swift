import Foundation

/// Reads a `.p12` certificate file: the certificate chain plus the private key.
///
/// We read these ourselves rather than handing them to iOS, because iOS refuses
/// plenty of real-world `.p12` files (old RC2-40 encryption, odd bag layouts) and
/// gives no reason why. This way the app can say exactly what is wrong.
public struct PKCS12 {
    public let certificates: [Certificate]
    public let privateKey: RSAPrivateKey?
    /// The certificate that goes with the private key, if we could tell.
    public let identity: Certificate?
    public let friendlyName: String?

    public init(data: Data, password: String) throws {
        let pfx = try DERNode.parse(data)
        guard let authSafeInfo = pfx.child(1), authSafeInfo.child(0)?.oid == OID.pkcs7Data,
              let authSafeWrap = authSafeInfo.child(1) else {
            throw SignKitError.malformed("this is not a .p12 certificate file")
        }
        let authSafe = try DERNode.parse(PKCS12.unwrap(authSafeWrap))

        var certs = [Certificate]()
        var keys = [(Data?, RSAPrivateKey)]()      // local key id, key
        var certIDs = [(Data?, Int)]()             // local key id -> index in certs
        var name: String?
        var sawEncryptedContent = false

        for info in authSafe.children {
            guard let type = info.child(0)?.oid else { continue }
            var safeContents: Data
            switch type {
            case OID.pkcs7Data:
                guard let c = info.child(1) else { continue }
                safeContents = PKCS12.unwrap(c)
            case OID.pkcs7EncryptedData:
                sawEncryptedContent = true
                guard let enc = info.child(1)?.child(0) else { continue }
                let c = enc.children
                guard c.count >= 2 else { continue }
                let encInfo = c[1]                            // EncryptedContentInfo
                guard let algo = encInfo.child(1) else { continue }
                // [0] implicit encryptedContent
                guard let contentNode = encInfo.children.first(where: { $0.tagClass == 0x80 }) else { continue }
                safeContents = try PBE.decrypt(contentNode.octets, algorithm: algo, password: password)
            default:
                continue
            }

            for bag in (try? DERNode.parse(safeContents))?.children ?? [] {
                guard let bagType = bag.child(0)?.oid,
                      let value = bag.child(1) else { continue }
                var localKeyID: Data?
                if let attrs = bag.children.first(where: { $0.tag == 0x31 }) {
                    for a in attrs.children {
                        if a.child(0)?.oid == OID.localKeyID { localKeyID = a.child(1)?.child(0)?.content }
                        if a.child(0)?.oid == OID.friendlyName { name = name ?? a.child(1)?.child(0)?.string }
                    }
                }
                switch bagType {
                case OID.certBag:
                    guard let inner = value.child(0), inner.child(0)?.oid == OID.x509Certificate,
                          let certData = inner.child(1)?.child(0)?.octets ?? inner.child(1)?.octets else { continue }
                    if let cert = try? Certificate(der: certData) {
                        certIDs.append((localKeyID, certs.count))
                        certs.append(cert)
                    }
                case OID.keyBag:
                    if let key = try? RSAPrivateKey(pkcs8: value.child(0)?.raw ?? value.raw) {
                        keys.append((localKeyID, key))
                    }
                case OID.shroudedKeyBag:
                    guard let wrap = value.child(0) else { continue }
                    let c = wrap.children
                    guard c.count >= 2 else { continue }
                    let plain = try PBE.decrypt(c[1].octets, algorithm: c[0], password: password)
                    keys.append((localKeyID, try RSAPrivateKey(pkcs8: plain)))
                default:
                    continue
                }
            }
        }

        guard !certs.isEmpty || !keys.isEmpty else {
            throw sawEncryptedContent ? SignKitError.badPassword
                                      : SignKitError.malformed("the .p12 file has no certificate inside")
        }

        certificates = certs
        privateKey = keys.first?.1
        friendlyName = name

        // Pair the key with its certificate: by the stored id if present, else by key match.
        if let (keyID, key) = keys.first {
            if let id = keyID, let hit = certIDs.first(where: { $0.0 == id }) {
                identity = certs[hit.1]
            } else {
                identity = certs.first { key.matches(publicKey: $0.publicKeyDER) } ?? certs.first
            }
        } else {
            identity = certs.first
        }
    }

    public init(url: URL, password: String) throws {
        try self.init(data: try Data(contentsOf: url), password: password)
    }

    /// Steps through an explicit `[0]` wrapper and an OCTET STRING to the bytes inside.
    static func unwrap(_ node: DERNode) -> Data {
        if node.tagClass == 0x80, node.isConstructed, let inner = node.child(0) {
            return inner.octets
        }
        return node.octets
    }

    /// True when the key and certificate really belong together.
    public var isUsableForSigning: Bool {
        guard let key = privateKey, let cert = identity else { return false }
        return key.matches(publicKey: cert.publicKeyDER)
    }
}

/// Password-based encryption schemes found in `.p12` files.
enum PBE {
    static func decrypt(_ data: Data, algorithm: DERNode, password: String) throws -> Data {
        guard let oid = algorithm.child(0)?.oid else { throw SignKitError.malformed("missing encryption type") }
        switch oid {
        case OID.pbeSHA1_3DES, OID.pbeSHA1_2DES, OID.pbeSHA1_RC2_128, OID.pbeSHA1_RC2_40:
            guard let params = algorithm.child(1),
                  let salt = params.child(0)?.content,
                  let iterNode = params.child(1) else { throw SignKitError.malformed("bad encryption settings") }
            let iterations = iterNode.intValue
            let keyLen: Int
            switch oid {
            case OID.pbeSHA1_3DES: keyLen = 24
            case OID.pbeSHA1_2DES: keyLen = 16
            case OID.pbeSHA1_RC2_128: keyLen = 16
            default: keyLen = 5
            }
            let key = KDF.pkcs12(password: password, salt: salt, iterations: iterations, id: 1, length: keyLen)
            let iv = KDF.pkcs12(password: password, salt: salt, iterations: iterations, id: 2, length: 8)
            let cipher: BlockCipher
            if oid == OID.pbeSHA1_RC2_40 {
                cipher = RC2(key: key, effectiveBits: 40)
            } else if oid == OID.pbeSHA1_RC2_128 {
                cipher = RC2(key: key, effectiveBits: 128)
            } else {
                cipher = try TripleDES(key: key)
            }
            return try CBC.decrypt(cipher, iv: iv, data)

        case OID.pbes2:
            guard let params = algorithm.child(1),
                  let kdfNode = params.child(0), let encNode = params.child(1),
                  kdfNode.child(0)?.oid == OID.pbkdf2,
                  let kdfParams = kdfNode.child(1),
                  let salt = kdfParams.child(0)?.content,
                  let iterNode = kdfParams.child(1) else {
                throw SignKitError.unsupported("this .p12 uses an encryption we do not read yet")
            }
            var prf = HashKind.sha1
            if let prfNode = kdfParams.children.last, prfNode.child(0)?.oid == OID.hmacSHA256 { prf = .sha256 }
            guard let encOID = encNode.child(0)?.oid, let iv = encNode.child(1)?.content else {
                throw SignKitError.malformed("bad encryption settings")
            }
            let keyLen: Int
            switch encOID {
            case OID.aes128CBC: keyLen = 16
            case OID.aes192CBC: keyLen = 24
            case OID.aes256CBC: keyLen = 32
            case OID.desEDE3CBC: keyLen = 24
            default: throw SignKitError.unsupported("unknown cipher in the .p12 file")
            }
            // PBES2 takes the password as plain UTF-8, not UTF-16.
            let key = KDF.pbkdf2(password: Data(password.utf8), salt: salt,
                                 iterations: iterNode.intValue, length: keyLen, hash: prf)
            let cipher: BlockCipher = encOID == OID.desEDE3CBC ? try TripleDES(key: key) : try AES(key: key)
            return try CBC.decrypt(cipher, iv: iv, data)

        default:
            throw SignKitError.unsupported("this .p12 uses an encryption we do not read yet (\(oid))")
        }
    }
}
