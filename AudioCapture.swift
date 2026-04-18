import Foundation
import ScreenCaptureKit
import AVFAudio
import CoreAudio

// MARK: - Railway WebSocket

class RailwayWS {
    private var task: URLSessionWebSocketTask?
    private let url: URL
    var connected = false
    var onOpen: (() -> Void)?
    var onMsg: ((String) -> Void)?
    private var intentionallyClosed = false
    private var reconnectAttempts = 0

    init(_ url: URL) { self.url = url }

    func connect() {
        intentionallyClosed = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = URLSession.shared.webSocketTask(with: url)
        task?.resume()
        recv()
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self, self.task?.state == .running else { return }
            self.connected = true
            self.reconnectAttempts = 0
            fputs("[Railway] Connected\n", stderr)
            self.onOpen?()
        }
    }

    func sendText(_ s: String) {
        guard connected else { return }
        task?.send(.string(s)) { [weak self] err in
            if let err = err {
                fputs("[Railway] send error: \(err)\n", stderr)
                self?.handleDisconnect()
            }
        }
    }

    func sendBinary(_ data: Data) {
        guard connected else { return }
        task?.send(.data(data)) { [weak self] err in
            if let err = err {
                fputs("[Railway] binary send error: \(err)\n", stderr)
                self?.handleDisconnect()
            }
        }
    }

    func close() {
        intentionallyClosed = true
        connected = false
        task?.cancel(with: .normalClosure, reason: nil)
    }

    private func handleDisconnect() {
        guard !intentionallyClosed else { return }
        connected = false
        reconnectAttempts += 1
        let delay = Double(min(15, 1 << min(reconnectAttempts, 4)))
        fputs("[Railway] Reconnecting in \(Int(delay))s (attempt \(reconnectAttempts))\n", stderr)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.connect()
        }
    }

    private func sendPong() {
        task?.sendPing { [weak self] err in
            if let err = err {
                fputs("[Railway] pong error: \(err)\n", stderr)
                self?.handleDisconnect()
            }
        }
    }

    private func recv() {
        task?.receive { [weak self] r in
            switch r {
            case .success(let m):
                switch m {
                case .string(let s):
                    self?.onMsg?(s)
                case .data:
                    // Server ping or binary — respond with pong
                    self?.sendPong()
                @unknown default:
                    break
                }
                self?.recv()
            case .failure:
                fputs("[Railway] WS closed\n", stderr)
                self?.handleDisconnect()
            }
        }
    }
}

// MARK: - Deepgram WebSocket (Authorization header, 16kHz)

class DeepgramWS {
    private var task: URLSessionWebSocketTask?
    private let apiKey: String
    private let sampleRate: Int
    let label: String
    var connected = false
    var onTranscript: ((String, Bool) -> Void)?
    // Phase 2: forward ALL Deepgram event types (SpeechStarted, UtteranceEnd, etc.)
    var onEvent: (([String: Any]) -> Void)?
    private var keepaliveTimer: DispatchSourceTimer?
    private var reconnectAttempts = 0

    init(apiKey: String, sampleRate: Int, label: String = "System") {
        self.apiKey = apiKey
        self.sampleRate = sampleRate
        self.label = label
    }

