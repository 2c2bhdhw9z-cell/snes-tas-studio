import Foundation
import Dispatch

/// Apple's code-signing blob types.
public enum BlobMagic {
    public static let requirement: UInt32 = 0xfade_0c00
    public static let requirements: UInt32 = 0xfade_0c01
    public static let codeDirectory: UInt32 = 0xfade_0c02
    public static let embeddedSignature: UInt32 = 0xfade_0cc0
    public static let detachedSignature: UInt32 = 0xfade_0cc1
    public static let entitlements: UInt32 = 0xfade_7171
    public static let derEntitlements: UInt32 = 0xfade_7172
    public static let blobWrapper: UInt32 = 0xfade_0b01
}

/// Slot numbers inside the signature.
public enum CSSlot {
    public static let codeDirectory: UInt32 = 0
    public static let infoPlist: UInt32 = 1
    public static let requirements: UInt32 = 2
    public static let resourceDir: UInt32 = 3
    public static let application: UInt32 = 4
    public static let entitlements: UInt32 = 5
    public static let repSpecific: UInt32 = 6
    public static let derEntitlements: UInt32 = 7
    public static let alternateCodeDirectory: UInt32 = 0x1000
    public static let signatureSlot: UInt32 = 0x1_0000
}

/// Flags in the code directory.
public enum CSFlags {
    public static let adhoc: UInt32 = 0x0000_0002
    public static let linkerSigned: UInt32 = 0x0002_0000
    public static let runtime: UInt32 = 0x0001_0000
}

/// One finished blob: magic + length + body.
public struct Blob {
    public let magic: UInt32
    public let body: Data

    public init(magic: UInt32, body: Data) {
        self.magic = magic
        self.body = body
    }

    public var encoded: Data {
        var d = Data()
        d.put32be(magic)
        d.put32be(UInt32(body.count + 8))
        d.append(body)
        return d
    }

    /// Wraps arbitrary data (used for the CMS signature).
    public static func wrapper(_ data: Data) -> Blob { Blob(magic: BlobMagic.blobWrapper, body: data) }
}

/// Builds the SuperBlob that goes into the Mach-O.
public struct SuperBlob {
    public var entries: [(slot: UInt32, blob: Blob)] = []

    public init() {}

    public mutating func add(_ slot: UInt32, _ blob: Blob) { entries.append((slot, blob)) }

    public func encoded(magic: UInt32 = BlobMagic.embeddedSignature) -> Data {
        let indexSize = 8 * entries.count
        var offset = 12 + indexSize
        var index = Data()
        var payload = Data()
        for e in entries {
            let bytes = e.blob.encoded
            index.put32be(e.slot)
            index.put32be(UInt32(offset))
            payload.append(bytes)
            offset += bytes.count
        }
        var out = Data()
        out.put32be(magic)
        out.put32be(UInt32(12 + indexSize + payload.count))
        out.put32be(UInt32(entries.count))
        out.append(index)
        out.append(payload)
        return out
    }
}

/// The code directory: the list of hashes iOS checks the app against.
public struct CodeDirectory {
    public var identifier: String
    public var teamID: String?
    public var hashKind: HashKind
    public var pageSize: Int = 4096
    public var codeLimit: Int
    public var flags: UInt32 = 0
    public var platform: UInt8 = 0
    public var execSegBase: UInt64 = 0
    public var execSegLimit: UInt64 = 0
    public var execSegFlags: UInt64 = 0
    /// Special slots, indexed by slot number (1 = Info.plist, 2 = requirements, …).
    public var specialHashes: [UInt32: Data] = [:]
    /// One hash per page of code.
    public var codeHashes: [Data] = []

    public init(identifier: String, teamID: String?, hashKind: HashKind, codeLimit: Int) {
        self.identifier = identifier
        self.teamID = teamID
        self.hashKind = hashKind
        self.codeLimit = codeLimit
    }

    public static let version: UInt32 = 0x0002_0400

    public var blob: Blob {
        let nSpecial = Int(specialHashes.keys.max() ?? 0)
        let hashSize = hashKind.size
        var ident = Data(identifier.utf8); ident.append(0)
        var team = Data()
        if let t = teamID, !t.isEmpty { team = Data(t.utf8); team.append(0) }

        // The fixed part of a version 0x20400 code directory is exactly 88 bytes,
        // counting the 8-byte blob header. Checked against real signed apps.
        let identOffset = 88
        let teamOffset = team.isEmpty ? 0 : identOffset + ident.count
        let hashOffset = identOffset + ident.count + team.count + nSpecial * hashSize

        var b = Data()
        b.put32be(CodeDirectory.version)
        b.put32be(flags)
        b.put32be(UInt32(hashOffset))
        b.put32be(UInt32(identOffset))
        b.put32be(UInt32(nSpecial))
        b.put32be(UInt32(codeHashes.count))
        b.put32be(UInt32(codeLimit))
        b.append(UInt8(hashSize))
        b.append(hashKind.cdType)
        b.append(platform)
        b.append(UInt8(log2(Double(pageSize))))
        b.put32be(0)                              // spare2
        b.put32be(0)                              // scatterOffset
        b.put32be(UInt32(teamOffset))
        b.put32be(0)                              // spare3
        b.put64be(0)                              // codeLimit64 (we never pass 4 GB)
        b.put64be(execSegBase)
        b.put64be(execSegLimit)
        b.put64be(execSegFlags)

        b.append(ident)
        b.append(team)
        // Special slots run backwards: slot n sits n entries before the code hashes.
        for slot in stride(from: nSpecial, through: 1, by: -1) {
            b.append(specialHashes[UInt32(slot)] ?? Data(count: hashSize))
        }
        for h in codeHashes { b.append(h) }
        return Blob(magic: BlobMagic.codeDirectory, body: b)
    }

    /// The identifier iOS uses to refer to this signature ("cdhash").
    public var cdhash: Data { Hasher.hash(hashKind, blob.encoded) }
    /// The 20-byte form Apple puts in the CMS attributes.
    public var truncatedCDHash: Data { cdhash.prefix(20) }

    /// Hashes every page of the file up to `codeLimit`.
    /// The pages are independent, so they are hashed on all the phone's cores at once —
    /// which is most of the time spent signing a big app.
    public mutating func hashCode(of data: Data) {
        let pages = (codeLimit + pageSize - 1) / pageSize
        guard pages > 0 else { codeHashes = []; return }
        let kind = hashKind
        let size = pageSize
        let limit = codeLimit

        if pages < 8 {
            codeHashes = (0..<pages).map { i in
                let start = i * size
                return Hasher.hash(kind, data.sub(start, min(size, limit - start)))
            }
            return
        }

        var results = [Data](repeating: Data(), count: pages)
        data.withUnsafeBytes { raw in
            let base = raw.baseAddress!
            results.withUnsafeMutableBufferPointer { out in
                let buffer = out
                DispatchQueue.concurrentPerform(iterations: pages) { i in
                    let start = i * size
                    let count = min(size, limit - start)
                    let page = UnsafeRawBufferPointer(start: base + start, count: count)
                    var hasher = Hasher(kind)
                    hasher.update(page)
                    buffer[i] = hasher.finish()
                }
            }
        }
        codeHashes = results
    }
}
