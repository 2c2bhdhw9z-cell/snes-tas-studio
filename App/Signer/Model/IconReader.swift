import Foundation
import UIKit
import SignKit

/// Getting an app's icon out of its compiled image set (`Assets.car`), the other half of the
/// fourth item on docs/FEATURES.md.
///
/// Apps whose icon exists only in there show up blank in every other signer. The pixels in that
/// file come in a dozen packings, several of which Apple has never written down - so rather than
/// guess at them, this hands the file to iOS, which has the only complete reader there is: a
/// folder with the image set and a tiny Info.plist in it is a bundle as far as iOS is concerned,
/// and `UIImage(named:in:)` will read the icon straight out of it.
enum IconReader {
    /// The icon as a PNG, or nil if iOS could not find one either.
    static func icon(fromCatalog catalog: Data, names: [String]) -> Data? {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("iconread-\(UUID().uuidString).bundle")
        defer { try? FileManager.default.removeItem(at: folder) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try catalog.write(to: folder.appendingPathComponent("Assets.car"))
            // Without an Info.plist iOS does not treat the folder as a bundle at all.
            let info: [String: Any] = [
                "CFBundleIdentifier": "com.continuum.signer.iconread",
                "CFBundleName": "IconRead",
                "CFBundleInfoDictionaryVersion": "6.0",
            ]
            try PropertyListSerialization.data(fromPropertyList: info, format: .binary, options: 0)
                .write(to: folder.appendingPathComponent("Info.plist"))
        } catch {
            return nil
        }
        guard let bundle = Bundle(url: folder) else { return nil }

        // "AppIcon" first, then whatever the catalogue says it holds, biggest-looking first.
        var tried = Set<String>()
        for name in ["AppIcon"] + names where tried.insert(name).inserted {
            guard let image = UIImage(named: name, in: bundle, compatibleWith: nil) else { continue }
            guard image.size.width >= 40, image.size.height >= 40 else { continue }
            if let png = image.pngData() { return png }
        }
        return nil
    }

    /// The icon for an app whose loose icon files are missing: reads the catalogue's contents
    /// list with the engine (to learn the names), then asks iOS for the picture.
    static func icon(fromCatalog catalog: Data) -> Data? {
        var names: [String] = []
        if let read = try? AssetCatalog.read(catalog) {
            // Names that look like an icon first, then the rest.
            let iconish = read.facets.filter { $0.localizedCaseInsensitiveContains("icon") }
            names = iconish + read.facets.filter { !iconish.contains($0) }
            // If the engine can unpack the picture itself, that is quicker than going via iOS.
            if let best = read.bestIcon, best.packing.canUnpackHere,
               let png = AssetCatalog.png(for: best, in: catalog) {
                return png
            }
        }
        return icon(fromCatalog: catalog, names: names)
    }
}
