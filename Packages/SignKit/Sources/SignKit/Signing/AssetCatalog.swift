import Foundation
import CZlib

/// Reading Apple's compiled image set, `Assets.car`.
///
/// Fourth on docs/FEATURES.md: an app whose icon only exists in here shows up blank in every
/// signer, and the usual "fix" is to delete the file, which takes every other picture in the
/// app with it. This reads it instead.
///
/// The file is a BOM (Apple's "bill of materials", big-endian blocks and trees) holding a tree
/// of renditions, each one a CSI record (little-endian) with the size, the scale and the
/// pixels. The pixels themselves come in a dozen packings, several of which only iOS can
/// unpack; the ones that are already a PNG or a JPEG, or are plain or zlib-packed pixels, are
/// unpacked here, and everything else is reported honestly with what packing it uses, so the
/// app can hand those to iOS instead (`IconReader` on the phone).
public enum AssetCatalog {
    public struct Rendition: Hashable, Sendable {
        /// The name of the thing it belongs to, as the app refers to it: "AppIcon".
        public var facet: String
        /// The name Xcode gave the file it was built from.
        public var name: String
        public var width: Int
        public var height: Int
        /// 100 = 1x, 200 = 2x, 300 = 3x.
        public var scale: Int
        /// "BGRA", "JPEG", "DATA", "GA8 "…
        public var pixelFormat: String
        public var packing: Packing
        /// Where the pixels sit inside the catalogue, for the unpacking below.
        public var payloadOffset: Int
        public var payloadLength: Int
        public var rowBytes: Int

        public var pixels: Int { width * height }
    }

    public enum Packing: Hashable, Sendable {
        /// Already a picture file, ready to use.
        case png
        case jpeg
        /// Plain pixels.
        case raw
        /// zlib, which we can undo.
        case zlib
        /// One of Apple's own packings (lzvn, lzfse, palette, deepmap, astc). The number is
        /// what the catalogue says, kept so it can be named in a report.
        case apple(Int)
        case unknown

        public var canUnpackHere: Bool {
            switch self {
            case .png, .jpeg, .raw, .zlib: return true
            case .apple, .unknown: return false
            }
        }

        public var label: String {
            switch self {
            case .png: return "a PNG"
            case .jpeg: return "a JPEG"
            case .raw: return "plain pixels"
            case .zlib: return "zlib-packed pixels"
            case .apple(let kind): return "Apple's packing number \(kind)"
            case .unknown: return "a packing we do not know"
            }
        }
    }

    public struct Catalog: Sendable {
        public var renditions: [Rendition] = []
        /// Every name the app can ask for: "AppIcon", "AccentColor"…
        public var facets: [String] = []

        /// The biggest icon in here, which is the one worth showing.
        public var bestIcon: Rendition? {
            let icons = renditions.filter {
                $0.facet.localizedCaseInsensitiveContains("appicon")
                    || $0.name.localizedCaseInsensitiveContains("appicon")
            }
            let pool = icons.isEmpty ? renditions.filter { $0.width == $0.height && $0.width >= 60 } : icons
            return pool.filter { $0.pixels > 0 }.max { left, right in
                // A picture we can unpack here beats a bigger one we cannot.
                if left.packing.canUnpackHere != right.packing.canUnpackHere {
                    return right.packing.canUnpackHere
                }
                return left.pixels < right.pixels
            }
        }
    }

