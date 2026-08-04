import assert from 'node:assert/strict';

const relayModule = await import('../dist-electron/services/relay-client.js');

assert.equal(
  typeof relayModule.MotionSequenceTracker,
  'function',
  'relay client must export a motion sequence tracker'
);
assert.equal(
  typeof relayModule.nextMotionSequence,
  'function',
  'relay client must export a motion sequence increment helper'
);

const tracker = new relayModule.MotionSequenceTracker();

assert.equal(tracker.accept(frame(10)), true, 'first sequenced frame is accepted');
assert.deepEqual(tracker.snapshot(), {
  receivedFrames: 1,
  acceptedFrames: 1,
  duplicateFrames: 0,
  outOfOrderFrames: 0,
  lostFrames: 0,
  lastSequence: 10
});

assert.equal(tracker.accept(frame(12)), true, 'newer frame is accepted');
assert.equal(tracker.snapshot().lostFrames, 1, 'sequence gap counts missing frames');

assert.equal(tracker.accept(frame(12)), false, 'duplicate frame is rejected');
assert.equal(tracker.accept(frame(11)), false, 'out-of-order frame is rejected');
assert.deepEqual(tracker.snapshot(), {
  receivedFrames: 4,
  acceptedFrames: 2,
  duplicateFrames: 1,
  outOfOrderFrames: 1,
  lostFrames: 1,
  lastSequence: 12
});

assert.equal(tracker.accept(frame(undefined, 1)), true, 'legacy V1 frame remains compatible');
assert.equal(tracker.snapshot().lastSequence, 12, 'legacy frame does not alter V2 ordering');

tracker.reset();
assert.deepEqual(tracker.snapshot(), {
  receivedFrames: 0,
  acceptedFrames: 0,
  duplicateFrames: 0,
  outOfOrderFrames: 0,
  lostFrames: 0,
  lastSequence: undefined
});

assert.equal(tracker.accept(frame(0xffff_fffe)), true, 'sequence near uint32 maximum is accepted');
assert.equal(tracker.accept(frame(0)), true, 'wrapped sequence is accepted');
assert.equal(tracker.snapshot().lostFrames, 1, 'wraparound gap counts the skipped maximum value');

assert.equal(relayModule.nextMotionSequence(0), 1, 'outgoing sequence increments');
assert.equal(relayModule.nextMotionSequence(0xffff_ffff), 0, 'outgoing sequence wraps at uint32 maximum');

const relayClient = new relayModule.RelayClient();
assert.equal(
  typeof relayClient.getMotionSequenceStats,
  'function',
  'relay client must expose receive sequence metrics'
);
assert.deepEqual(
  relayClient.getMotionSequenceStats(),
  {
    receivedFrames: 0,
    acceptedFrames: 0,
    duplicateFrames: 0,
    outOfOrderFrames: 0,
    lostFrames: 0,
    lastSequence: undefined
  },
  'relay client exposes current receive sequence metrics'
);

console.log('motion sequence tests passed');

function frame(sequence, protocolVersion = 2) {
  return {
    protocolVersion,
    sequence,
    sourceTimeMs: 1_785_846_123_456,
    timestamp: 1_785_846_123_456,
    durationMs: 20,
    position: 0.5,
    intensity: 0.5
  };
}
