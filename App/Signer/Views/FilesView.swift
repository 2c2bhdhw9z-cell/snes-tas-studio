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
    @State private var viewing: FileEntry?
    @State private var hexing: FileEntry?
    @State private var banner: String?
    @State private var bannerIsError = false
    // Choosing several files at once. Picking is kept by path rather than by position, so a
    // folder list that changes under it (a delete, a reload, the search box) never picks the
    // wrong file.
    @State private var selecting = false
    @State private var picked: Set<String> = []
    @State private var confirmingDelete = false

    var shown: [FileEntry] {
        guard !search.isEmpty else { return entries }
        return entries.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    /// The files that are picked right now, in the order they appear.
    var chosenFiles: [FileEntry] {
        shown.picked(picked)
    }

    var pickedFolders: Int {
        chosenFiles.filter(\.isDirectory).count
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
                        if selecting {
                            toggle(entry)
                        } else if entry.isDirectory {
                            directory = entry.url
                            reload()
                        } else {
                            chosen = entry
                        }
                    } label: {
                        HStack(spacing: 10) {
                            if selecting { SelectionCheck(isOn: picked.contains(entry.id)) }
                            FileRow(entry: entry)
                        }
                    }
                    .buttonStyle(.plain)
                }
                .onDelete { indexes in
                    // The swipe stays a one-row, no-questions delete; the bar is where the
                    // counts and the confirm live.
                    delete(shown.picked(Set(indexes.map { shown[$0].id })))
                }
            }
            .listStyle(.plain)
            .searchable(text: $search, prompt: "Search")
            .navigationTitle(directory == Paths.files ? "File List" : directory.lastPathComponent)
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if selecting {
                    SelectionBar(count: chosenFiles.count, unit: "file",
                                 allOn: !shown.isEmpty && shown.allSatisfy { picked.contains($0.id) },
                                 selectAll: selectAll, delete: { confirmDelete() })
                }
            }
            .alert(deleteTitle, isPresented: $confirmingDelete) {
                Button("Delete", role: .destructive) { delete(chosenFiles) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(deleteMessage)
            }
            .refreshable { reload() }
            .onAppear { reload() }
            .onReceive(NotificationCenter.default.publisher(for: .filesChanged)) { _ in reload() }
            .overlay(alignment: .bottom) { toast }
            // Tapping a file: the same short menu ESign shows.
            .confirmationDialog(chosen?.name ?? "", isPresented: Binding(
                get: { chosen != nil }, set: { if !$0 { chosen = nil } }), titleVisibility: .visible) {
                if let entry = chosen {
                    switch entry.kind {
                    case .p12:
                        Button("Import Certificate Management") {
                            ImportCoordinator.shared.password = ""
                            ImportCoordinator.shared.pendingCertificate = entry.url
                        }
                    case .profile:
                        Button("Import") { ImportCoordinator.shared.take([entry.url]) }
                    case .ipa:
                        Button("Sign this app") { addToLibrary(entry, thenSign: true) }
                        Button("Add to My apps") { addToLibrary(entry, thenSign: false) }
                    case .pairing:
                        Button("Use as the pairing file") { takePairingFile(entry) }
                    case .other:
                        EmptyView()
                    }
                    Button("View") { viewing = entry }
                    Button("HEX Editor") { hexing = entry }
                    Button("Delete", role: .destructive) {
                        delete([entry])
                    }
                    Button("Cancel", role: .cancel) {}
                }
            }
            .sheet(item: $viewing) { (entry: FileEntry) in
                FileViewer(entry: entry, hex: false)
            }
            .sheet(item: $hexing) { (entry: FileEntry) in
                FileViewer(entry: entry, hex: true)
            }
        }
    }

    // MARK: - choosing several

    /// The top bar. One `ToolbarItemGroup` returned directly: a `@ToolbarContentBuilder`
    /// property cannot hold bare `Button`s, only `ToolbarContent`.
    var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if directory != Paths.files && !selecting {
                Button {
                    directory = directory.deletingLastPathComponent()
                    reload()
                } label: {
                    Label("Up", systemImage: "arrow.up.left")
                }
            }
            if !entries.isEmpty {
                Button(selecting ? "Done" : "Select") {
                    if selecting {
                        stopSelecting()
                    } else {
                        selecting = true
                    }
                }
            }
            if !selecting {
                Button {
                    DocumentPicker.present { urls in
                        guard !urls.isEmpty else { return }
                        ImportCoordinator.shared.take(urls)
                    }
                } label: { Label("Add", systemImage: "plus") }
            }
        }
    }

    @ViewBuilder
    var toast: some View {
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

    func toggle(_ entry: FileEntry) {
        if picked.contains(entry.id) { picked.remove(entry.id) } else { picked.insert(entry.id) }
    }

    func stopSelecting() {
        selecting = false
        picked = []
    }

    /// Picks every row on screen. Folders are included: a folder is one thing on this list, and
    /// deleting it takes what is inside with it, which the confirm says out loud.
    func selectAll() {
        if !shown.isEmpty, shown.allSatisfy({ picked.contains($0.id) }) {
            picked = []
            return
        }
        picked = Set(shown.map(\.id))
    }

    var deleteTitle: String {
        if chosenFiles.isEmpty { return "Delete?" }
        if chosenFiles.count == 1 {
            return "Delete \(chosenFiles[0].name)?"
        }
        return "Delete \(chosenFiles.count) items?"
    }

    var deleteMessage: String {
        let files = chosenFiles.count - pickedFolders
        var text: String
        if files == 1 && pickedFolders == 0 {
            text = "The file is gone from this phone, and from the Files app, for good."
        } else if pickedFolders == 0 {
            text = "These \(files) files are gone from this phone, and from the Files app, for good."
        } else if files > 0 {
            text = "\(files) file" + (files == 1 ? "" : "s")
                + " and \(pickedFolders) folder" + (pickedFolders == 1 ? "" : "s")
                + " are gone for good, along with everything inside the"
                + (pickedFolders == 1 ? " folder." : " folders.")
        } else {
            text = "The whole folder is gone for good, along with everything inside it."
        }
        if chosenFiles.contains(where: { $0.kind == .ipa }) {
            text += " Apps in My apps that point at these lose their entry too."
        }
        return text
    }

    func confirmDelete() {
        guard !chosenFiles.isEmpty else { return }
        confirmingDelete = true
    }

    /// Deletes the rows given, folders and everything inside them included. Anything the
    /// library points at loses its entry as well, so My apps never ends up listing an app
    /// whose file has gone.
    func delete(_ list: [FileEntry]) {
        let fm = FileManager.default
        var removed = 0
        for entry in list {
            let inside = fm.enumerator(at: entry.url, includingPropertiesForKeys: nil)?
                .allObjects as? [URL] ?? []
            let paths = Set([entry.url] + inside)
            // A library entry can point at a file inside a folder as well as at the folder.
            store.library.removeAll { paths.contains($0.fileURL.standardizedFileURL) }
            if (try? fm.removeItem(at: entry.url)) != nil { removed += 1 }
        }
        if removed > 0 {
            store.save()
            stopSelecting()
            show("Deleted \(removed) item" + (removed == 1 ? "" : "s"))
        }
        reload()
    }

    // MARK: - doing things

    /// Listing a folder means asking iOS about every file in it, and counting what is inside
    /// every folder in it. Off the main thread, so a folder with hundreds of files does not
    /// freeze the screen while it is read.
    func reload() {
        let folder = directory
        Task { @MainActor in
            let found = await Task.detached(priority: .userInitiated) {
                FileEntry.list(in: folder)
            }.value
            entries = found
            // A file deleted elsewhere (or by another app through the Files app) should not
            // stay picked and quietly fail later.
            picked.formIntersection(found.map(\.id))
        }
    }

    func show(_ text: String, error: Bool = false) {
        banner = text
        bannerIsError = error
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if banner == text { banner = nil }
        }
    }

    /// Keeps a pairing file for installing the way SideStore does (Settings, Pairing file).
    func takePairingFile(_ entry: FileEntry) {
        do {
            let data = try Data(contentsOf: entry.url)
            let pairing = try PairingFile(data: data)
            try FileManager.default.createDirectory(at: Paths.root, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: DeviceInstaller.pairingURL)
            try data.write(to: DeviceInstaller.pairingURL)
            UserDefaults.standard.set(entry.name, forKey: DeviceInstaller.fileKey)
            show(pairing.udid == nil ? "Pairing file kept" : "Pairing file kept for \(pairing.udid ?? "")")
        } catch let e as SignKitError {
            show(e.description, error: true)
        } catch {
            show(error.localizedDescription, error: true)
        }
    }

    func addToLibrary(_ entry: FileEntry, thenSign: Bool) {
        do {
            let app = try SigningRunner.importIPA(entry.url)
            show(thenSign ? "Opening it in My apps…" : "Added to My apps")
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
    static let filesChanged = Notification.Name("filesChanged")
}

/// One row in the file list.
struct FileEntry: Identifiable, Hashable {
    enum Kind { case p12, profile, ipa, pairing, other }

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
        // A pairing file: what a computer keeps after this phone has trusted it.
        case "plist", "mobiledevicepairing", "pairing": return .pairing
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
        case .pairing: return "iphone.and.arrow.forward"
        case .other: return "doc"
        }
    }
}

