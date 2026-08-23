# What the Mochi API can and cannot do

This is the constraint the whole project is shaped around. It was established
before any code was written, by reading the source of eight independent Mochi
client libraries and MCP servers, because the Mochi documentation site itself
was unreachable from the machine this was built on.

## The verdict: reviews cannot be written back

**Mochi's public HTTP API is read-only with respect to review scheduling.**

- There is no endpoint that records a Remembered/Forgot result.
- There is no writable scheduling field on the card update endpoint.
- `reviews`, `due`, `interval`, and `new?` are returned by the API but are
  not accepted by `POST /cards/:id`.

Mochi's developer has said on the forum that this is not currently possible
and that an endpoint could be added. Until it is, **no voice app - this one or
any other - can advance Mochi's own schedule through the public API.**

This project therefore never pretends otherwise. Every grade sink declares
whether it actually moves the scheduler (`capabilities.advancesSchedule`), and
`start_review` and `end_session` both report the truth to the voice agent so it
can tell you.

## What the API *can* do

Everything needed to run the review itself:

| Purpose | Endpoint |
|---|---|
| Cards due today | `GET /due`, `GET /due/:deck-id`, optional `?date=<ISO>` |
| Card contents | `GET /cards`, `GET /cards/:id` |
| Update a card | `POST /cards/:id` (POST, not PUT/PATCH) |
| Decks | `GET/POST /decks`, `GET/POST/DELETE /decks/:id` |
| Templates | `GET /templates`, `GET /templates/:id` |

- Base URL is `https://app.mochi.cards/api` (**not** `api.mochi.cards`).
- Auth is HTTP Basic with the token as username and an **empty password**.
- Requires **Mochi Pro**; other accounts get `403 {"errors":["Please upgrade to use this feature."]}`.
- **One concurrent request per account.** Bursts get `429`, so `MochiClient`
  serializes every request through a queue.
- List endpoints paginate with `?limit=N&bookmark=X` and return
  `{bookmark, docs}`. The listing ends when the bookmark is the **literal
  string `"nil"`** — an easy way to write an infinite loop.
- `GET /due` uses a different envelope: `{cards: [...]}`, not `{docs}`, and is
  not paginated.

Review *history* is readable: each card carries `reviews[]`, whose elements are
`{date: {date}, due: {date}, "remembered?": bool, interval}`. That is how
third-party Mochi heatmaps exist without any write capability.

## The four options for write-back

Ranked by how much they actually give you.

### 1. Tag the cards you missed (implemented, on by default)

`manual-tags` **is** writable. `MochiTagSink` tags every missed card
`voice-forgot`, so you can filter to that tag in the Mochi app and re-review
exactly those cards by hand in a minute or two.

This is the only officially supported write path. It does not reschedule
anything — it makes the follow-up cheap.

Note `manual-tags` is replace-not-merge, so the sink reads the card first and
preserves your own tags. `tags` (which also contains tags parsed out of card
content) is read-only and must never be written back.

### 2. Point the webhook sink at something that can write (implemented, off)

`WebhookSink` sends each verdict to any endpoint you configure, with a body
template you control. If Mochi adds a review endpoint, or you build your own
automation, set `GRADE_WEBHOOK_URL` and you are done — no change to this
project. Set `GRADE_WEBHOOK_ADVANCES_SCHEDULE=true` only if it genuinely
reschedules, since the session summary reports that back to you.

### 3. Use the app's internal endpoint (not implemented)

The Mochi web app must submit reviews somehow, so a private endpoint almost
certainly exists. Finding it is a ten-minute job: open `app.mochi.cards`, open
DevTools → Network, review one card, and read the request that fires when you
press Remembered.

It is deliberately **not** implemented here, for two reasons: it could not be
observed from this environment, and it is unversioned, session-authed and
liable to break without notice. If you capture it, option 2 is how you wire it
in without forking anything.

### 4. Keep a parallel schedule (not implemented — a product decision)

Since the review history is readable, this project could bootstrap its own
FSRS scheduler from `reviews[]` and stop treating Mochi as the source of truth
for scheduling. That is a real option and probably the right long-term answer.

It is not built because it changes what the product *is*: your Mochi app and
this app would immediately begin to disagree about what is due, permanently.
That is your call to make, not a default to inherit.

## Open questions worth a five-minute check against a live account

These could not be settled from client source alone:

- **Which sub-schedule is due.** A card can have a forward schedule, a reverse
  schedule (`review-reverse?`), and one per numbered cloze group — but `/due`
  does not say which of them fell due. This project enumerates every prompt a
  card can produce and picks the least recently reviewed one. Check a card
  with numbered clozes and one with reverse review enabled to see whether
  `/due` carries a hint we could use instead.
- **The exact key type of `cloze/reviews`.** Verified to be a JSON map, but
  every card available for inspection had it empty.
- **Whether `POST /cards/:id` silently ignores unknown keys** such as
  `reviews` or `due`, or rejects them. Two independent doc transcriptions say
  they are not parameters; nobody has published an actual attempt.
