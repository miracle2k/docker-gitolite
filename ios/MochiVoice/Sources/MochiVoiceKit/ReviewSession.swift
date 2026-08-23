import Foundation

/// A review session running on the device.
///
/// This mirrors the TypeScript engine deliberately, including the part that
/// matters most: a grade can be changed after the fact, by card, by position,
/// or by how many cards back - and if the grade has not been written out yet,
/// correcting it costs nothing at all.
///
/// In the default deployment this type is NOT used: the broker holds the
/// session and the phone only carries audio. It exists so the app can also
/// run standalone, talking to Mochi directly with no server of your own.
public actor ReviewSession {
    public enum ReviseTarget: Sendable {
        case card(String)
        case position(Int)
        /// 0 = the card just graded, 1 = the one before it.
        case back(Int)
    }

    public enum SessionError: Error, LocalizedError {
        case noSuchEntry(String)

        public var errorDescription: String? {
            switch self {
            case .noSuchEntry(let detail): return detail
            }
        }
    }

    public let sessionId: String
    public private(set) var settings: ReviewSettings
    public private(set) var entries: [SessionEntry] = []

    private var queue: [(cardId: String, prompt: ReviewPrompt)]
    private var cursor = 0
    private let sinks: [GradeSink]
    private let clock: @Sendable () -> Date

    public init(
        sessionId: String = UUID().uuidString,
        queue: [(cardId: String, prompt: ReviewPrompt)],
        settings: ReviewSettings = ReviewSettings(),
        sinks: [GradeSink] = [],
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.sessionId = sessionId
        self.settings = settings
        self.sinks = sinks
        self.clock = clock
        var q = queue.filter { $0.prompt.speakable }
        if settings.maxCards > 0 { q = Array(q.prefix(settings.maxCards)) }
        self.queue = q
    }

    public var remaining: Int { max(0, queue.count - cursor) }

    /// The card that has been asked but not yet answered.
    public var current: SessionEntry? {
        guard let last = entries.last, last.verdict == nil, !last.deferred else { return nil }
        return last
    }

    public func next() -> SessionEntry? {
        guard cursor < queue.count else { return nil }
        let item = queue[cursor]
        cursor += 1
        let entry = SessionEntry(
            seq: entries.count + 1,
            cardId: item.cardId,
            promptKey: item.prompt.key,
            question: item.prompt.question,
            expectedAnswer: item.prompt.answer
        )
        entries.append(entry)
        return entry
    }

    @discardableResult
    public func grade(
        _ verdict: Verdict,
        learnerAnswer: String? = nil,
        target: ReviseTarget? = nil
    ) async throws -> SessionEntry {
        let index = try resolve(target)
        let wasGraded = entries[index].verdict != nil
        let previous = entries[index].verdict

        entries[index].verdict = verdict
        entries[index].deferred = false
        if let learnerAnswer { entries[index].learnerAnswer = learnerAnswer }

        if wasGraded, let previous, previous != verdict {
            let revision = GradeRevision(at: clock(), from: previous, to: verdict, reason: nil)
            entries[index].revisions.append(revision)
            try await pushRevision(index, revision)
        }
        return entries[index]
    }

    /// Change a verdict already given. Works after it has been written out.
    @discardableResult
    public func revise(
        to verdict: Verdict,
        target: ReviseTarget? = nil,
        reason: String? = nil
    ) async throws -> SessionEntry {
        let index = try resolve(target)
        guard let previous = entries[index].verdict else {
            return try await grade(verdict, target: target)
        }
        guard previous != verdict else { return entries[index] }

        let revision = GradeRevision(at: clock(), from: previous, to: verdict, reason: reason)
        entries[index].verdict = verdict
        entries[index].revisions.append(revision)
        try await pushRevision(index, revision)
        return entries[index]
    }

    /// Leave a card ungraded because the answer could not be judged.
    @discardableResult
    public func skip(reason: String, target: ReviseTarget? = nil) throws -> SessionEntry {
        let index = try resolve(target)
        entries[index].deferred = true
        entries[index].verdict = nil
        return entries[index]
    }

    /// Write out every grade that has not been written yet.
    public func flush() async throws {
        for index in entries.indices where entries[index].verdict != nil && entries[index].syncedAt == nil {
            for sink in sinks {
                try? await sink.record(entries[index])
            }
            entries[index].syncedAt = clock()
        }
    }

    public func end() async throws -> SessionSummary {
        try await flush()
        return summary
    }

    public var summary: SessionSummary {
        let graded = entries.filter { $0.verdict != nil }
        return SessionSummary(
            asked: entries.count,
            remembered: graded.filter { $0.verdict == .remembered }.count,
            forgot: graded.filter { $0.verdict == .forgot }.count,
            skipped: entries.filter(\.deferred).count,
            revised: entries.filter { !$0.revisions.isEmpty }.count,
            remaining: remaining
        )
    }

    // MARK: - Internals

    private func resolve(_ target: ReviseTarget?) throws -> Int {
        guard let target else {
            // Default: the card in progress, or failing that the last graded one.
            if let currentIndex = entries.lastIndex(where: { $0.verdict == nil && !$0.deferred }) {
                return currentIndex
            }
            return try resolve(.back(0))
        }
        switch target {
        case .card(let id):
            guard let index = entries.lastIndex(where: { $0.cardId == id }) else {
                throw SessionError.noSuchEntry("Card \(id) was not asked in this session")
            }
            return index
        case .position(let seq):
            guard let index = entries.firstIndex(where: { $0.seq == seq }) else {
                throw SessionError.noSuchEntry("No card at position \(seq)")
            }
            return index
        case .back(let n):
            let graded = entries.indices.filter { entries[$0].verdict != nil }
            let pool = graded.isEmpty ? Array(entries.indices) : graded
            let offset = pool.count - 1 - n
            guard offset >= 0, offset < pool.count else {
                throw SessionError.noSuchEntry("Cannot go back \(n) card(s)")
            }
            return pool[offset]
        }
    }

    private func pushRevision(_ index: Int, _ revision: GradeRevision) async throws {
        // Not written yet, so the correction is free.
        guard entries[index].syncedAt != nil else { return }
        for sink in sinks {
            try? await sink.revise(entries[index], revision)
        }
    }
}

/// Where a grade goes. Mirrors the TypeScript sink interface, including the
/// honest declaration of whether a sink actually moves Mochi's schedule -
/// which, via the public API, none of them can.
public protocol GradeSink: Sendable {
    var name: String { get }
    var advancesSchedule: Bool { get }
    func record(_ entry: SessionEntry) async throws
    func revise(_ entry: SessionEntry, _ revision: GradeRevision) async throws
}
