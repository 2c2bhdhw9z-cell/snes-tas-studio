import Foundation
import Dispatch

/// Looks over a finished app the way the iPhone's installer does, before anyone wastes
/// time installing something that will be refused.
///
/// When iOS rejects an app it says only "integrity could not be verified", whatever the
/// real reason. This checks the things that message can mean: the signature hashes, the
/// resource list, the permissions copies, the certificate chain, the profile, and whether
/// the program file is allowed to run. It is tested against apps that really install
/// (GBox, signed by Apple's own tool), so a clean report means something.
public enum SignatureInspector {
    public struct Problem: CustomStringConvertible, Equatable {
        public enum Kind: String { case structure, hash, entitlements, certificate, profile, permission, expired, resources }
        public let kind: Kind
        public let file: String
        public let message: String
        public var description: String { "\(file): \(message)" }
    }

    public struct Report {
        public var problems: [Problem] = []
        public var binariesChecked = 0
        public var filesChecked = 0
        public var isClean: Bool { problems.isEmpty }
        /// Problems worth showing the user, in plain English.
        public var summary: String {
            problems.prefix(4).map(\.description).joined(separator: "\n")
        }
    }

    /// - Parameters:
    ///   - app: the unpacked `.app` folder.
    ///   - profile: the profile that was embedded, if signing with a certificate.
    ///   - deep: also re-hash every page and every resource. Skipped for enormous apps,
    ///     where the signer has just computed those same hashes from the final bytes.
    public static func check(app: URL, profile: ProvisioningProfile?, deep: Bool = true,
                             now: Date = Date()) -> Report {
        var report = Report()
        let fm = FileManager.default
        let basePath = app.standardizedFileURL.path

        func relative(_ url: URL) -> String {
            let p = url.standardizedFileURL.path
            return p.hasPrefix(basePath + "/") ? String(p.dropFirst(basePath.count + 1)) : url.lastPathComponent
        }

        var binaries = [URL](), bundles = [app], resourceFiles = [URL]()
        if let walker = fm.enumerator(at: app, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
                                      options: []) {
            for case let url as URL in walker {
                let vals = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                if vals?.isSymbolicLink == true { continue }
                if ["app", "appex"].contains(url.pathExtension), url != app { bundles.append(url) }
                if url.lastPathComponent.hasSuffix(".dSYM") { continue }
                if url.lastPathComponent == "CodeResources", url.deletingLastPathComponent().lastPathComponent == "_CodeSignature" {
                    resourceFiles.append(url)
                }
                guard vals?.isRegularFile == true, MachOFile.isSignable(url: url) else { continue }
                binaries.append(url)
            }
        }

        // 1. Every program file: runnable, signed, and the signature holds together.
        var leafFound: Certificate?
        for url in binaries {
            report.binariesChecked += 1
            let name = relative(url)
            if let mode = (try? fm.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue,
               mode & 0o100 == 0 {
                report.problems.append(.init(kind: .permission, file: name,
                    message: "is not marked as runnable, so iOS refuses the whole app"))
            }
            let found = checkBinary(url, name: name, deep: deep, now: now, report: &report)
            if leafFound == nil { leafFound = found }
        }

        // 2. The list of resources must match the files on disk.
        for cr in resourceFiles {
            let bundle = cr.deletingLastPathComponent().deletingLastPathComponent()
            checkResources(listFile: cr, bundle: bundle, name: relative(bundle), deep: deep, report: &report)
        }

        // 3. Every app and extension needs a profile that covers it.
        if let profile {
            let hostID = (try? PropertyListSerialization.propertyList(
                from: Data(contentsOf: app.appendingPathComponent("Info.plist")), format: nil) as? [String: Any])?
                .flatMap { $0["CFBundleIdentifier"] as? String }
            for bundle in bundles {
                let isApp = bundle == app
                checkProfile(profile, bundle: bundle, name: isApp ? "the app" : relative(bundle),
                             leaf: leafFound, now: now, hostAppID: isApp ? nil : hostID, report: &report)
            }
        }
        return report
    }

    // MARK: - one program file

    @discardableResult
    static func checkBinary(_ url: URL, name: String, deep: Bool, now: Date, report: inout Report) -> Certificate? {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe),
              let file = try? MachOFile(data: data) else {
            report.problems.append(.init(kind: .structure, file: name, message: "could not be read"))
            return nil
        }
        var leaf: Certificate?
        for slice in file.slices {
            let who = file.slices.count > 1 ? "\(name) (\(slice.archName))" : name
            guard let lc = slice.codeSignatureCommand, let sig = slice.existingSignature else {
                report.problems.append(.init(kind: .structure, file: who, message: "has no signature"))
                continue
            }
            let dataOff = Int(slice.data.u32le(lc.offset + 8)), dataSize = Int(slice.data.u32le(lc.offset + 12))
            if dataOff + dataSize != slice.data.count {
                report.problems.append(.init(kind: .structure, file: who,
                    message: "the signature does not end where the file ends"))
            }
            if dataOff % 16 != 0 {
                report.problems.append(.init(kind: .structure, file: who, message: "the signature is not aligned"))
            }
            guard let blobs = parseBlobs(sig), let primary = blobs[CSSlot.codeDirectory] else {
                report.problems.append(.init(kind: .structure, file: who, message: "the signature cannot be read"))
                continue
            }
            // Apple's older signatures carry a second, SHA-256 directory next to a SHA-1 one.
            var directories = [primary]
            for n in 0..<5 { if let extra = blobs[CSSlot.alternateCodeDirectory + UInt32(n)] { directories.append(extra) } }
            for cd in directories {
                checkCodeDirectory(cd, blobs: blobs, slice: slice, dataOff: dataOff,
                                   url: url, who: who, deep: deep, report: &report)
            }
            // And the certificate envelope, once, covering all of them.
            let cms = blobs[CSSlot.signatureSlot].map { $0.sub(8, $0.count - 8) } ?? Data()
            let adhoc = primary.u32be(12) & CSFlags.adhoc != 0
            if adhoc || cms.isEmpty {
                if !adhoc { report.problems.append(.init(kind: .certificate, file: who, message: "is not signed with a certificate")) }
            } else if let l = checkCMS(cms, directories: directories, teamInCD: teamIdentifier(primary),
                                       who: who, now: now, report: &report) {
                leaf = leaf ?? l
            }
        }
        return leaf
    }

