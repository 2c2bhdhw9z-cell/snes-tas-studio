import Foundation
import Combine
import SignKit

/// Updating an app from a source in one tap: download the new version, sign it with the
/// chosen certificate, hand it to iOS to install, then tidy the old copy away.
///
/// BatSign and Feather both do this; it is the first thing on docs/FEATURES.md's list.
/// One shared instance so the same job shows on My apps and on the Sources screen, and so
/// two updates can never run at once (signing a big app uses the whole phone).
@MainActor
final class Updates: ObservableObject {
    static let shared = Updates()

    /// The app ID being worked on, or nil when nothing is.
    @Published private(set) var busyBundleID: String?
    /// What it is doing, in plain words, for the row to show.
    @Published private(set) var stage: String?
    @Published var error: String?

    /// The signing half of the job. Its progress is republished below, so a view watching
    /// `Updates.shared` redraws as it ticks.
    let runner = SigningRunner()
    private var bag = Set<AnyCancellable>()

    private init() {
        runner.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &bag)
    }

    var isBusy: Bool { busyBundleID != nil }

    func isBusy(with bundleID: String) -> Bool { busyBundleID == bundleID }

    /// Downloads `offer`, signs it, starts the install, and only then removes `replacing` (the
    /// older copy) and the unsigned download from My apps. The downloaded `.ipa` itself stays
    /// on the File tab, the way a download should.
    ///
    /// The old copy used to be deleted the moment the new one was signed, so cancelling the
    /// install sheet left nothing working at all.
    func run(_ offer: SourceApp, replacing old: LibraryApp?) async {
        guard busyBundleID == nil else { return }
        busyBundleID = offer.bundleID
        error = nil
        stage = "Downloading \(offer.name) \(offer.version)"
        defer {
            busyBundleID = nil
            stage = nil
        }
        let store = Store.shared
        do {
            let fresh = try await SourceLoader.shared.download(offer)
            stage = "Signing \(offer.name) \(offer.version)"
            // Everything the Sign screen would have used, not just the compression switch:
            // a name or an add-on chosen there used to be dropped on an update.
            var options = SigningOptions()
            options.compressOutput = UserDefaults.standard.bool(forKey: "compressOutput")
            options.adhoc = store.selectedCertificate == nil
            options.injectIntoExtensions = true
            await runner.run(ipa: fresh.fileURL, options: options, certificate: store.selectedCertificate)
            if let failure = runner.errorMessage {
                error = failure
                // The unsigned download is still ours to remove; the working app stays put.
                store.deleteApp(fresh)
                return
            }
            // The signed copy is at the top of My apps now. The old version is kept until
            // the install has actually been handed to iOS, so a cancelled sheet changes
            // nothing. `Store` clears it when the install finishes.
            if let old, old.id != fresh.id {
                store.replaceAfterInstall = (old.id, fresh.id)
            }
            store.deleteApp(fresh)
        } catch {
            self.error = (error as? SignKitError)?.description ?? error.localizedDescription
        }
    }
}
