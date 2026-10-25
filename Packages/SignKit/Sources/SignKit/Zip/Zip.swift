import Foundation
import CZlib

/// One file inside a zip (an `.ipa` is a zip).
public struct ZipEntry {
    public let name: String
    public let compressedSize: Int
    public let uncompressedSize: Int
    public let method: UInt16          // 0 = stored, 8 = deflate
    public let crc32: UInt32
    public let localHeaderOffset: Int
    public let externalAttributes: UInt32
    public let modified: Date?

    public var isDirectory: Bool { name.hasSuffix("/") }
    /// Unix permission bits, which carry the executable flag an app binary needs.
    public var unixMode: UInt16 { UInt16(externalAttributes >> 16) }
    public var isSymlink: Bool { unixMode & 0xf000 == 0xa000 }
}

/// Reads a zip from a file without loading it all into memory.
public final class ZipReader {
    let handle: FileHandle
    let size: Int
    public private(set) var entries: [ZipEntry] = []

    public init(url: URL) throws {
        guard let h = try? FileHandle(forReadingFrom: url) else {
            throw SignKitError.io("cannot open \(url.lastPathComponent)")
        }
        handle = h
        size = fileSize(of: url)
        try readCentralDirectory()
    }

    deinit { try? handle.close() }

    func read(at offset: Int, _ count: Int) throws -> Data {
        guard offset >= 0, count >= 0, offset + count <= size else {
            throw SignKitError.malformed("zip read past end of file")
        }
        try handle.seek(toOffset: UInt64(offset))
        // A single read can come back short, so keep asking until we have it all.
        var out = Data()
        out.reserveCapacity(count)
        while out.count < count {
            guard let part = try handle.read(upToCount: count - out.count), !part.isEmpty else {
                throw SignKitError.malformed("zip truncated")
            }
            out.append(part)
        }
        return out
    }

    func readCentralDirectory() throws {
        // End of central directory record: scan the last 64 KB for its signature.
        let tailLen = min(size, 66_000)
        let tail = try read(at: size - tailLen, tailLen)
        guard var eocd = lastIndex(of: Data([0x50, 0x4b, 0x05, 0x06]), in: tail) else {
            throw SignKitError.malformed("not a zip file (no end record)")
        }
        var count = Int(tail.u16le(eocd + 10))
        var cdSize = Int(tail.u32le(eocd + 12))
        var cdOffset = Int(tail.u32le(eocd + 16))

        // ZIP64 variant, used by big apps.
        if cdOffset == 0xffff_ffff || count == 0xffff || cdSize == 0xffff_ffff,
           let loc = lastIndex(of: Data([0x50, 0x4b, 0x06, 0x07]), in: tail) {
            let z64Offset = Int(tail.u64le(loc + 8))
            let z64 = try read(at: z64Offset, 56)
            guard z64.u32le(0) == 0x0606_4b50 else { throw SignKitError.malformed("bad zip64 record") }
            count = Int(z64.u64le(32))
            cdSize = Int(z64.u64le(40))
            cdOffset = Int(z64.u64le(48))
            eocd = loc
        }

        let cd = try read(at: cdOffset, cdSize)
        var o = 0
        var out = [ZipEntry]()
        out.reserveCapacity(count)
        while o + 46 <= cd.count, cd.u32le(o) == 0x0201_4b50 {
            let nameLen = Int(cd.u16le(o + 28))
            let extraLen = Int(cd.u16le(o + 30))
            let commentLen = Int(cd.u16le(o + 32))
            let name = String(decoding: cd.sub(o + 46, nameLen), as: UTF8.self)
            var csize = Int(cd.u32le(o + 20))
            var usize = Int(cd.u32le(o + 24))
            var lho = Int(cd.u32le(o + 42))
            // ZIP64 extra field
            if csize == 0xffff_ffff || usize == 0xffff_ffff || lho == 0xffff_ffff {
                let extra = cd.sub(o + 46 + nameLen, extraLen)
                var e = 0
                while e + 4 <= extra.count {
                    let id = extra.u16le(e), len = Int(extra.u16le(e + 2))
                    if id == 0x0001 {
                        var f = e + 4
                        if usize == 0xffff_ffff, f + 8 <= extra.count { usize = Int(extra.u64le(f)); f += 8 }
                        if csize == 0xffff_ffff, f + 8 <= extra.count { csize = Int(extra.u64le(f)); f += 8 }
                        if lho == 0xffff_ffff, f + 8 <= extra.count { lho = Int(extra.u64le(f)) }
                    }
                    e += 4 + len
                }
            }
            out.append(ZipEntry(name: name, compressedSize: csize, uncompressedSize: usize,
                                method: cd.u16le(o + 10), crc32: cd.u32le(o + 16),
                                localHeaderOffset: lho, externalAttributes: cd.u32le(o + 38),
                                modified: Zip.dosDate(cd.u16le(o + 12), cd.u16le(o + 14))))
            o += 46 + nameLen + extraLen + commentLen
        }
        entries = out
    }