    static func parseBlobs(_ sig: Data) -> [UInt32: Data]? {
        guard sig.count >= 12, sig.u32be(0) == BlobMagic.embeddedSignature else { return nil }
        let length = Int(sig.u32be(4)), count = Int(sig.u32be(8))
        guard length <= sig.count, count < 32 else { return nil }
        var out = [UInt32: Data]()
        for i in 0..<count {
            let slot = sig.u32be(12 + 8 * i), off = Int(sig.u32be(16 + 8 * i))
            guard off + 8 <= sig.count else { return nil }
            let len = Int(sig.u32be(off + 4))
            guard len >= 8, off + len <= sig.count else { return nil }
            out[slot] = sig.sub(off, len)
        }
        return out
    }

    static func checkCodeDirectory(_ cd: Data, blobs: [UInt32: Data], slice: MachOSlice, dataOff: Int,
                                   url: URL, who: String, deep: Bool, report: inout Report) {
        func bad(_ kind: Problem.Kind, _ message: String) {
            report.problems.append(.init(kind: kind, file: who, message: message))
        }
        guard cd.u32be(0) == BlobMagic.codeDirectory, cd.count >= 52 else {
            bad(.structure, "the code directory is damaged"); return
        }
        let flags = cd.u32be(12)
        let hashOffset = Int(cd.u32be(16)), identOffset = Int(cd.u32be(20))
        let nSpecial = Int(cd.u32be(24)), nCode = Int(cd.u32be(28)), codeLimit = Int(cd.u32be(32))
        let hashSize = Int(cd.u8(36)), hashType = cd.u8(37), pageShift = Int(cd.u8(39))
        let kind: HashKind = hashType == 1 ? .sha1 : .sha256
        guard (hashType == 1 && hashSize == 20) || (hashType == 2 && hashSize == 32), pageShift >= 12, pageShift <= 16 else {
            bad(.structure, "the code directory uses a hash iOS does not accept"); return
        }
        let pageSize = 1 << pageShift
        let adhoc = flags & CSFlags.adhoc != 0
        if codeLimit != dataOff { bad(.hash, "the signature covers \(codeLimit) bytes but starts at \(dataOff)") }
        if nCode != (codeLimit + pageSize - 1) / pageSize { bad(.hash, "the number of page hashes is wrong") }
        guard hashOffset + nCode * hashSize <= cd.count, identOffset < cd.count,
              hashOffset >= nSpecial * hashSize else { bad(.structure, "the code directory is truncated"); return }

        // Page hashes: each 4 KB (or 16 KB) of the program must hash to what the signature says.
        if deep, codeLimit <= slice.data.count {
            var wrong = 0
            let lock = NSLock()
            slice.data.withUnsafeBytes { raw in
                guard let base = raw.baseAddress else { return }
                DispatchQueue.concurrentPerform(iterations: nCode) { i in
                    let start = i * pageSize, count = min(pageSize, codeLimit - start)
                    var h = Hasher(kind)
                    h.update(UnsafeRawBufferPointer(start: base + start, count: count))
                    if h.finish() != cd.sub(hashOffset + i * hashSize, hashSize) {
                        lock.lock(); wrong += 1; lock.unlock()
                    }
                }
            }
            if wrong > 0 { bad(.hash, "\(wrong) pages of the program do not match their recorded hashes") }
        }

        // Special slots: the hashes of the other blobs, and of Info.plist and the resource list.
        func special(_ n: Int) -> Data {
            n <= nSpecial ? cd.sub(hashOffset - n * hashSize, hashSize) : Data(count: hashSize)
        }
        func expect(_ n: Int, _ blob: Data?, _ what: String) {
            let have = special(n), want = blob.map { Hasher.hash(kind, $0) } ?? Data(count: hashSize)
            if have != want { bad(.hash, "the recorded hash of the \(what) does not match it") }
        }
        expect(Int(CSSlot.requirements), blobs[CSSlot.requirements], "rules block")
        expect(Int(CSSlot.entitlements), blobs[CSSlot.entitlements], "permissions block")
        expect(Int(CSSlot.derEntitlements), blobs[CSSlot.derEntitlements], "permissions block (DER copy)")

        let dir = url.deletingLastPathComponent()
        let infoURL = dir.appendingPathComponent("Info.plist")
        let resourcesURL = dir.appendingPathComponent("_CodeSignature/CodeResources")
        if let info = try? Data(contentsOf: infoURL), isBundleExecutable(url, info: info) {
            if special(Int(CSSlot.infoPlist)) != Hasher.hash(kind, info) {
                bad(.hash, "the recorded hash of Info.plist does not match the file")
            }
            if let res = try? Data(contentsOf: resourcesURL),
               special(Int(CSSlot.resourceDir)) != Hasher.hash(kind, res) {
                bad(.hash, "the recorded hash of the resource list does not match the file")
            }
        }

        // The permissions: XML and DER copies must exist together and say the same thing.
        var xmlEnts: [String: E]?
        if let x = blobs[CSSlot.entitlements] {
            if x.u32be(0) != BlobMagic.entitlements { bad(.entitlements, "the permissions block has the wrong label") }
            if let plist = try? PropertyListSerialization.propertyList(from: x.sub(8, x.count - 8), format: nil) as? [String: Any] {
                xmlEnts = plist.mapValues { E.from($0) }
            } else { bad(.entitlements, "the permissions block cannot be read") }
        }
        if let d = blobs[CSSlot.derEntitlements] {
            if d.u32be(0) != BlobMagic.derEntitlements { bad(.entitlements, "the DER permissions block has the wrong label") }
            switch decodeDER(d.sub(8, d.count - 8)) {
            case .failure(let why):
                bad(.entitlements, "the DER permissions block is not in Apple's format (\(why))")
            case .success(let derEnts):
                if let xmlEnts, xmlEnts != derEnts {
                    bad(.entitlements, "the two copies of the permissions disagree")
                }
                if xmlEnts == nil { bad(.entitlements, "has the DER permissions but no XML copy") }
            }
        } else if xmlEnts != nil, !(xmlEnts?.isEmpty ?? true) {
            bad(.entitlements, "has permissions in XML but not the DER copy that iOS 15 and later read")
        }
        if blobs[CSSlot.requirements] == nil { bad(.structure, "has no rules block") }

    }

