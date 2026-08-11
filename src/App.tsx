import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppLogEntry, AppSettings, ApprovalRequest, EntryMode, HardwareProfile, HardwareProtection, MotionMonitorSnapshot, PortInfo, ViewerSession } from './shared/protocol';
import { createQrMatrix } from './qr-code';
import './styles.css';

type Role = 'host' | 'viewer';
type HostPage = 'setup' | 'room';
type ViewerPage = 'join' | 'room';
type HostTab = 'management' | 'demo' | 'settings';
type ViewerTab = 'receive' | 'delay' | 'settings';
type StatusTone = 'idle' | 'busy' | 'ok' | 'warning' | 'error';
type BusyAction = 'ports' | 'hardware' | 'room' | 'join' | 'approval' | 'moderation' | 'motion' | 'stop' | 'logs' | 'delay';

type AppStatus = {
  tone: StatusTone;
  message: string;
};

type HostRoomInvite = {
  roomName: string;
  password?: string;
  entryMode: EntryMode;
  relayUrl: string;
};
type InvitePayload = HostRoomInvite & {
  v: 1;
};

type SavedSettings = AppSettings;

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
const CURRENT_SETTINGS_SCHEMA_VERSION = 2;

export default function App() {
  const [role, setRole] = useState<Role>('host');
  const [hostPage, setHostPage] = useState<HostPage>('setup');
  const [viewerPage, setViewerPage] = useState<ViewerPage>('join');
  const [hostTab, setHostTab] = useState<HostTab>('management');
  const [viewerTab, setViewerTab] = useState<ViewerTab>('receive');
  const [relayUrl, setRelayUrl] = useState(import.meta.env.VITE_RELAY_URL ?? 'http://localhost:4174');
  const [displayName, setDisplayName] = useState('viewer-01');
  const [roomName, setRoomName] = useState('studio-main');
  const [password, setPassword] = useState('');
  const [entryMode, setEntryMode] = useState<EntryMode>('open');
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [hardwareProfile, setHardwareProfile] = useState<HardwareProfile>(DEFAULT_HARDWARE_PROFILE);
  const [hardwareProtection, setHardwareProtection] = useState<HardwareProtection>(DEFAULT_HARDWARE_PROTECTION);
  const [status, setStatus] = useState<AppStatus>({ tone: 'idle', message: '대기 중' });
  const [busyAction, setBusyAction] = useState<BusyAction>();
  const [intensity, setIntensity] = useState(0.5);
  const [position, setPosition] = useState(0.5);
  const [motionDemoActive, setMotionDemoActive] = useState(false);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [viewerSessions, setViewerSessions] = useState<ViewerSession[]>([]);
  const [logEntries, setLogEntries] = useState<AppLogEntry[]>([]);
  const [hostRoomInvite, setHostRoomInvite] = useState<HostRoomInvite>();
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [savedSettings, setSavedSettings] = useState<SavedSettings>();
  const [motionDelayMs, setMotionDelayMs] = useState(0);
  const [appliedMotionDelayMs, setAppliedMotionDelayMs] = useState(0);
  const [motionMonitorEntries, setMotionMonitorEntries] = useState<MotionMonitorSnapshot[]>([]);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const settingsLoadRequestId = useRef(0);

  const canHost = useMemo(() => roomName.trim().length >= 3, [roomName]);
  const canJoin = useMemo(() => roomName.trim().length >= 3 && displayName.trim().length > 0, [displayName, roomName]);
  const isBusy = busyAction !== undefined;
  const hasPendingMotionDelay = motionDelayMs !== appliedMotionDelayMs;
  const latestMotion = motionMonitorEntries[0];
  const inviteQrMatrix = useMemo(() => hostRoomInvite ? createQrMatrix(encodeInviteCode(hostRoomInvite)) : undefined, [hostRoomInvite]);

  useEffect(() => {
    void loadSettings();
    void refreshPorts(true);
  }, []);

  useEffect(() => {
    if (motionDemoActive) window.hapticRelay.updateMotionDemo(intensity, position);
  }, [intensity, motionDemoActive, position]);

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
      setStatusMessage('warning', `입장 신청: ${request.displayName}`);
    });
    const removeViewerStatus = window.hapticRelay.onViewerStatus(nextStatus => {
      if (nextStatus.status === 'approved') {
        setViewerPage('room');
        setViewerTab('receive');
        setStatusMessage('ok', `방 입장 승인됨: ${nextStatus.roomName}`);
        return;
      }
      if (nextStatus.status === 'removed') {
        setViewerPage('join');
        setStatusMessage('warning', `${nextStatus.reason === 'block' ? '차단' : '강퇴'}됨: ${nextStatus.roomName}`);
        return;
      }
      setViewerPage('join');
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
    const removeMotionReceived = window.hapticRelay.onMotionReceived(snapshot => {
      setMotionMonitorEntries(current => [snapshot, ...current].slice(0, 10));
    });

    return () => {
      removeLog();
      removeApprovalRequest();
      removeViewerStatus();
      removeViewerList();
      removeEmergencyStop();
      removeConnectionStatus();
      removeMotionReceived();
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

  async function loadSettings() {
    const requestId = ++settingsLoadRequestId.current;
    setSettingsLoading(true);
    try {
      const settings = await window.hapticRelay.getSettings();
      if (requestId !== settingsLoadRequestId.current) return;
      const protectionResult = await window.hapticRelay.setHardwareProtection(settings.hardwareProtection);
      if (requestId !== settingsLoadRequestId.current) return;
      setHardwareProfile(settings.hardwareProfile);
      setHardwareProtection(protectionResult.protection);
      setMotionDelayMs(settings.playback.motionDelayMs);
      setAppliedMotionDelayMs(settings.playback.motionDelayMs);
      setSavedSettings(settings);
    } catch (error) {
      if (requestId === settingsLoadRequestId.current) {
        setStatusMessage('warning', `설정 불러오기 실패: ${formatError(error)}`);
      }
    } finally {
      if (requestId === settingsLoadRequestId.current) {
        setSettingsLoading(false);
      }
    }
  }

  async function saveSettings() {
    if (!savedSettings) throw new Error('settings-not-loaded');

    await runAction('hardware', '설정 저장 중', async () => {
      const result = await window.hapticRelay.saveSettings({
        schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
        hardwareProfile,
        hardwareProtection,
        playback: { motionDelayMs: appliedMotionDelayMs }
      });
      setHardwareProfile(result.settings.hardwareProfile);
      setHardwareProtection(result.settings.hardwareProtection);
      setAppliedMotionDelayMs(result.settings.playback.motionDelayMs);
      setSavedSettings(result.settings);
      setStatusMessage('ok', '하드웨어/보호 설정 저장됨');
    });
  }

  async function applyMotionDelay() {
    await runAction('delay', '모션 지연 적용 중', async () => {
      const result = await window.hapticRelay.setMotionDelay(motionDelayMs);
      setMotionDelayMs(result.settings.playback.motionDelayMs);
      setAppliedMotionDelayMs(result.settings.playback.motionDelayMs);
      setSavedSettings(result.settings);
      setStatusMessage('ok', `모션 지연 적용됨: ${(result.settings.playback.motionDelayMs / 1000).toFixed(1)}초`);
    });
  }

  async function applyHardwareProtection() {
    await runAction('hardware', '보호 옵션 적용 중', async () => {
      const result = await window.hapticRelay.setHardwareProtection(hardwareProtection);
      setHardwareProtection(result.protection);
      setStatusMessage(result.protection.paused ? 'warning' : 'ok', result.protection.paused ? '수신 일시정지 적용됨' : '보호 옵션 적용됨');
    });
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
      const result = await window.hapticRelay.connectHardware(selectedPort, hardwareProfile);
      if (result.probe.detected) {
        const version = result.probe.version ? ` / TCode ${result.probe.version}` : '';
        const axes = result.probe.axes.length > 0 ? ` / 축 ${result.probe.axes.join(', ')}` : '';
        setStatusMessage('ok', `하드웨어 연결됨: ${selectedPort} / ${result.profile.baudRate}${version}${axes}`);
        return;
      }

      setStatusMessage('warning', `하드웨어 연결됨: ${selectedPort} / ${result.profile.baudRate} / TCode 응답 없음`);
    });
  }

  async function testHardware() {
    await runAction('hardware', '하드웨어 테스트 중', async () => {
      const result = await window.hapticRelay.testHardware();
      if (!result.tested) {
        setStatusMessage('warning', formatReason(result.reason ?? 'hardware-test-failed'));
        return;
      }

      setStatusMessage('ok', `하드웨어 테스트 완료: ${result.steps ?? 0}단계`);
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
      setHostRoomInvite({
        roomName: room.roomName,
        password: password.trim() || undefined,
        entryMode,
        relayUrl: room.relayUrl
      });
      setApprovalRequests([]);
      setViewerSessions(await window.hapticRelay.listViewers());
      setHostPage('room');
      setHostTab('management');
      setStatusMessage('ok', `방 생성됨: ${room.roomName} / ${room.relayUrl}`);
    });
  }

  async function copyInvite() {
    if (!hostRoomInvite) return;

    await runAction('room', '입장 정보 복사 중', async () => {
      await window.hapticRelay.copyText(formatInviteText(hostRoomInvite));
      setStatusMessage('ok', '방 입장 정보가 클립보드에 복사됨');
    });
  }

  async function copyInviteCode() {
    if (!hostRoomInvite) return;

    await runAction('room', '초대 코드 복사 중', async () => {
      await window.hapticRelay.copyText(encodeInviteCode(hostRoomInvite));
      setStatusMessage('ok', '초대 코드가 클립보드에 복사됨');
    });
  }

  function applyInviteCode() {
    try {
      const invite = decodeInviteCode(inviteCodeInput);
      setRelayUrl(invite.relayUrl);
      setRoomName(invite.roomName);
      setPassword(invite.password ?? '');
      setEntryMode(invite.entryMode);
      setStatusMessage('ok', `초대 코드 적용됨: ${invite.roomName}`);
    } catch (error) {
      setStatusMessage('error', formatError(error));
    }
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
      setViewerPage('room');
      setViewerTab('receive');
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

  async function toggleMotionDemo() {
    await runAction('motion', motionDemoActive ? '시연 중지 중' : '시연 시작 중', async () => {
      if (motionDemoActive) {
        await window.hapticRelay.stopMotionDemo();
        setMotionDemoActive(false);
        setStatusMessage('ok', '실시간 시연 중지됨');
        return;
      }

      await window.hapticRelay.startMotionDemo(intensity, position);
      setMotionDemoActive(true);
      setStatusMessage('ok', '실시간 시연 시작됨 / 30Hz 전송 중');
    });
  }

  async function leaveRoom() {
    await runAction('room', role === 'host' ? '방 종료 중' : '방 나가는 중', async () => {
      if (motionDemoActive) await window.hapticRelay.stopMotionDemo();
      await window.hapticRelay.disconnectRoom();
      setMotionDemoActive(false);
      setApprovalRequests([]);
      setViewerSessions([]);
      setHostRoomInvite(undefined);
      if (role === 'host') {
        setHostPage('setup');
        setHostTab('management');
      } else {
        setViewerPage('join');
        setViewerTab('receive');
      }
      setStatusMessage('ok', role === 'host' ? '방이 종료됨' : '방에서 나왔습니다');
    });
  }

  async function emergencyStop() {
    setBusyAction('stop');
    setStatusMessage('busy', '긴급 정지 처리 중');
    try {
      const result = await window.hapticRelay.emergencyStop() as {
        hardware?: { stopped?: boolean; reason?: string };
        relay?: { sent?: boolean; reason?: string };
      };
      setMotionDemoActive(false);
      if (result.hardware?.stopped === false && result.hardware.reason === 'hardware-stop-write-failed') {
        setStatusMessage('error', '긴급 정지 명령을 하드웨어에 쓰지 못했습니다. 장비 전원을 직접 차단하세요.');
        return;
      }
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

  async function exportLogs() {
    await runAction('logs', '로그 저장 중', async () => {
      const result = await window.hapticRelay.exportLogs();
      if (result.canceled) {
        setStatusMessage('warning', '로그 저장이 취소됨');
        return;
      }

      setStatusMessage('ok', `로그 저장 완료: ${result.count}개`);
    });
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
        <button disabled={isBusy} onClick={testHardware}>테스트</button>
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
          Stroke 축
          <input value={hardwareProfile.linearAxis} onChange={event => updateHardwareProfile({ linearAxis: event.target.value.toUpperCase() })} />
        </label>
        <label>
          진동 축
          <input value={hardwareProfile.vibrationAxis ?? ''} onChange={event => updateHardwareProfile({ vibrationAxis: event.target.value.toUpperCase() })} placeholder="선택, 예: V0" />
        </label>
        <label>
          최소 위치
          <input type="number" min="0" max="1" step="0.01" value={hardwareProfile.strokeMin} onChange={event => updateHardwareProfile({ strokeMin: Number(event.target.value) })} />
        </label>
        <label>
          최대 위치
          <input type="number" min="0" max="1" step="0.01" value={hardwareProfile.strokeMax} onChange={event => updateHardwareProfile({ strokeMax: Number(event.target.value) })} />
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={hardwareProfile.invertPosition} onChange={event => updateHardwareProfile({ invertPosition: event.target.checked })} />
          방향 반전
        </label>
      </div>
      <div className="button-row">
        <button disabled={isBusy || settingsLoading || !savedSettings} onClick={saveSettings}>설정 저장</button>
        <button disabled={isBusy || settingsLoading || !savedSettings} onClick={loadSettings}>설정 불러오기</button>
      </div>
    </section>
  );

  const protectionPanel = (
    <section className="panel">
      <h2>시청자 보호</h2>
      <div className="profile-grid">
        <label>
          강도 상한
          <input type="range" min="0" max="1" step="0.01" value={hardwareProtection.intensityLimit} onChange={event => updateHardwareProtection({ intensityLimit: Number(event.target.value) })} />
          <span className="field-value">{hardwareProtection.intensityLimit.toFixed(2)}</span>
        </label>
        <label>
          최소 위치
          <input type="number" min="0" max="1" step="0.01" value={hardwareProtection.positionMin} onChange={event => updateHardwareProtection({ positionMin: Number(event.target.value) })} />
        </label>
        <label>
          최대 위치
          <input type="number" min="0" max="1" step="0.01" value={hardwareProtection.positionMax} onChange={event => updateHardwareProtection({ positionMax: Number(event.target.value) })} />
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={hardwareProtection.paused} onChange={event => updateHardwareProtection({ paused: event.target.checked })} />
          수신 일시정지
        </label>
      </div>
      <button disabled={isBusy} onClick={applyHardwareProtection}>보호 옵션 적용</button>
    </section>
  );

  const motionMonitorPanel = (
    <section className="panel motion-monitor" aria-live="polite">
      <div className="panel-header">
        <h2>관리자 수신 모니터</h2>
        <span className={`monitor-state ${latestMotion ? 'receiving' : 'waiting'}`}>
          {latestMotion ? '수신 중' : '수신 대기 중'}
        </span>
      </div>
      {latestMotion ? (
        <>
          <div className="monitor-gauges">
            <MotionGauge label="위치" value={latestMotion.frame.position} />
            <MotionGauge label="강도" value={latestMotion.frame.intensity} />
          </div>
          <dl className="monitor-metrics">
            <div><dt>프로토콜</dt><dd>v{latestMotion.frame.protocolVersion ?? 1}</dd></div>
            <div><dt>시퀀스</dt><dd>{latestMotion.frame.sequence ?? '-'}</dd></div>
            <div><dt>누적 수신</dt><dd>{latestMotion.receivedFrames}</dd></div>
            <div><dt>마지막 수신</dt><dd>{formatTime(latestMotion.receivedAt)}</dd></div>
          </dl>
          <p className={`monitor-delivery ${latestMotion.hardware.queued || latestMotion.hardware.reason === 'hardware-not-connected' ? 'ok' : 'warning'}`}>
            {latestMotion.hardware.queued
              ? '하드웨어 전달 정상'
              : latestMotion.hardware.reason === 'hardware-not-connected'
                ? '가상 수신 정상 / 하드웨어 미연결'
                : `수신 정상 / 하드웨어 전달 실패: ${latestMotion.hardware.reason ?? 'unknown'}`}
          </p>
          <div className="motion-history" aria-label="최근 수신 프레임">
            {motionMonitorEntries.map(entry => (
              <div className="motion-history-row" key={`${entry.receivedAt}-${entry.receivedFrames}`}>
                <span>#{entry.receivedFrames}</span>
                <span>P {entry.frame.position.toFixed(2)}</span>
                <span>I {entry.frame.intensity.toFixed(2)}</span>
                <time>{formatTime(entry.receivedAt)}</time>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">스트리머의 모션 데이터가 도착하면 여기에 표시됩니다.</p>
      )}
    </section>
  );

  const motionDelayPanel = (
    <section className="panel">
      <div className="panel-header">
        <h2>모션 지연</h2>
      </div>
      <label>
        지연 시간
        <input className="range" type="range" min="0" max="10000" step="100" value={motionDelayMs} disabled={isBusy || settingsLoading || !savedSettings} onChange={event => setMotionDelayMs(Number(event.target.value))} />
        <span className="field-value">선택: {(motionDelayMs / 1000).toFixed(1)}초 / 적용됨: {(appliedMotionDelayMs / 1000).toFixed(1)}초</span>
      </label>
      <div className="button-row">
        <button disabled={isBusy || settingsLoading || !savedSettings || !hasPendingMotionDelay} onClick={applyMotionDelay}>적용</button>
      </div>
    </section>
  );

  const logPanel = (
    <section className="panel">
      <div className="panel-header">
        <h2>이벤트 로그</h2>
        <button disabled={isBusy || logEntries.length === 0} onClick={exportLogs}>저장</button>
      </div>
      {logEntries.length === 0 ? (
        <p className="muted">아직 기록된 이벤트가 없습니다.</p>
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

  const invitePanel = hostRoomInvite ? (
    <section className="panel">
      <h2>방 입장 정보</h2>
      <div className="invite-grid">
        <div>
          <span>서버</span>
          <strong>{hostRoomInvite.relayUrl}</strong>
        </div>
        <div>
          <span>방 이름</span>
          <strong>{hostRoomInvite.roomName}</strong>
        </div>
        <div>
          <span>비밀번호</span>
          <strong>{hostRoomInvite.password ?? '없음'}</strong>
        </div>
        <div>
          <span>입장 방식</span>
          <strong>{hostRoomInvite.entryMode === 'request' ? '신청입장' : '자유입장'}</strong>
        </div>
      </div>
      <div className="invite-code">
        <span>초대 코드</span>
        <code>{encodeInviteCode(hostRoomInvite)}</code>
      </div>
      {inviteQrMatrix ? (
        <div className="qr-card" aria-label="초대 QR 코드">
          <div className="qr-grid" style={{ gridTemplateColumns: `repeat(${inviteQrMatrix.length}, 1fr)` }}>
            {inviteQrMatrix.flatMap((row, rowIndex) => row.map((dark, colIndex) => (
              <span className={dark ? 'dark' : ''} key={`${rowIndex}-${colIndex}`} />
            )))}
          </div>
        </div>
      ) : null}
      <div className="button-row">
        <button disabled={isBusy} onClick={copyInvite}>입장 정보 복사</button>
        <button disabled={isBusy} onClick={copyInviteCode}>초대 코드 복사</button>
      </div>
    </section>
  ) : null;

  const approvalPanel = entryMode === 'request' ? (
    <section className="panel">
      <div className="panel-header">
        <h2>입장 신청</h2>
        <strong className="count-value">{approvalRequests.length}명 대기</strong>
      </div>
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
  ) : null;

  const viewerManagementPanel = (
    <section className="panel participant-panel">
      <div className="panel-header">
        <h2>접속자 관리</h2>
        <strong className="count-value">{viewerSessions.length}명 접속</strong>
      </div>
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
  );

  const motionDemoPanel = (
    <section className="panel motion-demo-panel">
      <div className="panel-header">
        <div>
          <p className="section-label">실시간 제어</p>
          <h2>모션 시연</h2>
        </div>
        <span className={`stream-state ${motionDemoActive ? 'active' : ''}`}>
          {motionDemoActive ? '30Hz 전송 중' : '전송 대기'}
        </span>
      </div>
      <div className="motion-demo-controls">
        <label>
          <span className="control-label"><span>위치</span><strong>{position.toFixed(2)}</strong></span>
          <input className="range range-large" type="range" min="0" max="1" step="0.01" value={position} onChange={event => setPosition(Number(event.target.value))} />
        </label>
        <label>
          <span className="control-label"><span>강도</span><strong>{intensity.toFixed(2)}</strong></span>
          <input className="range range-large intensity-range" type="range" min="0" max="1" step="0.01" value={intensity} onChange={event => setIntensity(Number(event.target.value))} />
        </label>
      </div>
      <div className="demo-footer">
        <p className="muted">시연 중에는 슬라이더의 최신 위치와 강도가 계속 전송됩니다.</p>
        <button className={motionDemoActive ? 'danger' : 'primary'} disabled={isBusy} onClick={toggleMotionDemo}>
          {motionDemoActive ? '시연 중지' : '시연 시작'}
        </button>
      </div>
    </section>
  );

  const activeRoom = role === 'host' ? hostPage === 'room' : viewerPage === 'room';

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Haptic Relay</p>
          <h1>방송 플랫폼 독립형 하드웨어 연동</h1>
        </div>
        <div className="sidebar-controls">
          {!activeRoom ? (
            <div className="role-switch" aria-label="역할 선택">
              <button className={role === 'host' ? 'active' : ''} onClick={() => setRole('host')}>스트리머</button>
              <button className={role === 'viewer' ? 'active' : ''} onClick={() => setRole('viewer')}>시청자</button>
            </div>
          ) : (
            <div className="session-summary">
              <span>{role === 'host' ? '스트리머 방' : '시청 중인 방'}</span>
              <strong>{hostRoomInvite?.roomName ?? roomName}</strong>
              {role === 'host' ? <span>접속자 {viewerSessions.length}명</span> : null}
            </div>
          )}
          <button className="danger" disabled={busyAction === 'stop'} onClick={emergencyStop}>긴급 정지</button>
        </div>
        <p className={`status ${status.tone}`}>{status.message}</p>
      </aside>

      <section className="workspace">
        {role === 'host' ? (
          hostPage === 'setup' ? (
            <div className="page-view">
              <header className="page-heading">
                <p className="section-label">스트리머</p>
                <h2>방 만들기</h2>
              </header>
              <div className="setup-grid">
                <section className="panel">
                  <h2>릴레이 서버</h2>
                  <label>
                    서버 URL
                    <input value={relayUrl} onChange={event => setRelayUrl(event.target.value)} />
                  </label>
                </section>
                <section className="panel">
                  <h2>방 설정</h2>
                  <div className="form-grid setup-form">
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
                  <button className="primary action-button" disabled={!canHost || isBusy} onClick={createRoom}>방 생성</button>
                </section>
              </div>
            </div>
          ) : (
            <div className="page-view room-page">
              <header className="room-toolbar">
                <div>
                  <p className="section-label">스트리머 방 관리</p>
                  <h2>{hostRoomInvite?.roomName ?? roomName}</h2>
                </div>
                <div className="room-actions">
                  <div className="viewer-count"><strong>{viewerSessions.length}</strong><span>접속자</span></div>
                  <button disabled={isBusy} onClick={leaveRoom}>방 종료</button>
                </div>
              </header>
              <nav className="page-tabs" aria-label="스트리머 방 메뉴">
                <button className={hostTab === 'management' ? 'active' : ''} onClick={() => setHostTab('management')}>방 관리</button>
                <button className={hostTab === 'demo' ? 'active' : ''} onClick={() => setHostTab('demo')}>실시간 시연</button>
                <button className={hostTab === 'settings' ? 'active' : ''} onClick={() => setHostTab('settings')}>설정 및 로그</button>
              </nav>
              <div className="tab-content">
                {hostTab === 'management' ? <div className="management-grid">{viewerManagementPanel}{approvalPanel}{invitePanel}</div> : null}
                {hostTab === 'demo' ? motionDemoPanel : null}
                {hostTab === 'settings' ? <div className="settings-stack">{hardwarePanel}{logPanel}</div> : null}
              </div>
            </div>
          )
        ) : (
          viewerPage === 'join' ? (
            <div className="page-view">
              <header className="page-heading">
                <p className="section-label">시청자</p>
                <h2>방 입장</h2>
              </header>
              <div className="setup-grid viewer-setup-grid">
                <section className="panel">
                  <h2>초대 코드</h2>
                  <label>
                    스트리머가 공유한 코드
                    <textarea value={inviteCodeInput} onChange={event => setInviteCodeInput(event.target.value)} rows={3} />
                  </label>
                  <button disabled={isBusy || inviteCodeInput.trim().length === 0} onClick={applyInviteCode}>초대 코드 적용</button>
                </section>
                <section className="panel">
                  <h2>접속 정보</h2>
                  <label>
                    서버 URL
                    <input value={relayUrl} onChange={event => setRelayUrl(event.target.value)} />
                  </label>
                  <div className="form-grid setup-form">
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
                  <button className="primary action-button" disabled={!canJoin || isBusy} onClick={joinRoom}>입장 요청</button>
                </section>
              </div>
            </div>
          ) : (
            <div className="page-view room-page">
              <header className="room-toolbar">
                <div>
                  <p className="section-label">시청자 수신</p>
                  <h2>{roomName}</h2>
                </div>
                <button disabled={isBusy} onClick={leaveRoom}>방 나가기</button>
              </header>
              <nav className="page-tabs" aria-label="시청자 방 메뉴">
                <button className={viewerTab === 'receive' ? 'active' : ''} onClick={() => setViewerTab('receive')}>수신 모니터</button>
                <button className={viewerTab === 'delay' ? 'active' : ''} onClick={() => setViewerTab('delay')}>지연 설정</button>
                <button className={viewerTab === 'settings' ? 'active' : ''} onClick={() => setViewerTab('settings')}>설정 및 로그</button>
              </nav>
              <div className="tab-content">
                {viewerTab === 'receive' ? motionMonitorPanel : null}
                {viewerTab === 'delay' ? motionDelayPanel : null}
                {viewerTab === 'settings' ? <div className="settings-stack">{hardwarePanel}{protectionPanel}{logPanel}</div> : null}
              </div>
            </div>
          )
        )}
      </section>
    </main>
  );
}

function MotionGauge({ label, value }: { label: string; value: number }) {
  return (
    <div className="motion-gauge">
      <div>
        <span>{label}</span>
        <strong>{value.toFixed(2)}</strong>
      </div>
      <progress max={1} value={value} aria-label={`${label} ${value.toFixed(2)}`} />
    </div>
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

function formatInviteText(invite: HostRoomInvite) {
  return [
    'Haptic Relay 방 입장 정보',
    `서버: ${invite.relayUrl}`,
    `방 이름: ${invite.roomName}`,
    `비밀번호: ${invite.password ?? '없음'}`,
    `입장 방식: ${invite.entryMode === 'request' ? '신청입장' : '자유입장'}`,
    `초대 코드: ${encodeInviteCode(invite)}`
  ].join('\n');
}

function encodeInviteCode(invite: HostRoomInvite) {
  const payload: InvitePayload = {
    v: 1,
    relayUrl: invite.relayUrl,
    roomName: invite.roomName,
    password: invite.password,
    entryMode: invite.entryMode
  };
  return `HRS1.${base64UrlEncode(JSON.stringify(payload))}`;
}

function decodeInviteCode(value: string): HostRoomInvite {
  try {
    const trimmed = value.trim();
    const encoded = trimmed.startsWith('HRS1.') ? trimmed.slice(5) : trimmed;
    const payload = JSON.parse(base64UrlDecode(encoded)) as Partial<InvitePayload>;

    if (payload.v !== 1) throw new Error('invalid-invite-code');
    if (typeof payload.relayUrl !== 'string') throw new Error('invalid-invite-code');
    if (typeof payload.roomName !== 'string' || payload.roomName.trim().length < 3) throw new Error('invalid-invite-code');
    if (payload.entryMode !== 'open' && payload.entryMode !== 'request') throw new Error('invalid-invite-code');
    const password = typeof payload.password === 'string' && payload.password.length > 0 ? payload.password : undefined;

    return {
      relayUrl: normalizeRelayUrl(payload.relayUrl),
      roomName: payload.roomName.trim(),
      password,
      entryMode: payload.entryMode
    };
  } catch {
    throw new Error('invalid-invite-code');
  }
}

function base64UrlEncode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('ko-KR', { hour12: false });
}

function formatLogMessage(message: string) {
  const messages: Record<string, string> = {
    'hardware-connected': '하드웨어 연결',
    'hardware-disconnected': '하드웨어 연결 해제',
    'hardware-connect-failed': '하드웨어 연결 실패',
    'hardware-stopped': '하드웨어 정지',
    'hardware-stop-write-failed': '정지 명령 실패',
    'hardware-motion-write-failed': '모션 출력 실패',
    'hardware-safety-timeout': '하드웨어 safety timeout',
    'hardware-probe-failed': 'T-Code probe 실패',
    'hardware-test-started': '하드웨어 테스트 시작',
    'hardware-test-failed': '하드웨어 테스트 실패',
    'hardware-test-finished': '하드웨어 테스트 종료',
    'receive-paused': '수신 일시정지',
    'protection-updated': '보호 옵션 변경',
    'motion-dropped-paused': 'pause 중 모션 드롭',
    'motion-not-queued': '모션 queue 제외',
    'approval-requested': '입장 신청',
    'viewer-approved': '시청자 승인',
    'viewer-rejected': '시청자 거절',
    'viewer-removed': '시청자 제거',
    'viewer-list-updated': '접속자 목록 갱신',
    'room-stop-received': '방 정지 수신',
    'relay-connected': 'relay 연결',
    'relay-disconnected': 'relay 끊김',
    'relay-reconnecting': 'relay 재연결 중',
    'relay-rejoined': '방 재입장',
    'relay-error': 'relay 오류',
    'room-create-requested': '방 생성 요청',
    'room-join-requested': '방 입장 요청',
    'emergency-stop-requested': '긴급 정지 요청',
    'relay-disconnect-requested': 'relay 연결 해제 요청',
    'clipboard-copied': '클립보드 복사',
    'logs-exported': '로그 저장',
    'settings-saved': '설정 저장',
    'settings-migrated': '설정 마이그레이션',
    'settings-defaulted': '기본 설정 사용'
  };

  return messages[message] ?? message;
}

function formatReason(reason: string) {
  const messages: Record<string, string> = {
    'invalid-relay-url': '릴레이 서버 URL은 https 또는 localhost/사설 IP의 http 주소여야 합니다',
    'invalid-invite-code': '초대 코드가 올바르지 않습니다',
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
    'host-disconnected': '스트리머 연결이 종료되었습니다',
    'hardware-stop-write-failed': '긴급 정지 명령을 하드웨어에 쓰지 못했습니다',
    'hardware-test-failed': '하드웨어 테스트에 실패했습니다',
    'invalid-hardware-profile': '하드웨어 프로필 설정이 올바르지 않습니다',
    'invalid-baud-rate': 'baudrate 값이 올바르지 않습니다',
    'invalid-linearAxis': 'stroke 축은 L0, R0, V0, A0 형식이어야 합니다',
    'invalid-vibrationAxis': '진동 축은 L0, R0, V0, A0 형식이어야 합니다',
    'invalid-stroke-range': '최소 위치는 최대 위치보다 작아야 합니다',
    'invalid-strokeMin': '최소 위치는 0부터 1 사이여야 합니다',
    'invalid-strokeMax': '최대 위치는 0부터 1 사이여야 합니다',
    'invalid-hardware-protection': '보호 옵션 설정이 올바르지 않습니다',
    'unsupported-settings-version': '지원하지 않는 설정 파일 버전입니다',
    'invalid-protection-position-range': '보호 최소 위치는 최대 위치보다 작아야 합니다',
    'invalid-protectionIntensityLimit': '강도 상한은 0부터 1 사이여야 합니다',
    'invalid-protectionPositionMin': '보호 최소 위치는 0부터 1 사이여야 합니다',
    'invalid-protectionPositionMax': '보호 최대 위치는 0부터 1 사이여야 합니다',
    'protection-paused': '수신 일시정지 중입니다',
    'timeout': '요청 시간이 초과되었습니다',
    'window-not-ready': '앱 창이 아직 준비되지 않았습니다'
  };

  return messages[reason] ?? reason;
}
