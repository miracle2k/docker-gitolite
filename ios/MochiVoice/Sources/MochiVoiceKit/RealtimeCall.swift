import AVFoundation
import Foundation

/// Connecting the phone to an OpenAI Realtime call.
///
/// WHY WEBRTC AND NOT A WEBSOCKET: the model's voice comes out of the speaker
/// while the mic is open, so without echo cancellation the model hears itself
/// and interrupts constantly. WebRTC's iOS audio device module uses Apple's
/// voice-processing audio unit, which gives hardware AEC, AGC and noise
/// suppression for free. Setting AVAudioSession's `.voiceChat` mode alone does
/// NOT apply echo cancellation - that is a common and costly misreading.
///
/// WHY THE BROKER: the SDP offer goes to your own server, which mints the
/// ephemeral key, forwards the offer to OpenAI, and keeps the returned call
/// id so it can attach a control socket and answer every tool call itself.
/// The phone therefore holds no OpenAI key, no Mochi token, and no grading
/// logic - and the review engine can change without shipping an app update.
///
/// NOT YET COMPILED: there is no Swift toolchain in the environment this was
/// written in, so treat this file as a reviewed starting point rather than
/// working code. The WebRTC package is a dependency you must add (see
/// ios/README.md); the peer-connection calls below are written against
/// stasel/WebRTC's plain `RTC*` API.
public actor RealtimeCall {

    public struct Configuration: Sendable {
        /// Your broker, e.g. https://nas.local:8766
        public var brokerURL: URL
        public var brokerToken: String?

        public init(brokerURL: URL, brokerToken: String? = nil) {
            self.brokerURL = brokerURL
            self.brokerToken = brokerToken
        }
    }

    public enum CallError: Error, LocalizedError {
        case brokerRejected(Int, String)
        case noAnswer

        public var errorDescription: String? {
            switch self {
            case .brokerRejected(let code, let body):
                return "The review server rejected the call (\(code)): \(body)"
            case .noAnswer:
                return "The review server did not return an SDP answer"
            }
        }
    }

    private let config: Configuration

    public init(configuration: Configuration) {
        self.config = configuration
    }

    /// Configure audio for a hands-free session.
    ///
    /// `.defaultToSpeaker` is applied ONLY when no headset or car audio is
    /// present. Apple documents that it makes the system ignore the user's
    /// own route choices until the category changes, which would break an
    /// AirPods handoff halfway through a walk.
    public func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        let hasExternalRoute = session.currentRoute.outputs.contains { output in
            output.portType != .builtInSpeaker && output.portType != .builtInReceiver
        }

        var options: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
        if !hasExternalRoute { options.insert(.defaultToSpeaker) }

        try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        try session.setActive(true, options: [])
    }

    /// Trade an SDP offer for an answer via the broker.
    ///
    /// The broker replies with `application/sdp`; anything else means it
    /// failed, and the body is worth surfacing because it usually says why.
    public func exchange(offerSDP: String) async throws -> String {
        var request = URLRequest(url: config.brokerURL.appendingPathComponent("call"))
        request.httpMethod = "POST"
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        if let token = config.brokerToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = Data(offerSDP.utf8)
        // A review session starts with a Mochi round-trip, so allow for it.
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CallError.noAnswer }
        guard (200..<300).contains(http.statusCode) else {
            throw CallError.brokerRejected(
                http.statusCode, String(data: data, encoding: .utf8) ?? ""
            )
        }
        guard let sdp = String(data: data, encoding: .utf8), !sdp.isEmpty else {
            throw CallError.noAnswer
        }
        return sdp
    }
}

/// Interruptions and route changes.
///
/// This is the part the public samples all skip, and it is most of the real
/// work: over a thirty-minute review someone will get a phone call, pull out
/// an AirPod, or walk into a dead spot. Note the two notifications arrive on
/// different threads - route changes off-main, interruptions on main.
public final class AudioLifecycleObserver: NSObject, @unchecked Sendable {
    public typealias Handler = @Sendable (Event) -> Void

    public enum Event: Sendable {
        case interrupted
        case interruptionEnded(shouldResume: Bool)
        case routeChanged(reason: AVAudioSession.RouteChangeReason)
    }

    private let handler: Handler

    public init(handler: @escaping Handler) {
        self.handler = handler
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(onInterruption(_:)),
                           name: AVAudioSession.interruptionNotification, object: nil)
        center.addObserver(self, selector: #selector(onRouteChange(_:)),
                           name: AVAudioSession.routeChangeNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func onInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            handler(.interrupted)
        case .ended:
            let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            handler(.interruptionEnded(shouldResume: options.contains(.shouldResume)))
        @unknown default:
            break
        }
    }

    @objc private func onRouteChange(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        handler(.routeChanged(reason: reason))
    }
}