    func connect() {
        let urlStr = "wss://api.deepgram.com/v1/listen?model=nova-2&language=en&punctuate=true&interim_results=true&endpointing=300&utterance_end_ms=1000&encoding=linear16&sample_rate=\(sampleRate)&channels=1"
        guard let url = URL(string: urlStr) else { return }
        var request = URLRequest(url: url)
        request.setValue("Token \(apiKey)", forHTTPHeaderField: "Authorization")
        task = URLSession.shared.webSocketTask(with: request)
        task?.resume()
        recv()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self = self else { return }
            let state = self.task?.state
            // Accept .running or any non-terminal state — handshake timing varies per connection
            guard state != .completed && state != .canceling else {
                fputs("[Deepgram-\(self.label)] Connection failed (state=\(String(describing: state))) — will retry\n", stderr)
                self.reconnectAttempts += 1
                DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { self.connect() }
                return
            }
            self.connected = true
            self.reconnectAttempts = 0
            fputs("[Deepgram-\(self.label)] Connected\n", stderr)
            self.startKeepalive()
        }
    }

    func sendAudio(_ data: Data) {
        guard connected else { return }
        task?.send(.data(data)) { _ in }
    }

    func close() {
        connected = false
        keepaliveTimer?.cancel()
        keepaliveTimer = nil
        task?.send(.string("{\"type\":\"CloseStream\"}")) { _ in }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.task?.cancel(with: .normalClosure, reason: nil)
        }
    }

    private func startKeepalive() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        timer.schedule(deadline: .now() + 5, repeating: 5.0)
        timer.setEventHandler { [weak self] in
            self?.task?.send(.string("{\"type\":\"KeepAlive\"}")) { _ in }
        }
        timer.resume()
        keepaliveTimer = timer
    }

    private func recv() {
        task?.receive { [weak self] r in
            switch r {
            case .success(let msg):
                if case .string(let s) = msg {
                    if let data = s.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let type_ = json["type"] as? String {

                        // Forward ALL event types to onEvent handler (Phase 2)
                        self?.onEvent?(json)

                        // Backward-compatible: extract transcript from Results
                        if type_ == "Results",
                           let channel = json["channel"] as? [String: Any],
                           let alts = channel["alternatives"] as? [[String: Any]],
                           let transcript = alts.first?["transcript"] as? String,
                           !transcript.isEmpty {
                            let isFinal = json["is_final"] as? Bool ?? false
                            self?.onTranscript?(transcript, isFinal)
                        }
                    }
                }
                self?.recv()
            case .failure(let err):
                fputs("[Deepgram-\(self?.label ?? "")] closed: \(err)\n", stderr)
                self?.connected = false
                self?.keepaliveTimer?.cancel()
                self?.keepaliveTimer = nil
                guard let self = self else { return }
                self.reconnectAttempts += 1
                if self.reconnectAttempts <= 5 {
                    let delay = Double(min(30, 2 << self.reconnectAttempts))
                    fputs("[Deepgram-\(self.label)] Reconnecting in \(Int(delay))s (attempt \(self.reconnectAttempts)/5)\n", stderr)
                    DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
                        self?.connect()
                    }
                } else {
                    fputs("[Deepgram-\(self.label)] Max reconnect attempts reached\n", stderr)
                }
            }
        }
    }
}

// MARK: - Shared Echo Canceller (AEC3 via WebRTC AudioProcessing)

// Single APM instance — reverse (system audio) and capture (mic) both flow
// through it. APM is not thread-safe between streams, so all calls are
// serialized on `aecQueue`.
let echoCanceller: ICEchoCanceller? = {
    let c = ICEchoCanceller()
    if let c = c {
        // Typical MacBook speaker→mic acoustic delay is ~100-150ms once you
        // sum CoreAudio output buffer + speaker emission + air + mic buffer.
        // AEC3's delay estimator adapts from this starting hint — set too low
        // and the estimator wanders, hurting initial convergence.
        c.setStreamDelayMs(120)
        fputs("[AEC] WebRTC AEC3 initialized\n", stderr)
    } else {
        fputs("[AEC] WebRTC AEC3 FAILED to initialize — falling back to raw audio\n", stderr)
    }
    return c
}()
let aecQueue = DispatchQueue(label: "ic.aec.serial", qos: .userInteractive)

// 48 kHz mono, 10 ms frames = 480 int16 samples per frame.
let kAecFrameSamples = 480

// MARK: - TTS gate (authoritative echo defense)
//
// Linear AEC alone on MacBook speakers leaves intelligible residual that
// Deepgram happily transcribes back as candidate speech. The reliable fix is
// to simply not send mic frames to Deepgram while the AI is physically
// speaking through the laptop speakers. The web app emits onplay/onended
// events on the TTS <audio> element; Railway forwards them to us as
// {type:"tts_state", playing:bool}. We hard-gate the mic during those
// windows with a 150ms hangover to catch speaker decay.
final class TTSGate {
    private let q = DispatchQueue(label: "ic.ttsgate", qos: .userInteractive)
    private var _active = false
    private var _hangoverUntil: CFAbsoluteTime = 0
    private let hangoverSeconds: Double = 0.15

    var isGated: Bool {
        q.sync {
            if _active { return true }
            return CFAbsoluteTimeGetCurrent() < _hangoverUntil
        }
    }

