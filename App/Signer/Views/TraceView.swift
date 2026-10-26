import SwiftUI
import UIKit
import SignKit

/// The breadcrumb file from the last signing run, and the one before it. After Signer is closed
/// by iOS part-way through a job, this is where it says what it was doing.
struct TraceView: View {
    @AppStorage(SigningRunner.traceKey) private var writeTrace = true
    @State private var showing: Which = .last
    @State private var text = ""
    @State private var summary = ""

    enum Which: String, CaseIterable {
        case last = "Last run"
        case before = "The run before"

        var url: URL { self == .last ? Paths.trace : Paths.tracePrevious }
    }

    var body: some View {
        List {
            if Which.allCases.contains(where: { exists($0) }) {
                Picker("", selection: $showing) {
                    ForEach(Which.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))

                Section {
                    Text(summary.isEmpty ? "nothing recorded" : summary)
                        .font(.footnote)
                        .foregroundStyle(summary.hasPrefix("closed unexpectedly") ? .red : .primary)
                } header: {
                    Text("How it ended")
                }

                Section {
                    Button {
                        UIPasteboard.general.string = text
                    } label: {
                        Label("Copy it all", systemImage: "doc.on.doc")
                    }
                    ShareLink(item: showing.url) {
                        Label("Share the file", systemImage: "square.and.arrow.up")
                    }
                    Button(role: .destructive) {
                        try? FileManager.default.removeItem(at: showing.url)
                        load()
                    } label: {
                        Label("Delete this trace", systemImage: "trash")
                    }
                }

                Section("What it recorded") {
                    Text(text.isEmpty ? "empty" : text)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
            } else {
                Section {
                    Text(writeTrace
                         ? "Nothing yet. Sign an app and it will be recorded here."
                         : "Traces are switched off. Turn on \"Keep a trace while signing\" in Settings first.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Last run")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: load)
        .onChange(of: showing) { _ in load() }
    }

    func exists(_ which: Which) -> Bool {
        FileManager.default.fileExists(atPath: which.url.path)
    }

    func load() {
        if !exists(showing), exists(.before) { showing = .before }
        text = (try? String(contentsOf: showing.url, encoding: .utf8)) ?? ""
        summary = Trace.summary(of: showing.url) ?? ""
    }
}
