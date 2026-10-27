import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Signing progress in the Dynamic Island and on the lock screen. Seventh on
/// docs/FEATURES.md (BatSign has this).
///
/// The island is drawn by a small extension inside the app (`App/SignerActivity`); this is the
/// side that starts it, feeds it and ends it. Updates are held back to about one a second:
/// iOS gives a Live Activity a small budget and signing reports progress hundreds of times a
/// second, so sending every one would get the island cut off.
@MainActor
final class SigningIsland {
    static let shared = SigningIsland()

    static let settingKey = "showIsland"
    static var isOn: Bool {
        UserDefaults.standard.object(forKey: settingKey) as? Bool ?? true
    }

    private var handle: Any?
    private var lastSent = Date.distantPast
    private var lastFraction: Double = -1

    private init() {}

    func start(appName: String) {
        #if canImport(ActivityKit)
        guard Self.isOn, #available(iOS 16.1, *) else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        end(failed: false, step: "", immediately: true)
        let attributes = SigningActivityAttributes(appName: appName)
        let state = SigningActivityAttributes.ContentState(fraction: 0, step: "Getting ready")
        handle = try? Activity.request(attributes: attributes, contentState: state,
                                       pushType: nil)
        lastSent = Date()
        lastFraction = 0
        #endif
    }

    func update(fraction: Double, step: String) {
        #if canImport(ActivityKit)
        guard #available(iOS 16.1, *), let activity = handle as? Activity<SigningActivityAttributes>
        else { return }
        // About one a second, or whenever it has moved a long way.
        let moved = abs(fraction - lastFraction) > 0.08
        guard moved || Date().timeIntervalSince(lastSent) > 1 else { return }
        lastSent = Date()
        lastFraction = fraction
        let state = SigningActivityAttributes.ContentState(fraction: fraction, step: step)
        Task { await activity.update(using: state) }
        #endif
    }

    func end(failed: Bool, step: String, immediately: Bool = false) {
        #if canImport(ActivityKit)
        guard #available(iOS 16.1, *), let activity = handle as? Activity<SigningActivityAttributes>
        else { return }
        handle = nil
        let state = SigningActivityAttributes.ContentState(
            fraction: failed ? lastFraction : 1,
            step: step,
            finished: true,
            failed: failed)
        Task {
            // The last word stays up for a few seconds, so it can be read, unless something
            // else is about to take the island over.
            await activity.end(using: state,
                               dismissalPolicy: immediately
                               ? .immediate
                               : .after(Date(timeIntervalSinceNow: 6)))
        }
        #endif
    }
}