    func setActive(_ playing: Bool, utteranceId: String?) {
        q.sync {
            if playing {
                _active = true
                _hangoverUntil = 0
                fputs("[TTSGate] engaged (utt=\(utteranceId ?? "-"))\n", stderr)
            } else {
                _active = false
                _hangoverUntil = CFAbsoluteTimeGetCurrent() + hangoverSeconds
                fputs("[TTSGate] released (utt=\(utteranceId ?? "-")) — hangover \(Int(hangoverSeconds*1000))ms\n", stderr)
            }
        }
    }
}

let ttsGate = TTSGate()

// Boxcar 3:1 downsample from 48 kHz int16 mono → 16 kHz int16 mono.
// `input.count` must be a multiple of 3.
@inline(__always)
func downsample48to16(_ input: UnsafePointer<Int16>, count: Int, output: UnsafeMutablePointer<Int16>) {
    let outCount = count / 3
    for i in 0..<outCount {
        let a = Int32(input[i * 3])
        let b = Int32(input[i * 3 + 1])
        let c = Int32(input[i * 3 + 2])
        output[i] = Int16(clamping: (a + b + c) / 3)
    }
}

// MARK: - Audio Delegate (SAFE: uses CMBlockBufferCopyDataBytes, never AudioBufferList)

@available(macOS 13.0, *)
class AudioDelegate: NSObject, SCStreamOutput, SCStreamDelegate {
    let railway: RailwayWS
    let deepgram: DeepgramWS
    private let chunkBytes = 8192 // 4096 int16 samples * 2 bytes @ 16 kHz
    private var sent = 0

    init(railway: RailwayWS, deepgram: DeepgramWS) {
        self.railway = railway
        self.deepgram = deepgram
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, buf.isValid, CMSampleBufferGetNumSamples(buf) > 0 else { return }
        processAudio(buf)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("[SC] stopped: \(error)\n", stderr)
    }

    // 48 kHz int16 mono frame accumulator (fed to AEC as "reverse" reference).
    private var pcm48 = Data()
    // 16 kHz int16 mono chunk accumulator (sent to Deepgram + Railway).
    private var chunk16 = Data()

    private func processAudio(_ buf: CMSampleBuffer) {
        // SAFE: get the block buffer and copy bytes out — no AudioBufferList pointers
        guard let blockBuffer = CMSampleBufferGetDataBuffer(buf) else { return }
        let totalBytes = CMBlockBufferGetDataLength(blockBuffer)
        guard totalBytes > 0 else { return }

        var rawData = Data(count: totalBytes)
        let status = rawData.withUnsafeMutableBytes { ptr -> OSStatus in
            guard let base = ptr.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: totalBytes, destination: base)
        }
        guard status == kCMBlockBufferNoErr else { return }

        guard let fmtDesc = buf.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else { return }
        let srcChannels = Int(asbd.pointee.mChannelsPerFrame)
        let numFrames = CMSampleBufferGetNumSamples(buf)
        guard numFrames > 0 else { return }

        // SCStream delivers 48 kHz float32 (typically mono). Convert to
        // int16 at 48 kHz — full rate, NO decimation. AEC needs 48 kHz input.
        rawData.withUnsafeBytes { rawPtr in
            guard let floats = rawPtr.baseAddress?.assumingMemoryBound(to: Float32.self) else { return }
            let totalFloats = totalBytes / 4

            for frameIdx in 0..<numFrames {
                var mono: Float32 = 0
                if srcChannels == 1 {
                    if frameIdx < totalFloats { mono = floats[frameIdx] }
                } else {
                    for ch in 0..<srcChannels {
                        let idx = frameIdx * srcChannels + ch
                        if idx < totalFloats { mono += floats[idx] }
                    }
                    mono /= Float32(srcChannels)
                }
                let clamped = max(-1.0, min(1.0, mono))
                var val = Int16(clamped < 0 ? clamped * 32768 : clamped * 32767).littleEndian
                pcm48.append(Data(bytes: &val, count: 2))
            }
        }

        // Slice 48 kHz accumulator into 480-sample (960-byte) AEC frames.
        let frameBytes = kAecFrameSamples * 2
        while pcm48.count >= frameBytes {
            let frame = pcm48.prefix(frameBytes)
            pcm48.removeFirst(frameBytes)

            // Make a heap copy the AEC queue can own.
            let frameData = Data(frame)

            // 1) Feed to AEC as reverse/reference signal.
            if let ec = echoCanceller {
                aecQueue.async {
                    frameData.withUnsafeBytes { raw in
                        guard let p = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                        ec.processReverseFrame(p)
                    }
                }
            }

            // 2) Downsample 48 kHz → 16 kHz for Deepgram (system-audio transcript).
            var ds = Data(count: (kAecFrameSamples / 3) * 2)
            ds.withUnsafeMutableBytes { outRaw in
                guard let outPtr = outRaw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                frameData.withUnsafeBytes { inRaw in
                    guard let inPtr = inRaw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                    downsample48to16(inPtr, count: kAecFrameSamples, output: outPtr)
                }
            }
            chunk16.append(ds)
        }

