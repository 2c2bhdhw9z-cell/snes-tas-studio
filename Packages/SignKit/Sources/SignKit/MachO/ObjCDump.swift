import Foundation

/// Reading the classes out of a program and writing them back out as headers - what people call
/// classdump. Ninth on docs/FEATURES.md (ABox has it).
///
/// A program keeps a description of every class it defines: the name, what it inherits from,
/// the things it holds, and every message it answers, with the types written in Apple's short
/// encoding ("v24@0:8@16" is a method taking an object and returning nothing). All of that is
/// laid out in the `__objc_*` sections as plain structures full of pointers, which is what this
/// follows.
///
/// Two complications are handled: newer programs store method lists as small relative offsets
/// instead of pointers, and newer programs also hand their pointers to iOS half-built (chained
/// fixups), so a pointer read straight off disk is not an address until the low bits are taken
/// and the program's own base added back.
public enum ObjCDump {
    public struct Method: Hashable, Sendable {
        public var selector: String
        /// Apple's short type encoding, kept as it is in the program.
        public var types: String
        public var isClassMethod: Bool
        /// "- (void)viewDidLoad;"
        public var line: String
    }

    public struct Ivar: Hashable, Sendable {
        public var name: String
        public var type: String
        public var line: String
    }

    public struct Property: Hashable, Sendable {
        public var name: String
        public var attributes: String
        public var line: String
    }

    public struct Class: Hashable, Sendable, Identifiable {
        public var id: String { name }
        public var name: String
        public var superName: String?
        public var protocols: [String]
        public var ivars: [Ivar]
        public var properties: [Property]
        public var methods: [Method]
        /// Swift classes live in the same list, under a mangled name.
        public var isSwift: Bool { name.hasPrefix("_Tt") || name.contains("$s") }

        /// A Swift class as a person wrote it: "BitByteData.LsbBitReader" rather than
        /// "_TtC11BitByteData12LsbBitReader". nil when the name is already plain.
        public var swiftName: String? { ObjCDump.unmangle(name) }

        /// The class as a header, the way class-dump writes it.
        public var header: String {
            var out = "@interface \(name)"
            if let swiftName { out = "// \(swiftName)\n" + out }
            if let superName { out += " : \(superName)" }
            if !protocols.isEmpty { out += " <" + protocols.joined(separator: ", ") + ">" }
            out += "\n"
            if !ivars.isEmpty {
                out += "{\n"
                for ivar in ivars { out += "    \(ivar.line)\n" }
                out += "}\n"
            }
            for property in properties { out += "\(property.line)\n" }
            if !properties.isEmpty { out += "\n" }
            for method in methods where method.isClassMethod { out += "\(method.line)\n" }
            for method in methods where !method.isClassMethod { out += "\(method.line)\n" }
            out += "@end\n"
            return out
        }
    }

    public struct ProtocolInfo: Hashable, Sendable, Identifiable {
        public var id: String { name }
        public var name: String
        public var adopts: [String]
        public var methods: [Method]

        public var header: String {
            var out = "@protocol \(name)"
            if !adopts.isEmpty { out += " <" + adopts.joined(separator: ", ") + ">" }
            out += "\n"
            for method in methods { out += "\(method.line)\n" }
            out += "@end\n"
            return out
        }
    }

    public struct Dump: Sendable {
        public var classes: [Class] = []
        public var protocols: [ProtocolInfo] = []
        /// Set when the program holds no class descriptions at all - a pure Swift or C program,
        /// or one whose pointers we could not follow.
        public var isEmpty: Bool { classes.isEmpty && protocols.isEmpty }

        /// Everything as one header file.
        public func headers() -> String {
            var out = "// Written by Signer, read straight out of the program.\n"
            out += "// \(classes.count) classes, \(protocols.count) protocols.\n\n"
            for proto in protocols.sorted(by: { $0.name < $1.name }) {
                out += proto.header + "\n"
            }
            for klass in classes.sorted(by: { $0.name < $1.name }) {
                out += klass.header + "\n"
            }
            return out
        }
    }

