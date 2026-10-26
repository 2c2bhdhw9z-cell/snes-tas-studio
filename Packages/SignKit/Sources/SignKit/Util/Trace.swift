import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// A breadcrumb file written while a job runs, so that if the app is closed by iOS part-way
/// through — out of memory, or anything else that leaves no error behind — the file still says
/// exactly where it was.
///
/// Every line is flushed to disk as it is written, because a killed app's buffers are lost.
/// Per-file lines are rate-limited (a few a second), so a 120,000-file app costs a few hundred
/// writes rather than 120,000: the last line is then at most a fraction of a second old, which
/// is close enough to name the file it stopped on.
///
/// Off by default. The app turns it on (Settings, Troubleshooting) and says where the file goes.
public enum Trace {
    /// How often per-file lines may be written.
    static let everySeconds: Double = 0.2
    /// ... and at least one line per this many items, so a fast phase over a hundred thousand
    /// files still narrows a crash down to a couple of thousand of them.
    static let everyItems = 2000

    private final class State {
        let lock = NSLock()
        var handle: FileHandle?
        var started = Date()
        var lastWrite = Date.distantPast
        var lastIndex = -1
        var phase = ""
        var finished = false
    }

    private static let state = State()

    /// Whether anything is recorded at all. Reading it is a plain load, so a call on the hot
    /// path costs almost nothing when it is off.
    public static var isOn: Bool {
        get { onFlag.withLock { $0 } }
        set { onFlag.withLock { $0 = newValue } }
    }

    private static let onFlag = Locked(false)

    /// Starts a new trace at `url`, keeping the previous one beside it as `<name>-previous.txt`.
    /// The previous one is what survives a crash: the next run does not overwrite it.
    public static func start(at url: URL, what: String) {
        guard isOn else { return }
        let fm = FileManager.default
        state.lock.lock()
        defer { state.lock.unlock() }
        closeLocked()
        let previous = url.deletingPathExtension().path + "-previous." + url.pathExtension
        if fm.fileExists(atPath: url.path) {
            try? fm.removeItem(atPath: previous)
            try? fm.moveItem(atPath: url.path, toPath: previous)
        }
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard fm.createFile(atPath: url.path, contents: nil),
              let h = try? FileHandle(forWritingTo: url) else { return }
        state.handle = h
        state.started = Date()
        state.lastWrite = .distantPast
        state.lastIndex = -1
        state.phase = ""
        state.finished = false
        writeLocked("trace of \(what)")
        writeLocked("started \(ISO8601DateFormatter().string(from: state.started))")
    }

    /// One line, always written. Use for phases and anything rare.
    public static func note(_ text: String) {
        guard isOn else { return }
        state.lock.lock()
        defer { state.lock.unlock() }
        writeLocked(text)
    }

    /// A phase beginning. Always written, and remembered for the per-file lines.
    public static func phase(_ name: String) {
        guard isOn else { return }
        state.lock.lock()
        defer { state.lock.unlock() }
        state.phase = name
        state.lastIndex = -1
        writeLocked("--- \(name)")
    }

    /// Where a long, repetitive job is up to: written at most a few times a second.
    /// `index` counts from 0; `name` is the file or item being worked on. `total` may be 0 when
    /// the job does not know how many there are (packing walks the folders as it goes).
    public static func step(_ index: Int, of total: Int, _ name: String) {
        guard isOn else { return }
        state.lock.lock()
        defer { state.lock.unlock() }
        let now = Date()
        let farEnough = index - state.lastIndex >= Trace.everyItems
        guard farEnough || now.timeIntervalSince(state.lastWrite) >= everySeconds else { return }
        state.lastWrite = now
        state.lastIndex = index
        let position = total > 0 ? "\(index + 1) of \(total)" : "\(index + 1)"
        writeLocked("\(state.phase): \(position) — \(name)")
    }

    /// The job ended normally. The app reads this to tell a finished run from a killed one.
    public static func finish(_ text: String = "finished") {
        guard isOn else { return }
        state.lock.lock()
        defer { state.lock.unlock() }
        state.finished = true
        writeLocked("=== \(text)")
        closeLocked()
    }

    /// The job stopped with a reason of its own (an error, not a crash).
    public static func failed(_ reason: String) {
        guard isOn else { return }
        state.lock.lock()
        defer { state.lock.unlock() }
        state.finished = true
        writeLocked("=== stopped: \(reason)")
        closeLocked()
    }

    // MARK: - what the app shows

    /// How a trace file ended, in plain words, for the Settings row.
    /// `nil` when there is no such file.
    public static func summary(of url: URL) -> String? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        guard let last = lines.last.map(body) else { return nil }
        if last.hasPrefix("===") {
            let rest = String(last.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            return rest.hasPrefix("stopped: ") ? rest : "finished normally"
        }
        // No ending line at all: the app was closed before it could write one.
        let steps = lines.map(body).filter { !$0.hasPrefix("started ") && !$0.hasPrefix("trace of ") }
        return "closed unexpectedly at — " + (steps.last ?? last)
    }

    /// One line without its time stamp and memory figure.
    private static func body(_ line: String) -> String {
        var rest = Substring(line)
        while rest.first == " " { rest = rest.dropFirst() }
        if let space = rest.firstIndex(of: " ") { rest = rest[rest.index(after: space)...] }   // the time
        if rest.first == "[", let close = rest.firstIndex(of: "]") {                            // the memory
            rest = rest[rest.index(after: close)...]
            while rest.first == " " { rest = rest.dropFirst() }
        }
        return String(rest)
    }

    // MARK: - inside the lock

    /// How much memory this app is using right now, in bytes, or 0 when it cannot be read.
    /// On the phone this is the figure iOS kills an app over, so every trace line carries it:
    /// a run that dies with this climbing was killed for memory, and one that dies with it flat
    /// was not.
    public static func memoryNow() -> Int {
        #if canImport(Darwin)
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Int(info.phys_footprint) : 0
        #else
        // Linux (the test machine): resident pages out of /proc.
        guard let text = try? String(contentsOfFile: "/proc/self/statm", encoding: .utf8),
              let pages = text.split(separator: " ").dropFirst().first.flatMap({ Int($0) }) else { return 0 }
        return pages * 4096
        #endif
    }

    private static func writeLocked(_ text: String) {
        guard let h = state.handle else { return }
        let stamp = String(format: "%7.2fs ", Date().timeIntervalSince(state.started))
        let memory = memoryNow()
        let used = memory > 0 ? String(format: "[%5.0f MB] ", Double(memory) / 1_048_576) : ""
        guard let data = (stamp + used + text + "\n").data(using: .utf8) else { return }
        h.write(data)
        // A killed app's buffers are lost, so every line goes to the disk now.
        try? h.synchronize()
    }

    private static func closeLocked() {
        try? state.handle?.close()
        state.handle = nil
    }
}

/// A value behind a lock. Foundation's own `Mutex` is too new for the iOS versions this app runs on.
final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()
    init(_ value: Value) { self.value = value }
    func withLock<T>(_ body: (inout Value) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

/// Runs `body` inside an autorelease pool on the phone, and plainly on Linux (which has no such
/// thing). Every loop that reads a file a block at a time goes through this: without it, iOS
/// keeps every block read until the whole job ends, and a game with gigabytes of data files
/// grows the app until iOS kills it. See `CodeResources.hashesOfFile`.
@inline(__always)
func withPool<T>(_ body: () throws -> T) rethrows -> T {
    #if canImport(Darwin)
    return try autoreleasepool { try body() }
    #else
    return try body()
    #endif
}
