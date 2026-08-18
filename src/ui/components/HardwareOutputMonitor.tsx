import { useEffect, useState } from 'react';
import { Cable, CircleCheck } from 'lucide-react';
import type { HardwareOutputSnapshot } from '../../shared/protocol';

export function HardwareOutputMonitor({ connected }: { connected: boolean }) {
  const [output, setOutput] = useState<HardwareOutputSnapshot>();

  useEffect(() => window.hapticRelay.onHardwareOutput(setOutput), []);
  useEffect(() => {
    if (!connected) setOutput(undefined);
  }, [connected]);

  return (
    <section className="hardware-output-monitor" aria-live="polite">
      <div className="hardware-output-heading">
        <span><Cable size={15} /> 직렬 출력 진단</span>
        <strong className={output ? 'ok' : ''}>
          {output ? <CircleCheck size={14} /> : null}
          {output ? '출력 성공' : connected ? '출력 대기' : '장비 미연결'}
        </strong>
      </div>
      <code data-hardware-output>{output?.command ?? 'T-Code 출력이 완료되면 표시됩니다.'}</code>
      <dl>
        <div><dt>종류</dt><dd>{output?.kind ?? '-'}</dd></div>
        <div><dt>포트</dt><dd>{output?.portPath ?? '-'}</dd></div>
        <div><dt>속도</dt><dd>{output ? `${output.baudRate}` : '-'}</dd></div>
        <div>
          <dt>완료 시각</dt>
          <dd>{output ? new Date(output.completedAt).toLocaleTimeString('ko-KR', { hour12: false }) : '-'}</dd>
        </div>
      </dl>
    </section>
  );
}