    /// Reads one slice of a program. Only 64-bit programs carry class descriptions worth
    /// reading; everything on an iPhone since 2017 is 64-bit.
    public static func read(_ slice: MachOSlice) -> Dump {
        guard slice.is64 else { return Dump() }
        let image = Image(slice)
        var dump = Dump()

        // The same class or protocol can be listed more than once (one entry per piece of
        // the program it was compiled into), so the first of each name is the one kept.
        var seenClasses = Set<String>()
        for va in image.pointerList(section: "__objc_classlist") {
            if let klass = readClass(at: va, image: image, seen: 0),
               seenClasses.insert(klass.name).inserted {
                dump.classes.append(klass)
            }
        }
        var seenProtocols = Set<String>()
        for va in image.pointerList(section: "__objc_protolist") {
            if let proto = readProtocol(at: va, image: image),
               seenProtocols.insert(proto.name).inserted {
                dump.protocols.append(proto)
            }
        }
        return dump
    }

    // MARK: - classes

    static func readClass(at va: UInt64, image: Image, seen: Int) -> Class? {
        // class_t: isa, superclass, cache, vtable, data
        guard let superRaw = image.pointer(atVA: va + 8),
              let dataRaw = image.pointer(atVA: va + 32) else { return nil }
        // The low bits of the data pointer are flags (Swift uses them).
        let roVA = image.target(of: dataRaw & ~UInt64(3))
        guard let ro = roVA else { return nil }

        // class_ro_t: flags, instanceStart, instanceSize, reserved, ivarLayout, name,
        //             baseMethods, baseProtocols, ivars, weakIvarLayout, baseProperties
        guard let name = image.string(atPointerIn: ro + 24) else { return nil }
        let methods = readMethods(listAt: ro + 32, image: image, classMethods: false)
        let protocols = readProtocolNames(listAt: ro + 40, image: image)
        let ivars = readIvars(listAt: ro + 48, image: image)
        let properties = readProperties(listAt: ro + 64, image: image)

        var superName: String? = image.boundName(forPointerAt: va + 8)
        if superName == nil, let superVA = image.target(of: superRaw), superVA != va, seen < 1 {
            // Only the direct parent's name is needed, not its whole description.
            if let superRo = image.pointer(atVA: superVA + 32).flatMap({ image.target(of: $0 & ~UInt64(3)) }) {
                superName = image.string(atPointerIn: superRo + 24)
            }
        }

        // The class's own (meta) methods, which are the + ones.
        var all = methods
        if let isaRaw = image.pointer(atVA: va), let meta = image.target(of: isaRaw),
           let metaRo = image.pointer(atVA: meta + 32).flatMap({ image.target(of: $0 & ~UInt64(3)) }) {
            all += readMethods(listAt: metaRo + 32, image: image, classMethods: true)
        }

        return Class(name: name, superName: superName, protocols: protocols,
                     ivars: ivars, properties: properties, methods: all)
    }

    static func readMethods(listAt pointerVA: UInt64, image: Image, classMethods: Bool) -> [Method] {
        guard let raw = image.pointer(atVA: pointerVA), let listVA = image.target(of: raw),
              let entsize = image.u32(atVA: listVA), let count = image.u32(atVA: listVA + 4),
              count > 0, count < 100_000 else { return [] }
        let relative = entsize & 0x8000_0000 != 0
        let stride = UInt64(entsize & 0xFFFC)
        var out: [Method] = []
        for index in 0..<UInt64(count) {
            let entry = listVA + 8 + index * (stride == 0 ? (relative ? 12 : 24) : stride)
            var selector: String?
            var types: String?
            if relative {
                // Three signed offsets from each field's own address. The first points at a
                // place that holds the pointer to the name, not at the name.
                if let nameOffset = image.i32(atVA: entry) {
                    let refVA = UInt64(bitPattern: Int64(entry) + Int64(nameOffset))
                    selector = image.string(atPointerIn: refVA)
                }
                if let typesOffset = image.i32(atVA: entry + 4) {
                    let typesVA = UInt64(bitPattern: Int64(entry + 4) + Int64(typesOffset))
                    types = image.cString(atVA: typesVA)
                }
            } else {
                selector = image.string(atPointerIn: entry)
                types = image.string(atPointerIn: entry + 8)
            }
            guard let selector, !selector.isEmpty else { continue }
            let encoding = types ?? ""
            out.append(Method(selector: selector, types: encoding, isClassMethod: classMethods,
                              line: line(selector: selector, types: encoding,
                                         classMethod: classMethods)))
        }
        // A protocol lists some methods as both required and optional, and a class compiled in
        // pieces can repeat one; a header wants each line once.
        var seen = Set<String>()
        return out.filter { seen.insert("\($0.isClassMethod)\($0.selector)\($0.types)").inserted }
    }

