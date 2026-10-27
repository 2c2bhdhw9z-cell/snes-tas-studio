import Foundation

public enum LC {
    static let segment: UInt32 = 0x1
    static let segment64: UInt32 = 0x19
    static let codeSignature: UInt32 = 0x1d
    static let loadDylib: UInt32 = 0xc
    static let idDylib: UInt32 = 0xd
    static let loadWeakDylib: UInt32 = 0x8000_0018
    static let reexportDylib: UInt32 = 0x8000_001f
    static let lazyLoadDylib: UInt32 = 0x20
    static let loadUpwardDylib: UInt32 = 0x8000_0023
    static let rpath: UInt32 = 0x8000_001c
    static let encryptionInfo: UInt32 = 0x21
    static let encryptionInfo64: UInt32 = 0x2c
    static let buildVersion: UInt32 = 0x32
    static let versionMinIPhoneOS: UInt32 = 0x25

    static func isDylibLoad(_ c: UInt32) -> Bool {
        c == loadDylib || c == loadWeakDylib || c == reexportDylib || c == lazyLoadDylib || c == loadUpwardDylib
    }
}

public struct LoadCommand {
    public let cmd: UInt32
    public let offset: Int   // offset of command inside the slice
    public let size: Int
}

public struct Segment {
    public let name: String
    public let cmdOffset: Int
    public let vmaddr: UInt64, vmsize: UInt64, fileoff: UInt64, filesize: UInt64
}

public struct Section {
    public let segment: String
    public let name: String
    public let addr: UInt64
    public let size: UInt64
    public let fileOffset: Int
}

/// One architecture slice of a Mach-O file.
public struct MachOSlice {
    public var data: Data
    public let is64: Bool
    public let cpuType: UInt32
    public let cpuSubtype: UInt32
    public var fileType: UInt32 { data.u32le(12) }
    public var ncmds: Int { Int(data.u32le(16)) }
    public var sizeofcmds: Int { Int(data.u32le(20)) }
    public var headerSize: Int { is64 ? 32 : 28 }
    public var isExecutable: Bool { fileType == 2 }

    public init(_ data: Data) throws {
        self.data = data
        guard data.count >= 28 else { throw SignKitError.malformed("Mach-O too small") }
        let magic = data.u32le(0)
        switch magic {
        case 0xfeedfacf: is64 = true
        case 0xfeedface: is64 = false
        default: throw SignKitError.malformed("not a Mach-O slice")
        }
        cpuType = data.u32le(4)
        cpuSubtype = data.u32le(8)
    }

    public var loadCommands: [LoadCommand] {
        var out = [LoadCommand]()
        var o = headerSize
        for _ in 0..<ncmds {
            guard o + 8 <= data.count else { break }
            let c = data.u32le(o), s = Int(data.u32le(o + 4))
            guard s >= 8 else { break }
            out.append(LoadCommand(cmd: c, offset: o, size: s))
            o += s
        }
        return out
    }

    public var segments: [Segment] {
        loadCommands.compactMap { lc in
            let o = lc.offset
            if lc.cmd == LC.segment64 {
                return Segment(name: cString(data.sub(o + 8, 16)), cmdOffset: o,
                               vmaddr: data.u64le(o + 24), vmsize: data.u64le(o + 32),
                               fileoff: data.u64le(o + 40), filesize: data.u64le(o + 48))
            } else if lc.cmd == LC.segment {
                return Segment(name: cString(data.sub(o + 8, 16)), cmdOffset: o,
                               vmaddr: UInt64(data.u32le(o + 24)), vmsize: UInt64(data.u32le(o + 28)),
                               fileoff: UInt64(data.u32le(o + 32)), filesize: UInt64(data.u32le(o + 36)))
            }
            return nil
        }
    }

