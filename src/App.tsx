import { useEffect, useMemo, useState } from 'react';
import type { ApprovalRequest, EntryMode, PortInfo, ViewerSession } from './shared/protocol';
import './styles.css';

type Role = 'host' | 'viewer';
type StatusTone = 'idle' | 'busy' | 'ok' | 'warning' | 'error';
type BusyAction = 'ports' | 'hardware' | 'room' | 'join' | 'approval' | 'moderation' | 'motion' | 'stop';

type AppStatus = {
  tone: StatusTone;
  message: string;
};

export default function App() {
  const [role, setRole] = useState<Role>('host');
  const [relayUrl, setRelayUrl] = useState(import.meta.env.VITE_RELAY_URL ?? 'http://localhost:4174');
  const [displayName, setDisplayName] = useState('viewer-01');
  const [roomName, setRoomName] = useState('studio-main');
  const [password, setPassword] = useState('');
  const [entryMode, setEntryMode] = useState<EntryMode>('open');
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [status, setStatus] = useState<AppStatus>({ tone: 'idle', message: '대기 중' });
  const [busyAction, setBusyAction] = useState<BusyAction>();
  const [intensity, setIntensity] = useState(0.5);
  const [position, setPosition] = useState(0.5);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [viewerSessions, setViewerSessions] = useState<ViewerSession[]>([]);

  const canHost = useMemo(() => roomName.trim().length >= 3, [roomName]);
  const canJoin = useMemo(() => roomName.trim().length >= 3 && displayName.trim().length > 0, [displayName, roomName]);
  const isBusy = busyAction !== undefined;

  useEffect(() => {
    void refreshPorts(true);
  }, []);

  useEffect(() => {
    const removeApprovalRequest = window.hapticRelay.onApprovalRequest(request => {
      setApprovalRequests(current => {
        if (current.some(item => item.socketId === request.socketId)) return current;
        return [...current, request];
      });
      setStatusMessage('warning', `입장 신청: ${request.displayName}`);
    });
    const removeViewerStatus = window.hapticRelay.onViewerStatus(nextStatus => {
      if (nextStatus.status === 'approved') {
        setStatusMessage('ok', `방 입장 승인됨: ${nextStatus.roomName}`);
        return;
      }
      if (nextStatus.status === 'removed') {
        setStatusMessage('warning', `${nextStatus.reason === 'block' ? '차단' : '강퇴'}됨: ${nextStatus.roomName}`);
        return;
      }
      setStatusMessage('warning', `방 입장 거절됨: ${formatReason(nextStatus.reason ?? nextStatus.roomName)}`);
    });
    const removeViewerList = window.hapticRelay.onViewerList(viewers => {
      setViewerSessions(viewers);
    });
    const removeEmergencyStop = window.hapticRelay.onEmergencyStop(signal => {
      setStatusMessage('warning', `긴급 정지 수신: ${signal.roomName}`);
    });
    const removeConnectionStatus = window.hapticRelay.onConnectionStatus(nextStatus => {
      if (nextStatus.status === 'connected') {
        if (!nextStatus.roomName) return;
        setStatusMessage('ok', `릴레이 연결됨: ${nextStatus.roomName}`);
        return;
      }
      if (nextStatus.status === 'reconnecting') {
        setStatusMessage('warning', `릴레이 재연결 중: ${nextStatus.roomName ?? '방 없음'}`);
        return;
      }
      if (nextStatus.status === 'rejoined') {
        const suffix = nextStatus.reason === 'approval-required' ? ' / 승인 대기' : '';
        setStatusMessage('ok', `방 재입장 완료: ${nextStatus.roomName}${suffix}`);
        return;
      }
      if (nextStatus.status === 'disconnected') {
        setStatusMessage('warning', `릴레이 연결 끊김: ${formatReason(nextStatus.reason ?? 'disconnected')}`);
        return;
      }
      setStatusMessage('error', `릴레이 오류: ${formatReason(nextStatus.reason ?? 'connect_error')}`);
    });

    return () => {
      removeApprovalRequest();
      removeViewerStatus();
      removeViewerList();
      removeEmergencyStop();
      removeConnectionStatus();
    };
  }, []);

  function setStatusMessage(tone: StatusTone, message: string) {
    setStatus({ tone, message });
  }

  async function runAction(action: BusyAction, busyMessage: string, task: () => Promise<void>) {
    if (busyAction) return;

    setBusyAction(action);
    setStatusMessage('busy', busyMessage);
    try {
      await task();
    } catch (error) {
      setStatusMessage('error', formatError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function refreshPorts(silent = false) {
    await runAction('ports', silent ? '포트 확인 중' : '하드웨어 포트 새로고침 중', async () => {
      const nextPorts = await window.hapticRelay.listPorts();
      setPorts(nextPorts);
      if (!selectedPort && nextPorts[0]) setSelectedPort(nextPorts[0].path);
      if (!silent) {
        setStatusMessage(nextPorts.length > 0 ? 'ok' : 'warning', nextPorts.length > 0 ? `포트 ${nextPorts.length}개 발견` : '사용 가능한 하드웨어 포트가 없습니다');
      }
    });
  }

  async function connectHardware() {
    if (!selectedPort) {
      setStatusMessage('warning', '연결할 하드웨어 포트를 선택하세요');
      return;
    }

    await runAction('hardware', '하드웨어 연결 중', async () => {
      const result = await window.hapticRelay.connectHardware(selectedPort, 115200);
      if (result.probe.detected) {
        const version = result.probe.version ? ` / TCode ${result.probe.version}` : '';
        const axes = result.probe.axes.length > 0 ? ` / 축 ${result.probe.axes.join(', ')}` : '';
        setStatusMessage('ok', `하드웨어 연결됨: ${selectedPort}${version}${axes}`);
        return;
      }

      setStatusMessage('warning', `하드웨어 연결됨: ${selectedPort} / TCode 응답 없음`);
    });
  }

  async function createRoom() {
    if (!canHost) {
      setStatusMessage('warning', '방 이름은 3자 이상이어야 합니다');
      return;
    }

    await runAction('room', '방 생성 중', async () => {
      const room = await window.hapticRelay.startHostRoom(normalizeRelayUrl(relayUrl), {
        roomName: roomName.trim(),
        password: password.trim() || undefined,
        entryMode
      });
      setApprovalRequests([]);
      setViewerSessions(await window.hapticRelay.listViewers());
      setStatusMessage('ok', `방 생성됨: ${room.roomName} / ${room.relayUrl}`);
    });
  }

  async function joinRoom() {
    if (!canJoin) {
      setStatusMessage('warning', '표시 이름과 3자 이상의 방 이름이 필요합니다');
      return;
    }

    await runAction('join', '방 입장 요청 중', async () => {
      const response = await window.hapticRelay.joinRoom(normalizeRelayUrl(relayUrl), {
        displayName: displayName.trim(),
        roomName: roomName.trim(),
        password: password.trim() || undefined
      });
      if (response.reason === 'approval-required') {
        setStatusMessage('warning', `입장 승인 대기 중: ${roomName.trim()}`);
        return;
      }
      setStatusMessage('ok', `방 입장됨: ${roomName.trim()}`);
    });
  }

  async function decideApproval(request: ApprovalRequest, approved: boolean) {
    await runAction('approval', `${request.displayName} ${approved ? '승인' : '거절'} 처리 중`, async () => {
      await window.hapticRelay.approveViewer(request.socketId, approved);
      setApprovalRequests(current => current.filter(item => item.socketId !== request.socketId));
      setStatusMessage('ok', `${request.displayName} ${approved ? '승인됨' : '거절됨'}`);
    });
  }

  async function moderateViewer(viewer: ViewerSession, action: 'kick' | 'block') {
    await runAction('moderation', `${viewer.displayName} ${action === 'block' ? '차단' : '강퇴'} 처리 중`, async () => {
      await window.hapticRelay.moderateViewer(viewer.socketId, action);
      setViewerSessions(current => current.filter(item => item.socketId !== viewer.socketId));
      setStatusMessage('ok', `${viewer.displayName} ${action === 'block' ? '차단됨' : '강퇴됨'}`);
    });
  }

  async function sendMotion() {
    await runAction('motion', '모션 전송 중', async () => {
      await window.hapticRelay.sendMotion(intensity, position);
      setStatusMessage('ok', `모션 전송: intensity ${intensity.toFixed(2)}, position ${position.toFixed(2)}`);
    });
  }

  async function emergencyStop() {
    setBusyAction('stop');
    setStatusMessage('busy', '긴급 정지 처리 중');
    try {
      const result = await window.hapticRelay.emergencyStop() as { relay?: { sent?: boolean; reason?: string } };
      if (result.relay?.sent === false && result.relay.reason !== 'invalid-host-room') {
        setStatusMessage('warning', `긴급 정지: 로컬 정지, relay ${formatReason(result.relay.reason ?? 'room-stop-failed')}`);
        return;
      }
      setStatusMessage('warning', role === 'host' ? '긴급 정지 전송됨' : '로컬 긴급 정지됨');
    } catch (error) {
      setStatusMessage('error', formatError(error));
    } finally {
      setBusyAction(undefined);
    }
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
        <button disabled={isBusy} onClick={() => refreshPorts()}>새로고침</button>
        <button disabled={isBusy || !selectedPort} onClick={connectHardware}>연결</button>
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
        <button className="danger" disabled={busyAction === 'stop'} onClick={emergencyStop}>긴급 정지</button>
        <p className={`status ${status.tone}`}>{status.message}</p>
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
              <button className="primary" disabled={!canHost || isBusy} onClick={createRoom}>방 생성</button>
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
                        <button disabled={isBusy} onClick={() => decideApproval(request, false)}>거절</button>
                        <button className="primary" disabled={isBusy} onClick={() => decideApproval(request, true)}>승인</button>
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
                      <button disabled={isBusy} onClick={() => moderateViewer(viewer, 'kick')}>강퇴</button>
                      <button disabled={isBusy} onClick={() => moderateViewer(viewer, 'block')}>차단</button>
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
              <button className="primary" disabled={isBusy} onClick={sendMotion}>시청자에게 전송</button>
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
              <button className="primary" disabled={!canJoin || isBusy} onClick={joinRoom}>입장 요청</button>
            </section>

            {hardwarePanel}
          </>
        )}
      </section>
    </main>
  );
}

function normalizeRelayUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('invalid-relay-url');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('invalid-relay-url');
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return formatReason(error.message);
  if (typeof error === 'string') return formatReason(error);
  return '알 수 없는 오류가 발생했습니다';
}

