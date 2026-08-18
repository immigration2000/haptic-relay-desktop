# Live Room Directory Design

## Goal

Replace the static mock room cards with the active rooms reported by the selected relay server so a viewer on another computer can discover and join a host room.

## Scope

- Add a public, read-only `GET /api/rooms` endpoint.
- Return only directory-safe room metadata.
- Add a typed Electron main/preload bridge for room listing.
- Refresh the directory when the browser opens, when the selected server changes, and every three seconds while the browser remains visible.
- Keep a manual refresh control for immediate checks.
- Open the real join dialog when a room card is selected.
- Remove static demo rooms from the live directory.
- Package and publish the change as Demo 6.

User-authored motion scripts, motion recording, hardware encoding changes, and production account authentication remain out of scope.

## Server Contract

`GET /api/rooms` returns:

```json
{
  "ok": true,
  "rooms": [
    {
      "roomName": "studio-main",
      "entryMode": "open",
      "passwordProtected": true,
      "viewerCount": 2,
      "maxViewers": 500,
      "relayNodeId": "local-1",
      "createdAt": 1787054400000
    }
  ]
}
```

The endpoint must not return the password value, host/viewer tokens, host socket IDs, blocked viewers, or approval requests. Responses retain the existing `Cache-Control: no-store` policy. Rooms disappear after the existing host disconnect grace cleanup removes them from the registry.

## Desktop Flow

`RelayClient.listRooms(controlUrl)` calls the endpoint through the Electron main process. The renderer never receives unrestricted networking access. The preload exposes one typed `listRooms` method.

The renderer maps each directory entry to the existing room-card model:

- title: room name;
- kind: live;
- host: generic `스트리머` because the current room contract has no public host profile;
- viewer count and capacity: server values;
- server name: selected server label;
- password icon: `passwordProtected`;
- entry label: open or approval-required.

Selecting a card fills the room name and current relay URL, clears any previous password, and opens the join dialog. Password-protected rooms ask for the password in that existing dialog.

## Refresh And Failure States

- Fetch immediately on entering the browser.
- Fetch immediately after selecting or saving a server.
- Poll every 3000 ms only while authenticated and on the browser screen.
- Ignore an older response when the server URL changes during a request.
- Preserve the last successful list during a transient refresh failure.
- Show a concise failure status and allow manual retry.
- Show a real empty state when the selected server has no rooms.

## LAN Requirement

Both computers must select the same reachable control URL. For the current laptop test that is `http://192.168.219.105:4175`. The relay process must advertise that same LAN URL through `HAPTIC_PUBLIC_RELAY_URL`; advertising `localhost` would redirect the PC client back to itself after the Control API response.

## Verification

- Server test proves directory entries appear and sensitive values are redacted.
- Server test proves viewer counts update after a viewer joins.
- UI smoke test proves a server-created room replaces mock cards and opens the real join dialog.
- Packaged two-client test proves a second installed app discovers and joins the host room.
- Existing motion, room moderation, security, UI, and release checks remain green.

