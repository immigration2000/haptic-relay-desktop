import type { BrowserRoom, RelayServerOption } from './model';

export const RELAY_SERVERS: readonly RelayServerOption[] = [
  { id: 'kr-seoul-1', name: '서울 1', url: 'https://relay-seoul-1.example.com', pingMs: 12, available: false },
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

export const DEMO_ROOMS: readonly BrowserRoom[] = [
  {
    id: 'demo-night-drive', kind: 'demo', title: '심야 드라이브', host: 'MinaLive',
    description: '부드러운 왕복 모션을 체험하는 공개 데모 방입니다.', tags: ['부드러움', '입문'],
    entryMode: 'open', viewerCount: 18, maxViewers: 50, serverName: '서울 1', passwordProtected: false, updatedLabel: '방금 전'
  },
  {
    id: 'demo-rhythm-lab', kind: 'demo', title: '리듬 테스트 랩', host: 'WaveStudio',
    description: '빠른 변화와 지연 설정을 확인하는 데모 데이터입니다.', tags: ['리듬', '테스트'],
    entryMode: 'request', viewerCount: 7, maxViewers: 30, serverName: '서울 2', passwordProtected: true, updatedLabel: '2분 전'
  },
  {
    id: 'demo-soft-session', kind: 'demo', title: '소프트 세션', host: 'Hana',
    description: '낮은 강도의 안정적인 움직임을 미리 확인합니다.', tags: ['저강도', '안정'],
    entryMode: 'open', viewerCount: 24, maxViewers: 100, serverName: '도쿄', passwordProtected: false, updatedLabel: '5분 전'
  }
];