    /// Reads the catalogue's contents list. Does not unpack any pixels.
    public static func read(_ data: Data) throws -> Catalog {
        guard data.count > 32, data.sub(0, 8) == Data("BOMStore".utf8) else {
            throw SignKitError.malformed("that is not a compiled image set")
        }
        let indexOffset = Int(data.u32be(16))
        let varsOffset = Int(data.u32be(24))
        guard indexOffset + 4 < data.count, varsOffset + 4 < data.count else {
            throw SignKitError.malformed("the image set's table of contents is damaged")
        }

        // Where every block lives.
        let blockCount = Int(data.u32be(indexOffset))
        var blocks: [(offset: Int, length: Int)] = []
        blocks.reserveCapacity(blockCount)
        for index in 0..<min(blockCount, 1 << 20) {
            let entry = indexOffset + 4 + index * 8
            guard entry + 8 <= data.count else { break }
            blocks.append((Int(data.u32be(entry)), Int(data.u32be(entry + 4))))
        }
        func block(_ index: Int) -> Data? {
            guard index > 0, index < blocks.count else { return nil }
            let (offset, length) = blocks[index]
            guard length > 0, offset >= 0, offset + length <= data.count else { return nil }
            return data.sub(offset, length)
        }
        func blockRange(_ index: Int) -> (offset: Int, length: Int)? {
            guard index > 0, index < blocks.count else { return nil }
            let entry = blocks[index]
            guard entry.length > 0, entry.offset + entry.length <= data.count else { return nil }
            return entry
        }

        // The named variables: RENDITIONS, FACETKEYS, KEYFORMAT…
        var variables: [String: Int] = [:]
        let variableCount = Int(data.u32be(varsOffset))
        var cursor = varsOffset + 4
        for _ in 0..<min(variableCount, 1000) {
            guard cursor + 5 <= data.count else { break }
            let index = Int(data.u32be(cursor))
            let nameLength = Int(data.u8(cursor + 4))
            guard cursor + 5 + nameLength <= data.count else { break }
            let name = String(bytes: Array(data.sub(cursor + 5, nameLength)), encoding: .utf8) ?? ""
            variables[name] = index
            cursor += 5 + nameLength
        }

        // Which attribute in a rendition's key says what it belongs to.
        var identifierIndex: Int?
        if let keyFormat = variables["KEYFORMAT"].flatMap(block) {
            let count = Int(keyFormat.u32le(8))
            var tokens: [UInt32] = []
            for index in 0..<min(count, 64) where 12 + index * 4 + 4 <= keyFormat.count {
                tokens.append(keyFormat.u32le(12 + index * 4))
            }
            identifierIndex = tokens.firstIndex(of: 17)   // 17 is the identifier
        }

        /// Walks a BOM tree and hands back every (key, value) pair of block numbers.
        func pairs(ofTree variable: String) -> [(key: Int, value: Int)] {
            guard let tree = variables[variable].flatMap(block), tree.count >= 21,
                  tree.sub(0, 4) == Data("tree".utf8) else { return [] }
            var out: [(key: Int, value: Int)] = []
            var queue = [Int(tree.u32be(8))]
            var visited = Set<Int>()
            while let index = queue.popLast() {
                guard visited.insert(index).inserted, let paths = block(index), paths.count >= 12
                else { continue }
                let isLeaf = paths.u16be(0) != 0
                let count = Int(paths.u16be(2))
                let forward = Int(paths.u32be(4))
                for entry in 0..<count {
                    let at = 12 + entry * 8
                    guard at + 8 <= paths.count else { break }
                    let value = Int(paths.u32be(at))
                    let key = Int(paths.u32be(at + 4))
                    if isLeaf {
                        out.append((key, value))
                    } else {
                        queue.append(value)
                    }
                }
                if forward != 0 { queue.append(forward) }
            }
            return out
        }

        // Names, and the identifier each one goes by.
        var facetByIdentifier: [UInt16: String] = [:]
        var facetNames: [String] = []
        for pair in pairs(ofTree: "FACETKEYS") {
            guard let keyData = block(pair.key), let valueData = block(pair.value),
                  let name = String(bytes: Array(keyData), encoding: .utf8) else { continue }
            facetNames.append(name)
            guard valueData.count >= 6 else { continue }
            let attributeCount = Int(valueData.u16le(4))
            for index in 0..<min(attributeCount, 32) {
                let at = 6 + index * 4
                guard at + 4 <= valueData.count else { break }
                if valueData.u16le(at) == 17 {
                    facetByIdentifier[valueData.u16le(at + 2)] = name
                }
            }
        }

        var catalog = Catalog()
        catalog.facets = facetNames.sorted()

        for pair in pairs(ofTree: "RENDITIONS") {
            guard let keyData = block(pair.key), let valueRange = blockRange(pair.value),
                  let csi = block(pair.value), csi.count > 172,
                  csi.sub(0, 4) == Data("ISTC".utf8) else { continue }
            var facet = ""
            if let identifierIndex, keyData.count >= (identifierIndex + 1) * 2 {
                facet = facetByIdentifier[keyData.u16le(identifierIndex * 2)] ?? ""
            }
            let width = Int(csi.u32le(12))
            let height = Int(csi.u32le(16))
            let scale = Int(csi.u32le(20))
            let format = String(bytes: Array(csi.sub(24, 4)).reversed(), encoding: .utf8) ?? ""
            let name = cString(csi.sub(40, 128))
            let infoLength = Int(csi.u32le(168))
            guard 172 + infoLength <= csi.count else { continue }
            let payload = csi.sub(172 + infoLength, csi.count - 172 - infoLength)
            let (packing, dataOffset, dataLength, rowBytes) = describe(payload: payload)
            catalog.renditions.append(Rendition(
                facet: facet.isEmpty ? name : facet,
                name: name, width: width, height: height, scale: scale,
                pixelFormat: format, packing: packing,
                payloadOffset: valueRange.offset + 172 + infoLength + dataOffset,
                payloadLength: dataLength, rowBytes: rowBytes))
        }
        return catalog
    }

