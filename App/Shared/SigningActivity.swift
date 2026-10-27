import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// What the Dynamic Island (and the lock screen) is told about a signing job.
///
/// This file is built into both Signer and the little extension that draws the island, because
/// iOS passes these values between the two. Keep it small: everything in here is copied on
/// every update, and there are a lot of updates while a game is being signed.
@available(iOS 16.1, *)
struct SigningActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// 0 to 1.
        var fraction: Double
        /// What it is doing now, in plain words: "Unpacking", "Signing the program".
        var step: String
        /// Set when the job has ended, so the island can say how it went.
        var finished: Bool = false
        var failed: Bool = false
    }

    /// The app being signed, fixed for the life of the job.
    var appName: String
}
#endif
