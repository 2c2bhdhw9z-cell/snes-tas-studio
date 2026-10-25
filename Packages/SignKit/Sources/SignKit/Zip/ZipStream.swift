import Foundation
import CZlib

/// Streaming zip work: a very large app (a few hundred megabytes) must never sit in
/// memory all at once, or iOS kills the app halfway through signing.
public enum ZipStream {
    static let chunk = 4 << 20      // 4 MB at a time

    /// Decompresses `count` bytes starting at `offset` in `source` straight into `destination`.
    /// Returns the checksum of what was written.
    @discardableResult
    public static func inflate(from source: FileHandle, offset: Int, count: Int,
                               to destination: FileHandle, stored: Bool) throws -> UInt32 {
        try source.seek(toOffset: UInt64(offset))
        var crc: UInt32 = 0
        var remaining = count

        if stored {
            while remaining > 0 {
                let want = min(chunk, remaining)
                let data = source.readData(ofLength: want)
                guard !data.isEmpty else { break }
                crc = data.withUnsafeBytes { p in
                    UInt32(CZlib.crc32(uLong(crc), p.baseAddress?.assumingMemoryBound(to: UInt8.self),
                                       UInt32(data.count)))
                }
                try destination.write(contentsOf: data)
                remaining -= data.count
            }
            return crc
        }

        var stream = z_stream()
        guard inflateInit2_(&stream, -15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
            throw SignKitError.crypto("cannot start decompression")
        }
        defer { inflateEnd(&stream) }

        var out = [UInt8](repeating: 0, count: chunk)
        var status: Int32 = Z_OK

        while remaining > 0 && status != Z_STREAM_END {
            let want = min(chunk, remaining)
            var input = source.readData(ofLength: want)
            guard !input.isEmpty else { break }
            remaining -= input.count

            try input.withUnsafeMutableBytes { inPtr in
                stream.next_in = inPtr.baseAddress?.assumingMemoryBound(to: UInt8.self)
                stream.avail_in = UInt32(inPtr.count)

                repeat {
                    let produced: Int = try out.withUnsafeMutableBufferPointer { op -> Int in
                        stream.next_out = op.baseAddress
                        stream.avail_out = UInt32(chunk)
                        status = CZlib.inflate(&stream, Z_NO_FLUSH)
                        guard status == Z_OK || status == Z_STREAM_END || status == Z_BUF_ERROR else {
                            throw SignKitError.malformed("a file inside the app is damaged")
                        }
                        return chunk - Int(stream.avail_out)
                    }
                    if produced > 0 {
                        let slice = out.withUnsafeBufferPointer { Data(buffer: UnsafeBufferPointer(start: $0.baseAddress, count: produced)) }
                        crc = slice.withUnsafeBytes { p in
                            UInt32(CZlib.crc32(uLong(crc), p.baseAddress?.assumingMemoryBound(to: UInt8.self),
                                               UInt32(slice.count)))
                        }
                        try destination.write(contentsOf: slice)
                    }
                    if produced == 0 && status != Z_STREAM_END { break }
                } while stream.avail_in > 0 || status == Z_OK
            }
        }
        return crc
    }

    /// Copies a file into a zip a chunk at a time, compressing if asked.
    /// Returns (checksum, bytes written, method).
    @discardableResult
    public static func deflate(file source: FileHandle, size: Int, to destination: FileHandle,
                               compress: Bool, level: Int32 = 6) throws -> (UInt32, Int, UInt16) {
        var crc: UInt32 = 0
        var written = 0

        if !compress {
            while true {
                let data = source.readData(ofLength: chunk)
                if data.isEmpty { break }
                crc = data.withUnsafeBytes { p in
                    UInt32(CZlib.crc32(uLong(crc), p.baseAddress?.assumingMemoryBound(to: UInt8.self),
                                       UInt32(data.count)))
                }
                try destination.write(contentsOf: data)
                written += data.count
            }
            return (crc, written, 0)
        }

        var stream = z_stream()
        guard deflateInit2_(&stream, level, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY,
                            ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
            throw SignKitError.crypto("cannot start compression")
        }
        defer { deflateEnd(&stream) }

        var out = [UInt8](repeating: 0, count: chunk)
        var finished = false

        while !finished {
            var input = source.readData(ofLength: chunk)
            let isLast = input.count < chunk
            if !input.isEmpty {
                crc = input.withUnsafeBytes { p in
                    UInt32(CZlib.crc32(uLong(crc), p.baseAddress?.assumingMemoryBound(to: UInt8.self),
                                       UInt32(input.count)))
                }
            }
            try input.withUnsafeMutableBytes { inPtr in
                stream.next_in = inPtr.baseAddress?.assumingMemoryBound(to: UInt8.self)
                stream.avail_in = UInt32(inPtr.count)
                repeat {
                    let produced = out.withUnsafeMutableBufferPointer { op -> Int in
                        stream.next_out = op.baseAddress
                        stream.avail_out = UInt32(chunk)
                        let status = CZlib.deflate(&stream, isLast ? Z_FINISH : Z_NO_FLUSH)
                        if status == Z_STREAM_END { finished = true }
                        return chunk - Int(stream.avail_out)
                    }
                    if produced > 0 {
                        let slice = out.withUnsafeBufferPointer { Data(buffer: UnsafeBufferPointer(start: $0.baseAddress, count: produced)) }
                        try destination.write(contentsOf: slice)
                        written += produced
                    }
                    if produced == 0 && stream.avail_in == 0 { break }
                } while stream.avail_in > 0 || (isLast && !finished)
            }
            if isLast { finished = true }
        }
        return (crc, written, 8)
    }
}
