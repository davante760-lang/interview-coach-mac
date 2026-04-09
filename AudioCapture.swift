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

    private func recv() {
        task?.receive { [weak self] r in
            switch r {
            case .success(let m):
                if case .string(let s) = m { self?.onMsg?(s) }
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
    private var keepaliveTimer: DispatchSourceTimer?
    private var reconnectAttempts = 0

    init(apiKey: String, sampleRate: Int, label: String = "System") {
        self.apiKey = apiKey
        self.sampleRate = sampleRate
        self.label = label
    }

    func connect() {
        let urlStr = "wss://api.deepgram.com/v1/listen?model=nova-2&language=en&punctuate=true&interim_results=true&utterance_end_ms=1000&encoding=linear16&sample_rate=\(sampleRate)&channels=1"
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
                       let type_ = json["type"] as? String, type_ == "Results",
                       let channel = json["channel"] as? [String: Any],
                       let alts = channel["alternatives"] as? [[String: Any]],
                       let transcript = alts.first?["transcript"] as? String,
                       !transcript.isEmpty {
                        let isFinal = json["is_final"] as? Bool ?? false
                        self?.onTranscript?(transcript, isFinal)
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

// MARK: - Audio Delegate (SAFE: uses CMBlockBufferCopyDataBytes, never AudioBufferList)

@available(macOS 13.0, *)
class AudioDelegate: NSObject, SCStreamOutput, SCStreamDelegate {
    let railway: RailwayWS
    let deepgram: DeepgramWS
    private var accum = Data()
    private let chunkBytes = 8192 // 4096 int16 samples * 2 bytes
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

        // SCStream delivers float32 mono (channelCount=1)
        // Downsample 48kHz -> 16kHz = take every 3rd frame
        let dsRatio = 3

        rawData.withUnsafeBytes { rawPtr in
            guard let floats = rawPtr.baseAddress?.assumingMemoryBound(to: Float32.self) else { return }
            let totalFloats = totalBytes / 4

            var frameIdx = 0
            while frameIdx < numFrames {
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
                accum.append(Data(bytes: &val, count: 2))

                frameIdx += dsRatio
            }
        }

        while accum.count >= chunkBytes {
            let chunk = accum.prefix(chunkBytes)
            accum.removeFirst(chunkBytes)
            deepgram.sendAudio(Data(chunk))
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
    private var accum = Data()
    private let chunkBytes = 8192
    private var sent = 0
    private var running = false
    private var deviceChangeObserver: NSObjectProtocol?
    private var coreAudioListenerInstalled = false
    private var restartInFlight = false

    // Patch C: RMS gate — drop chunks quieter than this (kills residual speaker bleed)
    private let rmsGateThreshold: Float = 0.005

    init(railway: RailwayWS, deepgram: DeepgramWS) {
        self.railway = railway
        self.deepgram = deepgram
    }

    func start() {
        // Set up Deepgram transcript handler — sends as desktop_candidate_transcript
        deepgram.onTranscript = { [weak self] text, isFinal in
            guard let self = self else { return }
            if isFinal {
                fputs("[Mic-Transcript] \(text)\n", stderr)
                let msg: [String: Any] = [
                    "type": "desktop_candidate_transcript",
                    "text": text,
                    "isFinal": true,
                    "speaker": "You"
                ]
                if let d = try? JSONSerialization.data(withJSONObject: msg),
                   let s = String(data: d, encoding: .utf8) {
                    self.railway.sendText(s)
                }
            } else {
                fputs("[Mic-Interim] \(text)\n", stderr)
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
        // Subtracts system audio output from mic input. Stops the interviewer's
        // voice (playing through speakers) from being captured by the mic and
        // mis-tagged as candidate speech.
        do {
            try inputNode.setVoiceProcessingEnabled(true)
            fputs("[Mic] Voice processing (AEC) enabled\n", stderr)
        } catch {
            fputs("[Mic] AEC unavailable: \(error) — continuing without echo cancel\n", stderr)
        }

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

        let hwSampleRate = hwFormat.sampleRate
        let hwChannels = Int(hwFormat.channelCount)
        let dsRatio = max(1, Int(hwSampleRate / 16000.0))

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            guard let channelData = buffer.floatChannelData else { return }

            let frameCount = Int(buffer.frameLength)

            // ── Patch C: RMS gate ────────────────────────────────────────────
            // Compute mean-square energy across the buffer; if it's near silence,
            // drop the whole buffer. Catches any residual speaker bleed AEC misses.
            var sumSq: Float = 0
            var sampleCount: Int = 0
            for ch in 0..<hwChannels {
                let ptr = channelData[ch]
                for f in 0..<frameCount {
                    let s = ptr[f]
                    sumSq += s * s
                    sampleCount += 1
                }
            }
            let rms = sampleCount > 0 ? sqrt(sumSq / Float(sampleCount)) : 0
            if rms < self.rmsGateThreshold {
                return  // silence/bleed — don't downsample, don't send
            }

            var frameIdx = 0
            while frameIdx < frameCount {
                var mono: Float = 0
                for ch in 0..<hwChannels { mono += channelData[ch][frameIdx] }
                mono /= Float(hwChannels)

                let clamped = max(-1.0, min(1.0, mono))
                var val = Int16(clamped < 0 ? clamped * 32768 : clamped * 32767).littleEndian
                self.accum.append(Data(bytes: &val, count: 2))

                frameIdx += dsRatio
            }

            while self.accum.count >= self.chunkBytes {
                let chunk = self.accum.prefix(self.chunkBytes)
                self.accum.removeFirst(self.chunkBytes)
                self.deepgram.sendAudio(Data(chunk))
                self.sent += 1
                if self.sent == 1 || self.sent == 10 || self.sent % 100 == 0 {
                    fputs("[Audio-Mic] \(self.sent) chunks sent\n", stderr)
                }
            }
        }

        do {
            try engine.start()
            running = true
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
        if let old = deviceChangeObserver {
            NotificationCenter.default.removeObserver(old)
        }
        deviceChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            guard let self = self, self.running else { return }
            fputs("[Mic] AVAudioEngine config change — restarting\n", stderr)
            self.restartEngine()
        }
    }

    // ── Patch B: Core Audio device-list listener ─────────────────────────────
    // AVAudioEngineConfigurationChange misses some plug/unplug events.
    // Listen directly on Core Audio for default-input changes too.
    private func installCoreAudioDeviceListener() {
        guard !coreAudioListenerInstalled else { return }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &addr,
            DispatchQueue.global()
        ) { [weak self] _, _ in
            guard let self = self, self.running else { return }
            fputs("[Mic] Core Audio default-input changed — restarting\n", stderr)
            self.restartEngine()
        }
        if status == noErr {
            coreAudioListenerInstalled = true
            fputs("[Mic] Core Audio device listener installed\n", stderr)
        } else {
            fputs("[Mic] Failed to install Core Audio listener: \(status)\n", stderr)
        }
    }

    private func restartEngine() {
        // Coalesce: device-change and config-change often fire back-to-back
        guard !restartInFlight else { return }
        restartInFlight = true

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        accum = Data()

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
    railway.onMsg = { fputs("[Railway] <- \($0.prefix(80))\n", stderr) }

    railway.connect()
    dgSystem.connect()

    // Start mic capture (separate Deepgram session, sends desktop_candidate_transcript)
    let micCapture = MicCapture(railway: railway, deepgram: dgMic)
    micCapture.start()

    // Start system audio capture via ScreenCaptureKit
    let d = AudioDelegate(railway: railway, deepgram: dgSystem)
    var stream: SCStream? = nil
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            fputs("[SC] No display found — system audio unavailable, mic still running\n", stderr)
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
        fputs("[SC] Screen capture failed: \(error) — mic capture still running\n", stderr)
    }
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
    let serverURL = a.count > 1 ? a[1] : "wss://interview-coach-production-9c63.up.railway.app"
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
