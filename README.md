# Mochi voice review

Hands-free spoken review for [Mochi](https://mochi.cards) spaced-repetition
cards. It walks through what is due today, asks each card as a natural spoken
question, listens to your answer, judges it on meaning rather than wording, and
lets you overrule any grade — including several cards later, after the fact.

> **Read this first:** Mochi's public API **cannot record reviews.** It can
> tell you what is due and let you read your review history, but there is no
> endpoint to submit a Remembered/Forgot result, so nothing can advance Mochi's
> own schedule. This project is honest about that everywhere rather than
> pretending: missed cards get **tagged** in Mochi so you can re-review just
> those in a minute, every verdict is written to a durable local ledger, and a
> webhook sink is ready if you find or are given a real write path.
> See [docs/mochi-api-constraints.md](docs/mochi-api-constraints.md) for the
> full verdict and the four options.

## Try it in two minutes, no OpenAI key needed

The riskiest part of a project like this is not the voice — it is whether your
actual cards parse into sensible questions. So look at that first:

```bash
npm install && npm run build
export MOCHI_API_TOKEN=...        # Mochi > Settings > API (Mochi Pro only)
node packages/voice-agent/dist/bin.js preview
```

```
5 card(s) due; 4 reviewable by voice.

  1. [forward] Capital of France?
     -> Paris
  2. [cloze] The Bastille fell in blank.
     -> 1789
  3. [forward] chien
     -> dog
  4. [cloze] blank met Bob in Paris.
     -> Alice

1 card(s) skipped:
  c4: stripped image(s); no speakable text remains
```

Every question and reference answer a session would use, plus every card that
cannot be reviewed by voice at all and why.

## What it does with a card

Mochi cards are not uniform, and a voice reviewer has to handle all of it:

- **Two-sided cards** — asks the front, expects the back. Cards can have more
  than two sides; the extras become follow-up detail.
- **Cloze deletions** — `{{text}}` reads the sentence with the span blanked.
  Numbered groups `{{1::…}} {{2::…}}` are separate prompts with separate
  histories, exactly as Mochi schedules them.
- **Reversed cards** — `review-reverse?` on a card or its deck adds the
  back→front direction as its own prompt.
- **Template cards** — renders `<< Field >>` placeholders and conditional
  `<<# Field >>…<</ Field >>` sections. Front vs back comes from the template
  layout, never from which field happens to be called `name`.
- **Unreviewable cards** — an answer that is only an image is skipped with a
  reason, rather than asking a question you cannot possibly answer aloud.

## Grading

Meaning, not wording. Beyond that:

- **Numbers are decided by arithmetic, not vibes.** A year within ±3 counts
  (configurable); other quantities within ±5%. "Seventeen eighty-nine" parses
  as 1789 — the way people actually say years. When the model's call disagrees
  with the arithmetic, it is told so and asked to state the exact figure.
- **Corrections are first-class.** "No, that should count" — or "actually that
  last one was wrong", three cards later — reaches back and fixes the grade
  without re-asking the card or disturbing the one in progress. Grades are
  written at the *end* of the session by default, so a correction costs
  nothing.
- **Uncertainty is a third outcome.** If the transcript was unusable, the card
  is left ungraded and its schedule untouched. A grading failure must never
  quietly become a lapse. ("I don't know" is a real lapse, and is graded as one.)

## Running it

### On a NAS, with Docker

```bash
cp .env.example .env      # fill in MOCHI_API_TOKEN and MCP_AUTH_TOKEN
docker compose up -d
```

Serves MCP over Streamable HTTP at `http://<host>:8765/mcp`, with the review
ledger in `./data`.

### From a terminal, for any MCP client

```bash
MOCHI_API_TOKEN=... node packages/mcp-server/dist/bin.js --stdio
```

Point Claude Desktop, Claude Code or Cursor at it and review by text. Useful
for checking the flow before paying for audio.

### As a voice session

Two shapes, both covered in [docs/architecture.md](docs/architecture.md):

- **Hosted MCP** — put `{"type": "mcp", "server_url": "...", "require_approval": "never"}`
  in the Realtime session config. OpenAI calls your server, so it must be
  publicly reachable. `require_approval: "never"` is not optional: the default
  stalls the agent mid-conversation on every single card.
- **Sideband broker** (recommended for a home box) — the broker connects
  *outbound* to OpenAI and answers tool calls itself. No inbound port, no
  public hostname, and the phone holds no credentials at all.

```bash
docker compose --profile voice up -d
```

### On iPhone

`ios/` holds a Swift package: `MochiVoiceKit` (models, card parsing, a session
actor with the same revision semantics) and the WebRTC/audio-session layer.
See [ios/README.md](ios/README.md).

**The Swift code has never been compiled** — there was no Swift toolchain in
the environment this was built in. Treat it as a reviewed starting point, not
working code. The TypeScript side is tested and is where the load-bearing logic
lives.

## Tuning the review

Every strategy knob is data, so all front-ends change together. Set them in
`.env`:

| Variable | Options | What it changes |
|---|---|---|
| `REVIEW_QUESTION_STYLE` | `verbatim`, `rephrase`, `contextual` | Read the card as written, restate it naturally, or build a short scenario around it |
| `REVIEW_STRICTNESS` | `lenient`, `balanced`, `strict` | How much of the reference answer you must actually produce |
| `REVIEW_YEAR_TOLERANCE` | integer | How many years off still counts |
| `REVIEW_RELATIVE_TOLERANCE` | fraction | How far off other numbers may be |
| `REVIEW_SYNC_MODE` | `end-of-session`, `immediate` | When grades are written; deferred makes corrections free |
| `REVIEW_PROMPT_SELECTION` | `least-recent`, `forward-only`, `random` | Which sub-schedule of a card to ask |
| `MOCHI_TAG_SINK` | `true`/`false` | Tag missed cards in Mochi |

`node packages/voice-agent/dist/bin.js instructions` prints the exact
instructions the voice model receives for your current settings — the honest
way to see what a setting actually does.

## Layout

```
packages/core         engine: Mochi client, parsing, session ledger, grading
packages/mcp-server   the review protocol as MCP tools (HTTP + stdio)
packages/voice-agent  Realtime session, sideband broker, preview CLI
ios/                  Swift package and app source (uncompiled)
docs/                 the Mochi API verdict, and the architecture argument
legacy-gitolite/      the previous contents of this repo, moved aside
```

## Tests

```bash
npm test        # 100 tests
```

Covers card parsing, grading arithmetic, revision semantics, and the whole
tool protocol against a fake Mochi API. Not covered, for lack of access:
the live Mochi API, the live OpenAI Realtime API, the Docker build, and all
Swift code.