    /// Every section in the file, with where it lives in memory and on disk. Needed by anything
    /// that follows pointers inside a program, such as reading out its classes.
    public var sections: [Section] {
        var out = [Section]()
        for lc in loadCommands where lc.cmd == LC.segment64 || lc.cmd == LC.segment {
            let o = lc.offset
            let segName = cString(data.sub(o + 8, 16))
            let nsects = Int(data.u32le(o + (is64 ? 64 : 48)))
            var so = o + (is64 ? 72 : 56)
            for _ in 0..<nsects {
                guard so + (is64 ? 80 : 68) <= data.count else { break }
                let name = cString(data.sub(so, 16))
                let addr = is64 ? data.u64le(so + 32) : UInt64(data.u32le(so + 32))
                let size = is64 ? data.u64le(so + 40) : UInt64(data.u32le(so + 36))
                let offset = Int(data.u32le(so + (is64 ? 48 : 40)))
                out.append(Section(segment: segName, name: name, addr: addr,
                                   size: size, fileOffset: offset))
                so += is64 ? 80 : 68
            }
        }
        return out
    }

    public var codeSignatureCommand: LoadCommand? { loadCommands.first { $0.cmd == LC.codeSignature } }

    /// The existing embedded signature, if any.
    public var existingSignature: Data? {
        guard let lc = codeSignatureCommand else { return nil }
        let off = Int(data.u32le(lc.offset + 8)), size = Int(data.u32le(lc.offset + 12))
        guard off + size <= data.count, size > 0 else { return nil }
        return data.sub(off, size)
    }

    /// Install names of all linked libraries.
    public var dylibs: [String] {
        loadCommands.filter { LC.isDylibLoad($0.cmd) }.map { lc in
            let nameOff = Int(data.u32le(lc.offset + 8))
            return cString(data.sub(lc.offset + nameOff, lc.size - nameOff))
        }
    }

    public var rpaths: [String] {
        loadCommands.filter { $0.cmd == LC.rpath }.map { lc in
            let nameOff = Int(data.u32le(lc.offset + 8))
            return cString(data.sub(lc.offset + nameOff, lc.size - nameOff))
        }
    }

    /// True when the binary is still App Store encrypted (cryptid != 0). Such apps can't run when re-signed.
    public var isEncrypted: Bool {
        loadCommands.contains { ($0.cmd == LC.encryptionInfo || $0.cmd == LC.encryptionInfo64) && data.u32le($0.offset + 16) != 0 }
    }

    /// Free bytes between the end of load commands and the first section/segment data.
    public var headerPadding: Int {
        let end = headerSize + sizeofcmds
        var firstData = data.count
        for lc in loadCommands where lc.cmd == LC.segment64 || lc.cmd == LC.segment {
            let o = lc.offset
            let nsects = Int(data.u32le(o + (is64 ? 64 : 48)))
            var so = o + (is64 ? 72 : 56)
            for _ in 0..<nsects {
                let offset = Int(data.u32le(so + (is64 ? 48 : 40)))
                let flags = data.u32le(so + (is64 ? 64 : 56))
                let type = flags & 0xff
                // zerofill sections take no file space
                if offset > 0 && type != 0x1 && type != 0xc && type != 0x12 { firstData = min(firstData, offset) }
                so += is64 ? 80 : 68
            }
            let fo = is64 ? Int(data.u64le(o + 40)) : Int(data.u32le(o + 32))
            let fs = is64 ? Int(data.u64le(o + 48)) : Int(data.u32le(o + 36))
            if fo > 0 && fs > 0 { firstData = min(firstData, fo) }
        }
        return max(0, firstData - end)
    }

    /// The minimum OS from LC_BUILD_VERSION / LC_VERSION_MIN_IPHONEOS, as "major.minor".
    public var minOS: String? {
        for lc in loadCommands {
            if lc.cmd == LC.buildVersion { return version(data.u32le(lc.offset + 12)) }
            if lc.cmd == LC.versionMinIPhoneOS { return version(data.u32le(lc.offset + 8)) }
        }
        return nil
    }

    public var archName: String {
        switch (cpuType, cpuSubtype & 0xff) {
        case (0x0100000c, 2): return "arm64e"
        case (0x0100000c, _): return "arm64"
        case (0x0200000c, _): return "arm64_32"
        case (12, 9): return "armv7"
        case (12, 11): return "armv7s"
        case (12, _): return "arm"
        case (0x01000007, _): return "x86_64"
        case (7, _): return "i386"
        default: return "cpu\(cpuType)"
        }
    }

    func version(_ v: UInt32) -> String { "\(v >> 16).\((v >> 8) & 0xff)" }
}

