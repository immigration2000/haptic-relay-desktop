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

export function decodeMotionPacket(payload: ArrayBuffer | Uint8Array | Buffer): MotionFrame {
  const packet = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (packet.byteLength !== PACKET_SIZE) {
    throw new Error(`invalid-motion-packet-size:${packet.byteLength}`);
  }

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return {
    position: fromUint16(view.getUint16(0, false)),
    intensity: fromUint16(view.getUint16(2, false)),
    timestamp: Date.now()
  };
}

function toUint16(value: number) {
  return Math.round(clamp01(value) * UINT16_SCALE);
}

function fromUint16(value: number) {
  return value / UINT16_SCALE;
}
