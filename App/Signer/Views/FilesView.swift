import SwiftUI
import UniformTypeIdentifiers
import SignKit

/// The File list: everything sitting in Signer's own folder, with search.
/// Tap a file and import it right there — no forms, no pickers.
///
/// Files get here from the iPhone Files app (Signer shows up as a folder there),
/// from Safari with "Open in Signer", or from the share sheet.
struct FilesView: View {
    @EnvironmentObject var store: Store
    @State private var directory: URL = Paths.files
    @State private var entries: [FileEntry] = []
    @State private var search = ""
    @State private var chosen: FileEntry?
    @State private var askingPassword: FileEntry?
    @State private var password = ""
    @State private var viewing: FileEntry?
    @State private var hexing: FileEntry?
    @State private var banner: String?
    @State private var bannerIsError = false
    @State private var showSystemPicker = false

    var shown: [FileEntry] {
        guard !search.isEmpty else { return entries }
        return entries.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack {
            List {
                if entries.isEmpty {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Nothing here yet").font(.headline)
                            Text("Put files in with the + button, or from the iPhone Files app: "
                                 + "On My iPhone → Signer. Certificates, profiles and apps all live here.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
                ForEach(shown) { entry in
                    Button {
                        if entry.isDirectory {
                            directory = entry.url
                            reload()
                        } else {
                            chosen = entry
                        }
                    } label: {
                        FileRow(entry: entry)
                    }
                    .buttonStyle(.plain)
                }
                .onDelete { indexes in
                    for index in indexes {
                        try? FileManager.default.removeItem(at: shown[index].url)
                    }
                    reload()
                }
            }
            .listStyle(.plain)
            .searchable(text: $search, prompt: "Search")
            .navigationTitle(directory == Paths.files ? "File List" : directory.lastPathComponent)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if directory != Paths.files {
                        Button {
                            directory = directory.deletingLastPathComponent()
                            reload()
                        } label: {
                            Label("Up", systemImage: "arrow.up.left")
                        }
                    }
                    Button { showSystemPicker = true } label: { Label("Add", systemImage: "plus") }
                }
            }
            .refreshable { reload() }
            .onAppear { reload() }
            .overlay(alignment: .bottom) {
                if let banner {
                    Text(banner)
                        .font(.callout)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .foregroundStyle(bannerIsError ? .red : .primary)
                        .padding(.bottom, 12)
                        .transition(.opacity)
                }
            }
            // Tapping a file: the same short menu ESign shows.
            .confirmationDialog(chosen?.name ?? "", isPresented: Binding(
                get: { chosen != nil }, set: { if !$0 { chosen = nil } }), titleVisibility: .visible) {
                if let entry = chosen {
                    switch entry.kind {
                    case .p12:
                        Button("Import Certificate Management") {
                            password = ""
                            askingPassword = entry
                        }
                    case .profile:
                        Button("Import") { importProfile(entry) }
                    case .ipa:
                        Button("Sign this app") { addToLibrary(entry, thenSign: true) }
                        Button("Add to My apps") { addToLibrary(entry, thenSign: false) }
                    case .other:
                        EmptyView()
                    }
                    Button("View") { viewing = entry }
                    Button("HEX Editor") { hexing = entry }
                    Button("Delete", role: .destructive) {
                        try? FileManager.default.removeItem(at: entry.url)
                        reload()
                    }
                    Button("Cancel", role: .cancel) {}
                }
            }
            .alert("Certificate Password", isPresented: Binding(
                get: { askingPassword != nil }, set: { if !$0 { askingPassword = nil } })) {
                SecureField("Please enter the certificate password", text: $password)
                Button("Cancel", role: .cancel) { askingPassword = nil }
                Button("OK") {
                    if let entry = askingPassword { importCertificate(entry, password: password) }
                    askingPassword = nil
                }
            } message: {
                Text("Leave it empty if the certificate has no password.")
            }
            .sheet(item: $viewing) { (entry: FileEntry) in
                FileViewer(entry: entry, hex: false)
            }
            .sheet(item: $hexing) { (entry: FileEntry) in
                FileViewer(entry: entry, hex: true)
            }
            // Everything can be picked — nothing greyed out — and each file goes
            // where it belongs on its own.
            .fileImporter(isPresented: $showSystemPicker, allowedContentTypes: [.item],
                          allowsMultipleSelection: true) { result in
                if case .success(let urls) = result {
                    var notes = [String]()
                    for url in urls {
                        do { notes.append(try Intake.take(url, password: nil)) }
                        catch { notes.append((error as? SignKitError)?.description ?? error.localizedDescription) }
                    }
                    reload()
                    if let first = notes.first { show(notes.count == 1 ? first : "\(notes.count) files added") }
                }
            }
        }
    }

    // MARK: - doing things

    func reload() {
        entries = FileEntry.list(in: directory)
    }

    func show(_ text: String, error: Bool = false) {
        banner = text
        bannerIsError = error
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if banner == text { banner = nil }
        }
    }

    func importCertificate(_ entry: FileEntry, password: String) {
        do {
            let cert = try store.importCertificate(p12: entry.url, password: password)
            store.selectedCertificateID = cert.id
            store.save()
            show("Imported successfully")
        } catch let e as SignKitError {
            show(e.description, error: true)
        } catch {
            show(error.localizedDescription, error: true)
        }
    }

    func importProfile(_ entry: FileEntry) {
        do {
            _ = try store.importProfile(entry.url)
            show("Imported successfully")
        } catch let e as SignKitError {
            show(e.description, error: true)
        } catch {
            show(error.localizedDescription, error: true)
        }
    }

    func addToLibrary(_ entry: FileEntry, thenSign: Bool) {
        do {
            let app = try SigningRunner.importIPA(entry.url)
            show(thenSign ? "Added — open the Sign tab" : "Added to My apps")
            if thenSign { NotificationCenter.default.post(name: .signThisApp, object: app.id) }
        } catch let e as SignKitError {
            show(e.description, error: true)
        } catch {
            show(error.localizedDescription, error: true)
        }
    }
}