    func lastIndex(of needle: Data, in hay: Data) -> Int? {
        guard hay.count >= needle.count else { return nil }
        var i = hay.count - needle.count
        while i >= 0 {
            if hay.sub(i, needle.count) == needle { return i }
            i -= 1
        }
        return nil
    }

    /// Reads just the first `limit` bytes of an entry. Used to look at a huge app
    /// binary's header without unpacking a gigabyte of it.
    public func head(of entry: ZipEntry, limit: Int) throws -> Data {
        let start = try dataOffset(of: entry)
        if entry.method == 0 {
            return try read(at: start, min(limit, entry.compressedSize))
        }
        // Feed the compressed bytes in until enough has come out.
        var stream = z_stream()
        guard inflateInit2_(&stream, -15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
            throw SignKitError.crypto("cannot start decompression")
        }
        defer { inflateEnd(&stream) }
        var out = Data()
        var fed = 0
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        while out.count < limit && fed < entry.compressedSize {
            let want = min(1 << 18, entry.compressedSize - fed)
            var input = try read(at: start + fed, want)
            fed += want
            var done = false
            input.withUnsafeMutableBytes { inPtr in
                stream.next_in = inPtr.baseAddress?.assumingMemoryBound(to: UInt8.self)
                stream.avail_in = UInt32(inPtr.count)
                while stream.avail_in > 0 && out.count < limit && !done {
                    let produced = buffer.withUnsafeMutableBufferPointer { bp -> Int in
                        stream.next_out = bp.baseAddress
                        stream.avail_out = UInt32(bp.count)
                        let status = CZlib.inflate(&stream, Z_NO_FLUSH)
                        if status == Z_STREAM_END || (status != Z_OK && status != Z_BUF_ERROR) { done = true }
                        return bp.count - Int(stream.avail_out)
                    }
                    if produced > 0 {
                        out.append(contentsOf: buffer[0..<produced])
                    } else if done {
                        break
                    }
                }
            }
            if done { break }
        }
        return out.prefix(limit)
    }

    /// Reads and decompresses one entry.
    public func data(for entry: ZipEntry) throws -> Data {
        let local = try read(at: entry.localHeaderOffset, 30)
        guard local.u32le(0) == 0x0403_4b50 else { throw SignKitError.malformed("bad local header for \(entry.name)") }
        let dataStart = entry.localHeaderOffset + 30 + Int(local.u16le(26)) + Int(local.u16le(28))
        let raw = try read(at: dataStart, entry.compressedSize)
        switch entry.method {
        case 0: return raw
        case 8: return try Zip.inflate(raw, expected: entry.uncompressedSize)
        default: throw SignKitError.unsupported("compression method \(entry.method) in \(entry.name)")
        }
    }

    /// Where an entry's bytes start in the file.
    func dataOffset(of entry: ZipEntry) throws -> Int {
        let local = try read(at: entry.localHeaderOffset, 30)
        guard local.u32le(0) == 0x0403_4b50 else {
            throw SignKitError.malformed("bad local header for \(entry.name)")
        }
        return entry.localHeaderOffset + 30 + Int(local.u16le(26)) + Int(local.u16le(28))
    }

