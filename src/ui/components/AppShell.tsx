import type { ReactNode } from 'react';
import { ChevronDown, Cpu, LogOut, Radio, ScrollText, Server, Settings, Shield, UserRound } from 'lucide-react';
import type { AppScreen, RelayServerOption } from '../model';
import { StatusBadge } from './StatusBadge';

type AppShellProps = {
  children: ReactNode;
  screen: AppScreen;
  sessionScreen?: 'host-room' | 'participant-room';
  username: string;
  server: RelayServerOption;
  servers: readonly RelayServerOption[];
  serverOpen: boolean;
  relayConnected: boolean;
  deviceConnected: boolean;
  statusTone: string;
  statusMessage: string;
  onToggleServers(): void;
  onSelectServer(server: RelayServerOption): void;
  onCustomServer(): void;
  onNavigate(screen: AppScreen): void;
  onLogout(): void;
};

export function AppShell(props: AppShellProps) {
  const roomActive = props.screen === 'host-room' || props.screen === 'participant-room';
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark"><Radio size={17} /></span>
          <div><strong>HAPTIC RELAY</strong><span>LIVE MOTION NETWORK</span></div>
        </div>
        <div className="server-picker">
          <div className="server-current"><Server size={15} /><span><small>현재 서버</small><strong>{props.server.name} · {props.server.pingMs}ms</strong></span></div>
          <button className="btn btn-secondary" type="button" onClick={props.onToggleServers}>서버 선택 <ChevronDown size={14} /></button>
          {props.serverOpen ? (
            <div className="server-menu" role="menu">
              {props.servers.filter(server => !server.custom).map(server => (
                <button className={server.id === props.server.id ? 'active' : ''} disabled={!server.available} key={server.id} type="button" onClick={() => props.onSelectServer(server)}>
                  <span>{server.name}</span><small>{server.available ? `${server.pingMs}ms` : '점검 중'}</small>
                </button>
              ))}
              <button type="button" onClick={props.onCustomServer}><Settings size={13} /> 사용자 서버 추가</button>
            </div>
          ) : null}
        </div>
        <div className="topbar-status">
          <StatusBadge connected={props.relayConnected} label="RELAY" />
          <StatusBadge connected={props.deviceConnected} label="DEVICE" />
        </div>
        <div className="account-block"><UserRound size={16} /><span><small>로그인됨</small><strong>{props.username}</strong></span></div>
        <button className="icon-button" title="로그아웃" aria-label="로그아웃" type="button" onClick={props.onLogout}><LogOut size={16} /></button>
      </header>
      <nav className="global-nav" aria-label="주요 메뉴">
        <button className={props.screen === 'browser' ? 'active' : ''} type="button" onClick={() => props.onNavigate('browser')}><Server size={15} /> 방 찾기</button>
        <button className={roomActive ? 'active' : ''} disabled={!props.sessionScreen} type="button" onClick={() => props.sessionScreen && props.onNavigate(props.sessionScreen)}><Radio size={15} /> 현재 세션</button>
        <button className={props.screen === 'hardware' ? 'active' : ''} type="button" onClick={() => props.onNavigate('hardware')}><Cpu size={15} /> 하드웨어</button>
        <button className={props.screen === 'safety' ? 'active' : ''} type="button" onClick={() => props.onNavigate('safety')}><Shield size={15} /> 보호 설정</button>
        <button className={props.screen === 'logs' ? 'active' : ''} type="button" onClick={() => props.onNavigate('logs')}><ScrollText size={15} /> 로그</button>
      </nav>
      <section className="workspace">{props.children}</section>
      <footer className={`statusbar ${props.statusTone}`}><span className="status-dot" />{props.statusMessage}<span className="statusbar-version">T-Code · 30Hz latest-value relay</span></footer>
    </main>
  );
}
