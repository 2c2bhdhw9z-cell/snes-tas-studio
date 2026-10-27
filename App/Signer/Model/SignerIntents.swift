import AppIntents
import Foundation
import SignKit

/// Shortcuts actions. Eleventh on docs/FEATURES.md, the first half.
///
/// Four things Shortcuts (and Siri) can do: sign an app that is already in My apps, install one,
/// read the repositories again, and ask what is out of date. Signing and installing open Signer
/// and start the job there on purpose - a Shortcuts action is given seconds of background time,
/// and signing a game takes minutes, so doing it inside the action would be killed half way.

/// An app in My apps, as something Shortcuts can pick from a list.
struct LibraryAppEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "App"
    static var defaultQuery = LibraryAppQuery()

    var id: UUID
    var name: String
    var version: String
    var isSigned: Bool

    var displayRepresentation: DisplayRepresentation {
        let state = isSigned ? "signed" : "not signed yet"
        return DisplayRepresentation(title: "\(name)", subtitle: "\(state) · \(version)")
    }

    init(_ app: LibraryApp) {
        id = app.id
        name = app.name
        version = app.version
        isSigned = app.isSigned
    }
}

struct LibraryAppQuery: EntityQuery {
    @MainActor
    func entities(for identifiers: [UUID]) async throws -> [LibraryAppEntity] {
        Store.shared.library.filter { identifiers.contains($0.id) }.map(LibraryAppEntity.init)
    }

    @MainActor
    func suggestedEntities() async throws -> [LibraryAppEntity] {
        Store.shared.library.map(LibraryAppEntity.init)
    }
}

/// Sign an app that is already in My apps, with the certificate Signer is set to use.
struct SignAppIntent: AppIntent {
    static var title: LocalizedStringResource = "Sign an app"
    static var description = IntentDescription("""
        Signs an app from My apps with the certificate Signer is set to use. Signer opens and \
        does the work, because signing a large app takes longer than a shortcut is allowed.
        """)
    static var openAppWhenRun = true

    @Parameter(title: "App")
    var app: LibraryAppEntity

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let found = Store.shared.library.first(where: { $0.id == app.id }) else {
            throw AppIntentError.notFound
        }
        NotificationCenter.default.post(name: .signThisApp, object: found.id)
        let words = "Signing \(found.name) in Signer."
        return .result(dialog: IntentDialog("\(words)"))
    }
}

/// Install an app that has already been signed.
struct InstallAppIntent: AppIntent {
    static var title: LocalizedStringResource = "Install an app"
    static var description = IntentDescription("""
        Hands a signed app from My apps to iOS to install. Signer opens to serve the app from \
        the phone.
        """)
    static var openAppWhenRun = true

    @Parameter(title: "App")
    var app: LibraryAppEntity

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let found = Store.shared.library.first(where: { $0.id == app.id }) else {
            throw AppIntentError.notFound
        }
        guard found.isSigned else {
            let no = "\(found.name) is not signed yet, so it cannot be installed."
            return .result(dialog: IntentDialog("\(no)"))
        }
        Store.shared.pendingInstall = found
        let words = "Installing \(found.name)."
        return .result(dialog: IntentDialog("\(words)"))
    }
}

/// Read every repository again and say what is out of date.
struct RefreshSourcesIntent: AppIntent {
    static var title: LocalizedStringResource = "Check my sources"
    static var description = IntentDescription("""
        Reads every repository again and says which of your apps have a newer version waiting.
        """)
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Int> {
        let store = Store.shared
        await SourceLoader.shared.refreshAll(store.sources)
        let waiting = store.library.filter { SourceLoader.shared.update(for: $0) != nil }
        let words: String
        switch waiting.count {
        case 0: words = "Everything is up to date."
        case 1: words = "\(waiting[0].name) has a newer version waiting."
        default:
            let names = waiting.prefix(4).map(\.name).joined(separator: ", ")
            words = "\(waiting.count) apps have a newer version waiting: \(names)"
        }
        return .result(value: waiting.count, dialog: IntentDialog("\(words)"))
    }
}

/// What is out of date, without reading the repositories again.
struct UpdatesWaitingIntent: AppIntent {
    static var title: LocalizedStringResource = "Updates waiting"
    static var description = IntentDescription("""
        Says how many of your apps have a newer version waiting, using what Signer already knows.
        """)
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Int> {
        let waiting = Store.shared.library.filter { SourceLoader.shared.update(for: $0) != nil }
        let names = waiting.prefix(4).map(\.name).joined(separator: ", ")
        let words = waiting.isEmpty ? "Nothing is waiting." : "\(waiting.count) waiting: \(names)"
        return .result(value: waiting.count, dialog: IntentDialog("\(words)"))
    }
}

enum AppIntentError: Swift.Error, CustomLocalizedStringResourceConvertible {
    case notFound

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notFound: return "That app is not in My apps any more."
        }
    }
}

/// The phrases Siri and Shortcuts offer without any setting up.
struct SignerShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: RefreshSourcesIntent(),
                    phrases: ["Check my sources in \(.applicationName)",
                              "Check for app updates in \(.applicationName)"],
                    shortTitle: "Check my sources",
                    systemImageName: "arrow.clockwise")
        AppShortcut(intent: UpdatesWaitingIntent(),
                    phrases: ["What is waiting in \(.applicationName)",
                              "Updates waiting in \(.applicationName)"],
                    shortTitle: "Updates waiting",
                    systemImageName: "bell.badge")
        AppShortcut(intent: SignAppIntent(),
                    phrases: ["Sign an app with \(.applicationName)"],
                    shortTitle: "Sign an app",
                    systemImageName: "signature")
        AppShortcut(intent: InstallAppIntent(),
                    phrases: ["Install an app with \(.applicationName)"],
                    shortTitle: "Install an app",
                    systemImageName: "arrow.down.app")
    }
}
