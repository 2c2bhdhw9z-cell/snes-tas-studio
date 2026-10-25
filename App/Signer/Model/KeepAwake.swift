import Foundation
import UIKit
import AVFoundation

/// Keeps a long sign/import/install alive when the screen locks or the user checks
/// another app. A multi-gigabyte app can take longer than iOS's ordinary 30-second
/// grace period, so (when enabled) a silent audio loop keeps the work alive exactly
/// while a job is running. It stops the instant the last job ends.
@MainActor
final class KeepAwake {
    private var taskID: UIBackgroundTaskIdentifier = .invalid
    private var player: AVAudioPlayer?
    private var depth = 0

    static let shared = KeepAwake()

    func begin(_ reason: String) {
        depth += 1
        guard depth == 1 else { return }

        taskID = UIApplication.shared.beginBackgroundTask(withName: reason) { [weak self] in
            Task { @MainActor in self?.endNow() }
        }
        UIApplication.shared.isIdleTimerDisabled = true

        let setting = UserDefaults.standard.object(forKey: "keepLongJobsRunning") as? Bool ?? true
        guard setting, let sound = Bundle.main.url(forResource: "silence", withExtension: "wav") else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            let p = try AVAudioPlayer(contentsOf: sound)
            p.numberOfLoops = -1
            p.volume = 0.01
            p.prepareToPlay()
            p.play()
            player = p
        } catch {
            // The ordinary background task still gives the job a little time. Failure
            // to start the silent loop is not a reason to throw away a signing run.
            player = nil
        }
    }

    func end() {
        depth = max(0, depth - 1)
        guard depth == 0 else { return }
        endNow()
    }

    private func endNow() {
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        UIApplication.shared.isIdleTimerDisabled = false
        if taskID != .invalid {
            UIApplication.shared.endBackgroundTask(taskID)
            taskID = .invalid
        }
        depth = 0
    }
}