    /// Looks at a rendition's pixel block and works out how it is packed.
    static func describe(payload: Data) -> (Packing, Int, Int, Int) {
        guard payload.count > 8 else { return (.unknown, 0, 0, 0) }
        // A picture file stored as it is.
        if payload.count > 8, payload.u32be(0) == 0x8950_4E47 { return (.png, 0, payload.count, 0) }
        if payload.u8(0) == 0xFF, payload.u8(1) == 0xD8 { return (.jpeg, 0, payload.count, 0) }

        // A bitmap list: a short head, then "CELM" (written backwards) and the pixels.
        var rowBytes = 0
        if payload.count > 12 { rowBytes = Int(payload.u32le(8)) }
        var at = 0
        var found = -1
        while at + 4 <= min(payload.count, 64) {
            if payload.sub(at, 4) == Data("MLEC".utf8) { found = at; break }
            at += 1
        }
        guard found >= 0, found + 16 <= payload.count else {
            // No element header: treat what is there as plain pixels.
            return (.raw, 0, payload.count, rowBytes)
        }
        // After "MLEC" come three words - a version, which packing, and a small number that is
        // not a byte count (it reads 4 on real catalogues whose pixels run to half a megabyte),
        // so the pixels are simply the rest of the block.
        let kind = Int(payload.u32le(found + 8))
        let start = found + 16
        let bytes = max(0, payload.count - start)
        let packing: Packing
        switch kind {
        case 0: packing = .raw
        case 2: packing = .zlib
        default:
            // Anything else is one of Apple's own; the pixels are not readable here. A zlib
            // stream still gives itself away by its first byte, whatever the number says.
            if start < payload.count, payload.u8(start) == 0x78 {
                packing = .zlib
            } else {
                packing = .apple(kind)
            }
        }
        return (packing, start, bytes, rowBytes)
    }

    /// Unpacks one rendition into a PNG, when its packing allows it here.
    /// Returns nil for Apple's own packings - those are for `IconReader` on the phone.
    public static func png(for rendition: Rendition, in data: Data) -> Data? {
        guard rendition.payloadLength > 0,
              rendition.payloadOffset + rendition.payloadLength <= data.count else { return nil }
        let payload = data.sub(rendition.payloadOffset, rendition.payloadLength)
        switch rendition.packing {
        case .png, .jpeg:
            return payload
        case .raw:
            return PNG.write(bgra: payload, width: rendition.width, height: rendition.height,
                             rowBytes: rendition.rowBytes)
        case .zlib:
            guard let pixels = inflate(payload) else { return nil }
            return PNG.write(bgra: pixels, width: rendition.width, height: rendition.height,
                             rowBytes: rendition.rowBytes)
        case .apple, .unknown:
            return nil
        }
    }

