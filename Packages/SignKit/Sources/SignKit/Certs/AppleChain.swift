import Foundation

/// Apple's own certificates, and the job of linking a signing certificate back to Apple.
///
/// A `.p12` file normally holds only *your* certificate. iOS wants the signature itself
/// to carry the rest of the chain (Apple's developer-relations certificate and Apple's
/// root). Every working signer adds them; Apple's own tool does too. Without them iOS
/// cannot trace the signature to Apple and refuses the app with the vague message
/// "integrity could not be verified".
public enum AppleChain {
    /// Apple's public certificates, built into the app so nothing needs the internet.
    public static let known: [Certificate] = {
        AppleCertificateData.all.compactMap { entry in
            guard let der = Data(base64Encoded: entry.1, options: .ignoreUnknownCharacters) else { return nil }
            return try? Certificate(der: der)
        }
    }()

    /// The certificates above `leaf`, nearest first, ending at Apple's root when it is known.
    /// `extra` are any further certificates that arrived with the `.p12`.
    public static func parents(of leaf: Certificate, extra: [Certificate] = []) -> [Certificate] {
        var pool = known
        for e in extra where !pool.contains(where: { $0.der == e.der }) { pool.append(e) }

        var result = [Certificate]()
        var current = leaf
        // Real chains are three long. The limit only stops a malformed loop.
        for _ in 0..<4 {
            if current.isSelfIssued { break }
            guard let parent = issuer(of: current, in: pool),
                  !result.contains(where: { $0.der == parent.der }) else { break }
            result.append(parent)
            current = parent
        }
        return result
    }

    /// Finds the certificate that issued `cert`. Several of Apple's developer-relations
    /// certificates share one name, so the key identifiers decide between them.
    static func issuer(of cert: Certificate, in pool: [Certificate]) -> Certificate? {
        let named = pool.filter { $0.subjectDER == cert.issuerDER && $0.der != cert.der }
        guard named.count > 1 else { return named.first }
        if let wanted = cert.authorityKeyID,
           let exact = named.first(where: { $0.subjectKeyID == wanted }) {
            return exact
        }
        // As a last resort, the one whose key really signed it (RSA issuers only).
        return named.first(where: { cert.isSigned(by: $0) == true }) ?? named.first
    }

    /// True when the chain ends at a certificate that vouches for itself, which for
    /// Apple's certificates means Apple's root.
    public static func reachesRoot(_ parents: [Certificate], leaf: Certificate) -> Bool {
        if leaf.isSelfIssued { return true }
        return parents.last?.isSelfIssued == true
    }

    /// Everything that goes into the signature, in the order Apple's own tool writes it:
    /// the certificates above yours, then yours last.
    public static func embedded(leaf: Certificate, parents: [Certificate]) -> [Certificate] {
        // A SET OF is stored sorted by its encoding; for these certificates that is
        // shortest first, which is exactly the order Apple writes.
        (parents + [leaf]).sorted { $0.der.lexicographicallyPrecedes($1.der) }
    }
}
