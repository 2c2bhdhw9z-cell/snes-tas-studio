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
default:
    usage()
}