    /// zlib, both the wrapped and bare forms.
    static func inflate(_ input: Data) -> Data? {
        for windowBits in [Int32(47), Int32(-15)] {
            var stream = z_stream()
            guard inflateInit2_(&stream, windowBits, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
            else { continue }
            defer { inflateEnd(&stream) }
            var out = Data()
            var buffer = [UInt8](repeating: 0, count: 1 << 16)
            var finished = false
            var source = [UInt8](input)
            let ok: Bool = source.withUnsafeMutableBufferPointer { inputPointer -> Bool in
                stream.next_in = inputPointer.baseAddress
                stream.avail_in = uInt(inputPointer.count)
                while !finished {
                    var produced = 0
                    let status: Int32 = buffer.withUnsafeMutableBufferPointer { outputPointer -> Int32 in
                        stream.next_out = outputPointer.baseAddress
                        stream.avail_out = uInt(outputPointer.count)
                        let result = CZlib.inflate(&stream, Z_NO_FLUSH)
                        produced = outputPointer.count - Int(stream.avail_out)
                        return result
                    }
                    if produced > 0 { out.append(contentsOf: buffer[0..<produced]) }
                    if status == Z_STREAM_END { finished = true; break }
                    if status != Z_OK { return false }
                    if produced == 0 && stream.avail_in == 0 { break }
                }
                return true
            }
            if ok, !out.isEmpty { return out }
        }
        return nil
    }

    static func cString(_ data: Data) -> String {
        var bytes = [UInt8]()
        for index in 0..<data.count {
            let byte = data.u8(index)
            if byte == 0 { break }
            bytes.append(byte)
        }
        return String(bytes: bytes, encoding: .utf8) ?? ""
    }
}

/// Writing a PNG, for pixels taken out of a compiled image set.
enum PNG {
    /// Apple keeps its pixels blue-green-red-alpha, with the colour already multiplied by the
    /// alpha. PNG wants red-green-blue-alpha, not multiplied.
    static func write(bgra: Data, width: Int, height: Int, rowBytes: Int) -> Data? {
        guard width > 0, height > 0, width < 20000, height < 20000 else { return nil }
        let stride = rowBytes > 0 ? rowBytes : width * 4
        guard bgra.count >= stride * height else { return nil }

        var raw = Data(capacity: height * (1 + width * 4))
        for row in 0..<height {
            raw.append(0)   // no filtering on this row
            let start = row * stride
            for column in 0..<width {
                let at = start + column * 4
                let b = bgra.u8(at), g = bgra.u8(at + 1), r = bgra.u8(at + 2), a = bgra.u8(at + 3)
                if a == 0 {
                    raw.append(contentsOf: [0, 0, 0, 0])
                } else if a == 255 {
                    raw.append(contentsOf: [r, g, b, a])
                } else {
                    let scale = 255.0 / Double(a)
                    raw.append(UInt8(min(255, Double(r) * scale)))
                    raw.append(UInt8(min(255, Double(g) * scale)))
                    raw.append(UInt8(min(255, Double(b) * scale)))
                    raw.append(a)
                }
            }
        }
        guard let squashed = deflate(raw) else { return nil }

        var png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        var header = Data()
        header.append(be32(UInt32(width)))
        header.append(be32(UInt32(height)))
        header.append(contentsOf: [8, 6, 0, 0, 0])   // 8 bits each, colour with alpha
        png.append(chunk("IHDR", header))
        png.append(chunk("IDAT", squashed))
        png.append(chunk("IEND", Data()))
        return png
    }

    static func chunk(_ kind: String, _ body: Data) -> Data {
        var out = be32(UInt32(body.count))
        let payload = Data(kind.utf8) + body
        out.append(payload)
        out.append(be32(crc(payload)))
        return out
    }

    static func be32(_ value: UInt32) -> Data {
        Data([UInt8(truncatingIfNeeded: value >> 24), UInt8(truncatingIfNeeded: value >> 16),
              UInt8(truncatingIfNeeded: value >> 8), UInt8(truncatingIfNeeded: value)])
    }

    static func crc(_ data: Data) -> UInt32 {
        var value = CZlib.crc32(0, nil, 0)
        var bytes = [UInt8](data)
        bytes.withUnsafeBufferPointer { pointer in
            value = CZlib.crc32(value, pointer.baseAddress, uInt(pointer.count))
        }
        return UInt32(value)
    }

    static func deflate(_ input: Data) -> Data? {
        var stream = z_stream()
        guard deflateInit_(&stream, 6, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
        else { return nil }
        defer { deflateEnd(&stream) }
        var out = Data()
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        var source = [UInt8](input)
        let ok: Bool = source.withUnsafeMutableBufferPointer { inputPointer -> Bool in
            stream.next_in = inputPointer.baseAddress
            stream.avail_in = uInt(inputPointer.count)
            while true {
                var produced = 0
                let status: Int32 = buffer.withUnsafeMutableBufferPointer { outputPointer -> Int32 in
                    stream.next_out = outputPointer.baseAddress
                    stream.avail_out = uInt(outputPointer.count)
                    let result = CZlib.deflate(&stream, Z_FINISH)
                    produced = outputPointer.count - Int(stream.avail_out)
                    return result
                }
                if produced > 0 { out.append(contentsOf: buffer[0..<produced]) }
                if status == Z_STREAM_END { return true }
                if status != Z_OK { return false }
            }
        }
        return ok ? out : nil
    }
}
