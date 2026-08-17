import type { ReactNode } from 'react';
export function SafetyView({ children }: { children: ReactNode }) { return <div className="tool-view"><header className="view-heading compact"><div><span className="kicker">MOTION PROTECTION</span><h1>보호 설정</h1><p>수신 강도와 위치 범위를 제한하고 즉시 정지합니다.</p></div></header>{children}</div>; }