        // Ship 16 kHz chunks in 8192-byte pieces (Deepgram + Railway).
        while chunk16.count >= chunkBytes {
            let chunk = chunk16.prefix(chunkBytes)
            chunk16.removeFirst(chunkBytes)
            deepgram.sendAudio(Data(chunk))
            // Tag system audio with 0x01 prefix for server-side recording
            var tagged = Data([0x01])
            tagged.append(chunk)
            railway.sendBinary(tagged)
            sent += 1
            if sent == 1 || sent == 10 || sent % 100 == 0 {
                fputs("[Audio-System] \(sent) chunks sent\n", stderr)
            }
        }
    }
}

// MARK: - Mic Capture (AVAudioEngine → Deepgram → Railway as candidate transcript)

@available(macOS 13.0, *)
class MicCapture {
    private var engine = AVAudioEngine()
    private let deepgram: DeepgramWS
    private let railway: RailwayWS
    // 48 kHz int16 mono buffer fed into AEC as capture (near-end) signal.
    fileprivate var pcm48 = Data()
    // 16 kHz int16 mono buffer sent to Deepgram after AEC + downsample.
    fileprivate var chunk16 = Data()
    fileprivate let chunkBytes = 8192
    private var sent = 0
    private var running = false
    private var deviceChangeObserver: NSObjectProtocol?
    private var coreAudioListenerInstalled = false
    private var restartInFlight = false

    // Patch C: RMS gate — drop chunks quieter than this (kills residual speaker bleed)
    // DISABLED: set to 0 so nothing is gated. Was cutting candidate mic entirely.
    private let rmsGateThreshold: Float = 0.0

    init(railway: RailwayWS, deepgram: DeepgramWS) {
        self.railway = railway
        self.deepgram = deepgram
    }

    func start() {
        // Set up Deepgram transcript handler — sends ALL transcripts (interim + final)
        // to the server. Previously only finals were sent, which caused the server's
        // silence timer to fire during active speech (finals can be 3-7s apart).
        // Interims arrive every ~200-500ms during speech and keep timers alive.
        deepgram.onTranscript = { [weak self] text, isFinal in
            guard let self = self else { return }
            fputs("[Mic-\(isFinal ? "Transcript" : "Interim")] \(text)\n", stderr)
            let msg: [String: Any] = [
                "type": "desktop_candidate_transcript",
                "text": text,
                "isFinal": isFinal,
                "speaker": "You"
            ]
            if let d = try? JSONSerialization.data(withJSONObject: msg),
               let s = String(data: d, encoding: .utf8) {
                self.railway.sendText(s)
            }
        }

        // Phase 2: Forward Deepgram acoustic events (SpeechStarted, UtteranceEnd)
        // to Railway so the server can use them as turn-taking signals.
        // SpeechStarted = pseudo-VAD "someone is talking" (fires on acoustic energy)
        // UtteranceEnd = "silence after speech" (best answer-complete signal available)
        deepgram.onEvent = { [weak self] json in
            guard let self = self else { return }
            guard let type_ = json["type"] as? String else { return }

            if type_ == "SpeechStarted" || type_ == "UtteranceEnd" {
                fputs("[Mic-DG-Event] \(type_)\n", stderr)
                let msg: [String: Any] = [
                    "type": "desktop_deepgram_event",
                    "event": type_,
                    "source": "mic"
                ]
                if let d = try? JSONSerialization.data(withJSONObject: msg),
                   let s = String(data: d, encoding: .utf8) {
                    self.railway.sendText(s)
                }
            }
        }

        deepgram.connect()
        startEngine(retriesLeft: 3)
        installEngineConfigObserver()
        installCoreAudioDeviceListener()
    }

