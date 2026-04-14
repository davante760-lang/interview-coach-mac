// ICEchoCanceller.h
// Swift-visible Objective-C interface to WebRTC's AEC3 echo canceller.
// All audio is assumed to be 48 kHz, 1 channel, int16 interleaved,
// and delivered in 10 ms frames (480 samples per frame).

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ICEchoCanceller : NSObject

// Create an AEC3 instance. Returns nil if APM can't be built.
- (nullable instancetype)init;

// Feed one 10 ms frame of the "far-end" reference signal (what the user
// is hearing from the speakers — the system audio that we also want to
// prevent from leaking into the mic transcript).
// `samples` must be exactly 480 int16 samples (48 kHz * 10 ms * 1 channel).
- (void)processReverseFrame:(const int16_t *)samples;

// Feed one 10 ms frame of the "near-end" capture signal (raw mic).
// Writes 480 cleaned int16 samples into `output`.
// Returns YES on success, NO on any APM error.
- (BOOL)processCaptureFrame:(const int16_t *)input
                     output:(int16_t *)output;

// Inform the AEC of the total echo path delay in ms — roughly the time
// from when ProcessReverseStream is called until ProcessStream sees the
// same content bouncing back through the room.
- (void)setStreamDelayMs:(int)delayMs;

// Fully reset APM internal state (reverse buffer, delay estimator, etc.)
// Call this right before mic capture starts so reverse and capture streams
// begin with aligned frame counts — otherwise the leading reverse frames
// fall out of AEC3's ~300ms history window and cancellation fails.
- (void)reset;

@end

NS_ASSUME_NONNULL_END
