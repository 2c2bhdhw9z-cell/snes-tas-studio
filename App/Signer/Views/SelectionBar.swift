import SwiftUI

/// The check on the left of a row while several rows are being chosen.
///
/// Drawn by hand rather than with `List(selection:)` and `EditMode`: those rows have their own
/// buttons in them (Install, Update, Sign), and in edit mode those buttons still take the tap,
/// so a row could not be chosen by tapping it. This way choosing a row is the same gesture on
/// every screen, and the row's own buttons simply step aside while it is on.
struct SelectionCheck: View {
    let isOn: Bool

    var body: some View {
        Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
            .font(.title3)
            .foregroundStyle(isOn ? Color.accentColor : Color.secondary)
            .frame(width: 26)
            .accessibilityHidden(true)
    }
}

/// The bar along the bottom while rows are being chosen: how many are picked, a way to pick
/// every one at once, and Delete.
///
/// Shared by the File tab, My apps and Sources so the three behave the same — the words change
/// ("file", "app", "source"), nothing else does.
struct SelectionBar: View {
    let count: Int
    /// "file", "app", "source" — used for the words only.
    let unit: String
    /// True when every row on screen is already picked, so the button can say None.
    let allOn: Bool
    let selectAll: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Button(allOn ? "None" : "All", action: selectAll)
                .buttonStyle(.borderless)

            Spacer(minLength: 8)

            Text(pickedText)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(count == 0 ? .secondary : .primary)

            Spacer(minLength: 8)

            Button(role: .destructive, action: delete) {
                Label("Delete", systemImage: "trash")
            }
            .buttonStyle(.borderless)
            .disabled(count == 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    var pickedText: String {
        guard count > 0 else { return "Choose \(unit)s" }
        return "\(count) \(unit)" + (count == 1 ? "" : "s")
    }
}

extension Array where Element: Identifiable {
    /// The rows whose IDs are picked, in the order they are shown. Taken before deleting, so
    /// the list can change underneath without the wrong rows being removed.
    func picked(_ ids: Set<Element.ID>) -> [Element] {
        filter { ids.contains($0.id) }
    }
}