    /// Unpacks one entry straight to disk without holding it in memory.
    public func extract(_ entry: ZipEntry, to dest: URL) throws {
        let start = try dataOffset(of: entry)
        let fm = FileManager.default
        try? fm.removeItem(at: dest)
        guard fm.createFile(atPath: dest.path, contents: nil),
              let outHandle = try? FileHandle(forWritingTo: dest) else {
            throw SignKitError.io("cannot write \(dest.lastPathComponent)")
        }
        defer { try? outHandle.close() }
        guard entry.method == 0 || entry.method == 8 else {
            throw SignKitError.unsupported("compression method \(entry.method) in \(entry.name)")
        }
        let crc = try ZipStream.inflate(from: handle, offset: start, count: entry.compressedSize,
                                        to: outHandle, stored: entry.method == 0)
        guard crc == entry.crc32 else {
            throw SignKitError.malformed("\(entry.name) came out damaged")
        }
    }

    /// Unpacks everything into a directory, keeping permissions and symlinks.
    public func extractAll(to dir: URL, progress: ((Double, String) -> Void)? = nil) throws {
        let fm = FileManager.default
        let total = max(1, entries.count)
        for (i, e) in entries.enumerated() {
            progress?(Double(i) / Double(total), e.name)
            guard !e.name.contains("..") else { throw SignKitError.malformed("unsafe path in zip: \(e.name)") }
            let dest = dir.appendingPathComponent(e.name)
            if e.isDirectory {
                try fm.createDirectory(at: dest, withIntermediateDirectories: true)
                continue
            }
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)

            // Anything sizeable goes straight to disk in chunks.
            if !e.isSymlink && e.uncompressedSize > 8 << 20 {
                try extract(e, to: dest)
                let mode = e.unixMode & 0o7777
                if mode != 0 {
                    try? fm.setAttributes([.posixPermissions: NSNumber(value: mode)], ofItemAtPath: dest.path)
                }
                continue
            }

            let d = try data(for: e)
            if e.isSymlink, let target = String(data: d, encoding: .utf8) {
                try? fm.removeItem(at: dest)
                try fm.createSymbolicLink(atPath: dest.path, withDestinationPath: target)
                continue
            }
            try d.write(to: dest)
            let mode = e.unixMode & 0o7777
            if mode != 0 {
                try? fm.setAttributes([.posixPermissions: NSNumber(value: mode)], ofItemAtPath: dest.path)
            }
        }
        progress?(1, "")
    }
}

/// Writes a zip. Used to repack a signed app.
public final class ZipWriter {
    fileprivate var out: FileHandle
    private var offset = 0
    private var central = Data()
    private var count = 0

    public init(url: URL) throws {
        let fm = FileManager.default
        try? fm.removeItem(at: url)
        guard fm.createFile(atPath: url.path, contents: nil),
              let h = try? FileHandle(forWritingTo: url) else {
            throw SignKitError.io("cannot create \(url.lastPathComponent)")
        }
        out = h
    }

    private func write(_ d: Data) throws {
        try out.write(contentsOf: d)
        offset += d.count
    }

    /// Adds one file. `compress: false` is much faster for already-compressed data.
    public func add(name: String, data raw: Data, mode: UInt16 = 0o644,
                    compress: Bool = true, isSymlink: Bool = false) throws {
        let crc = Zip.crc32(raw)
        var payload = raw
        var method: UInt16 = 0
        if compress && raw.count > 64 {
            let def = try Zip.deflate(raw)
            if def.count < raw.count { payload = def; method = 8 }
        }
        let nameBytes = Data(name.utf8)
        let localOffset = offset
        let zip64 = raw.count >= 0xffff_ffff || payload.count >= 0xffff_ffff

        var local = Data()
        local.put32le(0x0403_4b50)
        local.put16le(zip64 ? 45 : 20)   // version needed
        local.put16le(Zip.nameFlags(name)) // flags (UTF-8 names)
        local.put16le(method)
        local.put16le(Zip.stampTime); local.put16le(Zip.stampDate)
        local.put32le(crc)
        local.put32le(UInt32(min(payload.count, 0xffff_ffff)))
        local.put32le(UInt32(min(raw.count, 0xffff_ffff)))
        local.put16le(UInt16(nameBytes.count))
        local.put16le(0)
        local.append(nameBytes)
        try write(local)
        try write(payload)
        let payloadBytes = payload.count

        var attrs = UInt32(isSymlink ? 0xa000 | UInt32(mode & 0o7777) : 0x8000 | UInt32(mode & 0o7777)) << 16
        if name.hasSuffix("/") { attrs = (0x4000 | UInt32(mode & 0o7777)) << 16 | 0x10 }

        central.put32le(0x0201_4b50)
        central.put16le(0x031e)          // made by unix
        central.put16le(zip64 ? 45 : 20)
        central.put16le(Zip.nameFlags(name))
        central.put16le(method)
        central.put16le(Zip.stampTime); central.put16le(Zip.stampDate)
        central.put32le(crc)
        central.put32le(UInt32(min(payload.count, 0xffff_ffff)))
        central.put32le(UInt32(min(raw.count, 0xffff_ffff)))
        var extra = Data()
        if zip64 {
            extra.put16le(0x0001)
            extra.put16le(16)
            extra.put64le(UInt64(raw.count))
            extra.put64le(UInt64(payloadBytes))
        }
        if localOffset >= 0xffff_ffff {
            if extra.isEmpty {
                extra.put16le(0x0001)
                extra.put16le(8)
            } else {
                extra.set16le(2, UInt16(Int(extra.u16le(2)) + 8))
            }
            extra.put64le(UInt64(localOffset))
        }
        central.put16le(UInt16(nameBytes.count))
        central.put16le(UInt16(extra.count))
        central.put16le(0)               // comment
        central.put16le(0)               // disk
        central.put16le(0)               // internal attrs
        central.put32le(attrs)
        central.put32le(UInt32(min(localOffset, 0xffff_ffff)))
        central.append(nameBytes)
        central.append(extra)
        count += 1
    }