    private func currentInputDeviceName() -> String {
        var deviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID)
        guard status == noErr, deviceID != 0 else { return "unknown" }

        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var name: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let nstatus = AudioObjectGetPropertyData(deviceID, &nameAddr, 0, nil, &nameSize, &name)
        guard nstatus == noErr, let cf = name?.takeRetainedValue() else { return "unknown" }
        return cf as String
    }

    private func startEngine(retriesLeft: Int) {
        let inputNode = engine.inputNode

        // ── Patch A: Acoustic Echo Cancellation ──────────────────────────────
        // DISABLED: Apple voice processing was attenuating candidate voice when
        // speaker was not close to mic, causing full dropouts. Leave raw.
        // do {
        //     try inputNode.setVoiceProcessingEnabled(true)
        //     fputs("[Mic] Voice processing (AEC) enabled\n", stderr)
        // } catch {
        //     fputs("[Mic] AEC unavailable: \(error) — continuing without echo cancel\n", stderr)
        // }
        fputs("[Mic] AEC disabled (raw mic input)\n", stderr)

        let hwFormat = inputNode.outputFormat(forBus: 0)
        let deviceName = currentInputDeviceName()
        fputs("[Mic] Device: \(deviceName) | Format: \(hwFormat.sampleRate)Hz, \(hwFormat.channelCount)ch\n", stderr)

        guard hwFormat.sampleRate > 0 else {
            if retriesLeft > 0 {
                fputs("[Mic] Sample rate 0 — retrying in 1.0s (\(retriesLeft) left)\n", stderr)
                DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    guard let self = self else { return }
                    self.engine = AVAudioEngine()
                    self.startEngine(retriesLeft: retriesLeft - 1)
                }
            } else {
                fputs("[Mic] No input device available after retries — mic capture offline\n", stderr)
            }
            return
        }

        // Resample hardware rate → 48 kHz int16 mono (AEC's native rate).
        // After AEC processing we boxcar-downsample 48→16 kHz for Deepgram.
        guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                               sampleRate: 48000,
                                               channels: 1,
                                               interleaved: true) else {
            fputs("[Mic] Failed to create 48k target format\n", stderr)
            return
        }
        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            fputs("[Mic] Failed to create AVAudioConverter \(hwFormat) → 48k mono\n", stderr)
            return
        }
        fputs("[Mic] Resampler: \(hwFormat.sampleRate)Hz \(hwFormat.channelCount)ch → 48000Hz 1ch (AEC input)\n", stderr)

        var tapCallCount = 0
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            tapCallCount += 1
            if tapCallCount <= 3 || tapCallCount % 50 == 0 {
                fputs("[Mic] tap#\(tapCallCount) frames=\(buffer.frameLength)\n", stderr)
            }

            // Compute output capacity proportional to input frames.
            let ratio = targetFormat.sampleRate / hwFormat.sampleRate
            let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 2048
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outCapacity) else {
                fputs("[Mic] outBuf alloc failed\n", stderr)
                return
            }

            var supplied = false
            var err: NSError?
            let status = converter.convert(to: outBuf, error: &err) { _, inputStatus in
                if supplied { inputStatus.pointee = .noDataNow; return nil }
                supplied = true
                inputStatus.pointee = .haveData
                return buffer
            }
            if let e = err {
                fputs("[Mic] convert error: \(e)\n", stderr)
                return
            }
            if status == .error {
                fputs("[Mic] convert status=.error\n", stderr)
                return
            }
            guard let int16ptr = outBuf.int16ChannelData?[0] else {
                fputs("[Mic] no int16 channel data\n", stderr)
                return
            }
            let n = Int(outBuf.frameLength)
            if tapCallCount <= 3 {
                fputs("[Mic] tap#\(tapCallCount) converted outFrames=\(n) @ 48kHz\n", stderr)
            }
            if n == 0 {
                return
            }
            // Accumulate 48 kHz int16 mono (AEC input rate).
            let data = Data(bytes: UnsafeRawPointer(int16ptr), count: n * 2)
            self.pcm48.append(data)

            // Slice into 480-sample (10 ms) AEC frames.
            let frameBytes = kAecFrameSamples * 2
            while self.pcm48.count >= frameBytes {
                let frame = self.pcm48.prefix(frameBytes)
                self.pcm48.removeFirst(frameBytes)
                let frameData = Data(frame)

                // Synchronously run AEC on the serial queue so we get cleaned output back.
                var cleaned = Data(count: frameBytes)
                if let ec = echoCanceller {
                    aecQueue.sync {
                        frameData.withUnsafeBytes { inRaw in
                            guard let inPtr = inRaw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                            cleaned.withUnsafeMutableBytes { outRaw in
                                guard let outPtr = outRaw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                                _ = ec.processCaptureFrame(inPtr, output: outPtr)
                            }
                        }
                    }
                } else {
                    cleaned = frameData // AEC unavailable — fall through with raw mic
                }

                // Downsample cleaned 48 kHz → 16 kHz for Deepgram.
                var ds = Data(count: (kAecFrameSamples / 3) * 2)
                ds.withUnsafeMutableBytes { outRaw in
                    guard let outPtr = outRaw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                    cleaned.withUnsafeBytes { inRaw in
                        guard let inPtr = inRaw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                        downsample48to16(inPtr, count: kAecFrameSamples, output: outPtr)
                    }
                }
                self.chunk16.append(ds)
            }

            // Ship 16 kHz chunks in 8192-byte pieces.
            while self.chunk16.count >= self.chunkBytes {
                let chunk = self.chunk16.prefix(self.chunkBytes)
                self.chunk16.removeFirst(self.chunkBytes)

                // TTS gate: while the AI is physically speaking through the
                // laptop speakers, replace mic audio with silence. Still send
                // it — Deepgram needs continuous audio or the WS closes, and
                // AEC needs to keep training on the real mic signal upstream
                // of here. Silence frames to Deepgram just transcribe as
                // nothing, which is exactly what we want.
                let gated = ttsGate.isGated
                let outChunk: Data = gated ? Data(count: chunk.count) : Data(chunk)
                self.deepgram.sendAudio(outChunk)
                // Tag mic audio with 0x02 prefix for server-side recording
                var tagged = Data([0x02])
                tagged.append(outChunk)
                self.railway.sendBinary(tagged)
                self.sent += 1
                if self.sent == 1 || self.sent == 10 || self.sent % 100 == 0 {
                    fputs("[Audio-Mic] \(self.sent) chunks sent\(gated ? " [gated]" : "")\n", stderr)
                }
            }
        }

        do {
            try engine.start()
            running = true
            // Re-align AEC state right before the first capture frame arrives.
            // Otherwise the reverse stream (which started ~1.5s earlier for speaker
            // warmup) has pre-buffered ~180 frames with no matching captures, and
            // AEC3's ~300ms history window can't find a reference for each input.
            aecQueue.sync { echoCanceller?.reset() }
            fputs("[Mic] Engine started on \(deviceName)\n", stderr)
        } catch {
            fputs("[Mic] Failed to start engine: \(error)\n", stderr)
            if retriesLeft > 0 {
                DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    guard let self = self else { return }
                    self.engine = AVAudioEngine()
                    self.startEngine(retriesLeft: retriesLeft - 1)
                }
            }
        }
    }

    private func installEngineConfigObserver() {
        // DISABLED: ScreenCaptureKit system-audio start fires a config change
        // shortly after launch, which triggered a restart that killed mic capture.
        // Leave the mic engine alone; it survives ScreenCaptureKit just fine.
        fputs("[Mic] Config-change observer disabled\n", stderr)
    }

    // ── Patch B: Core Audio device-list listener ─────────────────────────────
    // DISABLED: was firing during SCStream startup and triggering a mic restart
    // that killed candidate capture after ~5s.
    private func installCoreAudioDeviceListener() {
        fputs("[Mic] Core Audio device listener disabled\n", stderr)
    }

    private func restartEngine() {
        // Coalesce: device-change and config-change often fire back-to-back
        guard !restartInFlight else { return }
        restartInFlight = true

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        pcm48 = Data()
        chunk16 = Data()

        // ── Patch B: longer settle delay (1.2s) so the OS finishes the switch
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self = self else { return }
            self.engine = AVAudioEngine()
            self.startEngine(retriesLeft: 3)
            self.installEngineConfigObserver()
            self.restartInFlight = false
        }
    }

    func stop() {
        if running {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            running = false
            fputs("[Mic] Engine stopped\n", stderr)
        }
        if let obs = deviceChangeObserver {
            NotificationCenter.default.removeObserver(obs)
            deviceChangeObserver = nil
        }
        deepgram.close()
    }
}