    static func readIvars(listAt pointerVA: UInt64, image: Image) -> [Ivar] {
        guard let raw = image.pointer(atVA: pointerVA), let listVA = image.target(of: raw),
              let entsize = image.u32(atVA: listVA), let count = image.u32(atVA: listVA + 4),
              count > 0, count < 100_000 else { return [] }
        let stride = UInt64(entsize == 0 ? 32 : entsize)
        var out: [Ivar] = []
        for index in 0..<UInt64(count) {
            let entry = listVA + 8 + index * stride
            guard let name = image.string(atPointerIn: entry + 8) else { continue }
            let type = image.string(atPointerIn: entry + 16) ?? ""
            out.append(Ivar(name: name, type: type,
                            line: Types.declaration(of: type, named: name) + ";"))
        }
        return out
    }

    static func readProperties(listAt pointerVA: UInt64, image: Image) -> [Property] {
        guard let raw = image.pointer(atVA: pointerVA), let listVA = image.target(of: raw),
              let entsize = image.u32(atVA: listVA), let count = image.u32(atVA: listVA + 4),
              count > 0, count < 100_000 else { return [] }
        let stride = UInt64(entsize == 0 ? 16 : entsize)
        var out: [Property] = []
        for index in 0..<UInt64(count) {
            let entry = listVA + 8 + index * stride
            guard let name = image.string(atPointerIn: entry) else { continue }
            let attributes = image.string(atPointerIn: entry + 8) ?? ""
            out.append(Property(name: name, attributes: attributes,
                                line: Types.property(name: name, attributes: attributes)))
        }
        return out
    }

    static func readProtocolNames(listAt pointerVA: UInt64, image: Image) -> [String] {
        guard let raw = image.pointer(atVA: pointerVA), let listVA = image.target(of: raw),
              let count = image.u64(atVA: listVA), count > 0, count < 10_000 else { return [] }
        var out: [String] = []
        for index in 0..<count {
            guard let entry = image.pointer(atVA: listVA + 8 + index * 8),
                  let protoVA = image.target(of: entry),
                  let name = image.string(atPointerIn: protoVA + 8) else { continue }
            out.append(name)
        }
        return out
    }

    static func readProtocol(at va: UInt64, image: Image) -> ProtocolInfo? {
        // protocol_t: isa, name, protocols, instanceMethods, classMethods,
        //             optionalInstanceMethods, optionalClassMethods, instanceProperties, ...
        guard let name = image.string(atPointerIn: va + 8) else { return nil }
        var methods = readMethods(listAt: va + 24, image: image, classMethods: false)
        methods += readMethods(listAt: va + 32, image: image, classMethods: true)
        methods += readMethods(listAt: va + 40, image: image, classMethods: false)
        methods += readMethods(listAt: va + 48, image: image, classMethods: true)
        let adopts = readProtocolNames(listAt: va + 16, image: image)
        return ProtocolInfo(name: name, adopts: adopts, methods: methods)
    }

    /// Swift gives its classes a name with the module and the lengths packed into it, the older
    /// shape being `_TtC11BitByteData12LsbBitReader`. This puts it back together for reading.
    /// The newer `$s…` shape is left alone: unpacking it properly is a job in itself.
    public static func unmangle(_ name: String) -> String? {
        guard name.hasPrefix("_TtC") else { return nil }
        var rest = Substring(name.dropFirst(4))
        var parts: [String] = []
        while let first = rest.first, first.isNumber {
            let digits = rest.prefix { $0.isNumber }
            guard let length = Int(digits), length > 0, length < 200 else { break }
            rest = rest.dropFirst(digits.count)
            guard rest.count >= length else { break }
            parts.append(String(rest.prefix(length)))
            rest = rest.dropFirst(length)
        }
        return parts.count >= 2 ? parts.joined(separator: ".") : nil
    }

