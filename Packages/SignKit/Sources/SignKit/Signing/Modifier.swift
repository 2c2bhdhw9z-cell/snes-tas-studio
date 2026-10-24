import Foundation

/// Applies the user's changes to an unpacked app, before it gets signed.
struct Modifier {
    let options: SigningOptions
    let warnings: (String) -> Void

    func apply(to app: URL) throws {
        let fm = FileManager.default

        // Things the user asked to delete.
        if options.removeExtensions {
            for dir in ["PlugIns", "Plug-ins", "Extensions"] {
                try? fm.removeItem(at: app.appendingPathComponent(dir))
            }
        }
        if options.removeWatchApp {
            try? fm.removeItem(at: app.appendingPathComponent("Watch"))
            try? fm.removeItem(at: app.appendingPathComponent("com.apple.WatchKit"))
        }
        for rel in options.removeFiles {
            try? fm.removeItem(at: app.appendingPathComponent(rel))
        }
        // An old signature is always thrown away; we write a fresh one.
        try? fm.removeItem(at: app.appendingPathComponent("_CodeSignature"))
        try? fm.removeItem(at: app.appendingPathComponent("embedded.mobileprovision"))
        try? fm.removeItem(at: app.appendingPathComponent("SC_Info"))

        // Info.plist edits.
        let infoURL = app.appendingPathComponent("Info.plist")
        var info = try plist(at: infoURL)
        let oldBundleID = info["CFBundleIdentifier"] as? String
        if let v = options.bundleID { info["CFBundleIdentifier"] = v }
        if let v = options.displayName {
            info["CFBundleDisplayName"] = v
            info["CFBundleName"] = String(v.prefix(15))
        }
        if let v = options.version { info["CFBundleShortVersionString"] = v }
        if let v = options.buildNumber { info["CFBundleVersion"] = v }
        if let v = options.minimumOS { info["MinimumOSVersion"] = v }
        if options.fileSharing { info["UISupportsDocumentBrowser"] = true }
        if options.itunesFileSharing { info["UIFileSharingEnabled"] = true }
        if options.proMotion { info["CADisableMinimumFrameDurationOnPhone"] = true }
        if options.gameMode { info["GCSupportsGameMode"] = true }
        if options.iPadFullscreen { info["UIRequiresFullScreen"] = true }
        if let a = options.appearance { info["UIUserInterfaceStyle"] = a }
        if options.removeURLSchemes { info.removeValue(forKey: "CFBundleURLTypes") }
        if options.removeDeviceRestrictions {
            info.removeValue(forKey: "UISupportedDevices")
            info.removeValue(forKey: "UIRequiredDeviceCapabilities")
        }
        if let glass = options.liquidGlass { info["UIDesignRequiresCompatibility"] = !glass }
        if options.removeExtensions { info.removeValue(forKey: "NSExtension") }
        if options.removeWatchApp { info.removeValue(forKey: "WKCompanionAppBundleIdentifier") }
        if let icon = options.icon { try writeIcon(icon, to: app, info: &info) }
        try write(info, to: infoURL)

        // Extensions carry the app's ID as a prefix; keep them in step.
        if let newID = options.bundleID, let oldID = oldBundleID, newID != oldID {
            try renestExtensions(in: app, from: oldID, to: newID)
        }

        // Tweaks.
        if !options.injectLibraries.isEmpty || !options.removeLibraries.isEmpty
            || options.keepArchitectures != nil || options.minimumOS != nil {
            try editBinaries(in: app)
        }
    }

