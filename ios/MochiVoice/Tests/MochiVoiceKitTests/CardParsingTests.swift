import XCTest
@testable import MochiVoiceKit

/// Mirrors the TypeScript test suite so the two implementations cannot drift
/// apart silently. If you change parsing on one side, change it on both.
final class CardParsingTests: XCTestCase {

    func testSplitsOnExactlyThreeDashes() {
        XCTAssertEqual(CardParser.splitSides("front\n---\nback"), ["front", "back"])
    }

    func testDoesNotSplitOnAHorizontalRule() {
        // Four or more dashes is a rule, not a separator. Splitting on it
        // would silently corrupt the card.
        XCTAssertEqual(
            CardParser.splitSides("front\n----\nstill front"),
            ["front\n----\nstill front"]
        )
    }

    func testSupportsMoreThanTwoSides() {
        XCTAssertEqual(CardParser.splitSides("a\n---\nb\n---\nc"), ["a", "b", "c"])
    }

    func testFindsBareAndNumberedClozes() {
        let bare = CardParser.findClozes("capital is {{Paris}}")
        XCTAssertEqual(bare.count, 1)
        XCTAssertNil(bare[0].group)
        XCTAssertEqual(bare[0].text, "Paris")

        let numbered = CardParser.findClozes("{{1::Alice}} met {{2::Bob}}")
        XCTAssertEqual(numbered.map(\.group), [1, 2])
    }

    func testAnkiSyntaxIsNotTreatedAsANumberedGroup() {
        // Mochi uses {{1::x}}; Anki uses {{c1::x}}.
        XCTAssertNil(CardParser.findClozes("{{c1::Paris}}").first?.group)
    }

    func testBlanksTargetGroupAndRevealsOthers() {
        XCTAssertEqual(
            CardParser.blankCloze("{{1::Alice}} met {{2::Bob}}", group: 1, placeholder: "blank"),
            "blank met Bob"
        )
    }

    func testBlanksEveryOccurrenceOfARepeatedIndex() {
        XCTAssertEqual(
            CardParser.blankCloze("{{1::A}} and {{2::B}} and {{1::C}}", group: 1, placeholder: "_"),
            "_ and B and _"
        )
    }

    func testGroupsBareClozesTogether() {
        let groups = CardParser.clozeGroups("{{a}} and {{b}} then {{2::c}}")
        XCTAssertEqual(groups.count, 2)
        XCTAssertNil(groups[0].group)
        XCTAssertEqual(groups[0].answers, ["a", "b"])
    }

    func testForwardPromptFromTwoSidedCard() {
        let prompts = CardParser.prompts(content: "Capital of France?\n---\nParis")
        let forward = prompts.first { $0.key == "forward" }
        XCTAssertEqual(forward?.question, "Capital of France?")
        XCTAssertEqual(forward?.answer, "Paris")
        XCTAssertEqual(forward?.speakable, true)
    }

    func testReversePromptWhenEnabled() {
        let prompts = CardParser.prompts(content: "chien\n---\ndog", reviewReverse: true)
        let reverse = prompts.first { $0.kind == .reverse }
        XCTAssertEqual(reverse?.question, "dog")
        XCTAssertEqual(reverse?.answer, "chien")
    }

    func testImageOnlyAnswerIsNotSpeakable() {
        let prompts = CardParser.prompts(content: "What is this?\n---\n![](@media/x.png)")
        XCTAssertEqual(prompts.first { $0.key == "forward" }?.speakable, false)
    }

    func testSingleSidedCardWithNoClozeIsUnanswerable() {
        let prompts = CardParser.prompts(content: "Just a note.")
        XCTAssertEqual(prompts.first?.speakable, false)
    }
}

final class ReviewSessionTests: XCTestCase {

    private func session(_ settings: ReviewSettings = ReviewSettings()) -> ReviewSession {
        ReviewSession(
            queue: [
                ("c1", ReviewPrompt(key: "forward", kind: .forward, question: "Capital of France?", answer: "Paris")),
                ("c2", ReviewPrompt(key: "forward", kind: .forward, question: "Capital of Japan?", answer: "Tokyo")),
                ("c3", ReviewPrompt(key: "forward", kind: .forward, question: "Capital of Peru?", answer: "Lima")),
            ],
            settings: settings
        )
    }

    func testServesCardsInOrder() async {
        let s = session()
        let first = await s.next()
        XCTAssertEqual(first?.cardId, "c1")
        let remaining = await s.remaining
        XCTAssertEqual(remaining, 2)
    }

    func testRevisesThePreviousCardAfterMovingOn() async throws {
        let s = session()
        _ = await s.next()
        _ = try await s.grade(.remembered)
        _ = await s.next() // now on c2

        let revised = try await s.revise(to: .forgot)
        XCTAssertEqual(revised.cardId, "c1")
        XCTAssertEqual(revised.verdict, .forgot)
        XCTAssertEqual(revised.revisions.count, 1)

        // The card in progress is untouched.
        let current = await s.current
        XCTAssertEqual(current?.cardId, "c2")
    }

    func testReachesBackSeveralCards() async throws {
        let s = session()
        for _ in 0..<3 {
            _ = await s.next()
            _ = try await s.grade(.remembered)
        }
        let revised = try await s.revise(to: .forgot, target: .back(2))
        XCTAssertEqual(revised.cardId, "c1")
    }

    func testRevisingAnUngradedCardIsJustAGrade() async throws {
        let s = session()
        _ = await s.next()
        let entry = try await s.revise(to: .remembered)
        XCTAssertEqual(entry.verdict, .remembered)
        XCTAssertTrue(entry.revisions.isEmpty)
    }

    func testSkippedCardStaysUngraded() async throws {
        let s = session()
        _ = await s.next()
        _ = try s.skip(reason: "garbled")
        let summary = await s.summary
        XCTAssertEqual(summary.skipped, 1)
        XCTAssertEqual(summary.remembered, 0)
    }

    func testUnknownCardThrows() async {
        let s = session()
        _ = await s.next()
        do {
            _ = try await s.revise(to: .forgot, target: .card("nope"))
            XCTFail("expected a throw")
        } catch {
            // expected
        }
    }
}
