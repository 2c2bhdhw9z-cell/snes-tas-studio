// swift-tools-version: 5.9
import PackageDescription

// SignKit: our own iOS code-signing engine, written from scratch.
// No third-party code. Builds on iOS (the app) and on Linux (tests in the build sandbox).
let package = Package(
    name: "SignKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "SignKit", targets: ["SignKit"]),
    ],
    targets: [
        .systemLibrary(name: "CZlib", path: "Sources/CZlib"),
        .target(name: "SignKit", dependencies: ["CZlib"]),
        .executableTarget(name: "signkit-cli", dependencies: ["SignKit"]),
        .testTarget(name: "SignKitTests", dependencies: ["SignKit"]),
    ]
)
