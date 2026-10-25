import UIKit
import UniformTypeIdentifiers

/// Apple's own file picker, presented straight from UIKit.
///
/// SwiftUI's `.fileImporter` has a known fault on real iPhones: tapping Open
/// highlights the button but the sheet never closes and the files are never handed
/// over (reported on Apple's developer forums, and exactly what happened here).
/// Presenting `UIDocumentPickerViewController` ourselves avoids that path entirely.
///
/// `asCopy: true` makes iOS copy the chosen files into the app's own inbox before
/// handing them over, so there is no permission dance and nothing is greyed out.
@MainActor
enum DocumentPicker {
    private static var activeDelegate: Delegate?

    /// Shows the picker. `completion` gets the chosen files, or nothing if cancelled.
    static func present(multiple: Bool = true, completion: @escaping ([URL]) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item, .data, .content],
                                                    asCopy: true)
        picker.allowsMultipleSelection = multiple
        picker.shouldShowFileExtensions = true
        let delegate = Delegate { urls in
            activeDelegate = nil
            // Let the picker finish sliding away first. A password box shown while
            // it is still on screen would be silently dropped by iOS.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { completion(urls) }
        }
        activeDelegate = delegate
        picker.delegate = delegate
        guard let top = topViewController() else {
            activeDelegate = nil
            return
        }
        top.present(picker, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var top = window?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    private final class Delegate: NSObject, UIDocumentPickerDelegate {
        let done: ([URL]) -> Void
        init(done: @escaping ([URL]) -> Void) { self.done = done }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            done(urls)
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            done([])
        }
    }
}