// MARK: - Main

@available(macOS 13.0, *)
func run(_ serverURL: String, _ dgKey: String, _ name: String, _ company: String) async throws {
    guard let railURL = URL(string: serverURL) else { exit(1) }
    let railway = RailwayWS(railURL)

    // System audio Deepgram session (interviewer)
    let dgSystem = DeepgramWS(apiKey: dgKey, sampleRate: 16000, label: "System")
    // Mic audio Deepgram session (candidate)
    let dgMic = DeepgramWS(apiKey: dgKey, sampleRate: 16000, label: "Mic")

    // System audio transcripts → desktop_transcript (interviewer)
    dgSystem.onTranscript = { text, isFinal in
        if isFinal {
            fputs("[Transcript] \(text)\n", stderr)
            let msg: [String: Any] = ["type": "desktop_transcript", "text": text, "isFinal": true, "speaker": "Interviewer"]
            if let d = try? JSONSerialization.data(withJSONObject: msg), let s = String(data: d, encoding: .utf8) {
                railway.sendText(s)
            }
        } else {
            fputs("[Interim] \(text)\n", stderr)
        }
    }

    railway.onOpen = {
        fputs("[Railway] connected\n", stderr)
        let msg: [String: Any] = ["type": "start_call", "prospectName": name, "prospectCompany": company, "sampleRate": 16000, "source": "desktop_app"]
        if let d = try? JSONSerialization.data(withJSONObject: msg), let s = String(data: d, encoding: .utf8) { railway.sendText(s) }
    }
    railway.onMsg = { msg in
        fputs("[Railway] <- \(msg.prefix(80))\n", stderr)
        // Parse tts_state — server relays browser <audio> onplay/onended events
        // here so we can hard-gate the mic while the AI is physically speaking
        // through the speakers. See TTSGate.
        guard let data = msg.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type_ = obj["type"] as? String else { return }
        if type_ == "tts_state" {
            let playing = (obj["playing"] as? Bool) ?? false
            let utt = obj["utteranceId"] as? String
            ttsGate.setActive(playing, utteranceId: utt)
        }
    }

    railway.connect()
    dgSystem.connect()

    // Start system audio capture via ScreenCaptureKit FIRST so the audio
    // subsystem finishes reconfiguring before we install the mic tap.
    let d = AudioDelegate(railway: railway, deepgram: dgSystem)
    var stream: SCStream? = nil
    let micCapture = MicCapture(railway: railway, deepgram: dgMic)
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            fputs("[SC] No display found — system audio unavailable, starting mic only\n", stderr)
            micCapture.start()
            print("READY"); fflush(stdout)
            while let line = readLine(strippingNewline: true), line != "STOP" {}
            railway.sendText("{\"type\":\"end_call\"}")
            micCapture.stop()
            railway.close()
            return
        }

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = false
        cfg.sampleRate = 48000
        cfg.channelCount = 1  // mono — no channel mixing bugs
        cfg.width = 2; cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        stream = SCStream(filter: filter, configuration: cfg, delegate: d)
        try stream!.addStreamOutput(d, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio", qos: .userInteractive))
        try stream!.addStreamOutput(d, type: .screen, sampleHandlerQueue: DispatchQueue(label: "video", qos: .background))
        try await stream!.startCapture()
        fputs("[SC] capture started\n", stderr)
    } catch {
        fputs("[SC] Screen capture failed: \(error) — continuing with mic only\n", stderr)
    }

    // Give the audio subsystem ~1.5s to finish reconfiguring after SCStream
    // comes up, THEN install the mic tap.
    try await Task.sleep(nanoseconds: 1_500_000_000)
    micCapture.start()

    print("READY"); fflush(stdout)

    while let line = readLine(strippingNewline: true), line != "STOP" {}
    railway.sendText("{\"type\":\"end_call\"}")
    dgSystem.close()
    micCapture.stop()
    try await Task.sleep(nanoseconds: 300_000_000)
    if let s = stream { try? await s.stopCapture() }
    railway.close()
}

if #available(macOS 13.0, *) {
    let a = CommandLine.arguments
    let serverURL = a.count > 1 ? a[1] : "wss://app.noruma.ai"
    let dgKey     = a.count > 2 ? a[2] : "54d546fe79b59f0f372e78e6cc3e77673649b611"
    let name      = a.count > 3 ? a[3] : ""
    let company   = a.count > 4 ? a[4] : ""
    Task {
        do { try await run(serverURL, dgKey, name, company) }
        catch { fputs("[Fatal] \(error)\n", stderr); exit(1) }
        exit(0)
    }
    RunLoop.main.run()
} else { fputs("macOS 13+ required\n", stderr); exit(1) }
