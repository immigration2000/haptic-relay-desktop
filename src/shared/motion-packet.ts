import type { MotionFrame } from './protocol.js';
import { clamp01 } from './tuning.js';

const V1_PACKET_SIZE = 4;
const V2_PACKET_SIZE = 20;
const V2_VERSION = 2;
const UINT16_SCALE = 65535;

export function encodeMotionPacket(frame: MotionFrame) {
  const packet = new Uint8Array(V2_PACKET_SIZE);
  const view = new DataView(packet.buffer);
  view.setUint8(0, V2_VERSION);
  view.setUint8(1, toUint8(frame.flags ?? 0));
  view.setUint32(2, toUint32(frame.sequence ?? 0), false);
  view.setBigUint64(6, BigInt(toSafeTimestamp(frame.sourceTimeMs ?? frame.timestamp)), false);
  view.setUint16(14, toUint16Raw(frame.durationMs ?? 0), false);
  view.setUint16(16, toUint16(frame.position), false);
  view.setUint16(18, toUint16(frame.intensity), false);
  return packet;
}

export function decodeMotionPacket(payload: ArrayBuffer | Uint8Array | Buffer): MotionFrame {
  const packet = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (packet.byteLength === V1_PACKET_SIZE) {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    return {
      position: fromUint16(view.getUint16(0, false)),
      intensity: fromUint16(view.getUint16(2, false)),
      timestamp: Date.now(),
      protocolVersion: 1,
      durationMs: 0
    };
  }

  if (packet.byteLength !== V2_PACKET_SIZE) {
    throw new Error(`invalid-motion-packet-size:${packet.byteLength}`);
  }

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const version = view.getUint8(0);
  if (version !== V2_VERSION) {
    throw new Error(`invalid-motion-packet-version:${version}`);
  }

  const sourceTimeMs = Number(view.getBigUint64(6, false));
  return {
    protocolVersion: 2,
    flags: view.getUint8(1),
    sequence: view.getUint32(2, false),
    sourceTimeMs,
    timestamp: sourceTimeMs,
    durationMs: view.getUint16(14, false),
    position: fromUint16(view.getUint16(16, false)),
    intensity: fromUint16(view.getUint16(18, false))
  };
}

function toUint16(value: number) {
  return Math.round(clamp01(value) * UINT16_SCALE);
}

function fromUint16(value: number) {
  return value / UINT16_SCALE;
}

function toUint8(value: number) {
  return Math.max(0, Math.min(255, Math.trunc(value)));
}

function toUint32(value: number) {
  return Math.max(0, Math.min(0xffff_ffff, Math.trunc(value)));
}

function toUint16Raw(value: number) {
  return Math.max(0, Math.min(0xffff, Math.trunc(value)));
}

function toSafeTimestamp(value: number) {
  if (!Number.isFinite(value) || value < 0) return Date.now();
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}
