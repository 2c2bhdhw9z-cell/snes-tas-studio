import SwiftUI
import SignKit

/// The files inside an app, before it is signed: look in folders, read a file, edit a `.plist`
/// or any text file, or mark something to be deleted. Sixth on docs/FEATURES.md (ESign and GBox
/// both do this).
///
/// Nothing is unpacked to make this work and nothing is written to the app itself. Edits are
/// held as "write this file instead" and handed to the engine when signing starts
/// (`SigningOptions.replaceFiles`), so the signature always matches what is really in there.
struct AppFilesView: View {
    let ipa: URL
    @Binding var replace: [String: Data]
    @Binding var remove: [String]

    @State private var entries: [AppContents.Entry]?
    @State private var problem: String?
    @State private var folder = ""
    @State private var editing: Opened?
    @State private var busy = false

    struct Opened: Identifiable {
        var id: String { path }
        let path: String
        let data: Data
        let kind: AppContents.Kind
    }

    var shown: [AppContents.Entry] {
        let all = entries ?? []
        let prefix = folder.isEmpty ? "" : folder + "/"
        return all.filter { entry in
            guard entry.path.hasPrefix(prefix) else { return false }
            let rest = String(entry.path.dropFirst(prefix.count))
            return !rest.isEmpty && !rest.contains("/")
        }
        .sorted {
            if $0.isFolder != $1.isFolder { return $0.isFolder }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    var body: some View {
        List {
            if let problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.red)
                }
            } else if entries == nil {
                Section {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Reading the app…").foregroundStyle(.secondary)
                    }
                }
            }

            if !folder.isEmpty {
                Button {
                    folder = folder.split(separator: "/").dropLast().joined(separator: "/")
                } label: {
                    Label(folder, systemImage: "arrow.up.left")
                        .font(.callout)
                }
            }

            if !replace.isEmpty || !remove.isEmpty {
                Section("Waiting for signing") {
                    ForEach(replace.keys.sorted(), id: \.self) { path in
                        HStack {
                            Label(path, systemImage: "pencil").font(.caption).lineLimit(1)
                            Spacer()
                            Button("Undo") { replace.removeValue(forKey: path) }
                                .font(.caption)
                        }
                    }
                    ForEach(remove, id: \.self) { path in
                        HStack {
                            Label(path, systemImage: "trash").font(.caption).lineLimit(1)
                                .foregroundStyle(.red)
                            Spacer()
                            Button("Keep it") { remove.removeAll { $0 == path } }
                                .font(.caption)
                        }
                    }
                }
            }

