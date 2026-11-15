import Foundation

/// Reads a Debian package (`.deb`) and hands back the `.dylib` files inside it.
///
/// A `.deb` is three parts stuck together: a tiny `ar` archive header, then
/// `debian-binary`, then one or more compressed `tar` archives (`data.tar.gz`,
/// `data.tar.xz`, `data.tar.zst`). There is no need for a full tar reader: the
/// only thing wanted is the paths ending in `.dylib`, so the tar blocks are walked
/// in order and the wanted files are cut out.
///
/// The point is the add-ons people actually download: Cydia and Sileo packages hold
/// a `.dylib`, and a signature is the only thing between it and the app.
public enum Deb {

    public struct Member {
        /// Where it sits inside the package, e.g. `Library/MobileSubstrate/DynamicLibraries/Foo.dylib`.
        public let path: String
        public let data: Data
    }

    public enum DebError: Error, CustomStringConvertible {
        case notADeb
        case unsupported(String)
        case damaged(String)
        public var description: String {
            switch self {
            case .notADeb: return "this file is not a .deb package"
            case .unsupported(let s): return "Not supported: \(s)"
            case .damaged(let s): return "Damaged: \(s)"
            }
        }
    }

    /// Every `.dylib` inside `url`, ready to be used as an add-on.
    public static func dylibs(in url: URL) throws -> [Member] {
        try dylibs(in: try Data(contentsOf: url, options: .mappedIfSafe))
    }

    public static func dylibs(in data: Data) throws -> [Member] {
        guard data.count > 8, data.sub(0, 8) == Data("!<arch>\n".utf8) else { throw DebError.notADeb }
        var members = [Member]()
        var offset = 8
        while offset + 60 <= data.count {
            // Every ar member starts with a 60-byte header: a name, then sizes and a magic.
            // The name is padded with NULs or spaces and sometimes carries a trailing slash
            // (`data.tar.gz/`), so all three are trimmed before the name is compared.
            let header = data.sub(offset, 60)
            let name = String(decoding: header.sub(0, 16), as: UTF8.self)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\0 /"))
            guard let size = Int(String(decoding: header.sub(48, 10), as: UTF8.self)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\0 "))) else { break }
            let bodyStart = offset + 60
            guard bodyStart + size <= data.count else { throw DebError.damaged("a part runs past the end of the file") }
            let body = data.sub(bodyStart, size)
            offset = bodyStart + size + (size % 2)   // every member is padded to an even length

            // `data.tar.gz`, `data.tar.xz`, `data.tar.zst`, `data.tar` - and long names.
            let plain = name.hasPrefix("#1/") ? String(decoding: body.sub(0, size), as: UTF8.self)
                .trimmingCharacters(in: .init(charactersIn: "\0")) : name
            guard plain.contains("data.tar") else { continue }
            members.append(contentsOf: try dylibs(fromTar: body, name: plain))
        }
        return members
    }

    /// Opens the tar body with whichever compressor its name says, then walks it.
    private static func dylibs(fromTar body: Data, name: String) throws -> [Member] {
        let tar: Data
        if name.hasSuffix(".gz") {
            // A `.deb`'s data.tar.gz is gzip, not raw deflate, so it is opened as gzip (47).
            tar = try Zip.inflate(body, expected: body.count * 4, windowBits: 47)
        } else if name.hasSuffix(".xz") {
            throw DebError.unsupported(UnsupportedCompressor.explain(xz: true))
        } else if name.hasSuffix(".zst") {
            throw DebError.unsupported(UnsupportedCompressor.explain(xz: false))
        } else if name.hasSuffix(".tar") {
            tar = body
        } else {
            throw DebError.unsupported("this package is compressed in a way Signer does not know")
        }
        return walk(tar)
    }

    /// A tar file is 512-byte headers, each followed by its file's bytes, padded to 512.
    static func walk(_ tar: Data) -> [Member] {
        var found = [Member]()
        var offset = 0
        var longName: String?
        while offset + 512 <= tar.count {
            let header = tar.sub(offset, 512)
            // Two zero blocks end the archive.
            if header.allSatisfy({ $0 == 0 }) { break }
            let rawName = header.sub(0, 100)
            var name = String(decoding: rawName.prefix(while: { $0 != 0 }), as: UTF8.self)
            guard let size = octal(header.sub(124, 12)) else { break }
            let type = header.u8(156)
            let bodyStart = offset + 512
            let padded = (size + 511) / 512 * 512
            defer { offset = bodyStart + padded }

            switch type {
            case UInt8(ascii: "L"):   // GNU long name: the next header's name is in here
                longName = String(decoding: tar.sub(bodyStart, size).prefix(while: { $0 != 0 }), as: UTF8.self)
                continue
            case UInt8(ascii: "x"), UInt8(ascii: "g"):   // extended header: `path=` may be inside
                let text = String(decoding: tar.sub(bodyStart, size), as: UTF8.self)
                if let pathLine = text.split(separator: "\n").first(where: { $0.hasPrefix("path=") }) {
                    longName = String(pathLine.dropFirst(5))
                }
                continue
            case UInt8(ascii: "5"), UInt8(ascii: "2"), UInt8(ascii: "1"):
                continue   // folder, symlink, hard link: nothing to take
            default:
                break
            }
            if let pending = longName, !pending.isEmpty {
                name = pending
                longName = nil
            }
            // Some packages write `./Library/...`; strip the leading dot.
            if name.hasPrefix("./") { name = String(name.dropFirst(2)) }
            guard name.lowercased().hasSuffix(".dylib") else { continue }
            found.append(Member(path: name, data: tar.sub(bodyStart, size)))
        }
        return found
    }

    /// Tar stores numbers as octal text, sometimes with a leading space and a trailing NUL.
    static func octal(_ bytes: Data) -> Int? {
        var text = String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespaces)
        text = text.replacingOccurrences(of: "\0", with: "")
        guard !text.isEmpty else { return 0 }
        return Int(text, radix: 8)
    }
}