func cString(_ d: Data) -> String {
    let bytes = d.prefix { $0 != 0 }
    return String(decoding: bytes, as: UTF8.self)
}

/// A whole Mach-O file: either one slice or a fat (universal) file with many.
public struct MachOFile {
    public var slices: [MachOSlice]
    public let isFat: Bool
    var fatAligns: [UInt32]

    public init(data: Data) throws {
        guard data.count >= 8 else { throw SignKitError.malformed("file too small") }
        let magicBE = data.u32be(0)
        if magicBE == 0xcafebabe || magicBE == 0xcafebabf {
            let is64 = magicBE == 0xcafebabf
            let n = Int(data.u32be(4))
            guard n > 0 && n < 32 else { throw SignKitError.malformed("bad fat header") }
            var s = [MachOSlice](), a = [UInt32]()
            for i in 0..<n {
                let e = 8 + i * (is64 ? 32 : 20)
                let off = is64 ? Int(data.u64be(e + 8)) : Int(data.u32be(e + 8))
                let size = is64 ? Int(data.u64be(e + 16)) : Int(data.u32be(e + 12))
                let al = data.u32be(e + (is64 ? 24 : 16))
                guard off + size <= data.count else { throw SignKitError.malformed("fat slice out of range") }
                s.append(try MachOSlice(data.sub(off, size)))
                a.append(al)
            }
            slices = s; fatAligns = a; isFat = true
        } else {
            slices = [try MachOSlice(data)]; fatAligns = [14]; isFat = false
        }
    }

    public static func isMachO(_ d: Data) -> Bool {
        guard d.count >= 4 else { return false }
        let le = d.u32le(0), be = d.u32be(0)
        return le == 0xfeedfacf || le == 0xfeedface || be == 0xcafebabe || be == 0xcafebabf
    }

    public static func isMachO(url: URL) -> Bool {
        guard let h = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? h.close() }
        let d = h.readData(ofLength: 8)
        guard isMachO(d) else { return false }
        // Java class files share 0xcafebabe; they have a small arch count field of version numbers.
        if d.u32be(0) == 0xcafebabe { return d.u32be(4) < 32 }
        return true
    }

    /// True for the kinds of file iOS wants signed: programs, libraries and plug-in bundles.
    /// Object files, debug symbols and `.a` archives are not signable and are left alone.
    public static func isSignable(url: URL) -> Bool {
        guard let h = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? h.close() }
        let head = h.readData(ofLength: 64)
        guard head.count >= 32 else { return false }
        let be = head.u32be(0)
        var header = head
        if be == 0xcafebabe || be == 0xcafebabf {
            let n = head.u32be(4)
            guard n > 0, n < 32 else { return false }                 // Java class files share this magic
            let offset = be == 0xcafebabf ? Int(head.u64be(16)) : Int(head.u32be(16))
            guard (try? h.seek(toOffset: UInt64(offset))) != nil else { return false }
            header = h.readData(ofLength: 32)
            guard header.count >= 16 else { return false }
        }
        let m = header.u32le(0)
        guard m == 0xfeedfacf || m == 0xfeedface else { return false }
        let fileType = header.u32le(12)
        return fileType == 2 || fileType == 6 || fileType == 8       // executable, dylib, bundle
    }

    /// Rebuilds the file bytes from the slices.
    public func encoded() -> Data {
        if !isFat { return slices[0].data }
        var out = Data()
        out.put32be(0xcafebabe)
        out.put32be(UInt32(slices.count))
        var offsets = [Int]()
        var cursor = 8 + 20 * slices.count
        for (i, s) in slices.enumerated() {
            let a = 1 << Int(fatAligns[i])
            cursor = align(cursor, a)
            offsets.append(cursor)
            cursor += s.data.count
        }
        for (i, s) in slices.enumerated() {
            out.put32be(s.cpuType); out.put32be(s.cpuSubtype)
            out.put32be(UInt32(offsets[i])); out.put32be(UInt32(s.data.count)); out.put32be(fatAligns[i])
        }
        for (i, s) in slices.enumerated() {
            out.append(Data(count: offsets[i] - out.count))
            out.append(s.data)
        }
        return out
    }
}
