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

    /// Ask for permission to put a notification up. Called when the switch is turned on, and
    /// also once at launch if the switch is already on - it defaults to on, so without the
    /// second call the question never appeared and no update notice was ever shown.
    static func askAboutNotifications() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
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
    ///
    /// The same apps used to be announced again on every background run, and a library with
    /// two entries for one app counted it twice. The set that has been announced is kept, so
    /// only genuinely new updates produce a notice, and each app is named once.
    static let announcedKey = "announcedUpdates"

    static func notify(about apps: [LibraryApp]) {
        // One line per app ID, however many copies of it My apps holds.
        var seen = Set<String>()
        let unique = apps.filter { seen.insert($0.bundleID).inserted }
        let signature = unique.map { "\($0.bundleID)@\($0.version)" }.sorted()
        let announced = UserDefaults.standard.stringArray(forKey: announcedKey) ?? []
        guard Set(signature) != Set(announced) else { return }
        UserDefaults.standard.set(signature, forKey: announcedKey)

        let content = UNMutableNotificationContent()
        content.title = unique.count == 1 ? "An update is waiting" : "\(unique.count) updates are waiting"
        let names = unique.prefix(4).map(\.name).joined(separator: ", ")
        content.body = unique.count > 4 ? names + " and more" : names
        content.sound = .default
        let request = UNNotificationRequest(identifier: "updates-\(UUID().uuidString)",
                                            content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
