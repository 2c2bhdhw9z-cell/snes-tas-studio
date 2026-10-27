import SwiftUI
import UIKit
import SignKit

/// The classes inside one program, as headers - what people call classdump. Ninth on
/// docs/FEATURES.md (ABox has it).
///
/// Every class the program defines, what it inherits from, what it holds and every message it
/// answers. Reading is done off the main thread; the whole lot can be written to the File tab
/// as one `.h` file, or a single class copied.
struct HeadersView: View {
    let ipa: URL
    /// Path of the program inside the `.app`, for example "Feather" or
    /// "Frameworks/Thing.framework/Thing".
    let programPath: String
    let programName: String

    @State private var dump: ObjCDump.Dump?
    @State private var problem: String?
    @State private var search = ""
    @State private var banner: String?

    var classes: [ObjCDump.Class] {
        let all = (dump?.classes ?? []).sorted { $0.name < $1.name }
        guard !search.isEmpty else { return all }
        return all.filter {
            $0.name.localizedCaseInsensitiveContains(search)
                || ($0.swiftName ?? "").localizedCaseInsensitiveContains(search)
                || ($0.superName ?? "").localizedCaseInsensitiveContains(search)
        }
    }

    var protocols: [ObjCDump.ProtocolInfo] {
        let all = (dump?.protocols ?? []).sorted { $0.name < $1.name }
        guard !search.isEmpty else { return all }
        return all.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        List {
            if let problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.red)
                }
            } else if dump == nil {
                Section {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Reading the program…").foregroundStyle(.secondary)
                    }
                }
            } else if dump?.isEmpty == true {
                Section {
                    Text("No classes in this one. A program written entirely in Swift or C has "
                         + "nothing of this kind inside it.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }

            if let dump, !dump.isEmpty {
                Section {
                    Button {
                        writeHeaderFile(dump)
                    } label: {
                        Label("Save it all to the File tab", systemImage: "square.and.arrow.down")
                    }
                    Button {
                        UIPasteboard.general.string = dump.headers()
                        banner = "Copied"
                    } label: {
                        Label("Copy it all", systemImage: "doc.on.doc")
                    }
                } footer: {
                    Text("\(dump.classes.count) classes, \(dump.protocols.count) protocols.")
                }
            }

            if !classes.isEmpty {
                Section("Classes") {
                    ForEach(classes) { klass in
                        NavigationLink {
                            HeaderTextView(title: klass.name, text: klass.header)
                        } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(klass.swiftName ?? klass.name)
                                    .font(.callout).lineLimit(1)
                                Text(detail(klass))
                                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
            }

            if !protocols.isEmpty {
                Section("Protocols") {
                    ForEach(protocols) { proto in
                        NavigationLink {
                            HeaderTextView(title: proto.name, text: proto.header)
                        } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(proto.name).font(.callout).lineLimit(1)
                                Text("\(proto.methods.count) message"
                                     + (proto.methods.count == 1 ? "" : "s"))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $search, prompt: "Search classes")
        .navigationTitle(programName)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) {
            if let banner {
                Text(banner)
                    .font(.callout)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 12)
                    .task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        self.banner = nil
                    }
            }
        }
        .task { await load() }
    }

    func detail(_ klass: ObjCDump.Class) -> String {
        var bits: [String] = []
        if let parent = klass.superName { bits.append("from \(parent)") }
        if !klass.methods.isEmpty { bits.append("\(klass.methods.count) messages") }
        if !klass.ivars.isEmpty { bits.append("\(klass.ivars.count) things held") }
        return bits.joined(separator: " · ")
    }

    /// Writes the whole dump into the File tab, where it can be read, shared or copied out.
    func writeHeaderFile(_ dump: ObjCDump.Dump) {
        let safe = programName.replacingOccurrences(of: "/", with: "-")
        let url = Paths.files.appendingPathComponent("\(safe)-classes.h")
        do {
            try Data(dump.headers().utf8).write(to: url)
            NotificationCenter.default.post(name: .filesChanged, object: nil)
            banner = "Saved as \(url.lastPathComponent)"
        } catch {
            banner = "Could not save that file"
        }
    }

    func load() async {
        guard dump == nil else { return }
        let url = ipa
        let path = programPath
        let outcome: (ObjCDump.Dump?, String?) = await Task.detached(priority: .userInitiated) {
            do {
                // 96 MB: an ordinary program is a few megabytes; a huge game's is not worth
                // pulling into memory on a phone just to list its classes.
                let data = try AppContents.read(inIPA: url, path: path, limit: 96 << 20)
                let file = try MachOFile(data: data)
                guard let slice = file.slices.first(where: { $0.is64 }) ?? file.slices.first else {
                    return (nil, "that program has no 64-bit part to read")
                }
                return (ObjCDump.read(slice), nil)
            } catch let error as SignKitError {
                return (nil, error.description)
            } catch {
                return (nil, error.localizedDescription)
            }
        }.value
        if let found = outcome.0 {
            dump = found
        } else {
            problem = outcome.1
        }
    }
}

/// One class's header, as text that can be selected and copied.
struct HeaderTextView: View {
    let title: String
    let text: String

    var body: some View {
        ScrollView {
            Text(text)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button {
                UIPasteboard.general.string = text
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }
}
