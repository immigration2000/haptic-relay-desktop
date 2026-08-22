# Relay Server List Update Design

## Goal

Make the AWS relay the application's main/default relay while retaining the existing phone-hosted relay as a manually selectable backup.

## Current State

- The application defaults to `https://relay.syncra.uk`, which currently points to the phone-hosted relay.
- The server list includes the phone relay as the official relay, several unavailable placeholder regions, a local demo relay, and a custom server option.
- The AWS relay is available at `https://aws-relay.syncra.uk` through Cloudflare Tunnel.

## Decisions

1. Replace the visible relay list with the following order:
   - `AWS 메인 릴레이` — `https://aws-relay.syncra.uk`
   - `휴대폰 예비 릴레이` — `https://relay.syncra.uk`
   - `로컬 데모` — `http://localhost:4174`
   - `사용자 서버` — user-entered URL
2. Change the built-in default relay URL to `https://aws-relay.syncra.uk`.
3. Preserve `VITE_RELAY_URL` as the highest-priority deployment override.
4. Keep backup selection manual. The application will not automatically switch relays when the selected relay is unavailable.
5. Remove unavailable placeholder region entries because they are not usable servers.

## Behavior and Data Flow

On startup, the application selects the first server entry and initializes the relay URL from `VITE_RELAY_URL` when present, otherwise from the AWS relay URL. Selecting another server updates the existing relay URL state and uses the existing connection and health-check flow. The phone relay remains independently selectable from the server list.

This change does not synchronize rooms, tokens, or connection state between the AWS and phone relays. Switching relays is equivalent to connecting to a separate relay deployment.

## Verification

- Update the Electron UI smoke test to require the AWS relay as the default URL.
- Require both `AWS 메인 릴레이` and `휴대폰 예비 릴레이` in the rendered UI.
- Verify removed placeholder region names are absent.
- Run lint, application build, UI smoke tests, and Electron tests.
- Confirm both public relay health endpoints remain reachable.

## Documentation

Update the README, development handoff, and roadmap to state that:

- AWS is the application default/main relay.
- The phone-hosted relay is the manual backup.
- The hostnames remain separate; no DNS cutover is part of this change.

## Out of Scope

- Automatic failover or retry across relay servers
- Active-active relay coordination
- Shared room or token state between deployments
- Moving `relay.syncra.uk` DNS to AWS
- AWS or Cloudflare infrastructure changes
