import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HardwareOutputLogRow } from '../../shared/protocol';
import {
  applyInitialSnapshot,
  createFrameBatcher,
  createOutputLogModel,
  expandHistory,
  getVirtualWindow,
  getVisibleRows,
  reduceOutputLogEvent
} from '../output-log-model.mjs';
import type { OutputLogEvent, OutputLogModel } from '../output-log-model.mjs';
import '../../styles.css';

const FOLLOW_THRESHOLD_PX = 48;
const ROW_HEIGHT_PX = 32;

export default function HardwareOutputLogView() {
  const [model, setModel] = useState<OutputLogModel>(() => createOutputLogModel());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewport, setViewport] = useState({ scrollTop: 0, clientHeight: 0 });
  const modelRef = useRef(model);
  const scrollRef = useRef<HTMLDivElement>(null);
  const preservedScrollTopRef = useRef<number | undefined>(undefined);
  const visibleRows = useMemo(() => getVisibleRows(model), [model]);
  const virtualWindow = useMemo(
    () => getVirtualWindow(visibleRows.length, viewport.scrollTop, viewport.clientHeight, ROW_HEIGHT_PX),
    [viewport, visibleRows.length]
  );
  const renderedRows = useMemo(
    () => visibleRows.slice(virtualWindow.start, virtualWindow.end),
    [visibleRows, virtualWindow.end, virtualWindow.start]
  );

  function commitModel(nextModel: OutputLogModel) {
    if (nextModel === modelRef.current) return;
    modelRef.current = nextModel;
    setModel(nextModel);
  }

  function syncViewport(container: HTMLDivElement) {
    const nextViewport = { scrollTop: container.scrollTop, clientHeight: container.clientHeight };
    setViewport(current => current.scrollTop === nextViewport.scrollTop && current.clientHeight === nextViewport.clientHeight ? current : nextViewport);
  }

  useEffect(() => {
    const outputLog = window.hapticOutputLog;
    if (!outputLog) {
      setError('출력 로그 API를 사용할 수 없습니다.');
      setLoading(false);
      return;
    }

    let active = true;
    let initialPending = true;
    const pendingEvents: OutputLogEvent[] = [];
    const batcher = createFrameBatcher<OutputLogEvent>(events => {
      if (!active) return;
      const currentModel = modelRef.current;
      const nextModel = events.reduce(reduceOutputLogEvent, currentModel);
      commitModel(nextModel);
      if (nextModel !== currentModel) setError('');
    }, window.requestAnimationFrame, window.cancelAnimationFrame);
    const receive = (event: OutputLogEvent) => {
      if (initialPending) {
        pendingEvents.push(event);
        return;
      }
      batcher.push(event);
    };
    const removeReset = outputLog.onReset(session => receive({ type: 'reset', session }));
    const removeAppend = outputLog.onAppend(payload => receive({ type: 'append', payload }));

    void outputLog.getSession()
      .then(snapshot => {
        if (!active) return;
        initialPending = false;
        commitModel(applyInitialSnapshot(modelRef.current, snapshot, pendingEvents));
        setError('');
        setLoading(false);
      })
      .catch(loadError => {
        if (!active) return;
        initialPending = false;
        commitModel(pendingEvents.reduce(reduceOutputLogEvent, modelRef.current));
        setError(formatError(loadError));
        setLoading(false);
      });

    return () => {
      active = false;
      batcher.dispose();
      removeReset();
      removeAppend();
    };
  }, []);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const preservedScrollTop = preservedScrollTopRef.current;
    if (preservedScrollTop !== undefined) {
      container.scrollTop = preservedScrollTop;
      preservedScrollTopRef.current = undefined;
    } else if (model.following) {
      container.scrollTop = container.scrollHeight;
    }
    syncViewport(container);
  }, [model.following, model.revision, visibleRows.length]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => syncViewport(container));
    observer.observe(container);
    syncViewport(container);
    return () => observer.disconnect();
  }, []);

  function updateFollowing() {
    const container = scrollRef.current;
    if (!container) return;
    syncViewport(container);
    const following = container.scrollHeight - container.scrollTop - container.clientHeight <= FOLLOW_THRESHOLD_PX;
    if (following !== modelRef.current.following) commitModel({ ...modelRef.current, following });
  }

  function moveToLatest() {
    const container = scrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      syncViewport(container);
    }
    if (!modelRef.current.following) commitModel({ ...modelRef.current, following: true });
  }

  function showEarlierLogs() {
    const container = scrollRef.current;
    const expansion = expandHistory(modelRef.current, container?.scrollTop ?? 0, ROW_HEIGHT_PX);
    if (expansion.model === modelRef.current) return;
    preservedScrollTopRef.current = expansion.scrollTop;
    commitModel(expansion.model);
  }

  const session = model.session;
  const port = session.portPath ?? '연결 대기';
  const retainedRows = session.rows.length.toLocaleString('ko-KR');

  return (
    <main className="hardware-output-log-view">
      <header className="hardware-output-log-header">
        <div><span>HARDWARE OUTPUT</span><h1>전체 출력 로그</h1></div>
        <p>포트: {port} · 보관됨 {retainedRows}개</p>
      </header>
      <div className="hardware-output-log-toolbar">
        <button className="btn btn-secondary" disabled={model.visibleCount >= session.rows.length} onClick={showEarlierLogs}>이전 로그 더 보기</button>
        <span>{visibleRows.length.toLocaleString('ko-KR')}개 표시</span>
      </div>
      <div className="hardware-output-log-notice" aria-live="polite">
        {session.omittedRows > 0 ? <p className="hardware-output-log-omitted">이전 {session.omittedRows.toLocaleString('ko-KR')}개 생략됨</p> : null}
      </div>
      <div className="hardware-output-log-table-wrap" ref={scrollRef} onScroll={updateFollowing} aria-busy={loading}>
        <table className="hardware-output-log-table">
          <caption className="hardware-output-log-caption">하드웨어 출력 명령의 완료 기록</caption>
          <thead><tr><th scope="col">완료 시각</th><th scope="col">종류</th><th scope="col">명령</th><th scope="col">포트</th><th scope="col">Baudrate</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={5} className="hardware-output-log-state" role="status" aria-live="polite">출력 로그를 불러오는 중입니다.</td></tr>
              : error ? <tr><td colSpan={5} className="hardware-output-log-state" role="alert">{error}</td></tr>
                : visibleRows.length === 0 ? <tr><td colSpan={5} className="hardware-output-log-state" role="status">아직 출력 로그가 없습니다.</td></tr>
                  : <>
                    {virtualWindow.topSpacerPx > 0 ? <SpacerRow height={virtualWindow.topSpacerPx} /> : null}
                    {renderedRows.map(row => <OutputLogRow key={`${session.sessionId}:${row.id}`} row={row} />)}
                    {virtualWindow.bottomSpacerPx > 0 ? <SpacerRow height={virtualWindow.bottomSpacerPx} /> : null}
                  </>}
          </tbody>
        </table>
      </div>
      {!model.following ? <button className="btn btn-primary hardware-output-log-follow" onClick={moveToLatest}>최신 로그로 이동</button> : null}
    </main>
  );
}

const OutputLogRow = React.memo(function OutputLogRow({ row }: { row: HardwareOutputLogRow }) {
  return <tr><td>{formatCompletedAt(row.completedAt)}</td><td>{row.kind}</td><td><code>{row.command}</code></td><td>{row.portPath}</td><td>{row.baudRate.toLocaleString('ko-KR')}</td></tr>;
});

function SpacerRow({ height }: { height: number }) {
  return <tr className="hardware-output-log-spacer" aria-hidden="true"><td colSpan={5} style={{ height }} /></tr>;
}

function formatCompletedAt(completedAt: number) {
  if (!Number.isFinite(completedAt)) return '-';
  return new Date(completedAt).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return `출력 로그를 불러오지 못했습니다: ${error.message}`;
  return '출력 로그를 불러오지 못했습니다.';
}
