// ICEchoCanceller.mm
// Objective-C++ bridge between Swift (AudioCapture.swift) and WebRTC's
// AudioProcessingModule (AEC3). Everything is single-channel 48 kHz int16
// in 10 ms frames (480 samples per frame).

#import "ICEchoCanceller.h"

#include <memory>
#include "api/audio/audio_processing.h"
#include "api/scoped_refptr.h"

using webrtc::AudioProcessing;
using webrtc::AudioProcessingBuilder;
using webrtc::StreamConfig;

static constexpr int kSampleRateHz = 48000;
static constexpr int kFrameSamples = 480; // 10 ms @ 48 kHz mono
static constexpr size_t kNumChannels = 1;

static float frameRMS(const int16_t *s, int n) {
    if (n <= 0) return 0;
    double acc = 0;
    for (int i = 0; i < n; i++) { double x = (double)s[i]; acc += x*x; }
    return (float)sqrt(acc / (double)n);
}

@implementation ICEchoCanceller {
    rtc::scoped_refptr<AudioProcessing> _apm;
    StreamConfig _inConfig;
    StreamConfig _outConfig;
    long _reverseCount;
    long _captureCount;
    double _sumInRMS;
    double _sumOutRMS;
    long _windowFrames;
}

- (nullable instancetype)init {
    self = [super init];
    if (!self) return nil;

    AudioProcessing::Config config;
    // Enable AEC3 in full (non-mobile) mode — best quality path.
    config.echo_canceller.enabled = true;
    config.echo_canceller.mobile_mode = false;

    // AEC3 alone only cancels the LINEAR part of the echo path. On MacBook
    // speakers the residual nonlinear echo (~25% of original RMS in our
    // measurements) is still loud enough for Deepgram to transcribe. The
    // residual suppressor lives inside WebRTC's noise suppression block —
    // enabling NS at a moderate level knocks the residual down to near
    // silence without materially affecting the candidate's voice tone.
    // HPF removes DC + low-frequency rumble that otherwise confuses the AEC
    // delay estimator. AGC stays off so Deepgram gets unaltered levels.
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = false;
    config.noise_suppression.enabled = true;
    config.noise_suppression.level = AudioProcessing::Config::NoiseSuppression::kHigh;
    config.high_pass_filter.enabled = true;
    config.transient_suppression.enabled = false;

    // Mono in / mono out — no channel shuffling.
    config.pipeline.multi_channel_render = false;
    config.pipeline.multi_channel_capture = false;
    config.pipeline.maximum_internal_processing_rate = 48000;

    _apm = AudioProcessingBuilder().SetConfig(config).Create();
    if (!_apm) {
        NSLog(@"[ICEchoCanceller] APM build failed");
        return nil;
    }

    _inConfig = StreamConfig(kSampleRateHz, kNumChannels);
    _outConfig = StreamConfig(kSampleRateHz, kNumChannels);

    NSLog(@"[ICEchoCanceller] AEC3 initialized (48 kHz, mono, 480 samples/frame)");
    return self;
}

- (void)processReverseFrame:(const int16_t *)samples {
    if (!_apm || !samples) return;
    int err = _apm->ProcessReverseStream(samples, _inConfig, _outConfig,
                                         const_cast<int16_t *>(samples));
    if (err != AudioProcessing::kNoError) {
        NSLog(@"[ICEchoCanceller] ProcessReverseStream err=%d", err);
        return;
    }
    _reverseCount++;
    if (_reverseCount == 1 || _reverseCount == 10 || _reverseCount % 300 == 0) {
        fprintf(stderr, "[AEC] reverse frames processed: %ld (rms=%.0f)\n",
                _reverseCount, frameRMS(samples, 480));
    }
}

- (BOOL)processCaptureFrame:(const int16_t *)input
                     output:(int16_t *)output {
    if (!_apm || !input || !output) return NO;
    float inRms = frameRMS(input, 480);
    int err = _apm->ProcessStream(input, _inConfig, _outConfig, output);
    if (err != AudioProcessing::kNoError) {
        NSLog(@"[ICEchoCanceller] ProcessStream err=%d", err);
        return NO;
    }
    float outRms = frameRMS(output, 480);
    _captureCount++;
    _sumInRMS += inRms;
    _sumOutRMS += outRms;
    _windowFrames++;
    if (_captureCount == 1 || _captureCount == 10 || _captureCount % 100 == 0) {
        double meanIn  = _sumInRMS  / (double)_windowFrames;
        double meanOut = _sumOutRMS / (double)_windowFrames;
        double reduction = meanIn > 1.0 ? (1.0 - meanOut / meanIn) * 100.0 : 0.0;
        fprintf(stderr, "[AEC] capture=%ld  revSeen=%ld  inRMS=%.0f  outRMS=%.0f  reduction=%.1f%%\n",
                _captureCount, _reverseCount, meanIn, meanOut, reduction);
        _sumInRMS = 0; _sumOutRMS = 0; _windowFrames = 0;
    }
    return YES;
}

- (void)setStreamDelayMs:(int)delayMs {
    if (!_apm) return;
    _apm->set_stream_delay_ms(delayMs);
}

- (void)reset {
    if (!_apm) return;
    _apm->Initialize();
    _reverseCount = 0;
    _captureCount = 0;
    _sumInRMS = 0;
    _sumOutRMS = 0;
    _windowFrames = 0;
    fprintf(stderr, "[AEC] reset — frame counts re-aligned\n");
}

@end
