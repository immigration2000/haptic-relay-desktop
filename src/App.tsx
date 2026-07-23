import { useEffect, useMemo, useState } from 'react';
import type { ApprovalRequest, EntryMode, PortInfo, ViewerSession } from './shared/protocol';
import './styles.css';

type Role = 'host' | 'viewer';

export default function App() {
  const [role, setRole] = useState<Role>('host');
  const [relayUrl, setRelayUrl] = useState(import.meta.env.VITE_RELAY_URL ?? 'http://localhost:4174');
  const [displayName, setDisplayName] = useState('viewer-01');
  const [roomName, setRoomName] = useState('studio-main');
  const [password, setPassword] = useState('');
  const [entryMode, setEntryMode] = useState<EntryMode>('open');
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [status, setStatus] = useState('대기 중');
  const [intensity, setIntensity] = useState(0.5);
  const [position, setPosition] = useState(0.5);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [viewerSessions, setViewerSessions] = useState<ViewerSession[]>([]);

  const canHost = useMemo(() => roomName.trim().length >= 3, [roomName]);

  useEffect(() => {
    void refreshPorts();
  }, []);

  useEffect(() => {
    const removeApprovalRequest = window.hapticRelay.onApprovalRequest(request => {
      setApprovalRequests(current => {
        if (current.some(item => item.socketId === request.socketId)) return current;
        return [...current, request];
      });
      setStatus(`입장 신청: ${request.displayName}`);
    });
    const removeViewerStatus = window.hapticRelay.onViewerStatus(nextStatus => {
      if (nextStatus.status === 'approved') {
        setStatus(`방 입장 승인됨: ${nextStatus.roomName}`);
        return;
      }
      if (nextStatus.status === 'removed') {
        setStatus(`${nextStatus.reason === 'block' ? '차단' : '강퇴'}됨: ${nextStatus.roomName}`);
        return;
      }
      setStatus(`방 입장 거절됨: ${nextStatus.reason ?? nextStatus.roomName}`);
    });
    const removeViewerList = window.hapticRelay.onViewerList(viewers => {
      setViewerSessions(viewers);
    });
    const removeEmergencyStop = window.hapticRelay.onEmergencyStop(signal => {
      setStatus(`긴급 정지 수신: ${signal.roomName}`);
    });

    return () => {
      removeApprovalRequest();
      removeViewerStatus();
      removeViewerList();
      removeEmergencyStop();
    };
  }, []);

  async function refreshPorts() {
    const nextPorts = await window.hapticRelay.listPorts();
    setPorts(nextPorts);
    if (!selectedPort && nextPorts[0]) setSelectedPort(nextPorts[0].path);
  }

  async function connectHardware() {
    if (!selectedPort) return;
    await window.hapticRelay.connectHardware(selectedPort, 115200);
    setStatus(`하드웨어 연결됨: ${selectedPort}`);
  }

  async function createRoom() {
    if (!canHost) return;
    const room = await window.hapticRelay.startHostRoom(relayUrl.trim(), {
      roomName: roomName.trim(),
      password: password.trim() || undefined,
      entryMode
    });
    setApprovalRequests([]);
    setViewerSessions(await window.hapticRelay.listViewers());
    setStatus(`방 생성됨: ${room.roomName} / ${room.relayUrl}`);
  }

  async function joinRoom() {
    const response = await window.hapticRelay.joinRoom(relayUrl.trim(), {
      displayName: displayName.trim(),
      roomName: roomName.trim(),
      password: password.trim() || undefined
    });
    if (response.reason === 'approval-required') {
      setStatus(`입장 승인 대기 중: ${roomName}`);
      return;
    }
    setStatus(`방 입장됨: ${roomName}`);
  }

  async function decideApproval(request: ApprovalRequest, approved: boolean) {
    await window.hapticRelay.approveViewer(request.socketId, approved);
    setApprovalRequests(current => current.filter(item => item.socketId !== request.socketId));
    setStatus(`${request.displayName} ${approved ? '승인됨' : '거절됨'}`);
  }

  async function moderateViewer(viewer: ViewerSession, action: 'kick' | 'block') {
    await window.hapticRelay.moderateViewer(viewer.socketId, action);
    setViewerSessions(current => current.filter(item => item.socketId !== viewer.socketId));
    setStatus(`${viewer.displayName} ${action === 'block' ? '차단됨' : '강퇴됨'}`);
  }

  async function sendMotion() {
    await window.hapticRelay.sendMotion(intensity, position);
    setStatus(`모션 전송: intensity ${intensity.toFixed(2)}, position ${position.toFixed(2)}`);
  }

  async function emergencyStop() {
    const result = await window.hapticRelay.emergencyStop() as { relay?: { sent?: boolean; reason?: string } };
    if (result.relay?.sent === false && result.relay.reason !== 'invalid-host-room') {
      setStatus(`긴급 정지: 로컬 정지, relay ${result.relay.reason}`);
      return;
    }
    setStatus(role === 'host' ? '긴급 정지 전송됨' : '로컬 긴급 정지됨');
  }

  const hardwarePanel = (
    <section className="panel">
      <h2>{role === 'host' ? '스트리머 하드웨어' : '시청자 하드웨어'}</h2>
      <div className="hardware-row">
        <select value={selectedPort} onChange={event => setSelectedPort(event.target.value)}>
          {ports.map(port => (
            <option value={port.path} key={port.path}>{port.path}</option>
          ))}
        </select>
        <button onClick={refreshPorts}>새로고침</button>
        <button onClick={connectHardware}>연결</button>
      </div>
    </section>
  );

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Haptic Relay</p>
          <h1>방송 플랫폼 독립형 하드웨어 연동</h1>
        </div>
        <div className="role-switch" aria-label="role">
          <button className={role === 'host' ? 'active' : ''} onClick={() => setRole('host')}>스트리머</button>
          <button className={role === 'viewer' ? 'active' : ''} onClick={() => setRole('viewer')}>시청자</button>
        </div>
        <button className="danger" onClick={emergencyStop}>긴급 정지</button>
        <p className="status">{status}</p>
      </aside>

      <section className="workspace">
        <section className="panel">
          <h2>릴레이 서버</h2>
          <label>
            서버 URL
            <input value={relayUrl} onChange={event => setRelayUrl(event.target.value)} />
          </label>
        </section>

        {role === 'host' ? (
          <>
            <section className="panel">
              <h2>방 만들기</h2>
              <div className="form-grid">
                <label>
                  방 이름
                  <input value={roomName} onChange={event => setRoomName(event.target.value)} />
                </label>
                <label>
                  비밀번호
                  <input value={password} onChange={event => setPassword(event.target.value)} placeholder="선택" />
                </label>
                <label>
                  입장 방식
                  <select value={entryMode} onChange={event => setEntryMode(event.target.value as EntryMode)}>
                    <option value="open">자유입장</option>
                    <option value="request">신청입장</option>
                  </select>
                </label>
              </div>
              <button className="primary" disabled={!canHost} onClick={createRoom}>방 생성</button>
            </section>

            {hardwarePanel}

            {entryMode === 'request' ? (
              <section className="panel">
                <h2>입장 신청</h2>
                {approvalRequests.length === 0 ? (
                  <p className="muted">대기 중인 신청이 없습니다.</p>
                ) : (
                  <div className="approval-list">
                    {approvalRequests.map(request => (
                      <div className="approval-row" key={request.socketId}>
                        <div>
                          <strong>{request.displayName}</strong>
                          <span>{request.roomName}</span>
                        </div>
                        <button onClick={() => decideApproval(request, false)}>거절</button>
                        <button className="primary" onClick={() => decideApproval(request, true)}>승인</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            <section className="panel">
              <h2>접속자 관리</h2>
              {viewerSessions.length === 0 ? (
                <p className="muted">현재 접속한 시청자가 없습니다.</p>
              ) : (
                <div className="approval-list">
                  {viewerSessions.map(viewer => (
                    <div className="approval-row" key={viewer.socketId}>
                      <div>
                        <strong>{viewer.displayName}</strong>
                        <span>{viewer.roomName}</span>
                      </div>
                      <button onClick={() => moderateViewer(viewer, 'kick')}>강퇴</button>
                      <button onClick={() => moderateViewer(viewer, 'block')}>차단</button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="panel">
              <h2>모션 테스트</h2>
              <label>
                강도
                <input type="range" min="0" max="1" step="0.01" value={intensity} onChange={event => setIntensity(Number(event.target.value))} />
              </label>
              <label>
                위치
                <input type="range" min="0" max="1" step="0.01" value={position} onChange={event => setPosition(Number(event.target.value))} />
              </label>
              <button className="primary" onClick={sendMotion}>시청자에게 전송</button>
            </section>
          </>
        ) : (
          <>
            <section className="panel">
              <h2>방 입장</h2>
              <div className="form-grid">
                <label>
                  표시 이름
                  <input value={displayName} onChange={event => setDisplayName(event.target.value)} />
                </label>
                <label>
                  방 이름
                  <input value={roomName} onChange={event => setRoomName(event.target.value)} />
                </label>
                <label>
                  비밀번호
                  <input value={password} onChange={event => setPassword(event.target.value)} />
                </label>
              </div>
              <button className="primary" onClick={joinRoom}>입장 요청</button>
            </section>

            {hardwarePanel}
          </>
        )}
      </section>
    </main>
  );
}
