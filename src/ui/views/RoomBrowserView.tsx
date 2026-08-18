import { KeyRound, LockKeyhole, Plus, Radio, RefreshCw, Search, Users } from 'lucide-react';
import type { BrowserRoom, RoomFilter } from '../model';
import { filterRooms } from '../model';

type RoomBrowserViewProps = {
  rooms: readonly BrowserRoom[];
  query: string;
  filter: RoomFilter;
  loading: boolean;
  error: string;
  onQueryChange(value: string): void;
  onFilterChange(value: RoomFilter): void;
  onRefresh(): void;
  onCreateRoom(): void;
  onJoinByInvite(): void;
  onOpenRoom(room: BrowserRoom): void;
};

const FILTERS: Array<{ id: RoomFilter; label: string }> = [
  { id: 'all', label: '전체' }, { id: 'open', label: '자유 입장' }, { id: 'request', label: '승인 필요' },
  { id: 'live', label: '라이브' }
];

export function RoomBrowserView(props: RoomBrowserViewProps) {
  const rooms = filterRooms([...props.rooms], props.query, props.filter);
  return (
    <div className="browser-view">
      <header className="view-heading">
        <div><span className="kicker">ROOM DIRECTORY</span><h1>방 찾기</h1><p>선택한 릴레이 서버의 방을 확인하고 입장할 수 있습니다.</p></div>
        <div className="heading-actions"><button className="icon-button room-refresh" type="button" title="방 목록 새로고침" aria-label="방 목록 새로고침" disabled={props.loading} onClick={props.onRefresh}><RefreshCw size={16} /></button><button className="btn btn-secondary" type="button" onClick={props.onJoinByInvite}><KeyRound size={15} /> 초대 코드</button><button className="btn btn-primary" type="button" onClick={props.onCreateRoom}><Plus size={15} /> 방 만들기</button></div>
      </header>
      <div className="browser-toolbar">
        <label className="search-field"><Search size={15} /><input placeholder="방 이름, 소개, 태그 검색" value={props.query} onChange={event => props.onQueryChange(event.target.value)} /></label>
        <div className="segmented-control" aria-label="방 필터">{FILTERS.map(item => <button className={props.filter === item.id ? 'active' : ''} key={item.id} type="button" onClick={() => props.onFilterChange(item.id)}>{item.label}</button>)}</div>
        <span className="result-count">{rooms.length} ROOMS</span>
      </div>
      <div className="room-grid">
        {rooms.map((room, index) => (
          <article className="room-card" data-room-card key={room.id}>
            <button className="room-card-open" type="button" onClick={() => props.onOpenRoom(room)} aria-label={`${room.title} 상세 보기`}>
              <div className={`room-thumbnail pattern-${index + 1}`}><span><Radio size={20} />LIVE ROOM</span></div>
              <div className="room-card-body">
                <div className="room-title-row"><div><span className={`room-kind ${room.kind}`}>라이브</span><h2>{room.title}</h2></div>{room.passwordProtected ? <LockKeyhole size={15} /> : null}</div>
                <p>{room.description}</p>
                <div className="tag-row">{room.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
                <dl><div><dt>HOST</dt><dd>{room.host}</dd></div><div><dt>SERVER</dt><dd>{room.serverName}</dd></div><div><dt><Users size={12} /> VIEWERS</dt><dd>{room.viewerCount} / {room.maxViewers}</dd></div></dl>
              </div>
            </button>
            <footer><span>{room.entryMode === 'open' ? '자유 입장' : '승인 필요'}</span><time>{room.updatedLabel}</time></footer>
          </article>
        ))}
        {rooms.length === 0 ? <div className="empty-state"><Search size={24} /><strong>{props.loading ? '방 목록을 불러오는 중입니다' : props.error ? '방 목록을 불러오지 못했습니다' : props.query || props.filter !== 'all' ? '검색 결과가 없습니다' : '현재 열린 방이 없습니다'}</strong><span>{props.error ? props.error : props.query || props.filter !== 'all' ? '검색어나 필터를 변경하세요.' : '스트리머가 방을 만들면 자동으로 표시됩니다.'}</span></div> : null}
      </div>
    </div>
  );
}
