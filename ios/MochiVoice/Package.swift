// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "MochiVoice",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "MochiVoiceKit", targets: ["MochiVoiceKit"]),
    ],
    dependencies: [
        // Prebuilt WebRTC binary. Google's own GoogleWebRTC pod died at M80;
        // this is the maintained SwiftPM binary target with the plain RTC*
        // API. Pinned deliberately - it is a binary dependency.
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "151.0.0"),
    ],
    targets: [
        .target(
            name: "MochiVoiceKit",
            dependencies: [.product(name: "WebRTC", package: "WebRTC")]
        ),
        .testTarget(name: "MochiVoiceKitTests", dependencies: ["MochiVoiceKit"]),
    ]
)
