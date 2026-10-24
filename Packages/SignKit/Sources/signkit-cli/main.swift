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
default:
    usage()
}
