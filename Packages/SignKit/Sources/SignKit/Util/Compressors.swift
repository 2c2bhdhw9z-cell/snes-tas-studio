import Foundation

/// The two compressors a `.deb` may use that zlib cannot handle.
///
/// A `.deb`'s `data.tar` is usually `tar.gz`, `tar.xz` or `tar.zst`. gzip is read by `Zip`,
/// which already had a full decoder. The other two need a real codec, and neither is worth
/// writing from scratch for a job that is only ever an add-on package:
///
/// * **xz** needs a complete LZMA2 implementation.
/// * **zstd** has no supported decoder on iOS (`COMPRESSION_ZSTD` is not part of the public
///   Compression framework on iOS; it only exists on newer macOS).
///
/// So both answer honestly: the package cannot be opened, and the screen tells the person to
/// use the `.gz` build of the same package, which essentially every repository also offers.
/// Nothing here claims to succeed and then produces a wrong file.
public enum UnsupportedCompressor {
    /// True when the data starts like an xz stream.
    public static func isXZ(_ data: Data) -> Bool {
        data.count > 6 && data.sub(0, 6) == Data([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])
    }

    /// True when the data starts like a zstd frame (magic 0xFD2FB528, little-endian).
    public static func isZstd(_ data: Data) -> Bool {
        data.count > 4 && data.u32le(0) == 0xFD2F_B528
    }

    /// The sentence shown to the person, naming what to look for instead.
    public static func explain(xz: Bool) -> String {
        xz
            ? "this package is xz-compressed, and iOS has no decoder for xz. Look for the .gz "
              + "download of the same package — most repositories offer one."
            : "this package is zstd-compressed, and iOS has no decoder for zstd. Look for the .gz "
              + "download of the same package — most repositories offer one."
    }
}
