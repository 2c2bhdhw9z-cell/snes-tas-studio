import Foundation

extension MachOSlice {
    /// Inserts a new load command at the end of the load commands, using header padding.
    mutating func appendLoadCommand(_ cmd: Data) throws {
        guard headerPadding >= cmd.count else {
            throw SignKitError.unsupported("not enough free space in the app's header to add a library")
        }
        let end = headerSize + sizeofcmds
        data.replaceSubrange((data.startIndex + end)..<(data.startIndex + end + cmd.count), with: cmd)
        data.set32le(16, UInt32(ncmds + 1))
        data.set32le(20, UInt32(sizeofcmds + cmd.count))
    }

    /// Removes one load command and zero-fills the freed space at the end.
    mutating func removeLoadCommand(_ lc: LoadCommand) {
        let end = headerSize + sizeofcmds
        let s = data.startIndex
        let tail = data.sub(lc.offset + lc.size, end - lc.offset - lc.size)
        data.replaceSubrange((s + lc.offset)..<(s + end), with: tail + Data(count: lc.size))
        data.set32le(16, UInt32(ncmds - 1))
        data.set32le(20, UInt32(sizeofcmds - lc.size))
    }

    static func dylibCommand(_ path: String, weak: Bool) -> Data {
        var name = Data(path.utf8); name.append(0)
        let size = align(24 + name.count, 8)
        var d = Data()
        d.put32le(weak ? LC.loadWeakDylib : LC.loadDylib)
        d.put32le(UInt32(size))
        d.put32le(24)          // name offset
        d.put32le(2)           // timestamp
        d.put32le(0x0001_0000) // current version 1.0
        d.put32le(0x0001_0000) // compatibility version
        d.append(name)
        d.append(Data(count: size - d.count))
        return d
    }

    /// Adds `LC_LOAD_DYLIB` (or weak) for `path` if it isn't already linked.
    public mutating func injectDylib(_ path: String, weak: Bool = false) throws {
        if dylibs.contains(path) { return }
        try appendLoadCommand(MachOSlice.dylibCommand(path, weak: weak))
    }

    /// Removes every load command that links `path`. Returns true if one was removed.
    @discardableResult
    public mutating func removeDylib(_ path: String) -> Bool {
        var removed = false
        while let lc = loadCommands.first(where: { lc in
            guard LC.isDylibLoad(lc.cmd) else { return false }
            let nameOff = Int(data.u32le(lc.offset + 8))
            return cString(data.sub(lc.offset + nameOff, lc.size - nameOff)) == path
        }) {
            removeLoadCommand(lc); removed = true
        }
        return removed
    }

    /// Renames a linked library (for example CydiaSubstrate -> our hook library).
    public mutating func replaceDylib(_ old: String, with new: String) throws {
        guard let lc = loadCommands.first(where: { lc in
            guard LC.isDylibLoad(lc.cmd) else { return false }
            let nameOff = Int(data.u32le(lc.offset + 8))
            return cString(data.sub(lc.offset + nameOff, lc.size - nameOff)) == old
        }) else { return }
        let weak = lc.cmd == LC.loadWeakDylib
        removeLoadCommand(lc)
        try injectDylib(new, weak: weak)
    }

    public mutating func addRpath(_ path: String) throws {
        if rpaths.contains(path) { return }
        var name = Data(path.utf8); name.append(0)
        let size = align(12 + name.count, 8)
        var d = Data()
        d.put32le(LC.rpath); d.put32le(UInt32(size)); d.put32le(12)
        d.append(name); d.append(Data(count: size - d.count))
        try appendLoadCommand(d)
    }

    /// Changes the minimum OS version stored in the binary.
    public mutating func setMinOS(major: Int, minor: Int) {
        let v = UInt32(major << 16 | minor << 8)
        for lc in loadCommands {
            if lc.cmd == LC.buildVersion { data.set32le(lc.offset + 12, v) }
            if lc.cmd == LC.versionMinIPhoneOS { data.set32le(lc.offset + 8, v) }
        }
    }

    /// Changes the SDK version stored in LC_BUILD_VERSION (used to turn on / off Liquid Glass look).
    public mutating func setSDK(major: Int, minor: Int) {
        let v = UInt32(major << 16 | minor << 8)
        for lc in loadCommands where lc.cmd == LC.buildVersion { data.set32le(lc.offset + 16, v) }
    }

    /// Removes the signature and returns the slice trimmed to the end of the code.
    mutating func stripSignature() {
        guard let lc = codeSignatureCommand else { return }
        let off = Int(data.u32le(lc.offset + 8))
        if off > 0 && off <= data.count { data = data.prefix(off) }
        removeLoadCommand(lc)
        if let le = segments.first(where: { $0.name == "__LINKEDIT" }) {
            let newSize = UInt64(data.count) - le.fileoff
            setSegmentSize(le, fileSize: newSize)
        }
    }

    mutating func setSegmentSize(_ seg: Segment, fileSize: UInt64) {
        let vmsize = UInt64(align(Int(fileSize), 0x4000))
        if is64 {
            data.set64le(seg.cmdOffset + 48, fileSize)
            data.set64le(seg.cmdOffset + 32, max(vmsize, 0))
        } else {
            data.set32le(seg.cmdOffset + 36, UInt32(fileSize))
            data.set32le(seg.cmdOffset + 28, UInt32(vmsize))
        }
    }
}

extension MachOFile {
    public mutating func forEachSlice(_ body: (inout MachOSlice) throws -> Void) rethrows {
        for i in slices.indices { try body(&slices[i]) }
    }

    /// Keeps only the slices whose names are listed (e.g. ["arm64"]).
    public mutating func thin(keeping archs: Set<String>) {
        let idx = slices.indices.filter { archs.contains(slices[$0].archName) }
        guard !idx.isEmpty else { return }
        fatAligns = idx.map { fatAligns[$0] }
        slices = idx.map { slices[$0] }
    }

    public var archNames: [String] { slices.map(\.archName) }
}
