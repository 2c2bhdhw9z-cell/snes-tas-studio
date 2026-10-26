import SwiftUI
import SignKit

/// One permission added by hand on top of the ones the certificate's profile grants.
struct ExtraEntitlement: Identifiable, Hashable {
    enum Value: Hashable {
        case on
        case off
        case text(String)
        case list([String])
    }

    var id = UUID()
    var key: String
    var value: Value

    /// What goes into the app's permissions file.
    var plistValue: Any {
        switch value {
        case .on: return true
        case .off: return false
        case .text(let s): return s
        case .list(let items): return items
        }
    }

    var shown: String {
        switch value {
        case .on: return "on"
        case .off: return "off"
        case .text(let s): return s
        case .list(let items): return items.joined(separator: ", ")
        }
    }
}

/// The permissions editor: the third thing on docs/FEATURES.md's list. The engine has taken
/// `extraEntitlements` since the start; this is the screen for it.
///
/// Permissions (Apple calls them entitlements) are what an app is allowed to do. They come from
/// the profile paired with the certificate; anything added here is merged on top when signing.
struct EntitlementsView: View {
    @EnvironmentObject var store: Store
    @Binding var extras: [ExtraEntitlement]

    @State private var granted: [String: String] = [:]
    @State private var newKey = ""
    @State private var newText = ""
    @State private var newKind = Kind.on

    enum Kind: String, CaseIterable, Identifiable {
        case on = "On"
        case off = "Off"
        case text = "Text"
        case list = "List"
        var id: String { rawValue }
    }

    /// The handful worth a one-tap switch, with what they actually do in plain words.
    static let common: [(key: String, label: String, note: String)] = [
        ("get-task-allow", "Let a debugger attach",
         "Needed to attach Xcode or a debugger. Development profiles grant this."),
        ("com.apple.developer.kernel.increased-memory-limit", "Allow extra memory",
         "Lets the app use more memory than iOS normally allows. Emulators and big games want this."),
        ("com.apple.developer.kernel.extended-virtual-addressing", "Allow very large memory addresses",
         "Goes with extra memory for apps that map huge amounts at once."),
        ("com.apple.security.get-task-allow", "Let a debugger attach (older name)",
         "Some older apps look for this spelling."),
        ("dynamic-codesigning", "Allow making code as it runs (JIT)",
         "What an emulator's fast mode needs. Apple only grants this to a few apps: on an "
         + "ordinary certificate adding it usually stops the app installing."),
    ]

    var body: some View {
        List {
            Section("What your certificate allows") {
                if granted.isEmpty {
                    Text("No profile imported yet, so there is nothing to read. Import your "
                         + ".mobileprovision on the File tab.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(granted.keys.sorted(), id: \.self) { key in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(EntitlementsView.friendlyName(key)).font(.callout)
                            Text(key).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                            if let value = granted[key], !value.isEmpty {
                                Text(value).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                    }
                }
            }

            Section("Common extras") {
                ForEach(EntitlementsView.common, id: \.key) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Toggle(item.label, isOn: binding(for: item.key))
                        Text(item.note).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }

            Section("Add your own") {
                LabeledContent("Name") {
                    TextField("com.apple.developer.something", text: $newKey)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Picker("Value", selection: $newKind) {
                    ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
                }
                if newKind == .text || newKind == .list {
                    LabeledContent(newKind == .list ? "Items (comma separated)" : "Text") {
                        TextField(newKind == .list ? "one, two" : "value", text: $newText)
                            .multilineTextAlignment(.trailing)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }
                }
                Button("Add it") { add() }
                    .disabled(newKey.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            if !handAdded.isEmpty {
                Section("Added by hand") {
                    ForEach(handAdded) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.key).font(.callout).lineLimit(1)
                            Text(item.shown).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .onDelete { indexes in
                        let doomed = indexes.map { handAdded[$0].id }
                        extras.removeAll { doomed.contains($0.id) }
                    }
                }
            }

            Section {
                Label("A permission your certificate does not allow can stop the app installing, "
                      + "or make it close as it opens. If an app stops working after you add one, "
                      + "sign it again with this list empty.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .navigationTitle("Permissions")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: readProfile)
    }

    /// The ones that are not in the common list, so the two sections do not repeat each other.
    var handAdded: [ExtraEntitlement] {
        let commonKeys = Set(EntitlementsView.common.map(\.key))
        return extras.filter { !commonKeys.contains($0.key) }
    }

    func binding(for key: String) -> Binding<Bool> {
        Binding(
            get: { extras.contains { $0.key == key && $0.value == .on } },
            set: { wanted in
                extras.removeAll { $0.key == key }
                if wanted { extras.append(ExtraEntitlement(key: key, value: .on)) }
            })
    }

    func add() {
        let key = newKey.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { return }
        let value: ExtraEntitlement.Value
        switch newKind {
        case .on: value = .on
        case .off: value = .off
        case .text: value = .text(newText)
        case .list:
            value = .list(newText.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty })
        }
        extras.removeAll { $0.key == key }
        extras.append(ExtraEntitlement(key: key, value: value))
        newKey = ""
        newText = ""
    }

    /// Reads the permissions out of the profile paired with the chosen certificate.
    func readProfile() {
        guard let cert = store.selectedCertificate,
              let stored = store.profile(for: cert),
              let profile = try? ProvisioningProfile(url: store.profileURL(for: stored)) else {
            granted = [:]
            return
        }
        var found: [String: String] = [:]
        for (key, value) in profile.entitlements {
            found[key] = EntitlementsView.describe(value)
        }
        granted = found
    }

    static func describe(_ value: Any) -> String {
        switch value {
        case let b as Bool: return b ? "on" : "off"
        case let s as String: return s
        case let n as NSNumber: return n.stringValue
        case let list as [Any]: return list.map { describe($0) }.joined(separator: ", ")
        case let dict as [String: Any]: return dict.keys.sorted().joined(separator: ", ")
        default: return ""
        }
    }

    /// Plain words for the permissions that turn up most.
    static func friendlyName(_ key: String) -> String {
        switch key {
        case "application-identifier", "com.apple.application-identifier":
            return "Which app this is"
        case "com.apple.developer.team-identifier": return "Which team signed it"
        case "get-task-allow", "com.apple.security.get-task-allow":
            return "A debugger may attach"
        case "keychain-access-groups": return "Shared passwords"
        case "com.apple.security.application-groups": return "Shared storage with its extras"
        case "com.apple.developer.kernel.increased-memory-limit": return "Extra memory"
        case "com.apple.developer.kernel.extended-virtual-addressing":
            return "Very large memory addresses"
        case "aps-environment", "com.apple.developer.aps-environment": return "Push messages"
        case "com.apple.developer.icloud-container-identifiers": return "iCloud storage"
        case "com.apple.developer.ubiquity-kvstore-identifier": return "iCloud settings"
        case "com.apple.developer.networking.multicast": return "Talking to devices on the network"
        case "com.apple.developer.associated-domains": return "Links that open the app"
        case "dynamic-codesigning": return "Making code as it runs (JIT)"
        default:
            // "com.apple.developer.healthkit" reads as "healthkit".
            return key.split(separator: ".").last.map(String.init) ?? key
        }
    }
}
