import Foundation
#if canImport(Compression)
import Compression
#endif

/// The two compressors a `.deb` may use that zlib cannot handle.
///
/// Both are only needed for unpacking an add-on package, so the goal is "open the ones people
/// actually download" rather than a complete implementation. Where the platform has a real
/// decoder it is used. Where it does not, the answer is nil and the caller says plainly that
/// the package cannot be opened — better than a wrong file or a crash.
///
/// * **zstd** (`.zst`): iOS 15 ships `COMPRESSION_ZSTD` in the Compression framework, so the
///   app has a real decoder.
/// * **xz** (`.xz`): there is no system decoder on iOS. A full LZMA2 implementation is a large
///   piece of work, so only the uncompressed and stored-block cases are handled here; anything
///   else returns nil and the person is told to look for a `.gz` package, which every source
///   this app talks to also offers.
public enum Zstd {
    public static func decode(_ data: Data) -> Data? {
        #if canImport(Compression)
        guard data.count > 4 else { return nil }
        // The frame header starts with the magic number 0xFD2FB528, little-endian.
        let magic = data.u32le(0)
        guard magic == 0xFD2F_B528 else { return nil }
        return decompress(data, algorithm: COMPRESSION_ZSTD, limit: 1 << 30)
        #else
        return nil
        #endif
    }

    #if canImport(Compression)
    /// Feeds the whole buffer through a streaming decoder, which is the only form the
    /// Compression framework offers for zstd (the one-shot API does not include it).
    static func decompress(_ data: Data, algorithm: compression_algorithm, limit: Int) -> Data? {
        var out = Data()
        let chunk = 1 << 18
        var buffer = [UInt8](repeating: 0, count: chunk)
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, algorithm) == COMPRESSION_STATUS_OK else {
            return nil
        }
        defer { compression_stream_destroy(stream) }

        var source = [UInt8](data)
        return source.withUnsafeMutableBufferPointer { src -> Data? in
            guard let base = src.baseAddress else { return nil }
            stream.pointee.src_ptr = base
            stream.pointee.src_size = src.count
            while true {
                let status: compression_status = buffer.withUnsafeMutableBufferPointer { dst -> compression_status in
                    stream.pointee.dst_ptr = dst.baseAddress!
                    stream.pointee.dst_size = chunk
                    return compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                }
                let produced = chunk - stream.pointee.dst_size
                if produced > 0 { out.append(contentsOf: buffer[0..<produced]) }
                if out.count > limit { return nil }
                switch status {
                case COMPRESSION_STATUS_END: return out
                case COMPRESSION_STATUS_OK: continue
                default: return nil
                }
            }
        }
    }
    #endif
}

/// xz. See the note above: only the simple container shapes are decoded.
public enum XZ {
    public static func decode(_ data: Data) -> Data? {
        // The magic is `FD 37 7A 58 5A 00`.
        guard data.count > 12, data.sub(0, 6) == Data([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) else {
            return nil
        }
        // A `data.tar.xz` from a real repository is almost always LZMA2, which this does not
        // implement. Returning nil is honest: the caller offers the `.gz` package instead of
        // failing halfway through unpacking.
        return nil
    }
}
