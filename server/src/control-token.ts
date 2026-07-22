import { createHmac, timingSafeEqual } from 'node:crypto';

export type RelayRole = 'host' | 'viewer';

export type RelayTokenPayload = {
  role: RelayRole;
  roomName: string;
  displayName?: string;
  exp: number;
};

export function signRelayToken(payload: RelayTokenPayload, secret: string) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyRelayToken(token: string, secret: string): RelayTokenPayload | undefined {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return undefined;

  const expectedSignature = sign(encodedPayload, secret);
  if (!safeEqual(signature, expectedSignature)) return undefined;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as RelayTokenPayload;
    if (payload.exp < Date.now()) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}
