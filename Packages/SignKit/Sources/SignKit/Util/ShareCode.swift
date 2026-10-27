import Foundation

/// Share codes: the strings signers pass around to hand over a whole list of repositories at
/// once, instead of one address at a time.
///
/// ESign calls its one an encrypted export, which is why people say "encrypted ESign repo".
/// It is not a feed and nothing is downloaded: the code is `source[` + base64 + `]`, and the
/// bytes inside are the plain list of addresses with every byte flipped against a fixed key
/// that ships inside ESign. Three other signers pass round base64 with their own separator:
/// KravaSign uses `[K$]`, MapleSign `[M$]`, FlareStore `[F$]`.
///
/// The format and the key were taken from FlareStore's public Repository Decoder page
/// (flarestore.app/repo-decoder), whose own note says the key matches ESign's
/// `RepoSourceParser.swift`. This is our own implementation of it, both ways, so Signer can
/// read anybody's code and hand out its own.
public enum ShareCode {
    public enum Format: String, CaseIterable, Sendable {
        case esign, flareStore, kravaSign, mapleSign, base64, plain

        /// What to call it on screen.
        public var label: String {
            switch self {
            case .esign: return "ESign code"
            case .flareStore: return "FlareStore code"
            case .kravaSign: return "KravaSign code"
            case .mapleSign: return "MapleSign code"
            case .base64: return "a jumbled list"
            case .plain: return "a plain list"
            }
        }
    }

    public struct Decoded: Sendable {
        public let format: Format
        public let urls: [URL]
    }

    /// Works out what the text is and pulls the addresses out of it. Handles a share code from
    /// any of the signers above, a jumbled list, one address, or a whole page of them.
    public static func decode(_ text: String) -> Decoded? {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }

        // ESign's own code.
        if cleaned.hasPrefix("source[") && cleaned.hasSuffix("]") {
            let inner = String(cleaned.dropFirst(7).dropLast())
            if let bytes = Data(base64Encoded: inner, options: [.ignoreUnknownCharacters]) {
                let flipped = flip(Array(bytes))
                let urls = addresses(in: readable(flipped))
                if !urls.isEmpty { return Decoded(format: .esign, urls: urls) }
            }
        }

        // The base64 ones, told apart by the separator inside.
        if let bytes = Data(base64Encoded: cleaned, options: [.ignoreUnknownCharacters]),
           !bytes.isEmpty {
            let inside = readable(Array(bytes))
            for (separator, format) in [("[K$]", Format.kravaSign),
                                        ("[M$]", Format.mapleSign),
                                        ("[F$]", Format.flareStore)] {
                if inside.contains(separator) {
                    let urls = addresses(in: inside.replacingOccurrences(of: separator, with: "\n"))
                    if !urls.isEmpty { return Decoded(format: format, urls: urls) }
                }
            }
            let urls = addresses(in: inside)
            if !urls.isEmpty { return Decoded(format: .base64, urls: urls) }
        }

        // Plain text: one address, or a list of them.
        let urls = addresses(in: text)
        if !urls.isEmpty { return Decoded(format: .plain, urls: urls) }
        return nil
    }

    /// Writes a code other signers can read.
    public static func encode(_ urls: [URL], as format: Format) -> String {
        let list = urls.map { $0.absoluteString }
        switch format {
        case .esign:
            let joined = Array(list.joined(separator: "\n").utf8)
            return "source[" + Data(flip(joined)).base64EncodedString() + "]"
        case .flareStore:
            return Data(list.joined(separator: "[F$]").utf8).base64EncodedString()
        case .kravaSign:
            return Data(list.joined(separator: "[K$]").utf8).base64EncodedString()
        case .mapleSign:
            return Data(list.joined(separator: "[M$]").utf8).base64EncodedString()
        case .base64:
            return Data(list.joined(separator: "\n").utf8).base64EncodedString()
        case .plain:
            return list.joined(separator: "\n")
        }
    }

    // MARK: - the pieces

    /// Flips every byte against the key. The same operation both ways, which is why one
    /// function does reading and writing.
    static func flip(_ bytes: [UInt8]) -> [UInt8] {
        let key = esignKey
        guard !key.isEmpty else { return bytes }
        var out = [UInt8]()
        out.reserveCapacity(bytes.count)
        for (index, byte) in bytes.enumerated() {
            out.append(byte ^ key[index % key.count])
        }
        return out
    }

    /// Bytes as text. A code flipped with a different key comes out as rubbish rather than
    /// nothing, so every byte has to map to something: UTF-8 first, byte-for-byte after.
    static func readable(_ bytes: [UInt8]) -> String {
        if let text = String(bytes: bytes, encoding: .utf8) { return text }
        return String(bytes.map { Character(UnicodeScalar($0)) })
    }

    /// Every web address in a lump of text, in the order they appear, without repeats.
    public static func addresses(in text: String) -> [URL] {
        var found: [URL] = []
        var seen = Set<String>()
        let breaks: Set<Character> = ["\n", "\r", " ", ",", "\t", "\"", "'", "<", ">", "|"]
        for piece in text.split(whereSeparator: { breaks.contains($0) }) {
            var candidate = piece.trimmingCharacters(in: .whitespacesAndNewlines)
            // People paste addresses inside brackets, quotes and sentences.
            while let first = candidate.first, "([{<".contains(first) { candidate.removeFirst() }
            while let last = candidate.last, ")]}>,;.".contains(last) { candidate.removeLast() }
            let lower = candidate.lowercased()
            guard lower.hasPrefix("http://") || lower.hasPrefix("https://"), candidate.count >= 10,
                  let url = URL(string: candidate), url.host?.contains(".") == true else { continue }
            if seen.insert(url.absoluteString).inserted { found.append(url) }
        }
        return found
    }

    /// The key ESign flips its codes with, 5056 bytes of it.
    static let esignKey: [UInt8] = {
        let packed = """
        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
        pjVSxzsHV/gr9EtGYZ+7WvPt5g==
        """
        guard let data = Data(base64Encoded: packed.filter { !$0.isWhitespace }) else { return [] }
        return Array(data)
    }()
}