    /// Adds a file by streaming it through, so a very large app binary never has to
    /// sit in memory. The header is written first and patched afterwards.
    public func addFile(name: String, url: URL, mode: UInt16, compress: Bool) throws {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            throw SignKitError.io("cannot read \(url.lastPathComponent)")
        }
        defer { try? handle.close() }
        // The bytes the handle reads: a link is measured by what it points to.
        let fileSize = SignKit.fileSize(of: url)
        let nameBytes = Data(name.utf8)
        let localOffset = offset

        let localZip64 = fileSize >= 0xffff_0000
        var localExtra = Data()
        if localZip64 {
            localExtra.put16le(0x0001)
            localExtra.put16le(16)
            localExtra.put64le(UInt64(fileSize))
            localExtra.put64le(0)                       // compressed size, patched later
        }

        var local = Data()
        local.put32le(0x0403_4b50)
        local.put16le(localZip64 ? 45 : 20)
        local.put16le(Zip.nameFlags(name))
        local.put16le(compress ? 8 : 0)
        local.put16le(Zip.stampTime); local.put16le(Zip.stampDate)
        local.put32le(0)                                // checksum, patched later
        local.put32le(localZip64 ? 0xffff_ffff : 0)     // compressed size
        local.put32le(localZip64 ? 0xffff_ffff : UInt32(fileSize))
        local.put16le(UInt16(nameBytes.count))
        local.put16le(UInt16(localExtra.count))
        local.append(nameBytes)
        local.append(localExtra)
        try write(local)

        let (crc, written, method) = try ZipStream.deflate(file: handle, size: fileSize,
                                                           to: out, compress: compress)
        offset += written

        // Go back and fill in what we only knew once the data was written.
        try out.seek(toOffset: UInt64(localOffset + 8))
        var patch = Data()
        patch.put16le(method)
        patch.put16le(Zip.stampTime); patch.put16le(Zip.stampDate)
        patch.put32le(crc)
        patch.put32le(localZip64 ? 0xffff_ffff : UInt32(written))
        try out.write(contentsOf: patch)
        if localZip64 {
            try out.seek(toOffset: UInt64(localOffset + 30 + nameBytes.count + 4))
            var sizes = Data()
            sizes.put64le(UInt64(fileSize))
            sizes.put64le(UInt64(written))
            try out.write(contentsOf: sizes)
        }
        try out.seek(toOffset: UInt64(offset))

        // ZIP64 values must appear only for fixed fields carrying 0xffffffff, and
        // in that same order. If only the offset crossed 4 GB, writing sizes first
        // makes other unzip tools mistake the file size for its offset.
        let needsZip64 = fileSize >= 0xffff_ffff || written >= 0xffff_ffff || localOffset >= 0xffff_ffff
        var extra = Data()
        var zip64Values = Data()
        if fileSize >= 0xffff_ffff { zip64Values.put64le(UInt64(fileSize)) }
        if written >= 0xffff_ffff { zip64Values.put64le(UInt64(written)) }
        if localOffset >= 0xffff_ffff { zip64Values.put64le(UInt64(localOffset)) }
        if !zip64Values.isEmpty {
            extra.put16le(0x0001)
            extra.put16le(UInt16(zip64Values.count))
            extra.append(zip64Values)
        }

