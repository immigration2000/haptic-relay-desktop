import type { ReactNode } from 'react';
export function HardwareView({ children }: { children: ReactNode }) { return <div className="tool-view"><header className="view-heading compact"><div><span className="kicker">DEVICE CONFIGURATION</span><h1>하드웨어 설정</h1><p>T-Code 장비 프로필과 직렬 연결을 관리합니다.</p></div></header>{children}</div>; }