function formatReason(reason: string) {
  const messages: Record<string, string> = {
    'invalid-relay-url': '릴레이 서버 URL은 http 또는 https 주소여야 합니다',
    'hardware-not-connected': '하드웨어가 연결되어 있지 않습니다',
    'relay-not-connected': '릴레이 서버에 연결되어 있지 않습니다',
    'room-not-found': '방을 찾을 수 없습니다',
    'room-full': '방 정원이 가득 찼습니다',
    'invalid-password': '비밀번호가 올바르지 않습니다',
    'blocked': '이 방에서 차단된 이름입니다',
    'approval-required': '스트리머 승인 대기 중입니다',
    'invalid-host-token': '스트리머 방 토큰이 유효하지 않습니다',
    'invalid-viewer-token': '시청자 입장 토큰이 유효하지 않습니다',
    'approval-not-found': '입장 신청을 찾을 수 없습니다',
    'viewer-disconnected': '시청자가 이미 연결을 끊었습니다',
    'viewer-not-found': '접속자를 찾을 수 없습니다',
    'connect_error': '릴레이 서버에 연결할 수 없습니다',
    'disconnected': '연결이 끊겼습니다',
    'transport close': '네트워크 연결이 끊겼습니다',
    'ping timeout': '릴레이 응답 시간이 초과되었습니다',
    'room-rejoin-failed': '방 재입장에 실패했습니다',
    'room-stop-failed': '긴급 정지 전송에 실패했습니다',
    'timeout': '요청 시간이 초과되었습니다'
  };

  return messages[reason] ?? reason;
}