/// Looks inside a file: the useful details, the text, or the raw bytes.
///
/// Reading happens once, off the main thread. It used to happen inside `body`, which SwiftUI
/// runs again at will: opening a 4 GB app meant unpacking its Info.plist on the main thread
/// every redraw, and the hex view re-read 64 KB off disk each time.
struct FileViewer: View {
    @Environment(\.dismiss) var dismiss
    let entry: FileEntry
    let hex: Bool
    @State private var shown: Shown?

    struct Shown: Sendable {
        let text: String
        let monospaced: Bool
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let shown {
                        Text(shown.text)
                            .font(shown.monospaced ? .footnote.monospaced() : .callout)
                            .textSelection(.enabled)
                    } else {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Reading…").foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(entry.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
        .task {
            let url = entry.url
            let kind = entry.kind
            let bytes = entry.bytes
            let raw = hex
            let result = await Task.detached(priority: .userInitiated) { () -> Shown in
                if !raw, let summary = FileViewer.details(url: url, kind: kind, bytes: bytes) {
                    return Shown(text: summary, monospaced: false)
                }
                return Shown(text: FileViewer.body(of: url, hex: raw), monospaced: true)
            }.value
            await MainActor.run { shown = result }
        }
    }

    /// For a certificate or profile, show what is actually in it.
    ///
    /// Deliberately not tied to the main thread: a SwiftUI view's own members are, and this is
    /// called from a background job on purpose - unpacking a 4 GB app's settings file must not
    /// happen on the main thread.
    nonisolated static func details(url: URL, kind: FileEntry.Kind, bytes: Int) -> String? {
        switch kind {
        case .profile:
            guard let p = try? ProvisioningProfile(url: url) else { return nil }
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
            guard let info = try? IPAInfo.read(url) else { return nil }
            var lines = ["App: \(info.name)", "ID: \(info.bundleID)",
                         "Version: \(info.version) (\(info.build))"]
            if let min = info.minimumOS { lines.append("Needs iOS: \(min)") }
            lines.append("Built for: \(info.architectures.joined(separator: ", "))")
            lines.append(info.isEncrypted ? "Locked by the App Store: yes" : "Locked by the App Store: no")
            if !info.linkedTweaks.isEmpty {
                lines.append("Add-ons inside: \(info.linkedTweaks.map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))")
            }
            return lines.joined(separator: "\n")
        case .pairing:
            guard let pairing = try? PairingFile(data: try Data(contentsOf: url)) else {
                return "A settings file. If it is a pairing file, Signer could not read it."
            }
            return (["Pairing file"] + pairing.summary).joined(separator: "\n")
        case .p12:
            return "A certificate file. Tap Import on it to use it for signing.\n"
                + "Size: \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))"
        case .other:
            return nil
        }
    }

    /// Looks at no more than the first 64 KB — opening a two-gigabyte file must
    /// never pull the whole thing into memory.
    nonisolated static func body(of url: URL, hex: Bool) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "Could not read this file." }
        let slice = autoreleasepool { handle.readData(ofLength: 64 * 1024) }
        try? handle.close()
        let total = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? slice.count
        if !hex, let text = String(data: slice, encoding: .utf8), !text.isEmpty {
            return text + (total > slice.count ? "\n\n… \(ByteCountFormatter.string(fromByteCount: Int64(total - slice.count), countStyle: .file)) more" : "")
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
        if total > slice.count {
            out += "\n… \(ByteCountFormatter.string(fromByteCount: Int64(total - slice.count), countStyle: .file)) more"
        }
        return out
    }
}
