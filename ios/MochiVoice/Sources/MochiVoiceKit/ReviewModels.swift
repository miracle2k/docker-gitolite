import Foundation

/// The review vocabulary, mirroring the TypeScript core.
///
/// These types exist so the app can talk about a review without knowing how
/// it is being conducted. In the default (broker) deployment the phone never
/// sees a card at all - the server holds the queue and the grades, and the
/// device only carries audio. These types are what a STANDALONE build uses,
/// where the phone talks to Mochi directly.
public enum Verdict: String, Codable, Sendable {
    case remembered
    case forgot
}

public enum PromptKind: String, Codable, Sendable {
    case forward
    case reverse
    case cloze
}

public struct ReviewPrompt: Codable, Sendable, Equatable {
    public let key: String
    public let kind: PromptKind
    public let question: String
    public let answer: String
    public let extra: [String]
    public let speakable: Bool

    public init(key: String, kind: PromptKind, question: String, answer: String,
                extra: [String] = [], speakable: Bool = true) {
        self.key = key
        self.kind = kind
        self.question = question
        self.answer = answer
        self.extra = extra
        self.speakable = speakable
    }
}

public struct GradeRevision: Codable, Sendable, Equatable {
    public let at: Date
    public let from: Verdict
    public let to: Verdict
    public let reason: String?
}

public struct SessionEntry: Codable, Sendable, Equatable {
    public let seq: Int
    public let cardId: String
    public let promptKey: String
    public let question: String
    public let expectedAnswer: String
    public var learnerAnswer: String?
    public var verdict: Verdict?
    public var deferred: Bool = false
    public var revisions: [GradeRevision] = []
    public var syncedAt: Date?
}

/// How strictly to judge, and how close a number has to be.
///
/// Kept as plain data so the same settings drive the server, the CLI and
/// this app without any of them re-deciding the policy.
public struct ReviewSettings: Codable, Sendable, Equatable {
    public enum QuestionStyle: String, Codable, Sendable {
        case verbatim, rephrase, contextual
    }
    public enum Strictness: String, Codable, Sendable {
        case lenient, balanced, strict
    }

    public var questionStyle: QuestionStyle = .rephrase
    public var strictness: Strictness = .balanced
    /// A year answer within this many years still counts.
    public var yearTolerance: Int = 3
    /// Other quantities count if within this fraction.
    public var relativeTolerance: Double = 0.05
    public var alwaysStateAnswer: Bool = true
    public var maxCards: Int = 0

    public init() {}
}

public struct SessionSummary: Codable, Sendable, Equatable {
    public let asked: Int
    public let remembered: Int
    public let forgot: Int
    public let skipped: Int
    public let revised: Int
    public let remaining: Int
}
