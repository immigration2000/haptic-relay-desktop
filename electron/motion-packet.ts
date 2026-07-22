import type { MotionFrame } from './protocol.js';
import { clamp01 } from './tuning.js';

const PACKET_SIZE = 4;
const UINT16_SCALE = 65535;

export function encodeMotionPacket(frame: MotionFrame) {
  const packet = new Uint8Array(PACKET_SIZE);
  const view = new DataView(packet.buffer);
  view.setUint16(0, toUint16(frame.position), false);
  view.setUint16(2, toUint16(frame.intensity), false);
  return packet;
}

function toUint16(value: number) {
  return Math.round(clamp01(value) * UINT16_SCALE);
}
