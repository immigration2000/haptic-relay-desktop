import { useEffect, useMemo, useState } from 'react';
import type { AppLogEntry, ApprovalRequest, EntryMode, HardwareProfile, HardwareProtection, PortInfo, ViewerSession } from './shared/protocol';
import './styles.css';

type Role = 'host' | 'viewer';
type StatusTone = 'idle' | 'busy' | 'ok' | 'warning' | 'error';
type BusyAction = 'ports' | 'hardware' | 'room' | 'join' | 'approval' | 'moderation' | 'motion' | 'stop';

type AppStatus = {
  tone: StatusTone;
  message: string;
};

const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  baudRate: 115200,
  linearAxis: 'L0',
  vibrationAxis: '',
  strokeMin: 0,
  strokeMax: 1,
  invertPosition: false
};
const DEFAULT_HARDWARE_PROTECTION: HardwareProtection = {
  intensityLimit: 1,
  positionMin: 0,
  positionMax: 1,
  paused: false
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
  const [hardwareProfile, setHardwareProfile] = useState<HardwareProfile>(DEFAULT_HARDWARE_PROFILE);
  const [hardwareProtection, setHardwareProtection] = useState<HardwareProtection>(DEFAULT_HARDWARE_PROTECTION);
  const [status, setStatus] = useState<AppStatus>({ tone: 'idle', message: '?? ?' });
  const [busyAction, setBusyAction] = useState<BusyAction>();
  const [intensity, setIntensity] = useState(0.5);
  const [position, setPosition] = useState(0.5);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [viewerSessions, setViewerSessions] = useState<ViewerSession[]>([]);
  const [logEntries, setLogEntries] = useState<AppLogEntry[]>([]);

  const canHost = useMemo(() => roomName.trim().length >= 3, [roomName]);
  const canJoin = useMemo(() => roomName.trim().length >= 3 && displayName.trim().length > 0, [displayName, roomName]);
  const isBusy = busyAction !== undefined;

  useEffect(() => {
    void refreshPorts(true);
  }, []);

  useEffect(() => {
    void window.hapticRelay.getLogs().then(entries => {
      setLogEntries(entries.slice(-80).reverse());
    });
    const removeLog = window.hapticRelay.onLog(entry => {
      setLogEntries(current => [entry, ...current].slice(0, 80));
    });
    const removeApprovalRequest = window.hapticRelay.onApprovalRequest(request => {
      setApprovalRequests(current => {
        if (current.some(item => item.socketId === request.socketId)) return current;
        return [...current, request];
      });
      setStatusMessage('warning', `?? ??: ${request.displayName}`);
    });
    const removeViewerStatus = window.hapticRelay.onViewerStatus(nextStatus => {
      if (nextStatus.status === 'approved') {
        setStatusMessage('ok', `? ?? ???: ${nextStatus.roomName}`);
        return;
      }
      if (nextStatus.status === 'removed') {
        setStatusMessage('warning', `${nextStatus.reason === 'block' ? '??' : '??'}?: ${nextStatus.roomName}`);
        return;
      }
      setStatusMessage('warning', `? ?? ???: ${formatReason(nextStatus.reason ?? nextStatus.roomName)}`);
    });
    const removeViewerList = window.hapticRelay.onViewerList(viewers => {
      setViewerSessions(viewers);
    });
    const removeEmergencyStop = window.hapticRelay.onEmergencyStop(signal => {
      setStatusMessage('warning', `?? ?? ??: ${signal.roomName}`);
    });
    const removeConnectionStatus = window.hapticRelay.onConnectionStatus(nextStatus => {
      if (nextStatus.status === 'connected') {
        if (!nextStatus.roomName) return;
        setStatusMessage('ok', `??? ???: ${nextStatus.roomName}`);
        return;
      }
      if (nextStatus.status === 'reconnecting') {
        setStatusMessage('warning', `??? ??? ?: ${nextStatus.roomName ?? '? ??'}`);
        return;
      }
      if (nextStatus.status === 'rejoined') {
        const suffix = nextStatus.reason === 'approval-required' ? ' / ?? ??' : '';
        setStatusMessage('ok', `? ??? ??: ${nextStatus.roomName}${suffix}`);
        return;
      }
      if (nextStatus.status === 'disconnected') {
        setStatusMessage('warning', `??? ?? ??: ${formatReason(nextStatus.reason ?? 'disconnected')}`);
        return;
      }
      setStatusMessage('error', `??? ??: ${formatReason(nextStatus.reason ?? 'connect_error')}`);
    });

    return () => {
      removeLog();
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

  function updateHardwareProfile(patch: Partial<HardwareProfile>) {
    setHardwareProfile(current => updateProfileValue(current, patch));
  }

  function updateHardwareProtection(patch: Partial<HardwareProtection>) {
    setHardwareProtection(current => updateProtectionValue(current, patch));
  }

  async function applyHardwareProtection() {
    await runAction('hardware', '?? ?? ?? ?', async () => {
      const result = await window.hapticRelay.setHardwareProtection(hardwareProtection);
      setHardwareProtection(result.protection);
      setStatusMessage(result.protection.paused ? 'warning' : 'ok', result.protection.paused ? '?? ???? ???' : '?? ?? ???');
    });
  }

  async function refreshPorts(silent = false) {
    await runAction('ports', silent ? '?? ?? ?' : '???? ?? ???? ?', async () => {
      const nextPorts = await window.hapticRelay.listPorts();
      setPorts(nextPorts);
      if (!selectedPort && nextPorts[0]) setSelectedPort(nextPorts[0].path);
      if (!silent) {
        setStatusMessage(nextPorts.length > 0 ? 'ok' : 'warning', nextPorts.length > 0 ? `?? ${nextPorts.length}? ??` : '?? ??? ???? ??? ????');
      }
    });
  }

  async function connectHardware() {
    if (!selectedPort) {
      setStatusMessage('warning', '??? ???? ??? ?????');
      return;
    }

    await runAction('hardware', '???? ?? ?', async () => {
      const result = await window.hapticRelay.connectHardware(selectedPort, hardwareProfile);
      if (result.probe.detected) {
        const version = result.probe.version ? ` / TCode ${result.probe.version}` : '';
        const axes = result.probe.axes.length > 0 ? ` / ? ${result.probe.axes.join(', ')}` : '';
        setStatusMessage('ok', `???? ???: ${selectedPort} / ${result.profile.baudRate}${version}${axes}`);
        return;
      }

      setStatusMessage('warning', `???? ???: ${selectedPort} / ${result.profile.baudRate} / TCode ?? ??`);
    });
  }

  async function createRoom() {
    if (!canHost) {
      setStatusMessage('warning', '? ??? 3? ????? ???');
      return;
    }

    await runAction('room', '? ?? ?', async () => {
      const room = await window.hapticRelay.startHostRoom(normalizeRelayUrl(relayUrl), {
        roomName: roomName.trim(),
        password: password.trim() || undefined,
        entryMode
      });
      setApprovalRequests([]);
      setViewerSessions(await window.hapticRelay.listViewers());
      setStatusMessage('ok', `? ???: ${room.roomName} / ${room.relayUrl}`);
    });
  }

  async function joinRoom() {
    if (!canJoin) {
      setStatusMessage('warning', '?? ??? 3? ??? ? ??? ?????');
      return;
    }

    await runAction('join', '? ?? ?? ?', async () => {
      const response = await window.hapticRelay.joinRoom(normalizeRelayUrl(relayUrl), {
        displayName: displayName.trim(),
        roomName: roomName.trim(),
        password: password.trim() || undefined
      });
      if (response.reason === 'approval-required') {
        setStatusMessage('warning', `?? ?? ?? ?: ${roomName.trim()}`);
        return;
      }
      setStatusMessage('ok', `? ???: ${roomName.trim()}`);
    });
  }

  async function decideApproval(request: ApprovalRequest, approved: boolean) {
    await runAction('approval', `${request.displayName} ${approved ? '??' : '??'} ?? ?`, async () => {
      await window.hapticRelay.approveViewer(request.socketId, approved);
      setApprovalRequests(current => current.filter(item => item.socketId !== request.socketId));
      setStatusMessage('ok', `${request.displayName} ${approved ? '???' : '???'}`);
    });
  }

  async function moderateViewer(viewer: ViewerSession, action: 'kick' | 'block') {
    await runAction('moderation', `${viewer.displayName} ${action === 'block' ? '??' : '??'} ?? ?`, async () => {
      await window.hapticRelay.moderateViewer(viewer.socketId, action);
      setViewerSessions(current => current.filter(item => item.socketId !== viewer.socketId));
      setStatusMessage('ok', `${viewer.displayName} ${action === 'block' ? '???' : '???'}`);
    });
  }

  async function sendMotion() {
    await runAction('motion', '?? ?? ?', async () => {
      await window.hapticRelay.sendMotion(intensity, position);
      setStatusMessage('ok', `?? ??: intensity ${intensity.toFixed(2)}, position ${position.toFixed(2)}`);
    });
  }

  async function emergencyStop() {
    setBusyAction('stop');
    setStatusMessage('busy', '?? ?? ?? ?');
    try {
      const result = await window.hapticRelay.emergencyStop() as { relay?: { sent?: boolean; reason?: string } };
      if (result.relay?.sent === false && result.relay.reason !== 'invalid-host-room') {
        setStatusMessage('warning', `?? ??: ?? ??, relay ${formatReason(result.relay.reason ?? 'room-stop-failed')}`);
        return;
      }
      setStatusMessage('warning', role === 'host' ? '?? ?? ???' : '?? ?? ???');
    } catch (error) {
      setStatusMessage('error', formatError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  const hardwarePanel = (
    <section className="panel">
      <h2>{role === 'host' ? '???? ????' : '??? ????'}</h2>
      <div className="hardware-row">
        <select value={selectedPort} onChange={event => setSelectedPort(event.target.value)}>
          {ports.map(port => (
            <option value={port.path} key={port.path}>{port.path}</option>
          ))}
        </select>
        <button disabled={isBusy} onClick={() => refreshPorts()}>????</button>
        <button disabled={isBusy || !selectedPort} onClick={connectHardware}>??</button>
      </div>
      <div className="profile-grid">
        <label>
          Baudrate
          <select value={hardwareProfile.baudRate} onChange={event => updateHardwareProfile({ baudRate: Number(event.target.value) })}>
            <option value={9600}>9600</option>
            <option value={57600}>57600</option>
            <option value={115200}>115200</option>
            <option value={230400}>230400</option>
            <option value={460800}>460800</option>
          </select>
        </label>
        <label>
          Stroke ?
          <input value={hardwareProfile.linearAxis} onChange={event => updateHardwareProfile({ linearAxis: event.target.value.toUpperCase() })} />
        </label>
        <label>
          ?? ?
          <input value={hardwareProfile.vibrationAxis ?? ''} onChange={event => updateHardwareProfile({ vibrationAxis: event.target.value.toUpperCase() })} placeholder="??, ?: V0" />
        </label>
        <label>
          ?? ??
          <input type="number" min="0" max="1" step="0.01" value={hardwareProfile.strokeMin} onChange={event => updateHardwareProfile({ strokeMin: Number(event.target.value) })} />
        </label>
        <label>
          ?? ??
          <input type="number" min="0" max="1" step="0.01" value={hardwareProfile.strokeMax} onChange={event => updateHardwareProfile({ strokeMax: Number(event.target.value) })} />
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={hardwareProfile.invertPosition} onChange={event => updateHardwareProfile({ invertPosition: event.target.checked })} />
          ?? ??
        </label>
      </div>
    </section>
  );

  const protectionPanel = (
    <section className="panel">
      <h2>??? ??</h2>
      <div className="profile-grid">
        <label>
          ?? ??
          <input type="range" min="0" max="1" step="0.01" value={hardwareProtection.intensityLimit} onChange={event => updateHardwareProtection({ intensityLimit: Number(event.target.value) })} />
          <span className="field-value">{hardwareProtection.intensityLimit.toFixed(2)}</span>
        </label>
        <label>
          ?? ??
          <input type="number" min="0" max="1" step="0.01" value={hardwareProtection.positionMin} onChange={event => updateHardwareProtection({ positionMin: Number(event.target.value) })} />
        </label>
        <label>
          ?? ??
          <input type="number" min="0" max="1" step="0.01" value={hardwareProtection.positionMax} onChange={event => updateHardwareProtection({ positionMax: Number(event.target.value) })} />
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={hardwareProtection.paused} onChange={event => updateHardwareProtection({ paused: event.target.checked })} />
          ?? ????
        </label>
      </div>
      <button disabled={isBusy} onClick={applyHardwareProtection}>?? ?? ??</button>
    </section>
  );

  const logPanel = (
    <section className="panel">
      <h2>??? ??</h2>
      {logEntries.length === 0 ? (
        <p className="muted">?? ??? ???? ????.</p>
      ) : (
        <div className="log-list">
          {logEntries.map(entry => (
            <div className={`log-row ${entry.level}`} key={entry.id}>
              <span>{formatTime(entry.timestamp)}</span>
              <strong>{entry.source}</strong>
              <span>{formatLogMessage(entry.message)}</span>
              {entry.details ? <em>{entry.details}</em> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Haptic Relay</p>
          <h1>?? ??? ??? ???? ??</h1>
        </div>
        <div className="role-switch" aria-label="role">
          <button className={role === 'host' ? 'active' : ''} onClick={() => setRole('host')}>????</button>
          <button className={role === 'viewer' ? 'active' : ''} onClick={() => setRole('viewer')}>???</button>
        </div>
        <button className="danger" disabled={busyAction === 'stop'} onClick={emergencyStop}>?? ??</button>
        <p className={`status ${status.tone}`}>{status.message}</p>
      </aside>

      <section className="workspace">
        <section className="panel">
          <h2>??? ??</h2>
          <label>
            ?? URL
            <input value={relayUrl} onChange={event => setRelayUrl(event.target.value)} />
          </label>
        </section>

        {role === 'host' ? (
          <>
            <section className="panel">
              <h2>? ???</h2>
              <div className="form-grid">
                <label>
                  ? ??
                  <input value={roomName} onChange={event => setRoomName(event.target.value)} />
                </label>
                <label>
                  ????
                  <input value={password} onChange={event => setPassword(event.target.value)} placeholder="??" />
                </label>
                <label>
                  ?? ??
                  <select value={entryMode} onChange={event => setEntryMode(event.target.value as EntryMode)}>
                    <option value="open">????</option>
                    <option value="request">????</option>
                  </select>
                </label>
              </div>
              <button className="primary" disabled={!canHost || isBusy} onClick={createRoom}>? ??</button>
            </section>

            {hardwarePanel}

            {entryMode === 'request' ? (
              <section className="panel">
                <h2>?? ??</h2>
                {approvalRequests.length === 0 ? (
                  <p className="muted">?? ?? ??? ????.</p>
                ) : (
                  <div className="approval-list">
                    {approvalRequests.map(request => (
                      <div className="approval-row" key={request.socketId}>
                        <div>
                          <strong>{request.displayName}</strong>
                          <span>{request.roomName}</span>
                        </div>
                        <button disabled={isBusy} onClick={() => decideApproval(request, false)}>??</button>
                        <button className="primary" disabled={isBusy} onClick={() => decideApproval(request, true)}>??</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            <section className="panel">
              <h2>??? ??</h2>
              {viewerSessions.length === 0 ? (
                <p className="muted">?? ??? ???? ????.</p>
              ) : (
                <div className="approval-list">
                  {viewerSessions.map(viewer => (
                    <div className="approval-row" key={viewer.socketId}>
                      <div>
                        <strong>{viewer.displayName}</strong>
                        <span>{viewer.roomName}</span>
                      </div>
                      <button disabled={isBusy} onClick={() => moderateViewer(viewer, 'kick')}>??</button>
                      <button disabled={isBusy} onClick={() => moderateViewer(viewer, 'block')}>??</button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="panel">
              <h2>?? ???</h2>
              <label>
                ??
                <input type="range" min="0" max="1" step="0.01" value={intensity} onChange={event => setIntensity(Number(event.target.value))} />
              </label>
              <label>
                ??
                <input type="range" min="0" max="1" step="0.01" value={position} onChange={event => setPosition(Number(event.target.value))} />
              </label>
              <button className="primary" disabled={isBusy} onClick={sendMotion}>????? ??</button>
            </section>

            {logPanel}
          </>
        ) : (
          <>
            <section className="panel">
              <h2>? ??</h2>
              <div className="form-grid">
                <label>
                  ?? ??
                  <input value={displayName} onChange={event => setDisplayName(event.target.value)} />
                </label>
                <label>
                  ? ??
                  <input value={roomName} onChange={event => setRoomName(event.target.value)} />
                </label>
                <label>
                  ????
                  <input value={password} onChange={event => setPassword(event.target.value)} />
                </label>
              </div>
              <button className="primary" disabled={!canJoin || isBusy} onClick={joinRoom}>?? ??</button>
            </section>

            {hardwarePanel}
            {protectionPanel}
            {logPanel}
          </>
        )}
      </section>
    </main>
  );
}

function updateProfileValue(profile: HardwareProfile, patch: Partial<HardwareProfile>): HardwareProfile {
  return {
    ...profile,
    ...patch
  };
}

function updateProtectionValue(protection: HardwareProtection, patch: Partial<HardwareProtection>): HardwareProtection {
  return {
    ...protection,
    ...patch
  };
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
  return '? ? ?? ??? ??????';
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('ko-KR', { hour12: false });
}

function formatLogMessage(message: string) {
  const messages: Record<string, string> = {
    'hardware-connected': '???? ??',
    'hardware-disconnected': '???? ?? ??',
    'hardware-connect-failed': '???? ?? ??',
    'hardware-stopped': '???? ??',
    'hardware-stop-write-failed': '?? ?? ??',
    'hardware-motion-write-failed': '?? ?? ??',
    'hardware-safety-timeout': '???? safety timeout',
    'hardware-probe-failed': 'T-Code probe ??',
    'receive-paused': '?? ????',
    'protection-updated': '?? ?? ??',
    'motion-dropped-paused': 'pause ? ?? ??',
    'motion-not-queued': '?? queue ??',
    'approval-requested': '?? ??',
    'viewer-approved': '??? ??',
    'viewer-rejected': '??? ??',
    'viewer-removed': '??? ??',
    'viewer-list-updated': '??? ?? ??',
    'room-stop-received': '? ?? ??',
    'relay-connected': 'relay ??',
    'relay-disconnected': 'relay ??',
    'relay-reconnecting': 'relay ??? ?',
    'relay-rejoined': '? ???',
    'relay-error': 'relay ??',
    'room-create-requested': '? ?? ??',
    'room-join-requested': '? ?? ??',
    'emergency-stop-requested': '?? ?? ??',
    'relay-disconnect-requested': 'relay ?? ?? ??'
  };

  return messages[message] ?? message;
}

function formatReason(reason: string) {
  const messages: Record<string, string> = {
    'invalid-relay-url': '??? ?? URL? http ?? https ???? ???',
    'hardware-not-connected': '????? ???? ?? ????',
    'relay-not-connected': '??? ??? ???? ?? ????',
    'room-not-found': '?? ?? ? ????',
    'room-full': '? ??? ?? ????',
    'invalid-password': '????? ???? ????',
    'blocked': '? ??? ??? ?????',
    'approval-required': '???? ?? ?? ????',
    'invalid-host-token': '???? ? ??? ???? ????',
    'invalid-viewer-token': '??? ?? ??? ???? ????',
    'approval-not-found': '?? ??? ?? ? ????',
    'viewer-disconnected': '???? ?? ??? ?????',
    'viewer-not-found': '???? ?? ? ????',
    'connect_error': '??? ??? ??? ? ????',
    'disconnected': '??? ?????',
    'transport close': '???? ??? ?????',
    'ping timeout': '??? ?? ??? ???????',
    'room-rejoin-failed': '? ???? ??????',
    'room-stop-failed': '?? ?? ??? ??????',
    'invalid-hardware-profile': '???? ??? ??? ???? ????',
    'invalid-baud-rate': 'baudrate ?? ???? ????',
    'invalid-linearAxis': 'stroke ?? L0, R0, V0, A0 ????? ???',
    'invalid-vibrationAxis': '?? ?? L0, R0, V0, A0 ????? ???',
    'invalid-stroke-range': '?? ??? ?? ???? ??? ???',
    'invalid-strokeMin': '?? ??? 0?? 1 ???? ???',
    'invalid-strokeMax': '?? ??? 0?? 1 ???? ???',
    'invalid-hardware-protection': '?? ?? ??? ???? ????',
    'invalid-protection-position-range': '?? ?? ??? ?? ???? ??? ???',
    'invalid-protectionIntensityLimit': '?? ??? 0?? 1 ???? ???',
    'invalid-protectionPositionMin': '?? ?? ??? 0?? 1 ???? ???',
    'invalid-protectionPositionMax': '?? ?? ??? 0?? 1 ???? ???',
    'protection-paused': '?? ???? ????',
    'timeout': '?? ??? ???????'
  };

  return messages[reason] ?? reason;
}
