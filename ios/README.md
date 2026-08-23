# MochiVoice (iOS)

Swift source for the iPhone app. **None of this has been compiled** — there was
no Swift toolchain available where it was written. It is a reviewed starting
point built on researched facts, not working code, and the first build will
need fixing up.

The tested, load-bearing logic lives in the TypeScript packages. Keep it that
way: in the recommended deployment the phone carries audio and nothing else.

## What is here

| File | Purpose |
|---|---|
| `Sources/MochiVoiceKit/ReviewModels.swift` | Verdicts, prompts, settings, summaries |
| `Sources/MochiVoiceKit/CardParsing.swift` | Mochi card parsing, mirroring the TS core |
| `Sources/MochiVoiceKit/ReviewSession.swift` | Session actor with revisable grades |
| `Sources/MochiVoiceKit/RealtimeCall.swift` | SDP exchange, audio session, lifecycle |
| `Tests/` | Mirrors of the TypeScript tests, so the two cannot drift silently |

## The two builds

**Broker mode (recommended).** The phone POSTs its SDP offer to your broker,
which mints the ephemeral key, talks to OpenAI, keeps the `call_id`, and opens
its own control socket to answer tool calls. The app holds no OpenAI key, no
Mochi token and no grading logic — and you can change the review engine without
shipping an app update. `CardParsing` and `ReviewSession` are unused here.

**Standalone.** The phone talks to Mochi and OpenAI directly. `MochiVoiceKit`
exists so this is possible, but it means shipping a Mochi token in the app and
duplicating grading policy on two sides. Prefer broker mode.

## Getting it building

1. **Add WebRTC.** `Package.swift` pins `stasel/WebRTC` at `151.0.0` — the
   maintained prebuilt SwiftPM binary with the plain `RTC*` API. Do **not**
   use `GoogleWebRTC`; it has been dead since M80.

2. **Write the peer connection.** `RealtimeCall` covers the SDP exchange and
   the audio session; the `RTCPeerConnection` setup is not written. You need:
   create the factory, add an audio track, create an offer, set the local
   description, send the SDP to the broker, set the remote description from
   the answer.

3. **Info.plist.**
   ```xml
   <key>NSMicrophoneUsageDescription</key>
   <string>Used to hear your answers during a spoken review.</string>
   <key>UIBackgroundModes</key>
   <array><string>audio</string></array>
   ```

4. **Point it at the broker.** `RealtimeCall.Configuration(brokerURL:brokerToken:)`.

## Things that will cost you a day if you skip them

**Echo cancellation is why this uses WebRTC.** With the speaker playing the
model's voice and the mic open, the model hears itself and interrupts
constantly. WebRTC's iOS audio device module uses Apple's voice-processing
audio unit, giving hardware AEC/AGC/NS for free. Setting `AVAudioSession`'s
`.voiceChat` mode alone does **not** apply echo cancellation — Apple documents
this explicitly, and it is the mistake everyone makes on the WebSocket path.

**`.defaultToSpeaker` only when nothing else is connected.** It makes the
system ignore the user's own route choices until the category changes, which
breaks an AirPods handoff mid-walk. `configureAudioSession()` checks the
current route first.

**Interruptions and route changes are most of the real work.** Over a
thirty-minute review someone will get a phone call, pull out an AirPod, or lose
signal. `AudioLifecycleObserver` gives you the events; handling them —
reconnect on ICE failure, resume after interruption — is not written yet. Note
route changes arrive off the main thread and interruptions arrive on it.

**Bluetooth degrades audio the moment the mic opens.** AirPods drop from A2DP
to HFP mono the instant recording starts. Worth a "listen-only" mode
(playback-category, good audio, tap to answer) alongside hands-free.

## Hands-free launch

Ship an `AppIntent` + `AppShortcutsProvider` ("Start my reviews") — zero setup,
works from Siri and Spotlight. To start from a *locked* device the intent must
conform to both `AudioRecordingIntent` and `LiveActivityIntent` and start a
Live Activity in `perform()`, with `supportedModes = .background`.
`AudioRecordingIntent` requires the Live Activity anyway.

Skip CarPlay for now: the conversational-app category is entitlement-gated,
individually reviewed, forbids wake-word launch, and wants the audio session
released as soon as interaction ends — which fights a long review. Plain
Bluetooth audio plus a Siri phrase covers driving with no entitlement at all.

## Turn detection matters more than you would think

Configured server-side in `buildSessionConfig`. A person recalling a fact
pauses mid-sentence, and the default 200 ms silence threshold cuts them off
constantly. The session uses `semantic_vad` with `eagerness: "low"` (waits up
to ~8s) and a 12s `idle_timeout_ms` so someone who goes quiet gets re-prompted
rather than stranded. Tune it there, not in the app.