    /// "- (void)setThing:(NSString *)arg1;"
    static func line(selector: String, types: String, classMethod: Bool) -> String {
        let decoded = Types.split(types)
        let sign = classMethod ? "+" : "-"
        guard let returnType = decoded.first else { return "\(sign) (id)\(selector);" }
        let arguments = Array(decoded.dropFirst(3))   // self, selector, then the real ones
        let parts = selector.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard selector.contains(":"), !arguments.isEmpty else {
            return "\(sign) (\(returnType))\(selector);"
        }
        var out = "\(sign) (\(returnType))"
        for (index, argument) in arguments.enumerated() {
            let label = index < parts.count ? parts[index] : ""
            out += "\(label):(\(argument))arg\(index + 1)"
            if index < arguments.count - 1 { out += " " }
        }
        return out + ";"
    }
}

// MARK: - following pointers inside a program

extension ObjCDump {
    /// A program's memory layout, and the few ways we need to read through it.
    struct Image {
        let slice: MachOSlice
        let sections: [Section]
        let segments: [Segment]
        let base: UInt64
        /// Addresses this program covers, used to tell a real pointer from a half-built one.
        let lowest: UInt64
        let highest: UInt64
        let usesChainedFixups: Bool

        init(_ slice: MachOSlice) {
            self.slice = slice
            sections = slice.sections
            segments = slice.segments
            let text = segments.first { $0.name == "__TEXT" }
            base = text?.vmaddr ?? 0
            lowest = segments.filter { $0.vmsize > 0 }.map(\.vmaddr).min() ?? 0
            highest = segments.filter { $0.vmsize > 0 }.map { $0.vmaddr + $0.vmsize }.max() ?? 0
            // LC_DYLD_CHAINED_FIXUPS
            usesChainedFixups = slice.loadCommands.contains { $0.cmd == 0x8000_0034 }
        }

        func covers(_ va: UInt64) -> Bool { va >= lowest && va < highest }

        func fileOffset(of va: UInt64) -> Int? {
            for segment in segments where segment.vmsize > 0 {
                if va >= segment.vmaddr, va < segment.vmaddr + segment.vmsize {
                    let delta = va - segment.vmaddr
                    guard delta < segment.filesize else { return nil }
                    let offset = Int(segment.fileoff + delta)
                    return offset < slice.data.count ? offset : nil
                }
            }
            return nil
        }

        /// The raw 8 bytes at an address, as they sit on disk.
        func pointer(atVA va: UInt64) -> UInt64? {
            guard let offset = fileOffset(of: va), offset + 8 <= slice.data.count else { return nil }
            return slice.data.u64le(offset)
        }

        func u64(atVA va: UInt64) -> UInt64? { pointer(atVA: va) }

        func u32(atVA va: UInt64) -> UInt32? {
            guard let offset = fileOffset(of: va), offset + 4 <= slice.data.count else { return nil }
            return slice.data.u32le(offset)
        }

        func i32(atVA va: UInt64) -> Int32? {
            u32(atVA: va).map { Int32(bitPattern: $0) }
        }

        /// What a pointer read off disk really points at.
        ///
        /// In an older program it is already an address. In a newer one it is a chained fixup:
        /// the low 36 bits are how far into the program the target sits, the top bit says it is
        /// an imported symbol instead (which lives in another library, so there is nothing here
        /// to follow).
        func target(of raw: UInt64) -> UInt64? {
            guard raw != 0 else { return nil }
            if covers(raw) { return raw }
            guard raw & (1 << 63) == 0 else { return nil }
            let candidate = base + (raw & 0xF_FFFF_FFFF)
            return covers(candidate) ? candidate : nil
        }

        /// A string that a pointer at this address points at.
        func string(atPointerIn va: UInt64) -> String? {
            guard let raw = pointer(atVA: va), let target = target(of: raw) else { return nil }
            return cString(atVA: target)
        }

        func cString(atVA va: UInt64) -> String? {
            guard let offset = fileOffset(of: va) else { return nil }
            var bytes = [UInt8]()
            var index = offset
            while index < slice.data.count, bytes.count < 4096 {
                let byte = slice.data.u8(index)
                if byte == 0 { break }
                bytes.append(byte)
                index += 1
            }
            guard !bytes.isEmpty else { return nil }
            return String(bytes: bytes, encoding: .utf8)
        }

        /// A list of pointers in one of the `__objc_` sections, already followed.
        func pointerList(section name: String) -> [UInt64] {
            guard let section = sections.first(where: { $0.name == name }) else { return [] }
            var out: [UInt64] = []
            var va = section.addr
            let end = section.addr + section.size
            while va + 8 <= end {
                if let raw = pointer(atVA: va), let target = target(of: raw) {
                    out.append(target)
                }
                va += 8
            }
            return out
        }

