import SwiftUI

/// Signer's own look. Separate from `SigningOptions.appearance`, which forces the look of an
/// app being signed — this one is only how Signer itself draws.
enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark

    /// Where the choice is kept, so Settings and the root screen agree.
    static let key = "appTheme"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var symbol: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max"
        case .dark: return "moon"
        }
    }

    /// nil means "whatever the phone is set to", which is what SwiftUI wants for Follow phone.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    static func named(_ raw: String) -> AppTheme { AppTheme(rawValue: raw) ?? .system }
}
