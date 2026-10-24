import SwiftUI
import UIKit
import UniformTypeIdentifiers
import SignKit

/// The apps on this phone's list: imported ones and ones we signed.
struct LibraryView: View {
    @EnvironmentObject var store: Store
    @State private var showImporter = false
    @State private var installing: LibraryApp?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if store.library.isEmpty {
                    emptyState
                } else {
                    List {
                        ForEach(store.library) { app in
                            AppRow(app: app) { installing = app }
                        }
                        .onDelete { indexes in
                            indexes.map { store.library[$0] }.forEach(store.deleteApp)
                        }
                    }
                }
            }
            .navigationTitle("My apps")
            .toolbar {
                Button {
                    showImporter = true
                } label: {
                    Label("Add an app", systemImage: "plus")
                }
            }
            .fileImporter(isPresented: $showImporter,
                          allowedContentTypes: [UTType(filenameExtension: "ipa") ?? .archive],
                          allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls):
                    for url in urls {
                        do { _ = try SigningRunner.importIPA(url) }
                        catch { self.error = friendly(error) }
                    }
                case .failure(let e):
                    self.error = e.localizedDescription
                }
            }
            .sheet(item: $installing) { (app: LibraryApp) in
                InstallView(app: app)
            }
            .alert("That did not work", isPresented: .constant(error != nil)) {
                Button("OK") { error = nil }
            } message: {
                Text(error ?? "")
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
            Text("Tap + to pick an app file (an \".ipa\") from your phone, or add a source on the Sign tab.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
    }

    func friendly(_ e: Error) -> String {
        (e as? SignKitError)?.description ?? e.localizedDescription
    }
}

struct AppRow: View {
    let app: LibraryApp
    let install: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            AppIcon(url: app.iconURL)
            VStack(alignment: .leading, spacing: 2) {
                Text(app.name).font(.body.weight(.medium))
                Text("\(app.version.isEmpty ? "no version" : app.version) · \(app.sizeText)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(app.bundleID)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer()
            if app.isSigned {
                Button("Install", action: install)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            } else {
                NavigationLink {
                    SignView(preselected: app)
                } label: {
                    Text("Sign")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }
}

struct AppIcon: View {
    let url: URL?

    var body: some View {
        Group {
            if let url, let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                Image(uiImage: image).resizable()
            } else {
                Image(systemName: "app.dashed").resizable().foregroundStyle(.secondary)
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}


