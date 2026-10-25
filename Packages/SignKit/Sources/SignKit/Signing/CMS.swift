import Foundation

/// Builds the CMS (PKCS#7) signature that iOS checks against Apple's root.
/// It signs the code directory, not the app bytes directly.
///
/// The layout below is copied from a real signature made by Apple's own tool (the
/// GBox app) and checked against the open-source `zsign` and `rcodesign`:
///
///  - five signed attributes: content type, signing time, message digest, and Apple's
///    two code-directory hash attributes (1.2.840.113635.100.9.2 and .9.1);
///  - the certificates above yours (Apple's developer-relations certificate and
///    Apple's root) embedded next to yours;
///  - SHA-256 with RSA, labelled the way Apple labels it.
public enum CMS {
    /// - Parameters:
    ///   - codeDirectories: the primary code directory first.
    ///   - chain: the signing certificate first, then any further certificates from the `.p12`.
    ///     Apple's own certificates are added automatically.
    public static func sign(codeDirectories: [CodeDirectory], key: RSAPrivateKey,
                            chain: [Certificate], signingTime: Date = Date()) throws -> Data {
        guard let primary = codeDirectories.first, let leaf = chain.first else {
            throw SignKitError.crypto("nothing to sign with")
        }
        let digestKind = primary.hashKind
        let messageDigest = Hasher.hash(digestKind, primary.blob.encoded)

        // Apple's two extra attributes.
        let hashOID = digestKind == .sha1 ? OID.sha1 : OID.sha256
        let cdHashesDER = DER.set(codeDirectories.map { cd in
            DER.seq([.oid(cd.hashKind == .sha1 ? OID.sha1 : OID.sha256), .octets(cd.cdhash)])
        })
        let cdHashesPlist = cdhashPlist(codeDirectories.map { $0.truncatedCDHash })

        let signedAttrs: [DER] = [
            .seq([.oid(OID.contentType), .set([.oid(OID.pkcs7Data)])]),
            .seq([.oid(OID.signingTime), .set([.utcTime(signingTime)])]),
            .seq([.oid(OID.messageDigest), .set([.octets(messageDigest)])]),
            .seq([.oid(OID.appleCDHashes), cdHashesDER]),
            .seq([.oid(OID.appleCDHashesPlist), .set([.octets(cdHashesPlist)])]),
        ]
        // The signature covers the attributes encoded as a SET, not as the [0] they appear in.
        // DER sorts a SET by its encoding, which is also the order Apple's tool writes.
        let attrsForSigning = DER.set(signedAttrs).encoded
        let signature = try key.sign(attrsForSigning, digestKind)

        let signerInfo = DER.seq([
            .intValue(1),
            .seq([.raw(leaf.issuerDER), .int(leaf.serial)]),
            .seq([.oid(hashOID), .null]),
            .raw(CMS.retagAsContext0(attrsForSigning)),
            .seq([.oid(digestKind == .sha1 ? OID.sha1WithRSA : OID.sha256WithRSAEncryption), .null]),
            .octets(signature),
        ])

        // Everything that travels with the signature: Apple's certificates, then yours.
        let parents = AppleChain.parents(of: leaf, extra: Array(chain.dropFirst()))
        let embedded = AppleChain.embedded(leaf: leaf, parents: parents)

        let signedData = DER.seq([
            .intValue(1),
            .set([.seq([.oid(hashOID), .null])]),
            .seq([.oid(OID.pkcs7Data)]),                       // detached: no content
            .tagged(0, embedded.map { .raw($0.der) }),
            .set([signerInfo]),
        ])

        return DER.seq([.oid(OID.pkcs7SignedData), .tagged(0, [signedData])]).encoded
    }

    /// The property list Apple puts in attribute 1.2.840.113635.100.9.1: the short
    /// (20-byte) code-directory hashes. Written exactly the way Apple's tool writes it.
    public static func cdhashPlist(_ hashes: [Data]) -> Data {
        var text = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        text += "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
        text += "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
        text += "<plist version=\"1.0\">\n<dict>\n\t<key>cdhashes</key>\n\t<array>\n"
        for h in hashes {
            text += "\t\t<data>\n\t\t\(h.base64EncodedString())\n\t\t</data>\n"
        }
        text += "\t</array>\n</dict>\n</plist>\n"
        return Data(text.utf8)
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
