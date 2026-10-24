import SwiftUI
import UniformTypeIdentifiers
import SignKit

/// Certificates: add one, see how long it has left, check whether Apple killed it.
struct CertificatesView: View {
    @EnvironmentObject var store: Store
    @State private var showAdd = false
    @State private var checking = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if store.certificates.isEmpty {
                    Section {
                        Text("A certificate is the ID file that lets an app install on your phone. "
                             + "You need a \".p12\" file and usually a \".mobileprovision\" file with it.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                ForEach(store.certificates) { cert in
                    NavigationLink {
                        CertificateDetailView(certificate: cert)
                    } label: {
                        CertificateRow(cert: cert, isSelected: cert.id == store.selectedCertificateID)
                    }
                }
                .onDelete { idx in idx.map { store.certificates[$0] }.forEach(store.deleteCertificate) }

                if !store.certificates.isEmpty {
                    Section {
                        Button {
                            Task { await checkAll() }
                        } label: {
                            if checking {
                                Label("Checking with Apple…", systemImage: "arrow.triangle.2.circlepath")
                            } else {
                                Label("Check if Apple turned these off", systemImage: "shield.checkered")
                            }
                        }
                        .disabled(checking)
                    } footer: {
                        Text("This asks Apple directly, so it catches a dead certificate even when the date still looks fine.")
                    }
                }
            }
            .navigationTitle("Certificates")
            .toolbar {
                Button { showAdd = true } label: { Label("Add", systemImage: "plus") }
            }
            .sheet(isPresented: $showAdd) { AddCertificateView() }
            .alert("That did not work", isPresented: .constant(errorMessage != nil)) {
                Button("OK") { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
        }
    }

    func checkAll() async {
        checking = true
        for index in store.certificates.indices {
            let cert = store.certificates[index]
            do {
                let identity = try store.identity(for: cert)
                guard let leaf = identity.chain.first else { continue }
                // Apple's answer needs the certificate above this one; the profile carries it.
                let issuer = identity.chain.count > 1 ? identity.chain[1] : leaf
                let answer = await OCSP.check(certificate: leaf, issuer: issuer)
                store.certificates[index].revocationState = {
                    switch answer.status {
                    case .good: return .good
                    case .revoked: return leaf.isExpired ? .expired : .revoked
                    case .unknown: return .unknown
                    case .unreachable: return .offline
                    }
                }()
                store.certificates[index].lastChecked = answer.checkedAt
            } catch {
                errorMessage = (error as? SignKitError)?.description ?? error.localizedDescription
            }
        }
        store.save()
        checking = false
    }
}

struct CertificateRow: View {
    let cert: StoredCertificate
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(colour)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(cert.nickname).font(.body.weight(.medium))
                Text(cert.statusLine).font(.caption).foregroundStyle(colour)
                if let team = cert.teamID {
                    Text("Team \(team)").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if isSelected { Image(systemName: "checkmark").foregroundStyle(.tint) }
        }
    }

    var icon: String {
        switch cert.revocationState {
        case .revoked: return "xmark.seal"
        case .expired: return "clock.badge.xmark"
        case .good: return "checkmark.seal"
        default: return "seal"
        }
    }

    var colour: Color {
        switch cert.revocationState {
        case .revoked, .expired: return .red
        case .good: return (cert.daysLeft ?? 99) < 7 ? .orange : .green
        default: return (cert.daysLeft ?? 99) < 0 ? .red : .secondary
        }
    }
}

struct CertificateDetailView: View {
    @EnvironmentObject var store: Store
    let certificate: StoredCertificate

    var body: some View {
        List {
            Section("What this is") {
                LabeledContent("Name", value: certificate.commonName)
                if let team = certificate.teamID { LabeledContent("Team", value: team) }
                if let apple = certificate.appleID { LabeledContent("Apple ID", value: apple) }
                LabeledContent("Status", value: certificate.statusLine)
                if let checked = certificate.lastChecked {
                    LabeledContent("Last checked", value: checked.formatted(date: .abbreviated, time: .shortened))
                }
            }
            Section("Profile") {
                if let name = certificate.profileName {
                    LabeledContent("Name", value: name)
                } else {
                    Text("No profile was added with this certificate. Most apps will not install without one.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                if let pattern = certificate.bundleIDPattern {
                    LabeledContent("Allows app IDs", value: pattern)
                }
                if let count = certificate.deviceCount {
                    LabeledContent("Phones allowed", value: "\(count)")
                } else if certificate.profileName != nil {
                    LabeledContent("Phones allowed", value: "any")
                }
                if let expiry = certificate.profileExpires {
                    LabeledContent("Profile ends", value: expiry.formatted(date: .abbreviated, time: .omitted))
                }
            }
            Section {
                Button("Use this one for signing") {
                    store.selectedCertificateID = certificate.id
                    store.save()
                }
                Button("Remove", role: .destructive) { store.deleteCertificate(certificate) }
            }
            Section("Fingerprint") {
                Text(certificate.sha256).font(.footnote.monospaced()).textSelection(.enabled)
            }
        }
        .navigationTitle(certificate.nickname)
    }
}

struct AddCertificateView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss

    @State private var p12: URL?
    @State private var profile: URL?
    @State private var password = ""
    @State private var nickname = ""
    @State private var errorMessage: String?
    @State private var picking: Picking?

    enum Picking: Identifiable { case p12, profile; var id: Int { self == .p12 ? 0 : 1 } }

    var body: some View {
        NavigationStack {
            Form {
                Section("Files") {
                    Button {
                        picking = .p12
                    } label: {
                        LabeledContent("Certificate (.p12)", value: p12?.lastPathComponent ?? "choose")
                    }
                    Button {
                        picking = .profile
                    } label: {
                        LabeledContent("Profile (.mobileprovision)", value: profile?.lastPathComponent ?? "choose")
                    }
                }
                Section("Password") {
                    SecureField("Certificate password", text: $password)
                    Text("Leave this empty if the certificate has no password.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Name it (optional)") {
                    TextField("For example: work certificate", text: $nickname)
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add a certificate")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { add() }.disabled(p12 == nil)
                }
            }
            .fileImporter(isPresented: Binding(get: { picking != nil },
                                               set: { if !$0 { picking = nil } }),
                          allowedContentTypes: contentTypes) { result in
                if case .success(let url) = result {
                    if picking == .p12 { p12 = url } else { profile = url }
                }
                picking = nil
            }
        }
    }

    var contentTypes: [UTType] {
        picking == .profile
            ? [UTType(filenameExtension: "mobileprovision") ?? .data]
            : [UTType(filenameExtension: "p12") ?? .data, UTType(filenameExtension: "pfx") ?? .data]
    }

    func add() {
        guard let p12 else { return }
        do {
            _ = try store.importCertificate(p12: p12, password: password, profile: profile,
                                            nickname: nickname.isEmpty ? nil : nickname)
            dismiss()
        } catch let e as SignKitError {
            error = e.description
        } catch let other {
            error = other.localizedDescription
        }
    }
}
