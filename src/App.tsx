import { useEffect, useMemo, useState } from 'react';
import type { EntryMode, PortInfo } from './shared/protocol';
import './styles.css';

type Role = 'host' | 'viewer';

export default function App() {
  const [role, setRole] = useState<Role>('host');
  const [roomName, setRoomName] = useState('studio-main');
  const [password, setPassword] = useState('');
  const [entryMode, setEntryMode] = useState<EntryMode>('open');
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [status, setStatus] = useState('대기 중');
  const [intensity, setIntensity] = useState(0.5);
  const [position, setPosition] = useState(0.5);

  const canHost = useMemo(() => roomName.trim().length >= 3, [roomName]);

  useEffect(() => {
    void refreshPorts();
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
    const room = await window.hapticRelay.startHostRoom({
      roomName: roomName.trim(),
      password: password.trim() || undefined,
      entryMode
    });
    setStatus(`방 생성됨: ${room.roomName} / ${room.relayUrl}`);
  }

  async function sendMotion() {
    await window.hapticRelay.sendMotion(intensity, position);
    setStatus(`모션 전송: intensity ${intensity.toFixed(2)}, position ${position.toFixed(2)}`);
  }

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
        <p className="status">{status}</p>
      </aside>

      <section className="workspace">
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

            <section className="panel">
              <h2>스트리머 하드웨어</h2>
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
          <section className="panel">
            <h2>방 입장</h2>
            <div className="form-grid">
              <label>
                표시 이름
                <input placeholder="viewer-01" />
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
            <button className="primary">입장 요청</button>
          </section>
        )}
      </section>
    </main>
  );
}
