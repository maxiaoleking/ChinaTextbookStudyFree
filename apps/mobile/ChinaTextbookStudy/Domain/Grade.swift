import Foundation

/// Answer grading — 1:1 port of packages/core/src/grade.ts.
///
/// Tolerances:
///   - whitespace, full-width vs half-width punctuation
///   - case-insensitive
///   - numeric formats (leading zeros, fractions, units)
///   - matching pairs are order-independent set equality
enum Grade {
    private static let trueValues: Set<String> = ["对", "正确", "true", "t", "✓", "√", "y", "yes"]
    private static let falseValues: Set<String> = ["错", "错误", "false", "f", "✗", "×", "n", "no"]

    static func gradeAnswer(question: Question, userAnswer: String) -> Bool {
        let trimmed = userAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return false }
        let correct = question.answer

        switch question.type {
        case .trueFalse:
            let u = normalize(userAnswer)
            let c = normalize(correct)
            let userIsTrue = trueValues.contains(trimmed) || trueValues.contains(u)
            let userIsFalse = falseValues.contains(trimmed) || falseValues.contains(u)
            let correctIsTrue = trueValues.contains(correct.trimmingCharacters(in: .whitespacesAndNewlines))
                || trueValues.contains(c)
            if userIsTrue || userIsFalse {
                return userIsTrue == correctIsTrue
            }
            return u == c

        case .choice:
            // 用户侧只可能是选项字母或选项正文；标准答案可能是 "B" 或正文（含拼音 dì/bà 等）。
            // 禁止把答案首字母 d 误当成选项 D —— 仅当整串是 A-D 单字母时才按字母解释。
            let uRaw = trimmed
            var cLetter: String? = nil
            let correctTrimmed = correct.trimmingCharacters(in: .whitespacesAndNewlines)
            if correctTrimmed.count == 1, let scal = correctTrimmed.uppercased().unicodeScalars.first,
               scal.value >= 65, scal.value <= 68 {
                cLetter = correctTrimmed.uppercased()
            } else if !question.options.isEmpty {
                let cn = normalize(correct)
                if let idx = question.options.firstIndex(where: { opt in
                    let stripped = stripOptionPrefix(opt)
                    return normalize(opt) == cn || normalize(stripped) == cn
                }), idx < 4 {
                    cLetter = String(UnicodeScalar(65 + idx)!)
                }
            }
            guard let cLetter else {
                return normalize(userAnswer) == normalize(correct)
            }
            if uRaw.count == 1, let us = uRaw.uppercased().unicodeScalars.first,
               us.value >= 65, us.value <= 68 {
                return uRaw.uppercased() == cLetter
            }
            if !question.options.isEmpty {
                let un = normalize(userAnswer)
                if let idx = question.options.firstIndex(where: { opt in
                    let stripped = stripOptionPrefix(opt)
                    return normalize(opt) == un || normalize(stripped) == un
                }), idx < 4 {
                    return String(UnicodeScalar(65 + idx)!) == cLetter
                }
            }
            return false

        case .fillBlank, .calculation, .wordProblem:
            if normalize(userAnswer) == normalize(correct) { return true }
            let un = normalizeNumeric(userAnswer)
            let cn = normalizeNumeric(correct)
            if !un.isEmpty, !cn.isEmpty, un == cn { return true }
            if let uf = Double(un), let cf = Double(cn), abs(uf - cf) < 1e-6 { return true }
            return false

        case .fillBlankText:
            return normalizeText(userAnswer) == normalizeText(correct)

        case .wordOrder:
            return normalizeWordOrder(userAnswer) == normalizeWordOrder(correct)

        case .matching:
            let userPairs = parseMatchingAnswer(userAnswer)
            let correctPairs = parseMatchingAnswer(correct)
            return userPairs == correctPairs
        }
    }

    // MARK: - normalization helpers

    static func normalize(_ s: String) -> String {
        var out = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        out = out.components(separatedBy: .whitespacesAndNewlines).joined()
        let pairs: [(String, String)] = [
            ("，", ","), ("。", "."), ("（", "("), ("）", ")"), ("：", ":"),
        ]
        for (k, v) in pairs { out = out.replacingOccurrences(of: k, with: v) }
        return out
    }

    /// Strip leading "A. " / "B、" prefixes from option text.
    private static func stripOptionPrefix(_ s: String) -> String {
        guard let first = s.first, ("A"..."D").contains(first) else { return s }
        var idx = s.index(after: s.startIndex)
        if idx < s.endIndex {
            let c = s[idx]
            if c == "." || c == "、" { idx = s.index(after: idx) }
            while idx < s.endIndex, s[idx].isWhitespace { idx = s.index(after: idx) }
            return String(s[idx...])
        }
        return s
    }

    private static func normalizeNumeric(_ s: String) -> String {
        // keep digits, '-', '.', '/', '%' and ascii letters (e.g. "m" for meters)
        let allowed: Set<Character> = {
            var set = Set<Character>("0123456789-./%")
            for c in "abcdefghijklmnopqrstuvwxyz" { set.insert(c) }
            return set
        }()
        var out = normalize(s).filter { allowed.contains($0) }
        // strip leading zeros (but keep a single zero if everything is zeros)
        while out.count > 1, out.first == "0", let second = out.dropFirst().first, second.isNumber {
            out.removeFirst()
        }
        return out
    }

    private static func normalizeText(_ s: String) -> String {
        var out = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        out = out.components(separatedBy: .whitespacesAndNewlines).joined()
        let punct = Set<Character>("，。！？：；,.!?:;()（）\"'`")
        out.removeAll { punct.contains($0) }
        return out
    }

    private static func normalizeWordOrder(_ s: String) -> String {
        var out = s.trimmingCharacters(in: .whitespacesAndNewlines)
        out = out.replacingOccurrences(of: "，", with: ",")
        out = out.components(separatedBy: .whitespacesAndNewlines).joined()
        return out
    }

    /// Public accessor so the matching question UI can validate pairs live
    /// against the exact same parse the grader uses.
    static func matchingPairs(_ s: String) -> [String: String] {
        parseMatchingAnswer(s)
    }

    private static func parseMatchingAnswer(_ s: String) -> [String: String] {
        var cleaned = s.trimmingCharacters(in: .whitespacesAndNewlines)
        cleaned = cleaned.replacingOccurrences(of: "，", with: ",")
        cleaned = cleaned.components(separatedBy: .whitespacesAndNewlines).joined()
        if cleaned.isEmpty { return [:] }
        var map: [String: String] = [:]
        for pair in cleaned.split(separator: ",") {
            let parts = pair.split(separator: "-", maxSplits: 1).map(String.init)
            if parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty {
                map[parts[0].uppercased()] = parts[1]
            }
        }
        return map
    }
}