extension Notification.Name {
    static let signThisApp = Notification.Name("signThisApp")
}

/// One row in the file list.
struct FileEntry: Identifiable, Hashable {
    enum Kind { case p12, profile, ipa, other }

    var id: String { url.path }
    let url: URL
    let isDirectory: Bool
    let bytes: Int
    let modified: Date?
    let childCount: Int

    var name: String { url.lastPathComponent }

    var kind: Kind {
        switch url.pathExtension.lowercased() {
        case "p12", "pfx": return .p12
        case "mobileprovision", "provisionprofile": return .profile
        case "ipa": return .ipa
        default: return .other
        }
    }

    var detail: String {
        if isDirectory { return "\(childCount) Item" + (childCount == 1 ? "" : "s") }
        let size = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
        guard let modified else { return size }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss"
        return "\(size)   \(f.string(from: modified))"
    }

    static func list(in directory: URL) -> [FileEntry] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(at: directory,
                                                      includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey,
                                                                                   .contentModificationDateKey],
                                                      options: [.skipsHiddenFiles]) else { return [] }
        let entries = names.map { url -> FileEntry in
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey,
                                                           .contentModificationDateKey])
            let isDir = values?.isDirectory ?? false
            let count = isDir
                ? ((try? fm.contentsOfDirectory(atPath: url.path))?.count ?? 0)
                : 0
            return FileEntry(url: url, isDirectory: isDir,
                             bytes: values?.fileSize ?? 0,
                             modified: values?.contentModificationDate,
                             childCount: count)
        }
        return entries.sorted {
            if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }
}

struct FileRow: View {
    let entry: FileEntry

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(entry.isDirectory ? Color.accentColor : Color.secondary)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name).font(.body)
                Text(entry.detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "info.circle").foregroundStyle(.tint)
        }
        .contentShape(Rectangle())
    }

    var icon: String {
        if entry.isDirectory { return "folder.fill" }
        switch entry.kind {
        case .p12: return "key.fill"
        case .profile: return "doc.badge.gearshape"
        case .ipa: return "app.gift"
        case .other: return "doc"
        }
    }
}

/// Looks inside a file: the useful details, the text, or the raw bytes.
struct FileViewer: View {
    @Environment(\.dismiss) var dismiss
    let entry: FileEntry
    let hex: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !hex, let summary = details {
                        Text(summary).font(.callout).textSelection(.enabled)
                    } else {
                        Text(body(of: entry.url))
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(entry.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
    }

    /// For a certificate or profile, show what is actually in it.
    var details: String? {
        switch entry.kind {
        case .profile:
            guard let p = try? ProvisioningProfile(url: entry.url) else { return nil }
            var lines = ["Profile: \(p.name ?? "-")"]
            if let team = p.teamName { lines.append("Team: \(team) (\(p.teamID ?? "-"))") }
            if let pattern = p.bundleIDPattern { lines.append("Apps allowed: \(pattern)") }
            lines.append(p.isEnterprise ? "Devices: any" : "Devices: \(p.devices.count)")
            if let e = p.expiry { lines.append("Ends: \(e.formatted(date: .abbreviated, time: .omitted))") }
            lines.append("Certificates inside: \(p.certificates.count)")
            for c in p.certificates { lines.append("  • \(c.commonName)") }
            if !p.entitlements.isEmpty {
                lines.append("")
                lines.append("Permissions: \(p.entitlements.keys.sorted().joined(separator: ", "))")
            }
            return lines.joined(separator: "\n")
        case .ipa:
            guard let info = try? IPAInfo.read(entry.url) else { return nil }
            var lines = ["App: \(info.name)", "ID: \(info.bundleID)",
                         "Version: \(info.version) (\(info.build))"]
            if let min = info.minimumOS { lines.append("Needs iOS: \(min)") }
            lines.append("Built for: \(info.architectures.joined(separator: ", "))")
            lines.append(info.isEncrypted ? "Locked by the App Store: yes" : "Locked by the App Store: no")
            if !info.linkedTweaks.isEmpty {
                lines.append("Add-ons inside: \(info.linkedTweaks.map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))")
            }
            return lines.joined(separator: "\n")
        case .p12:
            return "A certificate file. Tap Import on it to use it for signing.\n"
                + "Size: \(ByteCountFormatter.string(fromByteCount: Int64(entry.bytes), countStyle: .file))"
        case .other:
            return nil
        }
    }

    /// Text if it reads as text, otherwise a hex dump of the first part.
    func body(of url: URL) -> String {
        guard let data = try? Data(contentsOf: url) else { return "Could not read this file." }
        let slice = data.prefix(64 * 1024)
        if !hex, let text = String(data: slice, encoding: .utf8), !text.isEmpty {
            return text
        }
        var out = ""
        var offset = 0
        let bytes = [UInt8](slice)
        while offset < bytes.count {
            let row = bytes[offset..<min(offset + 16, bytes.count)]
            var hexPart = row.map { String(format: "%02x", $0) }.joined(separator: " ")
            while hexPart.count < 47 { hexPart += " " }
            let textPart = row.map { $0 >= 32 && $0 < 127 ? String(UnicodeScalar($0)) : "." }.joined()
            out += String(format: "%08x  ", offset) + hexPart + "  " + textPart + "\n"
            offset += 16
        }
        if data.count > slice.count {
            out += "\n… \(ByteCountFormatter.string(fromByteCount: Int64(data.count - slice.count), countStyle: .file)) more"
        }
        return out
    }
}