        let attrs = UInt32(0x8000 | UInt32(mode & 0o7777)) << 16
        central.put32le(0x0201_4b50)
        central.put16le(0x031e)
        central.put16le(needsZip64 ? 45 : 20)
        central.put16le(Zip.nameFlags(name))
        central.put16le(method)
        central.put16le(Zip.stampTime); central.put16le(Zip.stampDate)
        central.put32le(crc)
        central.put32le(UInt32(min(written, 0xffff_ffff)))
        central.put32le(UInt32(min(fileSize, 0xffff_ffff)))
        central.put16le(UInt16(nameBytes.count))
        central.put16le(UInt16(extra.count))
        central.put16le(0)
        central.put16le(0)
        central.put16le(0)
        central.put32le(attrs)
        central.put32le(UInt32(min(localOffset, 0xffff_ffff)))
        central.append(nameBytes)
        central.append(extra)
        count += 1
    }

    public func addDirectory(_ name: String) throws {
        try add(name: name.hasSuffix("/") ? name : name + "/", data: Data(), mode: 0o755, compress: false)
    }

    /// Adds a whole directory tree, which is how a signed `.app` gets packed into `Payload/`.
    public func addTree(at root: URL, prefix: String, compress: Bool = true,
                        removeAfterWriting: Bool = false,
                        progress: ((Double, String) -> Void)? = nil) throws {
        let fm = FileManager.default
        var files = [URL]()
        if let it = fm.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                                  options: [], errorHandler: nil) {
            for case let u as URL in it { files.append(u) }
        }
        files.sort { $0.path < $1.path }
        let total = max(1, files.count)
        for (i, u) in files.enumerated() {
            let rel = u.path.replacingOccurrences(of: root.path + "/", with: "")
            let name = prefix + rel
            progress?(Double(i) / Double(total), rel)
            let vals = try u.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if vals.isSymbolicLink == true {
                let target = try fm.destinationOfSymbolicLink(atPath: u.path)
                try add(name: name, data: Data(target.utf8), mode: 0o755, compress: false, isSymlink: true)
            } else if vals.isDirectory == true {
                try addDirectory(name)
            } else {
                let attrs = try fm.attributesOfItem(atPath: u.path)
                let mode = (attrs[.posixPermissions] as? NSNumber)?.uint16Value ?? 0o644
                let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
                if size > 8 << 20 {
                    // Big files are streamed, so a multi-gigabyte binary never lands in memory.
                    try addFile(name: name, url: u, mode: mode, compress: compress)
                } else {
                    try add(name: name, data: try Data(contentsOf: u, options: .mappedIfSafe),
                            mode: mode, compress: compress)
                }
                // While packing a huge app, trade each unpacked file for its bytes in
                // the output. Peak disk use stays near one unpacked copy, not two.
                if removeAfterWriting { try? fm.removeItem(at: u) }
            }
        }
        progress?(1, "")
    }

    public func finish() throws {
        let cdOffset = offset
        try write(central)
        let cdSize = offset - cdOffset
        let needsZip64 = count >= 0xffff || cdOffset >= 0xffff_ffff || cdSize >= 0xffff_ffff
        if needsZip64 {
            var z = Data()
            z.put32le(0x0606_4b50)
            z.put64le(44)
            z.put16le(45); z.put16le(45)
            z.put32le(0); z.put32le(0)
            z.put64le(UInt64(count)); z.put64le(UInt64(count))
            z.put64le(UInt64(cdSize)); z.put64le(UInt64(cdOffset))
            let z64Start = offset
            try write(z)
            var loc = Data()
            loc.put32le(0x0706_4b50)
            loc.put32le(0)
            loc.put64le(UInt64(z64Start))
            loc.put32le(1)
            try write(loc)
        }
        var e = Data()
        e.put32le(0x0605_4b50)
        e.put16le(0); e.put16le(0)
        e.put16le(UInt16(min(count, 0xffff))); e.put16le(UInt16(min(count, 0xffff)))
        e.put32le(UInt32(min(cdSize, 0xffff_ffff)))
        e.put32le(UInt32(min(cdOffset, 0xffff_ffff)))
        e.put16le(0)
        try write(e)
        try out.close()
    }
}