        /// A parent class that lives in another library (UIViewController, NSObject) is not a
        /// pointer at all: it is a note to iOS saying "fill this in with the class called X".
        /// This reads X out of the program's list of names it borrows.
        func boundName(forPointerAt va: UInt64) -> String? {
            guard let raw = pointer(atVA: va), raw & (1 << 63) != 0 else { return nil }
            // In a bind, the bottom 24 bits say which borrowed name it is.
            let ordinal = Int(raw & 0xFF_FFFF)
            guard ordinal < importNames.count else { return nil }
            let name = importNames[ordinal]
            // "_OBJC_CLASS_$_UIViewController" is how a class is asked for.
            for prefix in ["_OBJC_CLASS_$_", "_OBJC_METACLASS_$_", "_"] where name.hasPrefix(prefix) {
                return String(name.dropFirst(prefix.count))
            }
            return name
        }

        /// Every name the program borrows from other libraries, in order, so a bind can be
        /// turned back into a name. Read from the chained fixups table.
        var importNames: [String] {
            if let cached = Image.importCache.withLock({ $0[cacheKey] }) { return cached }
            let names = readImportNames()
            Image.importCache.withLock { $0[cacheKey] = names }
            return names
        }

        private func readImportNames() -> [String] {
            guard let lc = slice.loadCommands.first(where: { $0.cmd == 0x8000_0034 }) else { return [] }
            let dataOffset = Int(slice.data.u32le(lc.offset + 8))
            let dataSize = Int(slice.data.u32le(lc.offset + 12))
            guard dataOffset > 0, dataSize > 32, dataOffset + dataSize <= slice.data.count else { return [] }
            let importsOffset = Int(slice.data.u32le(dataOffset + 8))
            let symbolsOffset = Int(slice.data.u32le(dataOffset + 12))
            let count = Int(slice.data.u32le(dataOffset + 16))
            let format = slice.data.u32le(dataOffset + 20)
            guard count > 0, count < 200_000 else { return [] }
            // 1: 4 bytes each, 2: 8 bytes, 3: 16 bytes. The first word holds the name's place
            // in the pool in its top 23 bits either way.
            let stride: Int
            switch format {
            case 1: stride = 4
            case 2: stride = 8
            case 3: stride = 16
            default: return []
            }
            let symbolsBase = dataOffset + symbolsOffset
            var out: [String] = []
            out.reserveCapacity(count)
            for index in 0..<count {
                let entry = dataOffset + importsOffset + index * stride
                guard entry + 4 <= slice.data.count else { break }
                let word = slice.data.u32le(entry)
                let nameOffset = Int(word >> 9)
                var bytes = [UInt8]()
                var cursor = symbolsBase + nameOffset
                while cursor < slice.data.count, bytes.count < 1024 {
                    let byte = slice.data.u8(cursor)
                    if byte == 0 { break }
                    bytes.append(byte)
                    cursor += 1
                }
                out.append(String(bytes: bytes, encoding: .utf8) ?? "")
            }
            return out
        }

        /// Reading the borrowed names means walking the whole table, so it is done once per
        /// program rather than once per class.
        private var cacheKey: String { "\(slice.cpuType)-\(slice.data.count)" }
        private static let importCache = Locked<[String: [String]]>([:])
    }
}

// MARK: - Apple's short type encodings

extension ObjCDump {
    /// Turning "v24@0:8@16" and "@\"NSString\"" into something a person can read.
    enum Types {
        /// Splits a method's encoding into the return type and each argument, in order.
        static func split(_ encoding: String) -> [String] {
            var out: [String] = []
            var characters = Array(encoding)
            var index = 0
            while index < characters.count {
                // Digits between types are just offsets; skip them.
                if characters[index].isNumber { index += 1; continue }
                let start = index
                skipOne(characters, &index)
                guard index > start else { index += 1; continue }
                out.append(readable(String(characters[start..<index])))
            }
            return out
        }

