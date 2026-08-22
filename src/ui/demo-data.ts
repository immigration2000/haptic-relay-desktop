import type { RelayServerOption } from './model';

export const RELAY_SERVERS: readonly RelayServerOption[] = [
  { id: 'aws-main', name: 'AWS 메인 릴레이', url: 'https://aws-relay.syncra.uk', pingMs: 0, available: true },
  { id: 'phone-backup', name: '휴대폰 예비 릴레이', url: 'https://relay.syncra.uk', pingMs: 0, available: true },
  { id: 'demo-local', name: '로컬 데모', url: 'http://localhost:4174', pingMs: 1, available: true },
  { id: 'custom', name: '사용자 서버', url: '', pingMs: 0, available: true, custom: true }
];
