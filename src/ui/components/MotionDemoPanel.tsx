import { Play, Square } from 'lucide-react';
import type { MotionDemoMode, MotionPattern, MotionPatternConfig } from '../../shared/protocol';

type MotionDemoPanelProps = {
  mode: MotionDemoMode;
  active: boolean;
  busy: boolean;
  position: number;
  intensity: number;
  livePosition: number;
  pattern: MotionPatternConfig;
  onModeChange(mode: MotionDemoMode): void;
  onPositionChange(position: number): void;
  onIntensityChange(intensity: number): void;
  onPatternChange(pattern: MotionPatternConfig): void;
  onToggle(): void;
};

const PATTERN_OPTIONS: Array<{ value: MotionPattern; label: string }> = [
  { value: 'sine', label: '사인' },
  { value: 'triangle', label: '삼각' },
  { value: 'pulse', label: '펄스' },
  { value: 'sawtooth', label: '톱니' }
];

export function MotionDemoPanel(props: MotionDemoPanelProps) {
  const livePercent = Math.min(100, Math.max(0, props.livePosition * 100));
  const markerOffset = livePercent * 0.08;

  function updatePositionMin(positionMin: number) {
    props.onPatternChange({
      ...props.pattern,
      positionMin,
      positionMax: Math.max(positionMin, props.pattern.positionMax)
    });
  }

  function updatePositionMax(positionMax: number) {
    props.onPatternChange({
      ...props.pattern,
      positionMin: Math.min(props.pattern.positionMin, positionMax),
      positionMax
    });
  }

  return (
    <section className="panel motion-demo-panel">
      <div className="panel-header motion-demo-header">
        <div>
          <p className="section-label">실시간 제어</p>
          <h2>모션 시연</h2>
        </div>
        <div className="motion-demo-header-actions">
          <div className="segmented-control compact motion-mode-control" aria-label="시연 모드">
            <button className={props.mode === 'manual' ? 'active' : ''} disabled={props.active} type="button" onClick={() => props.onModeChange('manual')}>수동</button>
            <button className={props.mode === 'pattern' ? 'active' : ''} disabled={props.active} type="button" onClick={() => props.onModeChange('pattern')}>자동 패턴</button>
          </div>
          <span className={`stream-state ${props.active ? 'active' : ''}`}>
            {props.active ? '30Hz 전송 중' : '전송 대기'}
          </span>
        </div>
      </div>

      {props.mode === 'manual' ? (
        <div className="motion-demo-controls">
          <label>
            <span className="control-label"><span>위치</span><strong>{props.position.toFixed(2)}</strong></span>
            <input className="range range-large" type="range" min="0" max="1" step="0.01" value={props.position} onChange={event => props.onPositionChange(Number(event.target.value))} />
          </label>
          <label>
            <span className="control-label"><span>강도</span><strong>{props.intensity.toFixed(2)}</strong></span>
            <input className="range range-large intensity-range" type="range" min="0" max="1" step="0.01" value={props.intensity} onChange={event => props.onIntensityChange(Number(event.target.value))} />
          </label>
        </div>
      ) : (
        <div className="pattern-demo-content">
          <div className="pattern-preview">
            <div className="pattern-preview-value"><span>실시간 위치</span><output>{props.livePosition.toFixed(2)}</output></div>
            <div className="pattern-preview-track" aria-hidden="true">
              <span className="pattern-preview-marker" style={{ left: `calc(${livePercent}% - ${markerOffset}px)` }} />
            </div>
          </div>
          <div className="pattern-controls">
            <label>
              <span className="control-label"><span>패턴</span></span>
              <select value={props.pattern.pattern} onChange={event => props.onPatternChange({ ...props.pattern, pattern: event.target.value as MotionPattern })}>
                {PATTERN_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              <span className="control-label"><span>주기</span><strong>{(props.pattern.periodMs / 1000).toFixed(1)}초</strong></span>
              <input className="range" data-control="period" type="range" min="500" max="5000" step="100" value={props.pattern.periodMs} onChange={event => props.onPatternChange({ ...props.pattern, periodMs: Number(event.target.value) })} />
            </label>
            <label>
              <span className="control-label"><span>최소 위치</span><strong>{props.pattern.positionMin.toFixed(2)}</strong></span>
              <input className="range" data-control="position-min" type="range" min="0" max="1" step="0.01" value={props.pattern.positionMin} onChange={event => updatePositionMin(Number(event.target.value))} />
            </label>
            <label>
              <span className="control-label"><span>최대 위치</span><strong>{props.pattern.positionMax.toFixed(2)}</strong></span>
              <input className="range" data-control="position-max" type="range" min="0" max="1" step="0.01" value={props.pattern.positionMax} onChange={event => updatePositionMax(Number(event.target.value))} />
            </label>
            <label className="pattern-intensity-control">
              <span className="control-label"><span>강도</span><strong>{props.pattern.intensity.toFixed(2)}</strong></span>
              <input className="range intensity-range" data-control="pattern-intensity" type="range" min="0" max="1" step="0.01" value={props.pattern.intensity} onChange={event => props.onPatternChange({ ...props.pattern, intensity: Number(event.target.value) })} />
            </label>
          </div>
        </div>
      )}

      <div className="demo-footer">
        <p className="muted">
          {props.mode === 'manual'
            ? '수동 위치 · 강도'
            : `${PATTERN_OPTIONS.find(option => option.value === props.pattern.pattern)?.label} · ${(props.pattern.periodMs / 1000).toFixed(1)}초 · ${props.pattern.positionMin.toFixed(2)}–${props.pattern.positionMax.toFixed(2)}`}
        </p>
        <button className={props.active ? 'danger' : 'primary'} disabled={props.busy} type="button" onClick={props.onToggle}>
          {props.active ? <Square size={15} /> : <Play size={15} />}
          <span>{props.active ? '시연 중지' : '시연 시작'}</span>
        </button>
      </div>
    </section>
  );
}