    static func teamIdentifier(_ cd: Data) -> String? {
        let off = Int(cd.u32be(48))
        guard off > 0, off < cd.count else { return nil }
        return cString(cd.sub(off, cd.count - off))
    }

    static func isBundleExecutable(_ url: URL, info: Data) -> Bool {
        guard let plist = try? PropertyListSerialization.propertyList(from: info, format: nil) as? [String: Any],
              let exec = plist["CFBundleExecutable"] as? String else { return false }
        return exec == url.lastPathComponent
    }

    // MARK: - the certificate envelope

    static func hashKind(ofDirectory cd: Data) -> HashKind { cd.u8(37) == 1 ? .sha1 : .sha256 }

    static func checkCMS(_ cms: Data, directories: [Data], teamInCD: String?, who: String,
                         now: Date, report: inout Report) -> Certificate? {
        func bad(_ k: Problem.Kind, _ m: String) { report.problems.append(.init(kind: k, file: who, message: m)) }
        guard let top = try? DERNode.parse(cms), let signedData = top.child(1)?.child(0),
              let certSet = signedData.children.first(where: { $0.tag == 0xa0 }),
              let signerInfo = signedData.children.last?.child(0) else {
            bad(.certificate, "the signature envelope cannot be read"); return nil
        }
        let certs = certSet.children.compactMap { try? Certificate(der: $0.raw) }
        let parts = signerInfo.children
        guard parts.count >= 6, let sid = parts[safe: 1], let issuerDER = sid.child(0)?.raw,
              let serial = sid.child(1)?.unsignedInteger,
              let leaf = certs.first(where: { $0.issuerDER == issuerDER && $0.serial == serial }) else {
            bad(.certificate, "your certificate is not inside the signature"); return nil
        }
        guard let attrsNode = parts.first(where: { $0.tag == 0xa0 }),
              let signature = parts.last?.content else {
            bad(.certificate, "the signature has no signed attributes"); return nil
        }

        // The message digest is the hash (in the envelope's own algorithm) of the first directory.
        var seen = [String: DERNode]()
        for attr in attrsNode.children { if let oid = attr.child(0)?.oid, let v = attr.child(1) { seen[oid] = v } }
        let cmsKind: HashKind = parts[2].child(0)?.oid == OID.sha1 ? .sha1 : .sha256
        if seen[OID.messageDigest]?.child(0)?.content != Hasher.hash(cmsKind, directories[0]) {
            bad(.certificate, "the signature was made over a different code directory")
        }
        if seen[OID.contentType] == nil || seen[OID.signingTime] == nil {
            bad(.certificate, "the signature is missing a required attribute")
        }
        // Apple's two attributes must name every directory: full hash in one, short hash in the other.
        let listed = seen[OID.appleCDHashes]?.children ?? []
        let shortHashes = (seen[OID.appleCDHashesPlist]?.child(0)?.content)
            .flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any] }
            .flatMap { $0["cdhashes"] as? [Data] }
        if listed.isEmpty { bad(.certificate, "Apple's code-directory hash attribute is missing") }
        if shortHashes == nil { bad(.certificate, "Apple's short-hash attribute is missing") }
        for cd in directories {
            let kind = hashKind(ofDirectory: cd), full = Hasher.hash(kind, cd)
            let oid = kind == .sha1 ? OID.sha1 : OID.sha256
            if !listed.isEmpty, !listed.contains(where: { $0.child(0)?.oid == oid && $0.child(1)?.content == full }) {
                bad(.certificate, "Apple's code-directory hash attribute does not list one of the directories")
            }
            if let short = shortHashes, !short.contains(full.prefix(20)) {
                bad(.certificate, "Apple's short-hash attribute does not list one of the directories")
            }
        }

        // The signature itself, checked with your certificate's public key.
        let signedBytes = DER.tlv(0x31, attrsNode.content)
        if (try? RSAPrivateKey.publicModulus(spki: leaf.publicKeyDER)) != nil {
            if !RSAPrivateKey.verify(signature: signature, message: signedBytes, cmsKind, spki: leaf.publicKeyDER) {
                bad(.certificate, "the signature does not verify against your certificate")
            }
        }

        // The chain: every step must be present in the signature, ending at a root.
        var current = leaf, reached = leaf.isSelfIssued
        for _ in 0..<4 where !reached {
            guard let parent = AppleChain.issuer(of: current, in: certs) else { break }
            current = parent
            reached = parent.isSelfIssued
        }
        if !reached {
            bad(.certificate, "the signature does not carry Apple's certificates that link yours back to Apple")
        }
        if let n = leaf.notAfter, n < now { bad(.expired, "your certificate ran out on \(n.formatted(date: .abbreviated, time: .omitted))") }
        if let t = teamInCD, let ou = leaf.teamID, t != ou {
            bad(.certificate, "the team in the signature (\(t)) is not the team of your certificate (\(ou))")
        }
        return leaf
    }

    // MARK: - permissions, comparable form

    indirect enum E: Equatable {
        case bool(Bool), int(Int64), string(String), array([E]), dict([String: E]), other

        static func from(_ v: Any) -> E {
            switch v {
            case let n as NSNumber:
                let t = String(cString: n.objCType)
                return (t == "c" || t == "B") ? .bool(n.boolValue) : .int(n.int64Value)
            case let b as Bool: return .bool(b)
            case let s as String: return .string(s)
            case let a as [Any]: return .array(a.map(from))
            case let d as [String: Any]: return .dict(d.mapValues(from))
            default: return .other
            }
        }
    }

    /// Reads the DER permissions strictly, in Apple's version-1 layout.
    static func decodeDER(_ bytes: Data) -> Result<[String: E], DecodeError> {
        guard let top = try? DERNode.parse(bytes), top.tag == 0x70 else { return .failure(.init("outer tag is not 0x70")) }
        let parts = top.children
        guard parts.count == 2, parts[0].tag == 0x02, parts[0].intValue == 1 else { return .failure(.init("missing version 1")) }
        guard parts[1].tag == 0xb0 else { return .failure(.init("dictionary tag is not 0xB0")) }
        return dictionary(parts[1])
    }

    struct DecodeError: Error, CustomStringConvertible {
        let description: String
        init(_ d: String) { description = d }
    }

    static func dictionary(_ node: DERNode) -> Result<[String: E], DecodeError> {
        var out = [String: E](), last: [UInt8]?
        for entry in node.children {
            guard entry.tag == 0x30, entry.children.count == 2, entry.children[0].tag == 0x0c,
                  let key = entry.children[0].string else { return .failure(.init("an entry is not key and value")) }
            let raw = Array(key.utf8)
            if let l = last, !l.lexicographicallyPrecedes(raw) { return .failure(.init("keys are not sorted")) }
            last = raw
            switch value(entry.children[1]) {
            case .success(let v): out[key] = v
            case .failure(let e): return .failure(e)
            }
        }
        return .success(out)
    }

    static func value(_ n: DERNode) -> Result<E, DecodeError> {
        switch n.tag {
        case 0x01: return .success(.bool(n.content.first == 0xff))
        case 0x02:
            var v: Int64 = n.content.first.map { $0 & 0x80 != 0 ? -1 : 0 } ?? 0
            for b in n.content { v = v << 8 | Int64(b) }
            return .success(.int(v))
        case 0x0c: return .success(.string(n.string ?? ""))
        case 0x30:
            var items = [E]()
            for c in n.children {
                switch value(c) { case .success(let v): items.append(v); case .failure(let e): return .failure(e) }
            }
            return .success(.array(items))
        case 0xb0:
            switch dictionary(n) { case .success(let d): return .success(.dict(d)); case .failure(let e): return .failure(e) }
        default: return .failure(.init("unknown value tag \(n.tag)"))
        }
    }

    // MARK: - the resource list

    static func checkResources(listFile: URL, bundle: URL, name: String, deep: Bool, report: inout Report) {
        func bad(_ m: String) { report.problems.append(.init(kind: .resources, file: name, message: m)) }
        guard let data = try? Data(contentsOf: listFile),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let files2 = plist["files2"] as? [String: Any] else {
            bad("the resource list cannot be read"); return
        }
        let fm = FileManager.default
        report.filesChecked += files2.count
        var listed = Set(files2.keys)
        for (path, raw) in files2 {
            guard let entry = raw as? [String: Any] else { continue }
            let url = bundle.appendingPathComponent(path)
            let optional = entry["optional"] as? Bool ?? false
            if let target = entry["symlink"] as? String {
                if (try? fm.destinationOfSymbolicLink(atPath: url.path)) != target && !optional {
                    bad("\(path) is not the link the list says")
                }
                continue
            }
            guard fm.fileExists(atPath: url.path) else {
                if !optional { bad("\(path) is listed but missing") }
                continue
            }
            if deep, let want = entry["hash2"] as? Data {
                guard let (_, h2) = try? CodeResources.hashesOfFile(url) else { bad("\(path) cannot be read"); continue }
                if h2 != want { bad("\(path) changed after the list was made") }
            }
        }
        // Anything in the bundle that the list does not mention would fail at install.
        if let walker = fm.enumerator(at: bundle, includingPropertiesForKeys: [.isRegularFileKey], options: []) {
            let skipped: Set<String> = ["Info.plist", "PkgInfo"]
            for case let url as URL in walker {
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                let rel = String(url.standardizedFileURL.path.dropFirst(bundle.standardizedFileURL.path.count + 1))
                if listed.contains(rel) || skipped.contains(rel) || rel.hasPrefix("_CodeSignature/") { continue }
                if rel.hasSuffix(".DS_Store") || rel.hasSuffix("locversion.plist") { continue }
                if rel == mainExecutable(of: bundle) { continue }
                bad("\(rel) is in the app but not in the resource list")
                listed.insert(rel)
            }
        }
    }

    static func mainExecutable(of bundle: URL) -> String? {
        guard let d = try? Data(contentsOf: bundle.appendingPathComponent("Info.plist")),
              let p = try? PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any] else { return nil }
        return p["CFBundleExecutable"] as? String
    }

    // MARK: - the profile

    /// - Parameter hostAppID: the surrounding app's bundle id when `bundle` is an extension
    ///   (nil for the app itself). An extension signed under a profile that allows only one app
    ///   ID shares the app's identifier, so both its own id and the app's count as allowed.
    static func checkProfile(_ profile: ProvisioningProfile, bundle: URL, name: String, leaf: Certificate?,
                             now: Date, hostAppID: String? = nil, report: inout Report) {
        func bad(_ k: Problem.Kind, _ m: String) { report.problems.append(.init(kind: k, file: name, message: m)) }
        let embedded = bundle.appendingPathComponent("embedded.mobileprovision")
        guard let data = try? Data(contentsOf: embedded), let inside = try? ProvisioningProfile(data: data) else {
            bad(.profile, "has no provisioning profile inside it"); return
        }
        if inside.uuid != profile.uuid { bad(.profile, "has a different profile inside than the one chosen") }
        if let e = inside.expiry, e < now { bad(.expired, "the profile ran out on \(e.formatted(date: .abbreviated, time: .omitted))") }
        if let leaf, !inside.matches(certificate: leaf) {
            bad(.profile, "the profile was not made for the certificate that signed this")
        }
        guard let info = try? PropertyListSerialization.propertyList(
                from: Data(contentsOf: bundle.appendingPathComponent("Info.plist")), format: nil) as? [String: Any],
              let bundleID = info["CFBundleIdentifier"] as? String else { return }
        // An extension that sits under the app's id and shares its identifier is allowed, even
        // though the profile never names the extension itself (BundleSigner explains why).
        let sharesTheApp = hostAppID.map { bundleID.hasPrefix($0 + ".") } ?? false
        if !inside.allows(bundleID: bundleID), !sharesTheApp {
            bad(.profile, "the app ID \(bundleID) is not allowed by the profile (it allows \(inside.bundleIDPattern ?? "?"))")
        }
        // What the program asks for must be something the profile grants.
        guard let exec = mainExecutable(of: bundle),
              let bin = try? Data(contentsOf: bundle.appendingPathComponent(exec), options: .mappedIfSafe),
              let slice = try? MachOFile(data: bin).slices.first,
              let sig = slice.existingSignature, let blobs = parseBlobs(sig),
              let xml = blobs[CSSlot.entitlements],
              let ents = try? PropertyListSerialization.propertyList(from: xml.sub(8, xml.count - 8), format: nil) as? [String: Any]
        else { return }
        let granted = inside.entitlements
        if let appID = ents["application-identifier"] as? String {
            let prefix = (inside.applicationIdentifier ?? "").split(separator: ".").first.map(String.init) ?? ""
            // Its own identifier, or the app's when it shares it.
            var allowed = ["\(prefix).\(bundleID)"]
            if let host = hostAppID { allowed.append("\(prefix).\(host)") }
            if !allowed.contains(appID) {
                bad(.entitlements, "the app identifier in the permissions (\(appID)) does not match "
                    + allowed.joined(separator: " or "))
            }
        } else { bad(.entitlements, "the permissions have no application-identifier") }
        if let t = ents["com.apple.developer.team-identifier"] as? String, t != inside.teamID {
            bad(.entitlements, "the team in the permissions (\(t)) is not the profile's team")
        }
        for key in ents.keys.sorted() where granted[key] == nil && key != "application-identifier" {
            bad(.entitlements, "asks for \(key), which the profile does not grant")
        }
    }
}

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
