import SwiftUI
import UIKit
import SignKit

/// Sources: lists of apps you can add by address, browse and download.
struct SourcesView: View {
    @EnvironmentObject var store: Store
    // Shared, so My apps knows what the sources offer and can say an update is waiting.
    @ObservedObject private var loader = SourceLoader.shared
    @State private var adding = false
    @State private var message: String?
    @State private var banner: String?

    var body: some View {
        NavigationStack {
            List {
                if store.sources.isEmpty {
                    Section {
                        Text("A source is an address that holds a list of apps. Paste one in and its "
                             + "apps show up here, ready to download and sign.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                ForEach(store.sources) { source in
                    Section {
                        NavigationLink {
                            SourceAppsView(source: source, loader: loader)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(loader.feeds[source.id]?.name ?? source.name)
                                        .font(.body.weight(.medium))
                                    if loader.loading.contains(source.id) {
                                        Text("Loading…").font(.caption).foregroundStyle(.secondary)
                                    } else if let failure = loader.failures[source.id] {
                                        Text(failure).font(.caption).foregroundStyle(.red)
                                    } else if let feed = loader.feeds[source.id] {
                                        Text("\(feed.apps.count) apps").font(.caption).foregroundStyle(.secondary)
                                    } else {
                                        Text(source.url.host ?? "").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                            }
                        }
                    }
                }
                .onDelete { idx in
                    idx.map { store.sources[$0] }.forEach { source in
                        store.sources.removeAll { $0.id == source.id }
                    }
                    store.save()
                }

                if let progress = loader.downloadProgress {
                    Section("Downloading \(loader.downloadName ?? "")") {
                        ProgressView(value: progress)
                    }
                }
            }
            .navigationTitle("Sources")
            .refreshable { await loader.refreshAll(store.sources) }
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !store.sources.isEmpty {
                        Menu {
                            ForEach(ShareCode.Format.allCases, id: \.self) { format in
                                Button(format.label) { copyCode(as: format) }
                            }
                        } label: {
                            Label("Share my sources", systemImage: "square.and.arrow.up")
                        }
                    }
                    Button { adding = true } label: { Label("Add", systemImage: "plus") }
                }
            }
            .task { await loader.refreshAll(store.sources) }
            .sheet(isPresented: $adding) {
                AddSourcesView { urls in
                    add(urls)
                }
            }
            .overlay(alignment: .bottom) {
                if let banner {
                    Text(banner)
                        .font(.callout)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.bottom, 12)
                        .task {
                            try? await Task.sleep(nanoseconds: 2_500_000_000)
                            self.banner = nil
                        }
                }
            }
            .alert("That did not work", isPresented: .constant(message != nil)) {
                Button("OK") { message = nil }
            } message: { Text(message ?? "") }
        }
    }

    /// Adds every address found, skipping the ones already here, then reads them.
    func add(_ urls: [URL]) {
        var added: [Source] = []
        for url in urls {
            guard !store.sources.contains(where: { $0.url.absoluteString == url.absoluteString }) else { continue }
            let source = Source(id: UUID(), url: url, name: url.host ?? url.absoluteString)
            store.sources.append(source)
            added.append(source)
        }
        store.save()
        let skipped = urls.count - added.count
        if added.isEmpty {
            banner = skipped > 0 ? "Already added" : "Nothing to add"
        } else {
            banner = "Added \(added.count)" + (skipped > 0 ? ", \(skipped) already here" : "")
        }
        Task {
            for source in added { await loader.refresh(source) }
        }
    }

    /// Puts a code for every source on the clipboard, in whichever signer's shape was chosen.
    func copyCode(as format: ShareCode.Format) {
        let code = ShareCode.encode(store.sources.map(\.url), as: format)
        UIPasteboard.general.string = code
        banner = "\(format.label) copied — \(store.sources.count) source"
            + (store.sources.count == 1 ? "" : "s")
    }
}

/// Adding sources: one address, a list of them, or a share code from another signer.
///
/// ESign hands out its list as `source[…]`, which people call an encrypted repo; KravaSign,
/// MapleSign and FlareStore each have their own. All of them are read here (SignKit's
/// `ShareCode`), and the screen says which one it recognised before anything is added.
struct AddSourcesView: View {
    @Environment(\.dismiss) var dismiss
    let add: ([URL]) -> Void
    @State private var text = ""