            Section {
                ForEach(shown) { entry in
                    row(entry)
                }
            } header: {
                Text(folder.isEmpty ? "The app" : folder)
            }
        }
        .navigationTitle("Files inside")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $editing) { opened in
            switch opened.kind {
            case .plist:
                PlistEditorView(path: opened.path, original: opened.data) { data in
                    replace[opened.path] = data
                }
            case .text, .other:
                TextFileEditorView(path: opened.path, original: opened.data) { data in
                    replace[opened.path] = data
                }
            }
        }
    }

    @ViewBuilder
    func row(_ entry: AppContents.Entry) -> some View {
        if entry.isFolder {
            Button {
                folder = entry.path
            } label: {
                HStack {
                    Label(entry.name, systemImage: "folder.fill")
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
            }
        } else {
            HStack(spacing: 10) {
                Image(systemName: icon(for: entry.path))
                    .foregroundStyle(.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.name).font(.callout).lineLimit(1)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(entry.bytes), countStyle: .file))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if replace[entry.path] != nil {
                    Text("edited").font(.caption2).foregroundStyle(.tint)
                }
                if remove.contains(entry.path) {
                    Text("deleting").font(.caption2).foregroundStyle(.red)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { open(entry) }
            .contextMenu {
                Button {
                    open(entry)
                } label: {
                    Label("Open", systemImage: "square.and.pencil")
                }
                if remove.contains(entry.path) {
                    Button {
                        remove.removeAll { $0 == entry.path }
                    } label: {
                        Label("Keep it", systemImage: "arrow.uturn.backward")
                    }
                } else {
                    Button(role: .destructive) {
                        remove.append(entry.path)
                    } label: {
                        Label("Delete when signing", systemImage: "trash")
                    }
                }
            }
        }
    }

    func icon(for path: String) -> String {
        let lower = path.lowercased()
        if lower.hasSuffix(".plist") || lower.hasSuffix(".strings") { return "doc.badge.gearshape" }
        if lower.hasSuffix(".png") || lower.hasSuffix(".jpg") || lower.hasSuffix(".car") { return "photo" }
        if lower.hasSuffix(".dylib") || lower.hasSuffix(".framework") { return "shippingbox" }
        if lower.hasSuffix(".nib") || lower.hasSuffix(".storyboardc") { return "rectangle.on.rectangle" }
        return "doc"
    }

    func open(_ entry: AppContents.Entry) {
        guard !busy else { return }
        busy = true
        let url = ipa
        let path = entry.path
        Task { @MainActor in
            defer { busy = false }
            let outcome: (Data?, String?) = await Task.detached(priority: .userInitiated) {
                do {
                    // 4 MB: a plist or a text file is tiny; anything bigger is not for editing.
                    return (try AppContents.read(inIPA: url, path: path, limit: 4 << 20), nil)
                } catch let error as SignKitError {
                    return (nil, error.description)
                } catch {
                    return (nil, error.localizedDescription)
                }
            }.value
            if let data = outcome.0 {
                // Something already edited opens as it was left, not as it is in the app.
                let current = replace[path] ?? data
                editing = Opened(path: path, data: current,
                                 kind: AppContents.kind(of: path, firstBytes: current))
            } else {
                problem = outcome.1
            }
        }
    }

    func load() async {
        guard entries == nil else { return }
        let url = ipa
        let outcome: ([AppContents.Entry], String?) = await Task.detached(priority: .userInitiated) {
            do {
                return (try AppContents.files(inIPA: url), nil)
            } catch let error as SignKitError {
                return ([], error.description)
            } catch {
                return ([], error.localizedDescription)
            }
        }.value
        if let message = outcome.1 {
            problem = message
        } else {
            entries = outcome.0
        }
    }
}

/// Editing a `.plist`: the settings file inside an app. Works for both shapes Apple uses, the
/// readable one and the packed one, and saves in the packed one, which every iPhone reads.
struct PlistEditorView: View {
    @Environment(\.dismiss) var dismiss
    let path: String
    let original: Data
    let save: (Data) -> Void

    @State private var rows: [Row] = []
    /// Anything that is a list or a group of its own is kept exactly as it was.
    @State private var untouched: [String: Any] = [:]
    @State private var problem: String?
    @State private var newKey = ""
    @State private var asText = false
    @State private var text = ""

    struct Row: Identifiable {
        enum Value {
            case words(String)
            case yesNo(Bool)
            case number(String)
        }
        let id = UUID()
        var key: String
        var value: Value
    }

