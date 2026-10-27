import Foundation
import BackgroundTasks
import UserNotifications
import SignKit

/// Checking the repositories while Signer is closed, and saying so when something has a newer
/// version waiting. Eleventh on docs/FEATURES.md, the second half of it.
///
/// iOS decides when this runs - usually when the phone is charging or on Wi-Fi and the app has
/// been used lately. It is asked for once a day; iOS gives it less often than that if Signer is
/// rarely opened. Nothing is downloaded or signed here: it reads the lists, counts what is out
/// of date, and puts up one notification.
enum BackgroundRefresh {
    static let taskID = "com.continuum.signer.refresh"
    static let settingKey = "checkSourcesInBackground"

    static var isOn: Bool {
        UserDefaults.standard.object(forKey: settingKey) as? Bool ?? true
    }

    /// Called once as the app starts. Registering has to happen before the app finishes
    /// launching or iOS refuses the identifier.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskID, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(refresh)
        }
        schedule()
    }

    static func schedule() {
        guard isOn else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskID)
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: taskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 6 * 3600)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Ask for permission to put a notification up. Called when the switch is turned on, so
    /// the question arrives with a reason the person just saw.
    static func askAboutNotifications() async {
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])
    }

    private static func handle(_ task: BGAppRefreshTask) {
        // Line up the next one first: if this is cut short, there is still another coming.
        schedule()
        let work = Task { @MainActor in
            let store = Store.shared
            await SourceLoader.shared.refreshAll(store.sources)
            let waiting = store.library.filter { SourceLoader.shared.update(for: $0) != nil }
            if !waiting.isEmpty { notify(about: waiting) }
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }

    /// One notification, naming what is out of date.
    static func notify(about apps: [LibraryApp]) {
        let content = UNMutableNotificationContent()
        content.title = apps.count == 1 ? "An update is waiting" : "\(apps.count) updates are waiting"
        let names = apps.prefix(4).map(\.name).joined(separator: ", ")
        content.body = apps.count > 4 ? names + " and more" : names
        content.sound = .default
        let request = UNNotificationRequest(identifier: "updates-\(UUID().uuidString)",
                                            content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
