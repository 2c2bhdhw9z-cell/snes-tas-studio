import Foundation

/// Comparing version numbers the way a person reads them.
///
/// Needed to tell whether a source is offering something newer than the copy already here.
/// Plain text comparison gets this wrong in the obvious place: "1.10" sorts before "1.9"
/// because "1" is before "9", but 1.10 is the newer app.
public enum Version {
    /// True when `candidate` is later than `installed`.
    public static func isNewer(_ candidate: String, than installed: String) -> Bool {
        compare(candidate, installed) == .orderedDescending
    }

    public static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let left = parts(of: a)
        let right = parts(of: b)
        for index in 0..<max(left.numbers.count, right.numbers.count) {
            let l = index < left.numbers.count ? left.numbers[index] : 0
            let r = index < right.numbers.count ? right.numbers[index] : 0
            if l != r { return l < r ? .orderedAscending : .orderedDescending }
        }
        // Same numbers. A plain version beats one with something stuck on the end:
        // 1.0 is the finished thing, 1.0-beta2 came before it.
        switch (left.suffix.isEmpty, right.suffix.isEmpty) {
        case (true, true): return .orderedSame
        case (true, false): return .orderedDescending
        case (false, true): return .orderedAscending
        case (false, false):
            if left.suffix == right.suffix { return .orderedSame }
            return left.suffix < right.suffix ? .orderedAscending : .orderedDescending
        }
    }

    /// "1.10.2-beta3" becomes [1, 10, 2] and "beta3". Anything that is not a digit ends a
    /// number; once a letter turns up, the rest is the suffix.
    private static func parts(of text: String) -> (numbers: [Int], suffix: String) {
        var numbers: [Int] = []
        var current = ""
        var suffix = ""
        var inSuffix = false
        var trimmed = Substring(text.trimmingCharacters(in: .whitespaces))
        // Sources write "v2.1" as often as "2.1".
        if let first = trimmed.first, first == "v" || first == "V",
           trimmed.dropFirst().first?.isNumber == true {
            trimmed = trimmed.dropFirst()
        }
        for character in trimmed {
            if inSuffix {
                suffix.append(character)
                continue
            }
            if character.isNumber {
                current.append(character)
            } else if character == "." || character == "_" || character == "-" || character == "+" {
                if !current.isEmpty { numbers.append(Int(current) ?? 0); current = "" }
                // A dash or plus before letters starts the suffix, a dot just separates numbers.
                if character == "-" || character == "+" { inSuffix = true }
            } else {
                if !current.isEmpty { numbers.append(Int(current) ?? 0); current = "" }
                inSuffix = true
                suffix.append(character)
            }
        }
        if !current.isEmpty { numbers.append(Int(current) ?? 0) }
        return (numbers, suffix.lowercased())
    }
}
