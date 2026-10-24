import SwiftUI
import SignKit

@main
struct SignerApp: App {
    @StateObject private var store = Store.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .onOpenURL { url in
                    Task { await Importer.handle(url) }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: Store
    @State private var tab = Tab.library

    enum Tab: Hashable { case library, sign, sources, certificates, settings }

    var body: some View {
        TabView(selection: $tab) {
            LibraryView()
                .tabItem { Label("My apps", systemImage: "square.stack.3d.up") }
                .tag(Tab.library)

            SignView()
                .tabItem { Label("Sign", systemImage: "signature") }
                .tag(Tab.sign)

            SourcesView()
                .tabItem { Label("Sources", systemImage: "square.grid.2x2") }
                .tag(Tab.sources)

            CertificatesView()
                .tabItem { Label("Certificates", systemImage: "checkmark.seal") }
                .tag(Tab.certificates)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
    }
}

/// Handles files opened from elsewhere (Files app, Safari downloads, share sheet).
enum Importer {
    @MainActor
    static func handle(_ url: URL) async {
        let ext = url.pathExtension.lowercased()
        switch ext {
        case "ipa":
            _ = try? SigningRunner.importIPA(url)
        case "p12", "pfx", "mobileprovision":
            // Stash it; the Certificates screen picks it up and asks for the password.
            let dest = Store.shared.importsDir.appendingPathComponent(url.lastPathComponent)
            try? FileManager.default.removeItem(at: dest)
            try? FileManager.default.copyItem(at: url, to: dest)
        default:
            break
        }
    }
}
