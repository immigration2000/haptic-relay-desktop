export type AppScreen = 'browser' | 'host-room' | 'participant-room' | 'hardware' | 'safety' | 'logs';
export type RoomKind = 'demo' | 'live';
export type RoomFilter = 'all' | 'open' | 'request' | 'demo' | 'live';

export type RelayServerOption = {
  id: string;
  name: string;
  url: string;
  pingMs: number;
  available: boolean;
  custom?: boolean;
};

export type BrowserRoom = {
  id: string;
  kind: RoomKind;
  title: string;
  host: string;
  description: string;
  tags: string[];
  entryMode: 'open' | 'request';
  viewerCount: number;
  maxViewers: number;
  serverName: string;
  passwordProtected: boolean;
  updatedLabel: string;
};

export function filterRooms(rooms: BrowserRoom[], query: string, filter: RoomFilter) {
  const normalized = query.trim().toLowerCase();
  return rooms.filter(room => {
    const matchesFilter = filter === 'all' || room.entryMode === filter || room.kind === filter;
    const haystack = [room.title, room.host, room.description, ...room.tags].join(' ').toLowerCase();
    return matchesFilter && (!normalized || haystack.includes(normalized));
  });
}
