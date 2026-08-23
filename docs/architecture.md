# Architecture

## The question you actually asked

> Maybe it's enough if it's implemented as an MCP interface or some tool calls
> that a voice AI could use... but then maybe also as a ready-made iOS app with
> the core logic abstracted out, so it could be run standalone.

That instinct is right, and it turns out to be better supported than expected:
**the OpenAI Realtime API accepts a remote MCP server as a tool source
directly**, executed by OpenAI's own infrastructure. So "an MCP server" is not
a compromise or a stepping stone — it is a first-class way to ship a voice app.

## Layers

```
                    ┌──────────────────────────────────────┐
                    │  @mochi-voice/core                   │
                    │  Mochi client · card parsing ·       │
                    │  session ledger · grading policy ·   │
                    │  review instructions · grade sinks   │
                    └──────────────┬───────────────────────┘
                                   │  one engine, one policy
                 ┌─────────────────┴──────────────────┐
                 ▼                                    ▼
    ┌────────────────────────┐          ┌──────────────────────────┐
    │ @mochi-voice/mcp-server│          │ @mochi-voice/voice-agent │
    │ tools over Streamable  │          │ same tools as Realtime   │
    │ HTTP + stdio           │          │ functions, over an       │
    │                        │          │ OUTBOUND sideband socket │
    └───────────┬────────────┘          └───────────┬──────────────┘
                │                                   │
   Claude / ChatGPT / Cursor /            iOS app (audio only) ·
   any MCP client · hosted-MCP            no inbound port needed
   voice sessions
```

`ios/MochiVoiceKit` mirrors the core in Swift for a **standalone** build where
the phone talks to Mochi directly with no server of yours in the loop.

## Three decisions, and why

### 1. Session state lives on the server, never in the model's context

The single most important structural choice. A voice model that tracks its own
place in the deck will eventually lose it, re-ask a card, or grade the wrong
one — and nothing can be audited afterwards.

So the engine owns: which card is current, what the reference answer is, and
what every card was graded. The model gets a session handle as an ordinary
tool argument (the pattern the MCP spec now prescribes, since transport-level
sessions were removed and some clients open a fresh connection per tool call).

This is also what makes **retroactive correction** a lookup instead of a feat
of memory. "No, mark that last one wrong" three cards later is
`revise_grade(back: 2)` against a ledger, not the model reconstructing history.

### 2. Grading is split between the model and arithmetic

The *semantic* judgement — is this paraphrase good enough? — belongs to the
voice model. It heard the audio and holds the conversation.

But **numbers are decided by subtraction, not by impression.** You asked for
years to count when they are close; "close" is `|1791 - 1789| ≤ 3`, computed,
returned to the model, and reported to you as an exact value. `checkNumeric`
also parses years the way people actually say them: "seventeen eighty-nine"
is 1789, not the numbers 17, 80 and 9.

When the model's verdict contradicts the arithmetic, the tool result says so
and tells it to state the exact figure.

There is also a third outcome besides remembered and forgot: **ungraded**.
If the transcript was unusable, `skip_card` leaves the schedule untouched. A
grading failure must never silently become a lapse.

### 3. Writes go to pluggable sinks that declare what they really do

Because [Mochi cannot record reviews](./mochi-api-constraints.md), the engine
never assumes a grade landed anywhere meaningful. Each sink says whether it
advances the schedule, and the session summary reports the truth.

Grades are also **deferred to the end of the session by default**, which makes
mid-session corrections completely free — no write, no un-write.

## Deployment shapes

### A. Any MCP client (simplest to try)

Point Claude Desktop, Claude Code or Cursor at the stdio server and review by
text. Good for checking the flow before spending anything on audio.

### B. Hosted MCP inside a voice session

Put the MCP tool straight in the Realtime session config:

```json
{"type": "session.update", "session": {"type": "realtime",
  "tools": [{"type": "mcp", "server_label": "mochi_review",
             "server_url": "https://your-host/mcp",
             "headers": {"Authorization": "Bearer <MCP_AUTH_TOKEN>"},
             "require_approval": "never"}]}}
```

Two things will bite you if you skip them:

- **`require_approval: "never"` is mandatory.** The default asks for approval,
  and in a voice session an approval request *stalls the agent* — it cannot
  process speech while waiting. A review loop would deadlock on every card.
- **POST responses must be SSE-framed.** OpenAI's MCP client requires
  `text/event-stream`; replying `application/json` makes the session report
  zero tools with no error at all. `enableJsonResponse: false` in
  `server.ts` is load-bearing, not a default nobody thought about.

OpenAI calls your server from *its* infrastructure, so this shape needs your
server to be publicly reachable — a tunnel, for a NAS.

### C. The sideband broker (best for a NAS behind NAT)

The phone sends its SDP offer to your broker. The broker mints an ephemeral
key, forwards the offer to OpenAI, keeps the returned `call_id`, and opens a
control socket *outbound* to `wss://api.openai.com/v1/realtime?call_id=...`.
Every tool call is answered there.

The result: **no inbound port, no public hostname, no tunnel** — and the phone
holds no OpenAI key, no Mochi token and no grading logic. You can change the
review engine without shipping an app update.

This is the recommended shape for the iOS app.

## Verification status

Honesty about what has been exercised:

- **Tested here:** card parsing, grading arithmetic, revision semantics, the
  whole MCP tool protocol against a fake Mochi API, and the Realtime tool
  bridge against synthetic events. 132 tests.
- **Not tested here:** the live Mochi API (no token available), the live
  OpenAI Realtime API (OpenAI hosts were unreachable from this environment),
  the Docker image (no daemon), and all Swift code (no toolchain).

The Realtime field names came from OpenAI's OpenAPI-generated SDK types rather
than prose docs, so `realtime.ts` is the first file to re-check against the
live API. Two GA renames are already handled: `modalities` → `output_modalities`,
and `temperature` removed from the session config.