        /// Moves `index` past exactly one type.
        private static func skipOne(_ characters: [Character], _ index: inout Int) {
            guard index < characters.count else { return }
            // Qualifiers in front of a type.
            while index < characters.count, "rnNoORV".contains(characters[index]) { index += 1 }
            guard index < characters.count else { return }
            let c = characters[index]
            switch c {
            case "^", "b":
                index += 1
                skipOne(characters, &index)
            case "@":
                index += 1
                if index < characters.count, characters[index] == "\"" {
                    index += 1
                    while index < characters.count, characters[index] != "\"" { index += 1 }
                    if index < characters.count { index += 1 }
                } else if index < characters.count, characters[index] == "?" {
                    index += 1
                }
            case "{", "(":
                let close: Character = c == "{" ? "}" : ")"
                var depth = 0
                while index < characters.count {
                    if characters[index] == c { depth += 1 }
                    if characters[index] == close {
                        depth -= 1
                        index += 1
                        if depth == 0 { break }
                        continue
                    }
                    index += 1
                }
            case "[":
                var depth = 0
                while index < characters.count {
                    if characters[index] == "[" { depth += 1 }
                    if characters[index] == "]" {
                        depth -= 1
                        index += 1
                        if depth == 0 { break }
                        continue
                    }
                    index += 1
                }
            default:
                index += 1
            }
        }

        /// One encoded type as C.
        static func readable(_ encoded: String) -> String {
            var type = encoded
            // Drop the qualifiers; they say how an argument is passed, not what it is.
            while let first = type.first, "rnNoORV".contains(first) { type.removeFirst() }
            guard let first = type.first else { return "id" }
            switch first {
            case "v": return "void"
            case "c": return "char"
            case "C": return "unsigned char"
            case "s": return "short"
            case "S": return "unsigned short"
            case "i": return "int"
            case "I": return "unsigned int"
            case "l": return "long"
            case "L": return "unsigned long"
            case "q": return "long long"
            case "Q": return "unsigned long long"
            case "f": return "float"
            case "d": return "double"
            case "D": return "long double"
            case "B": return "BOOL"
            case "*": return "char *"
            case "#": return "Class"
            case ":": return "SEL"
            case "?": return "void *"
            case "@":
                let rest = type.dropFirst()
                if rest.hasPrefix("?") { return "id /* block */" }
                if rest.hasPrefix("\"") {
                    let name = rest.dropFirst().prefix { $0 != "\"" }
                    // A protocol, written @"<NSCopying>", is not a class.
                    if name.hasPrefix("<") { return "id \(name)" }
                    return name.isEmpty ? "id" : "\(name) *"
                }
                return "id"
            case "^":
                let inner = readable(String(type.dropFirst()))
                return inner.hasSuffix("*") ? inner + "*" : inner + " *"
            case "{", "(":
                let name = type.dropFirst().prefix { $0 != "=" && $0 != "}" && $0 != ")" }
                let kind = first == "{" ? "struct" : "union"
                return name.isEmpty || name == "?" ? "\(kind) { ... }" : "\(kind) \(name)"
            case "[":
                let digits = type.dropFirst().prefix { $0.isNumber }
                let element = readable(String(type.dropFirst(1 + digits.count).dropLast()))
                return "\(element)[\(digits)]"
            case "b":
                return "unsigned int"   // a bitfield
            default:
                return "id"
            }
        }

        /// An instance variable, written out.
        static func declaration(of encoded: String, named name: String) -> String {
            let type = readable(encoded)
            return type.hasSuffix("*") ? "\(type)\(name)" : "\(type) \(name)"
        }

        /// A property, with the bits of its attribute string that are worth showing.
        static func property(name: String, attributes: String) -> String {
            // "T@\"NSString\",&,N,V_thing"
            var type = "id"
            var flags: [String] = []
            for part in attributes.split(separator: ",") {
                guard let marker = part.first else { continue }
                let value = String(part.dropFirst())
                switch marker {
                case "T": type = readable(value)
                case "R": flags.append("readonly")
                case "C": flags.append("copy")
                case "&": flags.append("retain")
                case "W": flags.append("weak")
                case "N": flags.append("nonatomic")
                case "G": flags.append("getter=\(value)")
                case "S": flags.append("setter=\(value)")
                default: break
                }
            }
            let list = flags.isEmpty ? "" : " (" + flags.joined(separator: ", ") + ")"
            let spacer = type.hasSuffix("*") ? "" : " "
            return "@property\(list) \(type)\(spacer)\(name);"
        }
    }
}
