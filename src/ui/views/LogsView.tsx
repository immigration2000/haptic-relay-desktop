import type { ReactNode } from 'react';
export function LogsView({ children }: { children: ReactNode }) { return <div className="tool-view"><header className="view-heading compact"><div><span className="kicker">EVENT INSPECTOR</span><h1>로그</h1><p>릴레이, 방, 하드웨어, 보호 이벤트를 확인합니다.</p></div></header>{children}</div>; }