public enum Zip {
    /// Names with accents or other non-ASCII letters must be flagged as UTF-8, or strict
    /// readers decode them as old DOS text and the file no longer matches the resource list.
    static func nameFlags(_ name: String) -> UInt16 {
        name.utf8.contains { $0 > 127 } ? 0x0800 : 0
    }

    /// Every entry carries the same real date (1 January 2026, 00:00). A date of zero is
    /// not a valid calendar date, and strict readers can object to it. A fixed one also
    /// keeps the output identical from run to run.
    static let stampTime: UInt16 = 0
    static let stampDate: UInt16 = UInt16((2026 - 1980) << 9 | 1 << 5 | 1)

    static func dosDate(_ time: UInt16, _ date: UInt16) -> Date? {
        guard date != 0 else { return nil }
        var c = DateComponents()
        c.year = Int(date >> 9) + 1980
        c.month = Int((date >> 5) & 0xf)
        c.day = Int(date & 0x1f)
        c.hour = Int(time >> 11)
        c.minute = Int((time >> 5) & 0x3f)
        c.second = Int(time & 0x1f) * 2
        return Calendar(identifier: .gregorian).date(from: c)
    }

    public static func crc32(_ d: Data) -> UInt32 {
        d.withUnsafeBytes { p in
            UInt32(CZlib.crc32(0, p.baseAddress?.assumingMemoryBound(to: UInt8.self), UInt32(d.count)))
        }
    }

    public static func inflate(_ input: Data, expected: Int) throws -> Data {
        if input.isEmpty { return Data() }
        var stream = z_stream()
        guard inflateInit2_(&stream, -15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
            throw SignKitError.crypto("cannot start decompression")
        }
        defer { inflateEnd(&stream) }
        var out = Data()
        out.reserveCapacity(max(expected, input.count * 4))
        let chunkSize = 1 << 18
        var chunk = [UInt8](repeating: 0, count: chunkSize)
        var inputCopy = input
        var status: Int32 = Z_OK
        try inputCopy.withUnsafeMutableBytes { inPtr in
            stream.next_in = inPtr.baseAddress?.assumingMemoryBound(to: UInt8.self)
            stream.avail_in = UInt32(inPtr.count)
            repeat {
                let produced: Int = try chunk.withUnsafeMutableBufferPointer { cp -> Int in
                    stream.next_out = cp.baseAddress
                    stream.avail_out = UInt32(chunkSize)
                    status = CZlib.inflate(&stream, Z_NO_FLUSH)
                    guard status == Z_OK || status == Z_STREAM_END || status == Z_BUF_ERROR else {
                        throw SignKitError.malformed("file inside the app is damaged")
                    }
                    return chunkSize - Int(stream.avail_out)
                }
                if produced > 0 { out.append(contentsOf: chunk[0..<produced]) }
                if produced == 0 && status != Z_STREAM_END { break }
            } while status != Z_STREAM_END
        }
        return out
    }

    public static func deflate(_ input: Data, level: Int32 = 6) throws -> Data {
        var stream = z_stream()
        guard deflateInit2_(&stream, level, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY,
                            ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
            throw SignKitError.crypto("cannot start compression")
        }
        defer { deflateEnd(&stream) }
        var out = Data()
        let chunkSize = 1 << 18
        var chunk = [UInt8](repeating: 0, count: chunkSize)
        var inputCopy = input
        inputCopy.withUnsafeMutableBytes { inPtr in
            stream.next_in = inPtr.baseAddress?.assumingMemoryBound(to: UInt8.self)
            stream.avail_in = UInt32(inPtr.count)
            var status: Int32 = Z_OK
            repeat {
                let produced = chunk.withUnsafeMutableBufferPointer { cp -> Int in
                    stream.next_out = cp.baseAddress
                    stream.avail_out = UInt32(chunkSize)
                    status = CZlib.deflate(&stream, Z_FINISH)
                    return chunkSize - Int(stream.avail_out)
                }
                if produced > 0 { out.append(contentsOf: chunk[0..<produced]) }
            } while status == Z_OK
        }
        return out
    }
}
