import type { ReactNode } from 'react';
import { LogOut, Radio, Users } from 'lucide-react';

export type SessionTab = 'overview' | 'demo' | 'receive' | 'delay' | 'hardware' | 'safety' | 'logs';

export function RoomSessionView({ role, roomTitle, roomMeta, activeTab, tabs, viewerCount, onTabChange, onLeave, children }: {
  role: 'host' | 'participant'; roomTitle: string; roomMeta: string; activeTab: SessionTab;
  tabs: Array<{ id: SessionTab; label: string }>; viewerCount?: number;
  onTabChange(tab: SessionTab): void; onLeave(): void; children: ReactNode;
}) {
  return (
    <div className="session-view">
      <header className="session-header"><div className="session-title"><span className="live-indicator"><Radio size={14} /> LIVE</span><div><span>{role === 'host' ? 'HOST SESSION' : 'PARTICIPANT SESSION'}</span><h1>{roomTitle}</h1><p>{roomMeta}</p></div></div><div className="session-actions">{role === 'host' ? <span className="viewer-chip"><Users size={14} /> {viewerCount ?? 0}명 접속</span> : null}<button className="btn btn-secondary" type="button" onClick={onLeave}><LogOut size={14} /> {role === 'host' ? '방 종료' : '방 나가기'}</button></div></header>
      <nav className="session-tabs" aria-label="세션 메뉴">{tabs.map(tab => <button className={activeTab === tab.id ? 'active' : ''} key={tab.id} type="button" onClick={() => onTabChange(tab.id)}>{tab.label}</button>)}</nav>
      <div className="session-content">{children}</div>
    </div>
  );
}
