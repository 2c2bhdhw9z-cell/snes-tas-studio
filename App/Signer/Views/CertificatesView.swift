import SwiftUI
import SignKit

/// Certificate Management: the same plain list ESign shows — who the certificate is,
/// when it ends, and one word for whether it still works.
struct CertificatesView: View {
    @EnvironmentObject var store: Store
    @State private var checking = false
    @State private var banner: String?

    var body: some View {
        List {
            if store.certificates.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No certificate yet").font(.headline)
                        Text("Open the File tab, tap your .p12, choose Import Certificate Management "
                             + "and type its password. Then tap your .mobileprovision and choose Import. "
                             + "They pair up on their own.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            }

            ForEach(store.certificates) { cert in
                NavigationLink {
                    CertificateDetailView(certificate: cert)
                } label: {
                    CertificateRow(cert: cert,
                                   profile: store.profile(for: cert),
                                   isSelected: cert.id == store.selectedCertificateID)
                }
            }
            .onDelete { idx in idx.map { store.certificates[$0] }.forEach(store.deleteCertificate) }

            if !store.profiles.isEmpty {
                Section("Profiles") {
                    ForEach(store.profiles) { profile in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(profile.name).font(.callout)
                            Text(profile.summary).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .onDelete { idx in idx.map { store.profiles[$0] }.forEach(store.deleteProfile) }
                }
            }

            if !store.certificates.isEmpty {
                Section {
                    Button {
                        Task { await checkAll() }
                    } label: {
                        if checking {
                            Label("Asking Apple…", systemImage: "arrow.triangle.2.circlepath")
                        } else {
                            Label("Check these with Apple", systemImage: "shield.checkered")
                        }
                    }
                    .disabled(checking)
                } footer: {
                    Text("Asks Apple directly, so a certificate that has been switched off shows up "
                         + "even while its dates still look fine.")
                }
            }
        }
        .navigationTitle("Certificate Management")
        .overlay(alignment: .bottom) {
            if let banner {
                Text(banner)
                    .font(.callout)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 12)
            }
        }
    }

    func checkAll() async {
        checking = true
        for index in store.certificates.indices {
            let cert = store.certificates[index]
            do {
                let identity = try store.identity(for: cert)
                guard let leaf = identity.chain.first else { continue }
                // The issuer is found from what came with the certificate and from Apple's own
                // certificates, which are built in: a .p12 holding only the certificate used to
                // make the question unanswerable, and the result read as "Unchecked".
                let answer = await OCSP.check(certificate: leaf, chain: identity.chain)
                store.certificates[index].revocationState = {
                    switch answer.status {
                    case .good: return .good
                    case .revoked: return leaf.isExpired ? .expired : .revoked
                    case .unknown: return .unknown
                    case .unreachable: return .offline
                    }
                }()
                store.certificates[index].lastChecked = answer.checkedAt
                store.certificates[index].lastCheckDetail = answer.detail
                if answer.status != .good, !answer.detail.isEmpty { banner = answer.detail }
            } catch {
                banner = (error as? SignKitError)?.description ?? error.localizedDescription
            }
        }
        store.save()
        checking = false
    }
}

struct CertificateRow: View {
    let cert: StoredCertificate
    let profile: StoredProfile?
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(cert.title)
                .font(.callout)
                .lineLimit(2)
            HStack {
                Text("Expiration: \(cert.expiryText)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(cert.statusWord)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(colour)
            }
            HStack(spacing: 6) {
                if profile == nil {
                    Text("no profile paired yet")
                        .font(.caption2).foregroundStyle(.orange)
                } else if let pattern = profile?.bundleIDPattern {
                    Text(pattern).font(.caption2).foregroundStyle(.tertiary)
                }
                if isSelected {
                    Text("· signing with this one").font(.caption2).foregroundStyle(.tint)
                }
            }
        }
        .padding(.vertical, 2)
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
    @Environment(\.dismiss) var dismiss
    let certificate: StoredCertificate

    var profile: StoredProfile? { store.profile(for: certificate) }

    var body: some View {
        List {
            Section("Certificate") {
                LabeledContent("Name", value: certificate.commonName)
                if let team = certificate.teamID { LabeledContent("Team", value: team) }
                if let apple = certificate.appleID { LabeledContent("Apple ID", value: apple) }
                LabeledContent("Expiration", value: certificate.expiryText)
                LabeledContent("Status", value: certificate.statusWord)
                if let checked = certificate.lastChecked {
                    LabeledContent("Checked", value: checked.formatted(date: .abbreviated, time: .shortened))
                }
                if let detail = certificate.lastCheckDetail, !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Profile") {
                if let profile {
                    LabeledContent("Name", value: profile.name)
                    if let pattern = profile.bundleIDPattern { LabeledContent("Apps allowed", value: pattern) }
                    LabeledContent("Devices", value: profile.deviceCount.map(String.init) ?? "any")
                    if let e = profile.expires {
                        LabeledContent("Ends", value: e.formatted(date: .abbreviated, time: .omitted))
                    }
                } else {
                    Text("None paired. Import the matching .mobileprovision from the File tab and it "
                         + "will attach itself to this certificate.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }

            Section {
                Button("Sign with this one") {
                    store.selectedCertificateID = certificate.id
                    store.save()
                }
                Button("Remove", role: .destructive) {
                    store.deleteCertificate(certificate)
                    dismiss()
                }
            }

            Section("Fingerprint") {
                Text(certificate.sha256).font(.footnote.monospaced()).textSelection(.enabled)
            }
        }
        .navigationTitle("Certificate")
        .navigationBarTitleDisplayMode(.inline)
    }
}
