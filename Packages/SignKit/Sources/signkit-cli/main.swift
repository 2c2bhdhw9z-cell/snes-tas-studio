import Foundation
import SignKit

// Small command-line front end, used to check the engine in the build sandbox.
// Usage: signkit-cli macho <path>

let args = Array(CommandLine.arguments.dropFirst())

func usage() -> Never {
    print("usage: signkit-cli macho <file>")
    exit(2)
}

guard let cmd = args.first else { usage() }

switch cmd {
case "macho":
    guard args.count == 2 else { usage() }
    let url = URL(fileURLWithPath: args[1])
    let data = try Data(contentsOf: url)
    let file = try MachOFile(data: data)
    print("fat: \(file.isFat)")
    for s in file.slices {
        print("arch \(s.archName): type=\(s.fileType) cmds=\(s.ncmds) minOS=\(s.minOS ?? "-") "
              + "encrypted=\(s.isEncrypted) headerFree=\(s.headerPadding) signature=\(s.existingSignature?.count ?? 0)")
        for d in s.dylibs { print("   links \(d)") }
    }
case "zip":
    guard args.count == 2 else { usage() }
    let r = try ZipReader(url: URL(fileURLWithPath: args[1]))
    print("entries: \(r.entries.count)")
    var checked = 0, bytes = 0
    for e in r.entries where !e.isDirectory && !e.isSymlink {
        let d = try r.data(for: e)
        guard Zip.crc32(d) == e.crc32 else {
            print("CHECKSUM MISMATCH: \(e.name)")
            exit(1)
        }
        checked += 1
        bytes += d.count
    }
    print("checksums verified: \(checked) files, \(bytes) bytes")
case "sign":
    // sign <macho> <p12> <password> <identifier> <out> [entitlements.plist]
    guard args.count >= 6 else {
        print("usage: signkit-cli sign <macho> <p12> <password> <identifier> <out> [entitlements.plist]")
        exit(2)
    }
    let p12 = try PKCS12(url: URL(fileURLWithPath: args[2]), password: args[3])
    guard let key = p12.privateKey, let leaf = p12.identity else {
        print("the .p12 has no usable certificate")
        exit(1)
    }
    var ents: [String: Any]?
    if args.count > 6 {
        let d = try Data(contentsOf: URL(fileURLWithPath: args[6]))
        ents = try PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any]
    }
    let signer = MachOSigner(key: key, chain: [leaf] + p12.certificates.filter { $0.der != leaf.der })
    var opts = MachOSigner.Options(identifier: args[4], teamID: leaf.teamID, entitlements: ents)
    opts.hashKind = .sha256
    let input = try Data(contentsOf: URL(fileURLWithPath: args[1]))
    let signed = try signer.sign(data: input, options: opts)
    try signed.write(to: URL(fileURLWithPath: args[5]))
    let file = try MachOFile(data: signed)
    for s in file.slices {
        print("signed \(s.archName): signature \(s.existingSignature?.count ?? 0) bytes, "
              + "cdhash \(signer.cdhash(for: s)?.hex.prefix(40) ?? "-")")
    }
default:
    usage()
}
