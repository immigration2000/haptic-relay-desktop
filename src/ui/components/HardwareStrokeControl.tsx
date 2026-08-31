import type { CSSProperties } from 'react';
import type { HardwareProfile, HardwareProtection, MotionSafetySettings } from '../../shared/protocol';
import { formatTraversalSeconds, normalizedSpeedToPercent, normalizedToPercent, percentSpeedToNormalized, percentToNormalized, updateMotionRange } from '../hardware-settings-values';

type HardwareStrokeControlProps = {
  profile: HardwareProfile; protection: HardwareProtection; profileDisabled: boolean; busy: boolean;
  settingsLoading: boolean; hasSavedSettings: boolean;
  motionSafety: MotionSafetySettings;
  onProfileChange: (patch: Partial<HardwareProfile>) => void;
  onProtectionChange: (patch: Partial<HardwareProtection>) => void;
  onMotionSafetyChange: (manualMaxPositionSpeed: number) => void;
  onApplyProtection: () => void; onSave: () => void; onLoad: () => void;
};

export function HardwareStrokeControl({
  profile,
  protection,
  profileDisabled,
  busy,
  settingsLoading,
  hasSavedSettings,
  motionSafety,
  onProfileChange,
  onProtectionChange,
  onMotionSafetyChange,
  onApplyProtection,
  onSave,
  onLoad
}: HardwareStrokeControlProps) {
  const min = normalizedToPercent(profile.strokeMin);
  const max = normalizedToPercent(profile.strokeMax);
  const stop = Math.min(max, Math.max(min, normalizedToPercent(profile.stopPosition)));
  const intensity = normalizedToPercent(protection.intensityLimit);
  const manualSpeedPercent = normalizedSpeedToPercent(motionSafety.manualMaxPositionSpeed);
  const traversalSeconds = formatTraversalSeconds(motionSafety.manualMaxPositionSpeed);
  const railStyle = {
    '--stroke-min': `${min}%`,
    '--stroke-max': `${max}%`,
    '--stroke-stop': `${stop}%`
  } as CSSProperties;

  function changeRange(handle: 'min' | 'max', requested: number) {
    const next = updateMotionRange({ min, max, stop }, handle, requested);
    onProfileChange({
      strokeMin: percentToNormalized(next.min),
      strokeMax: percentToNormalized(next.max),
      stopPosition: percentToNormalized(next.stop)
    });
  }

  return (
    <section className="hardware-stroke-control">
      <h3>스트로크 제어 ({profile.linearAxis})</h3>
      <div className="stroke-visual-grid">
        <div className="stroke-rail-column">
          <div className="stroke-rail" style={railStyle} aria-label={`동작 범위 ${min}%에서 ${max}%`}>
            <span className="stroke-rail-mark stroke-rail-mark-top">100</span>
            <span className="stroke-rail-fill" />
            <span className="stroke-rail-stop" />
            <span className="stroke-rail-label stroke-rail-label-max">MAX {max}%</span>
            <span className="stroke-rail-label stroke-rail-label-min">MIN {min}%</span>
            <span className="stroke-rail-mark stroke-rail-mark-bottom">0</span>
          </div>
        </div>
        <label className="vertical-stop-control" htmlFor="hardware-stop-position">
          <span>긴급 정지 위치</span>
          <input
            id="hardware-stop-position"
            type="range"
            min={min}
            max={max}
            step="1"
            value={stop}
            disabled={profileDisabled}
            onChange={event => onProfileChange({ stopPosition: percentToNormalized(Number(event.target.value)) })}
          />
          <output id="hardware-stop-position-output" htmlFor="hardware-stop-position">{stop}%</output>
        </label>
      </div>
      <p className="stroke-summary">실제 {min}~{max}% · 중심 {stop}% · 원본 대비 {((max - min) / 100).toFixed(2)}배{profile.invertPosition ? ' · 방향 반전' : ''}</p>

      <fieldset className="motion-range-fieldset" disabled={profileDisabled}>
        <legend>동작 범위</legend>
        <div className="motion-range-heading"><output id="hardware-motion-range-output" htmlFor="hardware-stroke-min hardware-stroke-max hardware-stroke-min-range hardware-stroke-max-range">{min}%~{max}%</output></div>
        <div className="motion-range-steppers">
          <label htmlFor="hardware-stroke-min">
            최소 위치 (%)
            <input id="hardware-stroke-min" type="number" min="0" max="99" step="1" value={min} onChange={event => changeRange('min', Number(event.target.value))} />
          </label>
          <label htmlFor="hardware-stroke-max">
            최대 위치 (%)
            <input id="hardware-stroke-max" type="number" min="1" max="100" step="1" value={max} onChange={event => changeRange('max', Number(event.target.value))} />
          </label>
        </div>
        <div className="dual-range-slider">
          <input id="hardware-stroke-min-range" aria-label="동작 범위 최소" type="range" min="0" max="99" step="1" value={min} onChange={event => changeRange('min', Number(event.target.value))} />
          <input id="hardware-stroke-max-range" aria-label="동작 범위 최대" type="range" min="1" max="100" step="1" value={max} onChange={event => changeRange('max', Number(event.target.value))} />
        </div>
      </fieldset>

      <div className="safety-speed-control-grid">
        <label htmlFor="hardware-manual-speed-limit">
          <span>안전 모드 속도 제한</span>
          <input
            id="hardware-manual-speed-limit"
            type="range"
            min="50"
            max="400"
            step="25"
            value={manualSpeedPercent}
            disabled={busy}
            onChange={event => onMotionSafetyChange(percentSpeedToNormalized(Number(event.target.value)))}
          />
        </label>
        <output htmlFor="hardware-manual-speed-limit">{manualSpeedPercent}%/초 · 끝→끝 약 {traversalSeconds}초</output>
      </div>

      <div className="intensity-control-grid">
        <label htmlFor="hardware-intensity-limit">
          <span>강도 상한</span>
          <input id="hardware-intensity-limit" type="range" min="0" max="100" step="1" value={intensity} disabled={busy} onChange={event => onProtectionChange({ intensityLimit: percentToNormalized(Number(event.target.value)) })} />
        </label>
        <output id="hardware-intensity-output" htmlFor="hardware-intensity-limit">{intensity}%</output>
        <button type="button" disabled={busy} onClick={onApplyProtection}>보호 옵션 적용</button>
      </div>

      <details className="hardware-advanced-settings">
        <summary>고급 설정</summary>
        <div className="profile-grid">
          <label>
            Baudrate
            <select value={profile.baudRate} disabled={profileDisabled} onChange={event => onProfileChange({ baudRate: Number(event.target.value) })}>
              <option value={9600}>9600</option>
              <option value={57600}>57600</option>
              <option value={115200}>115200</option>
              <option value={230400}>230400</option>
              <option value={460800}>460800</option>
            </select>
          </label>
          <label>
            Stroke 축
            <input value={profile.linearAxis} disabled={profileDisabled} onChange={event => onProfileChange({ linearAxis: event.target.value.toUpperCase() })} />
          </label>
          <label>
            진동 축
            <input value={profile.vibrationAxis ?? ''} disabled={profileDisabled} onChange={event => onProfileChange({ vibrationAxis: event.target.value.toUpperCase() })} placeholder="선택, 예: V0" />
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={profile.invertPosition} disabled={profileDisabled} onChange={event => onProfileChange({ invertPosition: event.target.checked })} />
            방향 반전
          </label>
        </div>
        <div className="button-row">
          <button type="button" disabled={busy || settingsLoading || !hasSavedSettings} onClick={onSave}>설정 저장</button>
          <button type="button" disabled={busy || settingsLoading || !hasSavedSettings || profileDisabled} onClick={onLoad}>설정 불러오기</button>
        </div>
      </details>
    </section>
  );
}
