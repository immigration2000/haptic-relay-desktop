import type { RelayServerOption } from './model';

export const RELAY_SERVERS: readonly RelayServerOption[] = [
  { id: 'official-relay', name: '공식 릴레이', url: 'https://relay.syncra.uk', pingMs: 0, available: true },
  { id: 'kr-seoul-2', name: '서울 2', url: 'https://relay-seoul-2.example.com', pingMs: 18, available: false },
  { id: 'jp-tokyo', name: '도쿄', url: 'https://relay-tokyo.example.com', pingMs: 34, available: false },
  { id: 'sg-singapore', name: '싱가포르', url: 'https://relay-singapore.example.com', pingMs: 71, available: false },
  { id: 'us-west', name: '미국 서부', url: 'https://relay-us-west.example.com', pingMs: 132, available: false },
  { id: 'us-east', name: '미국 동부', url: 'https://relay-us-east.example.com', pingMs: 181, available: false },
  { id: 'eu-frankfurt', name: '프랑크푸르트', url: 'https://relay-frankfurt.example.com', pingMs: 224, available: false },
  { id: 'au-sydney', name: '시드니', url: 'https://relay-sydney.example.com', pingMs: 194, available: false },
  { id: 'demo-local', name: '로컬 데모', url: 'http://localhost:4174', pingMs: 1, available: true },
  { id: 'custom', name: '사용자 서버', url: '', pingMs: 0, available: true, custom: true }
];