    var body: some View {
        NavigationStack {
            Form {
                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
                if asText {
                    Section("All of it") {
                        TextEditor(text: $text)
                            .font(.footnote.monospaced())
                            .frame(minHeight: 320)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }
                } else {
                    Section("Settings") {
                        ForEach($rows) { $row in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.key).font(.caption).foregroundStyle(.secondary)
                                switch row.value {
                                case .words:
                                    TextField("", text: Binding(
                                        get: { if case .words(let s) = row.value { return s } else { return "" } },
                                        set: { row.value = .words($0) }))
                                        .autocorrectionDisabled()
                                        .textInputAutocapitalization(.never)
                                case .yesNo:
                                    Toggle("On", isOn: Binding(
                                        get: { if case .yesNo(let b) = row.value { return b } else { return false } },
                                        set: { row.value = .yesNo($0) }))
                                case .number:
                                    TextField("", text: Binding(
                                        get: { if case .number(let s) = row.value { return s } else { return "" } },
                                        set: { row.value = .number($0) }))
                                        .keyboardType(.numbersAndPunctuation)
                                }
                            }
                        }
                        .onDelete { indexes in
                            indexes.sorted(by: >).forEach { rows.remove(at: $0) }
                        }
                    }
                    if !untouched.isEmpty {
                        Section("Kept as they are") {
                            ForEach(untouched.keys.sorted(), id: \.self) { key in
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(key).font(.caption)
                                    Text(describe(untouched[key]))
                                        .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                            Text("Lists and groups are left exactly as they were; only the simple "
                                 + "settings above can be typed over here.")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Section("Add a setting") {
                        TextField("Its name", text: $newKey)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        Button("Add it as words") {
                            guard !newKey.isEmpty else { return }
                            rows.append(Row(key: newKey, value: .words("")))
                            newKey = ""
                        }
                        Button("Add it as on or off") {
                            guard !newKey.isEmpty else { return }
                            rows.append(Row(key: newKey, value: .yesNo(true)))
                            newKey = ""
                        }
                    }
                }
            }
            .navigationTitle((path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") { commit() }
                }
            }
            .onAppear(perform: load)
        }
    }

    func load() {
        guard rows.isEmpty, untouched.isEmpty else { return }
        guard let object = try? PropertyListSerialization.propertyList(from: original, format: nil),
              let dict = object as? [String: Any] else {
            // Not a settings file we can take apart: fall back to showing the words.
            asText = true
            text = String(data: original, encoding: .utf8) ?? ""
            if text.isEmpty { problem = "This file is not words or settings, so it cannot be edited here." }
            return
        }
        var simple: [Row] = []
        var rest: [String: Any] = [:]
        for key in dict.keys.sorted() {
            guard let value = dict[key] else { continue }
            // On or off has to be told apart from the number 1, which looks the same in Swift.
            if let number = value as? NSNumber,
               CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() {
                simple.append(Row(key: key, value: .yesNo(number.boolValue)))
            } else if let s = value as? String {
                simple.append(Row(key: key, value: .words(s)))
            } else if let n = value as? NSNumber {
                simple.append(Row(key: key, value: .number(n.stringValue)))
            } else {
                rest[key] = value
            }
        }
        rows = simple
        untouched = rest
    }

    func commit() {
        if asText {
            save(Data(text.utf8))
            dismiss()
            return
        }
        var dict = untouched
        for row in rows {
            switch row.value {
            case .words(let s): dict[row.key] = s
            case .yesNo(let b): dict[row.key] = b
            case .number(let s):
                if let i = Int(s) { dict[row.key] = i }
                else if let d = Double(s) { dict[row.key] = d }
                else { dict[row.key] = s }
            }
        }
        guard let data = try? PropertyListSerialization.data(fromPropertyList: dict,
                                                             format: .binary, options: 0) else {
            problem = "Those settings could not be written back. Check the numbers."
            return
        }
        save(data)
        dismiss()
    }

    func describe(_ value: Any?) -> String {
        switch value {
        case let list as [Any]: return "\(list.count) item" + (list.count == 1 ? "" : "s")
        case let group as [String: Any]: return group.keys.sorted().joined(separator: ", ")
        case let data as Data: return "\(data.count) bytes"
        case let date as Date: return date.formatted()
        default: return "kept"
        }
    }
}

/// Editing any file that is words: JSON, text, a list of strings.
struct TextFileEditorView: View {
    @Environment(\.dismiss) var dismiss
    let path: String
    let original: Data
    let save: (Data) -> Void

    @State private var text = ""
    @State private var readable = true

    var body: some View {
        NavigationStack {
            Group {
                if readable {
                    TextEditor(text: $text)
                        .font(.footnote.monospaced())
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .padding(.horizontal, 4)
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "doc.questionmark").font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("This file is not words").font(.headline)
                        Text("\(ByteCountFormatter.string(fromByteCount: Int64(original.count), countStyle: .file)) "
                             + "of something else — a picture, a program, or Apple's packed form. "
                             + "Use Delete when signing if you want it gone.")
                            .font(.callout).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center).padding(.horizontal, 24)
                    }
                }
            }
            .navigationTitle((path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        save(Data(text.utf8))
                        dismiss()
                    }
                    .disabled(!readable)
                }
            }
            .onAppear {
                if let words = String(data: original, encoding: .utf8) {
                    text = words
                } else {
                    readable = false
                }
            }
        }
    }
}
