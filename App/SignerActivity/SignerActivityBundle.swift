import WidgetKit
import SwiftUI
import ActivityKit

/// The extension that draws signing progress in the Dynamic Island and on the lock screen.
/// Seventh on docs/FEATURES.md (BatSign has this).
@main
struct SignerActivityBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.1, *) {
            SigningLiveActivity()
        }
    }
}

@available(iOS 16.1, *)
struct SigningLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SigningActivityAttributes.self) { context in
            // The lock screen and the banner at the top of the screen.
            HStack(spacing: 12) {
                Image(systemName: symbol(context.state))
                    .font(.title2)
                    .foregroundStyle(tint(context.state))
                VStack(alignment: .leading, spacing: 4) {
                    Text(context.attributes.appName)
                        .font(.headline)
                        .lineLimit(1)
                    Text(context.state.step)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if !context.state.finished {
                        ProgressView(value: context.state.fraction)
                            .tint(tint(context.state))
                    }
                }
                Spacer()
                if !context.state.finished {
                    Text("\(Int(context.state.fraction * 100))%")
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
            .activityBackgroundTint(nil)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: symbol(context.state))
                        .foregroundStyle(tint(context.state))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.finished {
                        Text(context.state.failed ? "stopped" : "done")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("\(Int(context.state.fraction * 100))%")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.appName)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        if !context.state.finished {
                            ProgressView(value: context.state.fraction)
                                .tint(tint(context.state))
                        }
                        Text(context.state.step)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            } compactLeading: {
                Image(systemName: symbol(context.state))
                    .foregroundStyle(tint(context.state))
            } compactTrailing: {
                if context.state.finished {
                    Image(systemName: context.state.failed ? "xmark" : "checkmark")
                        .foregroundStyle(tint(context.state))
                } else {
                    Text("\(Int(context.state.fraction * 100))%")
                        .font(.caption2.monospacedDigit())
                }
            } minimal: {
                Image(systemName: symbol(context.state))
                    .foregroundStyle(tint(context.state))
            }
        }
    }

    func symbol(_ state: SigningActivityAttributes.ContentState) -> String {
        if state.failed { return "exclamationmark.triangle" }
        if state.finished { return "checkmark.seal" }
        return "signature"
    }

    func tint(_ state: SigningActivityAttributes.ContentState) -> Color {
        if state.failed { return .red }
        if state.finished { return .green }
        return .accentColor
    }
}
