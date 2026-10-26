import UIKit

/// Decoded app icons, kept in memory.
///
/// Before this, every icon was read off disk and decoded inside the row's `body`, which SwiftUI
/// runs again on every redraw — scrolling My apps, a signing job ticking its progress, anything.
/// A dozen apps meant a dozen PNGs decoded dozens of times a second on the main thread.
/// Now each icon is read once, on a background thread, shrunk to the size the row actually
/// draws, and kept.
final class IconCache: @unchecked Sendable {
    static let shared = IconCache()

    private let cache = NSCache<NSString, UIImage>()
    private let queue = DispatchQueue(label: "signer.icons", qos: .utility)

    private init() {
        // Icons are tiny once shrunk; 300 of them is far less than one full-size one.
        cache.countLimit = 300
    }

    /// An icon we already have. Cheap, so a view body may ask.
    func cached(_ url: URL) -> UIImage? {
        cache.object(forKey: url.path as NSString)
    }

    /// Reads and decodes off the main thread, then keeps it. Asking twice for the same icon
    /// while the first read is still going just does the small work twice; it never blocks
    /// the screen.
    func load(_ url: URL, points: CGFloat = 44) async -> UIImage? {
        if let hit = cached(url) { return hit }
        let image = await withCheckedContinuation { (done: CheckedContinuation<UIImage?, Never>) in
            queue.async {
                done.resume(returning: IconCache.decode(url, points: points))
            }
        }
        if let image { cache.setObject(image, forKey: url.path as NSString) }
        return image
    }

    /// App icons are often 1024 pixels square. Drawing one in a 44-point row at full size costs
    /// about 4 MB of memory for nothing, so it is shrunk to what the screen needs.
    private static func decode(_ url: URL, points: CGFloat) -> UIImage? {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe),
              let full = UIImage(data: data) else { return nil }
        // 3 is the sharpest iPhone screen, and asking about the screen itself is
        // main-thread-only work we are deliberately not on.
        let side = points * 3
        let small = full.preparingThumbnail(of: CGSize(width: side, height: side))
        return small ?? full
    }
}
