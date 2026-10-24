import Foundation

/// Builds the CMS (PKCS#7) signature that iOS checks against Apple's root.
/// It signs the code directory, not the app bytes directly.
public enum CMS {
    /// - Parameters:
    ///   - codeDirectories: the primary code directory first; others go in the Apple hash attributes.
    ///   - chain: signing certificate first, then any intermediates.
    public static func sign(codeDirectories: [CodeDirectory], key: RSAPrivateKey,
                            chain: [Certificate], signingTime: Date = Date(),
                            includeAppleHashAttributes: Bool = false) throws -> Data {
        guard let primary = codeDirectories.first, let leaf = chain.first else {
            throw SignKitError.crypto("nothing to sign with")
        }
        let digestKind = primary.hashKind
        let messageDigest = Hasher.hash(digestKind, primary.blob.encoded)

        // Apple's two extra attributes: the short hashes as a plist, and the full ones in DER.
        let plist: [String: Any] = ["cdhashes": codeDirectories.map { $0.truncatedCDHash }]
        let cdhashPlist = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        let cdhashSeq = DER.seq(codeDirectories.map { cd in
            .seq([.seq([.oid(cd.hashKind == .sha1 ? OID.sha1 : OID.sha256), .null]), .octets(cd.cdhash)])
        })

        // Real shipping signatures (checked against ESign and Apple's own) carry
        // these three attributes; the two Apple hash attributes are optional extras.
        var signedAttrs: [DER] = [
            .seq([.oid(OID.contentType), .set([.oid(OID.pkcs7Data)])]),
            .seq([.oid(OID.signingTime), .set([.utcTime(signingTime)])]),
            .seq([.oid(OID.messageDigest), .set([.octets(messageDigest)])]),
        ]
        if includeAppleHashAttributes {
            signedAttrs.append(.seq([.oid(OID.appleCDHashesPlist), .set([.octets(cdhashPlist)])]))
            signedAttrs.append(.seq([.oid(OID.appleCDHashes), .set([cdhashSeq])]))
        }
        // The signature covers the attributes encoded as a SET, not as the [0] they appear in.
        let attrsForSigning = DER.set(signedAttrs).encoded
        let signature = try key.sign(attrsForSigning, digestKind)

        let digestOID = digestKind == .sha1 ? OID.sha1 : OID.sha256
        let signerInfo = DER.seq([
            .intValue(1),
            .seq([.raw(leaf.issuerDER), .int(leaf.serial)]),
            .seq([.oid(digestOID), .null]),
            .raw(CMS.retagAsContext0(attrsForSigning)),
            .seq([.oid(OID.rsaEncryption), .null]),
            .octets(signature),
        ])

        let signedData = DER.seq([
            .intValue(1),
            .set([.seq([.oid(digestOID), .null])]),
            .seq([.oid(OID.pkcs7Data)]),                       // detached: no content
            .tagged(0, chain.map { .raw($0.der) }),
            .set([signerInfo]),
        ])

        return DER.seq([.oid(OID.pkcs7SignedData), .tagged(0, [signedData])]).encoded
    }

    /// Length of the tag+length header of a DER value, so the body can be re-tagged as [0].
    static func headerLength(_ d: Data) -> Int {
        guard d.count >= 2 else { return 2 }
        let len = Int(d[d.startIndex + 1])
        if len & 0x80 == 0 { return 2 }
        return 2 + (len & 0x7f)
    }

    /// Re-tags a DER SET as the implicit `[0]` form that signed attributes use in the message.
    static func retagAsContext0(_ setEncoding: Data) -> Data {
        let h = headerLength(setEncoding)
        let body = setEncoding.sub(h, setEncoding.count - h)
        return DER.tlv(0xa0, body)
    }
}
