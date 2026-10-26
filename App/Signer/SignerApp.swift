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
    @AppStorage(AppTheme.key) private var theme = AppTheme.system.rawValue

    enum Tab: Hashable { case files, apps, sources, settings }

    var body: some View {
        TabView(selection: $tab) {
            FilesView()
                .tabItem { Label("File", systemImage: "folder") }
                .tag(Tab.files)

            // Signing lives inside My apps: the list is where apps are, so the Sign screen
            // opens from the app you picked instead of being a tab that starts empty.
            LibraryView()
                .tabItem { Label("My apps", systemImage: "square.grid.2x2") }
                .tag(Tab.apps)

            SourcesView()
                .tabItem { Label("Sources", systemImage: "antenna.radiowaves.left.and.right") }
                .tag(Tab.sources)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        // Tapping "Sign this app" on a file goes to My apps, which opens the Sign screen
        // on that app (LibraryView listens for the same thing).
        .onReceive(NotificationCenter.default.publisher(for: .signThisApp)) { _ in
            tab = .apps
        }
        // Light, dark, or follow the phone. nil is "follow the phone".
        .preferredColorScheme(AppTheme.named(theme).colorScheme)
        // A signing run iOS killed part-way through leaves the whole unpacked app in the
        // temporary folder - 3.7 GB for the owner's PUBG, twice, and nothing ever deleted it.
        // Nothing is signing at launch, so clear it, in the background.
        .task {
            let freed = await Task.detached(priority: .background) {
                IPASigner.clearLeftovers()
            }.value
            if freed > 0 { store.leftoversFreed = freed }
            // Reading the sources at launch is what lets My apps say an update is waiting
            // without opening the Sources tab first.
            await SourceLoader.shared.refreshAll(store.sources)
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
