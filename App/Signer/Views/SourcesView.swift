import SwiftUI
import SignKit

/// Sources: lists of apps you can add by address, browse and download.
struct SourcesView: View {
    @EnvironmentObject var store: Store
    // Shared, so My apps knows what the sources offer and can say an update is waiting.
    @ObservedObject private var loader = SourceLoader.shared
    @State private var newAddress = ""
    @State private var adding = false
    @State private var message: String?

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
                Button { adding = true } label: { Label("Add", systemImage: "plus") }
            }
            .task { await loader.refreshAll(store.sources) }
            .alert("Add a source", isPresented: $adding) {
                TextField("https://…", text: $newAddress)
                Button("Cancel", role: .cancel) { newAddress = "" }
                Button("Add") { add() }
            } message: {
                Text("Paste the address of an app list.")
            }
            .alert("That did not work", isPresented: .constant(message != nil)) {
                Button("OK") { message = nil }
            } message: { Text(message ?? "") }
        }
    }

    func add() {
        let text = newAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        newAddress = ""
        guard var url = URL(string: text) else {
            message = "That does not look like an address."
            return
        }
        if url.scheme == nil { url = URL(string: "https://" + text) ?? url }
        let source = Source(id: UUID(), url: url, name: url.host ?? text)
        store.sources.append(source)
        store.save()
        Task { await loader.refresh(source) }
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
