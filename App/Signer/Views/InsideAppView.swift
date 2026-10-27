import SwiftUI
import SignKit

/// What is inside an app: every program in it, everything each one links, and what the
/// signature already in it says. Fifth on docs/FEATURES.md (ABox has this).
///
/// Anything the app carries itself can be marked to be taken out while signing, which is how
/// an add-on someone else injected gets removed.
struct InsideAppView: View {
    let ipa: URL
    @Binding var removeLibraries: [String]

    @State private var reports: [BinaryReport]?
    @State private var problem: String?

    var body: some View {
        List {
            if let problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.red)
                }
            } else if reports == nil {
                Section {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Reading the app…").foregroundStyle(.secondary)
                    }
                }
            } else if reports?.isEmpty == true {
                Section {
                    Text("No programs found inside this file.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            ForEach(reports ?? []) { report in
                Section {
                    LabeledContent("Built for", value: report.architectures.joined(separator: ", "))
                    if let min = report.minimumOS {
                        LabeledContent("Needs iOS", value: min)
                    }
                    LabeledContent("Size", value: ByteCountFormatter.string(
                        fromByteCount: Int64(report.bytes), countStyle: .file))
                    if report.isEncrypted {
                        Label("Still locked by the App Store, so signing it will not make it run.",
                              systemImage: "lock")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    signatureRows(report)
                    linkRows(report)
                } header: {
                    HStack {
                        Text(report.name)
                        if report.isMainProgram {
                            Text("the app itself").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Inside the app")
        .navigationBarTitleDisplayMode(.inline)
        .task { await read() }
    }

    @ViewBuilder
    func signatureRows(_ report: BinaryReport) -> some View {
        if let facts = report.signature {
            LabeledContent("Signed as", value: facts.identifier.isEmpty ? "-" : facts.identifier)
            if let team = facts.teamID {
                LabeledContent("Team", value: team)
            }
            LabeledContent("Signature", value: facts.isAdHoc
                           ? "no certificate (ad-hoc)" : "with a certificate")
            LabeledContent("Checked in", value: "\(facts.pageHashes) pieces")
            LabeledContent("Hashes", value: facts.hashKind)
            LabeledContent("Permissions inside", value: facts.hasEntitlements ? "yes" : "none")
        } else if report.signatureUnread {
            Text("Too big to read the signature here.")
                .font(.caption).foregroundStyle(.secondary)
        } else {
            Text("Not signed.").font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    func linkRows(_ report: BinaryReport) -> some View {
        let carried = report.links.filter { !BinaryReport.isSystem($0) }
        let system = report.links.filter { BinaryReport.isSystem($0) }
        if !carried.isEmpty {
            DisclosureGroup("Carried inside the app (\(carried.count))") {
                ForEach(carried, id: \.self) { link in
                    Toggle(isOn: binding(for: link)) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text((link as NSString).lastPathComponent)
                                .font(.callout)
                            Text(link).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                        }
                    }
                }
                Text("Switch one on to take it out while signing. Add-ons someone else injected "
                     + "live here; so do the app's own frameworks, which it needs.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        if !system.isEmpty {
            DisclosureGroup("Part of iOS (\(system.count))") {
                ForEach(system, id: \.self) { link in
                    Text((link as NSString).lastPathComponent)
                        .font(.caption)
                }
            }
        }
        if !report.rpaths.isEmpty {
            DisclosureGroup("Where it looks for them (\(report.rpaths.count))") {
                ForEach(report.rpaths, id: \.self) { path in
                    Text(path).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    func binding(for link: String) -> Binding<Bool> {
        Binding(
            get: { removeLibraries.contains(link) },
            set: { wanted in
                removeLibraries.removeAll { $0 == link }
                if wanted { removeLibraries.append(link) }
            })
    }

    func read() async {
        guard reports == nil else { return }
        let url = ipa
        let outcome: ([BinaryReport], String?) = await Task.detached(priority: .userInitiated) {
            do {
                // 64 MB: big enough for ordinary programs, small enough that a huge game's
                // main program does not have to be read end to end on a phone.
                return (try BinaryReport.read(ipa: url, signatureLimit: 64 << 20), nil)
            } catch let error as SignKitError {
                return ([], error.description)
            } catch {
                return ([], error.localizedDescription)
            }
        }.value
        if let message = outcome.1 {
            problem = message
        } else {
            reports = outcome.0
        }
    }
}
