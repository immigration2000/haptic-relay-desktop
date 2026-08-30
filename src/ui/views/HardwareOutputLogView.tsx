import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HardwareOutputLogSession } from '../../shared/protocol';
import '../../styles.css';

const EMPTY_SESSION: HardwareOutputLogSession = { sessionId: 0, rows: [], omittedRows: 0 };
const PAGE_SIZE = 500;
const MAX_ROWS = 10_000;
const FOLLOW_THRESHOLD_PX = 48;

export default function HardwareOutputLogView() {
  const [session, setSession] = useState<HardwareOutputLogSession>(EMPTY_SESSION);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [following, setFollowing] = useState(true);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () => session.rows.slice(Math.max(0, session.rows.length - visibleCount)),
    [session.rows, visibleCount]
  );

  useEffect(() => {
    const outputLog = window.hapticOutputLog;
    if (!outputLog) {
      setError('출력 로그 API를 사용할 수 없습니다.');
      return;
    }

    let active = true;
    const removeReset = outputLog.onReset(nextSession => {
      setSession(nextSession);
      setVisibleCount(PAGE_SIZE);
      setFollowing(true);
      setError('');
    });
    const removeAppend = outputLog.onAppend(({ row, omittedRows }) => {
      setSession(current => ({
        ...current,
        rows: [...current.rows, row].slice(-MAX_ROWS),
        omittedRows
      }));
      setError('');
    });

    void window.hapticOutputLog?.getSession()
      .then(nextSession => {
        if (!active) return;
        setSession(nextSession);
        setError('');
      })
      .catch(loadError => {
        if (active) setError(formatError(loadError));
      });

    return () => {
      active = false;
      removeReset();
      removeAppend();
    };
  }, []);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container && following) container.scrollTop = container.scrollHeight;
  }, [following, rows.length]);

  function updateFollowing() {
    const container = scrollRef.current;
    if (!container) return;
    setFollowing(container.scrollHeight - container.scrollTop - container.clientHeight <= FOLLOW_THRESHOLD_PX);
  }

  function moveToLatest() {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    setFollowing(true);
  }

  const port = session.portPath ?? '연결 대기';
  const retainedRows = session.rows.length.toLocaleString('ko-KR');

  return (
    <main className="hardware-output-log-view">
      <header className="hardware-output-log-header">
        <div>
          <span>HARDWARE OUTPUT</span>
          <h1>전체 출력 로그</h1>
        </div>
        <p>포트: {port} · 보관됨 {retainedRows}개</p>
      </header>

      <div className="hardware-output-log-toolbar">
        <button
          className="btn btn-secondary"
          disabled={visibleCount >= session.rows.length}
          onClick={() => setVisibleCount(current => Math.min(session.rows.length, current + PAGE_SIZE))}
        >
          이전 로그 더 보기
        </button>
        <span>{rows.length.toLocaleString('ko-KR')}개 표시</span>
      </div>

      {session.omittedRows > 0 ? <p className="hardware-output-log-omitted">이전 {session.omittedRows.toLocaleString('ko-KR')}개 생략됨</p> : <span />}

      <div className="hardware-output-log-table-wrap" ref={scrollRef} onScroll={updateFollowing}>
        <table className="hardware-output-log-table">
          <thead>
            <tr>
              <th>완료 시각</th>
              <th>종류</th>
              <th>명령</th>
              <th>포트</th>
              <th>Baudrate</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr><td colSpan={5} className="hardware-output-log-state">{error}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="hardware-output-log-state">아직 출력 로그가 없습니다.</td></tr>
            ) : rows.map(row => (
              <tr key={`${session.sessionId}:${row.id}`}>
                <td>{formatCompletedAt(row.completedAt)}</td>
                <td>{row.kind}</td>
                <td><code>{row.command}</code></td>
                <td>{row.portPath}</td>
                <td>{row.baudRate.toLocaleString('ko-KR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!following ? <button className="btn btn-primary hardware-output-log-follow" onClick={moveToLatest}>최신 로그로 이동</button> : null}
    </main>
  );
}

function formatCompletedAt(completedAt: number) {
  if (!Number.isFinite(completedAt)) return '-';
  return new Date(completedAt).toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return `출력 로그를 불러오지 못했습니다: ${error.message}`;
  return '출력 로그를 불러오지 못했습니다.';
}