    func plist(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let d = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
            throw SignKitError.malformed("\(url.lastPathComponent) is damaged")
        }
        return d
    }

    func write(_ dict: [String: Any], to url: URL) throws {
        let data = try PropertyListSerialization.data(fromPropertyList: dict, format: .binary, options: 0)
        try data.write(to: url)
    }

    /// Copies the new icon in and points the app at it.
    func writeIcon(_ png: Data, to app: URL, info: inout [String: Any]) throws {
        let name = "SignKitIcon"
        for (suffix, _) in [("60x60@2x", 120), ("60x60@3x", 180), ("76x76@2x~ipad", 152)] {
            try png.write(to: app.appendingPathComponent("\(name)\(suffix).png"))
        }
        info["CFBundleIcons"] = [
            "CFBundlePrimaryIcon": [
                "CFBundleIconFiles": ["\(name)60x60"],
                "CFBundleIconName": name,
            ],
        ]
        info["CFBundleIconFiles"] = ["\(name)60x60"]
        // The compiled catalogue would override our icon, so it goes.
        try? FileManager.default.removeItem(at: app.appendingPathComponent("Assets.car"))
        warnings("The icon was replaced, which removes the app's built-in image set. "
                 + "Some pictures inside the app may be missing.")
    }

    /// Rewrites extension bundle IDs so they stay under the app's new ID.
    func renestExtensions(in app: URL, from oldID: String, to newID: String) throws {
        let fm = FileManager.default
        for dir in ["PlugIns", "Plug-ins", "Extensions", "Watch"] {
            let base = app.appendingPathComponent(dir)
            guard let items = try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil) else { continue }
            for item in items {
                let infoURL = item.appendingPathComponent("Info.plist")
                guard fm.fileExists(atPath: infoURL.path), var info = try? plist(at: infoURL) else { continue }
                if let id = info["CFBundleIdentifier"] as? String, id.hasPrefix(oldID) {
                    info["CFBundleIdentifier"] = newID + id.dropFirst(oldID.count)
                }
                if let companion = info["WKCompanionAppBundleIdentifier"] as? String, companion == oldID {
                    info["WKCompanionAppBundleIdentifier"] = newID
                }
                if var extra = info["NSExtension"] as? [String: Any],
                   let attrs = extra["NSExtensionAttributes"] as? [String: Any] {
                    var a = attrs
                    if let host = attrs["WKAppBundleIdentifier"] as? String, host.hasPrefix(oldID) {
                        a["WKAppBundleIdentifier"] = newID + host.dropFirst(oldID.count)
                    }
                    extra["NSExtensionAttributes"] = a
                    info["NSExtension"] = extra
                }
                try write(info, to: infoURL)
                // A nested .app (the Watch app) needs the same treatment one level down.
                if item.pathExtension == "app" { try renestExtensions(in: item, from: oldID, to: newID) }
            }
        }
    }

    /// Library injection, library removal and architecture thinning.
    func editBinaries(in app: URL) throws {
        let fm = FileManager.default
        let info = try plist(at: app.appendingPathComponent("Info.plist"))
        guard let exec = info["CFBundleExecutable"] as? String else { return }

        // Copy the tweaks into the bundle first.
        var injectedNames = [String]()
        let frameworks = app.appendingPathComponent("Frameworks")
        if !options.injectLibraries.isEmpty {
            try fm.createDirectory(at: frameworks, withIntermediateDirectories: true)
            for lib in options.injectLibraries {
                let dest = frameworks.appendingPathComponent(lib.lastPathComponent)
                try? fm.removeItem(at: dest)
                try fm.copyItem(at: lib, to: dest)
                injectedNames.append(lib.lastPathComponent)
            }
        }

        var targets = [app.appendingPathComponent(exec)]
        if options.injectIntoExtensions {
            for dir in ["PlugIns", "Plug-ins"] {
                let base = app.appendingPathComponent(dir)
                for item in (try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? [] {
                    if let i = try? plist(at: item.appendingPathComponent("Info.plist")),
                       let e = i["CFBundleExecutable"] as? String {
                        targets.append(item.appendingPathComponent(e))
                    }
                }
            }
        }

        for target in targets {
            guard fm.fileExists(atPath: target.path) else { continue }
            var file = try MachOFile(data: try Data(contentsOf: target, options: .mappedIfSafe))
            if let archs = options.keepArchitectures, file.isFat {
                file.thin(keeping: archs)
            }
            try file.forEachSlice { slice in
                for name in options.removeLibraries { slice.removeDylib(name) }
                for name in injectedNames {
                    try slice.injectDylib("\(options.injectPath)/\(name)")
                }
                if options.replaceSubstrateWithEllekit {
                    try slice.replaceDylib("/Library/Frameworks/CydiaSubstrate.framework/CydiaSubstrate",
                                           with: "@rpath/CydiaSubstrate.framework/CydiaSubstrate")
                }
                if let min = options.minimumOS {
                    let parts = min.split(separator: ".").compactMap { Int($0) }
                    if let major = parts.first { slice.setMinOS(major: major, minor: parts.count > 1 ? parts[1] : 0) }
                }
            }
            try file.encoded().write(to: target)
        }

        // Tweaks themselves often link Substrate; point them at the bundled copy.
        if options.replaceSubstrateWithEllekit {
            for name in injectedNames {
                let url = frameworks.appendingPathComponent(name)
                guard MachOFile.isMachO(url: url) else { continue }
                var lib = try MachOFile(data: try Data(contentsOf: url))
                try lib.forEachSlice { slice in
                    try slice.replaceDylib("/Library/Frameworks/CydiaSubstrate.framework/CydiaSubstrate",
                                           with: "@rpath/CydiaSubstrate.framework/CydiaSubstrate")
                    try slice.addRpath("@executable_path/Frameworks")
                }
                try lib.encoded().write(to: url)
            }
        }
    }
}