    var found: ShareCode.Decoded? { ShareCode.decode(text) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .frame(minHeight: 120)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.footnote.monospaced())
                } header: {
                    Text("Paste here")
                } footer: {
                    Text("An address, a whole list of them, or a code from another signer — "
                         + "ESign's source[…], KravaSign, MapleSign or FlareStore. It works out "
                         + "which it is by itself.")
                }

                Section {
                    Button {
                        if let clip = UIPasteboard.general.string { text = clip }
                    } label: {
                        Label("Paste from the clipboard", systemImage: "doc.on.clipboard")
                    }
                }

                if let found {
                    Section("Found") {
                        LabeledContent("Kind", value: found.format.label)
                        LabeledContent("Sources", value: "\(found.urls.count)")
                        ForEach(found.urls, id: \.absoluteString) { url in
                            Text(url.absoluteString)
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                } else if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Section {
                        Label("No addresses in that. If it is a code from another signer, paste "
                              + "all of it, including source[ and the ] at the end.",
                              systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("Add sources")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add") {
                        if let found { add(found.urls) }
                        dismiss()
                    }
                    .disabled(found == nil)
                }
            }
        }
    }
}

struct SourceAppsView: View {
    let source: Source
    @ObservedObject var loader: SourceLoader
    @ObservedObject private var updates = Updates.shared
    @EnvironmentObject var store: Store
    @State private var search = ""
    @State private var message: String?
    @State private var downloading: String?

    var apps: [SourceApp] {
        let all = loader.feeds[source.id]?.apps ?? []
        guard !search.isEmpty else { return all }
        return all.filter {
            $0.name.localizedCaseInsensitiveContains(search)
                || $0.bundleID.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        List {
            if let failure = loader.failures[source.id] {
                Section { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            }
            ForEach(apps) { app in
                HStack(spacing: 12) {
                    RemoteIcon(url: app.iconURL)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.name).font(.body.weight(.medium))
                        HStack(spacing: 6) {
                            if !app.version.isEmpty { Text(app.version) }
                            if let size = app.sizeText { Text("· \(size)") }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                        if let summary = app.summary {
                            Text(summary).font(.caption2).foregroundStyle(.tertiary).lineLimit(2)
                        }
                        if let notes = app.whatsNew, let have = loader.installed(app, in: store.library),
                           Version.isNewer(app.version, than: have.version) {
                            Text("New: \(notes)")
                                .font(.caption2).foregroundStyle(.tint).lineLimit(2)
                        }
                    }
                    Spacer()
                    if downloading == app.id || updates.isBusy(with: app.bundleID) {
                        ProgressView()
                    } else if let have = loader.installed(app, in: store.library) {
                        if Version.isNewer(app.version, than: have.version) {
                            // One tap: download, sign with the chosen certificate, install.
                            Button("Update") {
                                Task { await updates.run(app, replacing: have) }
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(app.downloadURL == nil || updates.isBusy)
                        } else {
                            Text("Added").font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        Button("Get") { get(app) }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(app.downloadURL == nil)
                    }
                }
            }
            if let stage = updates.stage {
                Section { Label(stage, systemImage: "arrow.down.circle").font(.caption) }
            }
            if let problem = updates.error {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                    Button("OK") { updates.error = nil }.font(.caption)
                }
            }
        }
        .searchable(text: $search)
        .navigationTitle(loader.feeds[source.id]?.name ?? source.name)
        .refreshable { await loader.refresh(source) }
        .task { if loader.feeds[source.id] == nil { await loader.refresh(source) } }
        .alert("That did not work", isPresented: .constant(message != nil)) {
            Button("OK") { message = nil }
        } message: { Text(message ?? "") }
    }

    func get(_ app: SourceApp) {
        downloading = app.id
        Task {
            do {
                _ = try await loader.download(app)
                message = nil
            } catch {
                message = (error as? SignKitError)?.description ?? error.localizedDescription
            }
            downloading = nil
        }
    }
}

struct RemoteIcon: View {
    let url: URL?

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image): image.resizable()
            default: Image(systemName: "app.dashed").resizable().foregroundStyle(.secondary)
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
