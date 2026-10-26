import SwiftUI
import Combine
import SignKit

@main
struct SignerApp: App {
    @StateObject private var store = Store.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .onOpenURL { url in
                    Importer.handle(url)
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: Store
    @State private var tab = Tab.files

    enum Tab: Hashable { case files, apps, sign, sources, settings }

    var body: some View {
        TabView(selection: $tab) {
            FilesView()
                .tabItem { Label("File", systemImage: "folder") }
                .tag(Tab.files)

            LibraryView()
                .tabItem { Label("My apps", systemImage: "square.grid.2x2") }
                .tag(Tab.apps)

            SignView()
                .tabItem { Label("Sign", systemImage: "signature") }
                .tag(Tab.sign)

            SourcesView()
                .tabItem { Label("Sources", systemImage: "antenna.radiowaves.left.and.right") }
                .tag(Tab.sources)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        // Tapping "Sign this app" on a file jumps straight to the Sign tab.
        .onReceive(NotificationCenter.default.publisher(for: .signThisApp)) { _ in
            tab = .sign
        }
        // One place for "Imported successfully", the password prompt and any complaint.
        .importFeedback()
        // Installing starts here, not on the Sign screen, so it still happens when the job
        // finishes while another tab is up or the Sign screen has been left.
        .sheet(item: $store.pendingInstall) { (app: LibraryApp) in
            InstallView(app: app)
        }
    }
}

/// Handles files opened from elsewhere: Safari downloads, the share sheet, another app.
/// Everything lands in Signer's own folder so it shows up on the File tab.
enum Importer {
    @MainActor
    static func handle(_ url: URL) {
        guard url.isFileURL else { return }
        ImportCoordinator.shared.take([url])
    }
}
