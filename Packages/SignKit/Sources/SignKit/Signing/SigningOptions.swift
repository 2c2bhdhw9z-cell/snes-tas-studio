import Foundation

/// Everything the user can change about an app while signing it.
public struct SigningOptions {
    // Identity
    public var bundleID: String?
    public var displayName: String?
    public var version: String?
    public var buildNumber: String?
    public var minimumOS: String?
    /// New icon as PNG data; the signer writes every size the app needs.
    public var icon: Data?

    // Switches that change how the app behaves
    public var fileSharing = false            // show the app's files in the Files app
    public var itunesFileSharing = false
    public var proMotion = false              // allow 120 Hz
    public var gameMode = false
    public var iPadFullscreen = false
    public var appearance: String?            // "Light" or "Dark"
    public var removeURLSchemes = false
    public var removeDeviceRestrictions = true
    public var liquidGlass: Bool?             // true = opt in, false = force the old look

    // Clean-up
    /// Signs the app as a separate copy: its ID gets a short random ending, so iPhone treats it
    /// as a different app and it installs beside the original instead of replacing it. Also what
    /// other signers call PPQ protection, because an ID nobody else uses is not matched against
    /// the App Store. Ignored when an ID is typed in by hand.
    public var separateCopy = false

    public var removeExtensions = false
    public var removeWatchApp = false
    public var removeFiles: [String] = []
    /// Files to write over inside the app, each path relative to the `.app` itself
    /// ("Info.plist", "Frameworks/thing.dylib"). This is how an edited `.plist` or a swapped
    /// file gets in: the app is unpacked, these are written, and signing happens afterwards,
    /// so the hashes always match what is really there.
    public var replaceFiles: [String: Data] = [:]
    /// Keep only these architectures (for example ["arm64"]) to make the app smaller.
    public var keepArchitectures: Set<String>?

    // Tweaks
    public var injectLibraries: [URL] = []
    public var removeLibraries: [String] = []
    public var injectIntoExtensions = false
    public var injectPath = "@executable_path/Frameworks"
    public var replaceSubstrateWithEllekit = true

    // Signing
    public var adhoc = false
    public var hashKind: HashKind = .sha256
    /// Extra entitlements merged on top of the profile's.
    public var extraEntitlements: [String: Any] = [:]
    /// Compress the finished `.ipa`. Off is much faster and still installs.
    public var compressOutput = true

    public init() {}
}

/// What came out of a signing run.
public struct SigningResult {
    public let outputURL: URL
    public let bundleID: String
    public let displayName: String
    public let version: String
    public let cdhash: Data
    public let bytes: Int
    public let duration: TimeInterval
    public let warnings: [String]
}
