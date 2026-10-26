import SwiftUI
import Combine
import UIKit
import UniformTypeIdentifiers
import SignKit

/// The apps on this phone, and signing them — one screen.
///
/// There used to be a separate Sign tab that opened with nothing chosen. Signing now starts
/// from the list: tap Sign on an app, or "Sign an app" at the top to pick a file first.
struct LibraryView: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var loader = SourceLoader.shared
    @ObservedObject private var updates = Updates.shared
    @State private var path: [Route] = []
    @State private var banner: String?

    /// Where the list can go. Only one place so far: the Sign screen, on an app or on nothing.
    enum Route: Hashable {
        case sign(LibraryApp?)
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if store.library.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("My apps")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .sign(let app):
                    SignView(preselected: app)
                }
            }
            .toolbar {
                Button {
                    DocumentPicker.present { urls in
                        guard !urls.isEmpty else { return }
                        ImportCoordinator.shared.take(urls)
                    }
                } label: {
                    Label("Add an app", systemImage: "plus")
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
            // A file tapped on the File tab with "Sign this app" lands here.
            .onReceive(NotificationCenter.default.publisher(for: .signThisApp)) { note in
                let chosen = (note.object as? UUID).flatMap { id in
                    store.library.first { $0.id == id }
                } ?? store.library.first
                path = [.sign(chosen)]
            }
        }
    }

    /// Apps with a newer version waiting in one of the sources.
    var updatable: [LibraryApp] {
        store.library.filter { loader.update(for: $0) != nil }
    }

    var list: some View {
        List {
            Section {
                Button {
                    path.append(.sign(nil))
                } label: {
                    Label("Sign an app", systemImage: "signature")
                        .font(.body.weight(.medium))
                }
            }
            if let problem = updates.error {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                    Button("OK") { updates.error = nil }
                        .font(.caption)
                }
            }
            Section {
                ForEach(store.library) { app in
                    AppRow(app: app,
                           offer: loader.update(for: app),
                           busy: updates.isBusy(with: app.bundleID),
                           stage: updates.stage,
                           fraction: updates.runner.isRunning ? updates.runner.fraction : nil,
                           // One update at a time: signing a big app uses the whole phone.
                           blocked: updates.isBusy && !updates.isBusy(with: app.bundleID),
                           sign: { path.append(.sign(app)) },
                           install: { store.pendingInstall = app },
                           updateNow: {
                               guard let offer = loader.update(for: app) else { return }
                               Task { await updates.run(offer, replacing: app) }
                           })
                        .contextMenu {
                            if let offer = loader.update(for: app) {
                                Button {
                                    Task { await updates.run(offer, replacing: app) }
                                } label: {
                                    Label("Update to \(offer.version)", systemImage: "arrow.down.circle")
                                }
                                .disabled(updates.isBusy)
                            }
                            Button {
                                path.append(.sign(app))
                            } label: {
                                Label(app.isSigned ? "Sign again" : "Sign", systemImage: "signature")
                            }
                            if app.isSigned {
                                Button {
                                    store.pendingInstall = app
                                } label: {
                                    Label("Install", systemImage: "arrow.down.app")
                                }
                            }
                            Button(role: .destructive) {
                                store.deleteApp(app)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                }
                .onDelete { indexes in
                    indexes.map { store.library[$0] }.forEach(store.deleteApp)
                }
            } header: {
                HStack {
                    Text("\(store.library.count) app" + (store.library.count == 1 ? "" : "s"))
                    if !updatable.isEmpty {
                        Text("· \(updatable.count) update" + (updatable.count == 1 ? "" : "s"))
                            .foregroundStyle(.tint)
                    }
                }
            }
        }
    }

    var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "square.stack.3d.up")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("No apps yet")
                .font(.headline)
            Text("Tap + and pick anything — an app file, your certificate, your profile. "
                 + "Nothing will be greyed out. They each go where they belong.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button {
                path.append(.sign(nil))
            } label: {
                Label("Sign an app", systemImage: "signature")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    func friendly(_ e: Error) -> String {
        (e as? SignKitError)?.description ?? e.localizedDescription
    }
}

struct AppRow: View {
    let app: LibraryApp
    /// A newer version waiting in a source, if there is one.
    var offer: SourceApp? = nil
    var busy: Bool = false
    var stage: String? = nil
    var fraction: Double? = nil
    /// Another app's update is running, so this one cannot start yet.
    var blocked: Bool = false
    let sign: () -> Void
    let install: () -> Void
    var updateNow: () -> Void = {}

    var body: some View {
        HStack(spacing: 12) {
            AppIcon(url: app.iconURL)
            VStack(alignment: .leading, spacing: 2) {
                Text(app.name).font(.body.weight(.medium))
                Text("\(app.version.isEmpty ? "no version" : app.version) · \(app.sizeText)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if busy {
                    if let stage {
                        Text(stage).font(.caption2).foregroundStyle(.tint).lineLimit(1)
                    }
                    if let fraction {
                        ProgressView(value: fraction).frame(maxWidth: 160)
                    }
                } else if let offer {
                    Text("\(offer.version) waiting"
                         + (offer.sizeText.map { " · \($0)" } ?? ""))
                        .font(.caption2)
                        .foregroundStyle(.tint)
                } else {
                    Text(app.bundleID)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer()
            if busy {
                ProgressView()
            } else if offer != nil {
                Button("Update", action: updateNow)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(blocked)
            } else if app.isSigned {
                Button("Install", action: install)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            } else {
                Button("Sign", action: sign)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }
}

/// An app's icon in a row. Reading and decoding happens once, off the main thread
/// (see `IconCache`); the row body only draws what is already there.
struct AppIcon: View {
    let url: URL?
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable()
            } else {
                Image(systemName: "app.dashed").resizable().foregroundStyle(.secondary)
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .task(id: url) {
            guard let url else {
                image = nil
                return
            }
            if let hit = IconCache.shared.cached(url) {
                image = hit
            } else {
                image = await IconCache.shared.load(url)
            }
        }
    }
}
