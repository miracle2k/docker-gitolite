import Foundation

/// Mochi card parsing, mirroring the TypeScript core.
///
/// Used only by a standalone build, where the phone talks to Mochi directly.
/// The rules are Mochi's, not ours, and two of them are easy to get wrong:
/// the side separator is a line of EXACTLY three dashes (four or more is a
/// horizontal rule and must not split the card), and cloze syntax is
/// `{{text}}` / `{{1::text}}`, not Anki's `{{c1::text}}`.
public enum CardParser {

    // MARK: - Sides

    public static func splitSides(_ content: String) -> [String] {
        var sides: [String] = []
        var current: [String] = []
        for line in content.components(separatedBy: .newlines) {
            if line.trimmingCharacters(in: .whitespaces) == "---" {
                sides.append(current.joined(separator: "\n"))
                current = []
            } else {
                current.append(line)
            }
        }
        sides.append(current.joined(separator: "\n"))
        let trimmed = sides.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        return trimmed.count == 1 ? trimmed : trimmed.filter { !$0.isEmpty }
    }

    // MARK: - Cloze

    public struct ClozeOccurrence: Equatable {
        public let group: Int?
        public let text: String
        public let range: Range<String.Index>
    }

    private static let clozeRegex = try! NSRegularExpression(
        pattern: #"\{\{(?:(\d+)::)?([\s\S]*?)\}\}"#
    )

    public static func findClozes(_ content: String) -> [ClozeOccurrence] {
        let ns = content as NSString
        return clozeRegex.matches(in: content, range: NSRange(location: 0, length: ns.length))
            .compactMap { match in
                guard let range = Range(match.range, in: content) else { return nil }
                let groupRange = match.range(at: 1)
                let group = groupRange.location == NSNotFound
                    ? nil
                    : Int(ns.substring(with: groupRange))
                let text = ns.substring(with: match.range(at: 2))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return ClozeOccurrence(group: group, text: text, range: range)
            }
    }

    public static func hasCloze(_ content: String) -> Bool {
        !findClozes(content).isEmpty
    }

    /// Distinct schedulable cloze units: one per number, plus one for all
    /// bare clozes taken together (Mochi hides those as a single prompt).
    public static func clozeGroups(_ content: String) -> [(group: Int?, answers: [String])] {
        var bare: [String] = []
        var numbered: [Int: [String]] = [:]
        for occ in findClozes(content) {
            if let g = occ.group { numbered[g, default: []].append(occ.text) }
            else { bare.append(occ.text) }
        }
        var out: [(Int?, [String])] = []
        if !bare.isEmpty { out.append((nil, bare)) }
        for key in numbered.keys.sorted() { out.append((key, numbered[key]!)) }
        return out.map { (group: $0.0, answers: $0.1) }
    }

    /// Render with one cloze group blanked and the rest revealed.
    public static func blankCloze(_ content: String, group: Int?, placeholder: String = "blank") -> String {
        var out = ""
        var cursor = content.startIndex
        for occ in findClozes(content) {
            out += content[cursor..<occ.range.lowerBound]
            out += (occ.group == group) ? placeholder : occ.text
            cursor = occ.range.upperBound
        }
        out += content[cursor...]
        return out
    }

    public static func revealClozes(_ content: String) -> String {
        blankClozeAll(content)
    }

    private static func blankClozeAll(_ content: String) -> String {
        var out = ""
        var cursor = content.startIndex
        for occ in findClozes(content) {
            out += content[cursor..<occ.range.lowerBound]
            out += occ.text
            cursor = occ.range.upperBound
        }
        out += content[cursor...]
        return out
    }

    // MARK: - Speech

    /// Flatten markdown for speech, and report when nothing sayable remains -
    /// a card whose answer is an image cannot be reviewed by voice at all,
    /// and asking it anyway would just waste the learner's time.
    public static func toSpeakable(_ markdown: String) -> (text: String, speakable: Bool) {
        var text = markdown

        let substitutions: [(String, String)] = [
            (#"!\[([^\]]*)\]\([^)]*\)"#, "$1"),   // images: keep alt text only
            (#"```[\s\S]*?```"#, " code "),
            (#"\[([^\]]*)\]\([^)]*\)"#, "$1"),    // links: keep the label
            (#"`([^`]+)`"#, "$1"),
            (#"<[^>]+>"#, " "),
            (#"(?m)^\s{0,3}#{1,6}\s+"#, ""),
            (#"(?m)^\s{0,3}>\s?"#, ""),
            (#"(?m)^\s*[-*+]\s+"#, ""),
            (#"(?m)^\s*(?:-{4,}|_{3,})\s*$"#, " "),
            (#"[*_~]{1,3}"#, ""),
            (#"\|"#, ", "),
            (#"[ \t]+"#, " "),
        ]
        for (pattern, replacement) in substitutions {
            text = text.replacingOccurrences(
                of: pattern, with: replacement, options: .regularExpression
            )
        }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)

        let speakable = text.contains { $0.isLetter || $0.isNumber }
        return (text, speakable)
    }

    // MARK: - Prompts

    /// Every prompt a card can produce. A card can carry several independently
    /// scheduled prompts, and Mochi's `/due` does not say which one fell due,
    /// so the caller picks.
    public static func prompts(content: String, reviewReverse: Bool = false) -> [ReviewPrompt] {
        var out: [ReviewPrompt] = []
        let sides = splitSides(content)

        if hasCloze(content) {
            for group in clozeGroups(content) {
                let blanked = blankCloze(content, group: group.group)
                    .replacingOccurrences(of: #"(?m)^\s*---\s*$"#, with: " ", options: .regularExpression)
                let q = toSpeakable(blanked)
                let a = toSpeakable(group.answers.joined(separator: "; "))
                out.append(ReviewPrompt(
                    key: group.group.map { "cloze:\($0)" } ?? "cloze",
                    kind: .cloze,
                    question: q.text,
                    answer: a.text,
                    speakable: q.speakable && a.speakable
                ))
            }
        }

        if sides.count > 1 {
            let front = toSpeakable(revealClozes(sides[0]))
            let back = toSpeakable(revealClozes(sides[1]))
            let extra = sides.dropFirst(2).map { toSpeakable(revealClozes($0)).text }
            let usable = front.speakable && back.speakable

            out.append(ReviewPrompt(key: "forward", kind: .forward, question: front.text,
                                    answer: back.text, extra: extra, speakable: usable))
            if reviewReverse {
                out.append(ReviewPrompt(key: "reverse", kind: .reverse, question: back.text,
                                        answer: front.text, extra: extra, speakable: usable))
            }
        } else if !hasCloze(content) {
            // Nothing is withheld, so there is no question to ask.
            let only = toSpeakable(content)
            out.append(ReviewPrompt(key: "forward", kind: .forward, question: only.text,
                                    answer: only.text, speakable: false))
        }

        return out
    }
}
