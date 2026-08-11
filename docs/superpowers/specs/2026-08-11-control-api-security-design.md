# Control API Security Design

## Goal

Protect public relay diagnostics and reduce room control abuse without adding a database or proxy dependency to the phone demo server.

## Design

- Keep `/healthz` public for tunnel and process checks.
- Return `404` from `/metrics` when no metrics token is configured.
- Require a constant-time Bearer token comparison when metrics are enabled.
- Apply separate in-memory, fixed-window limits to room creation and room join routes before parsing request bodies.
- Key limits by the direct peer address. Trust `CF-Connecting-IP` only when explicitly enabled for a loopback-only Cloudflare Tunnel origin.
- Bound the limiter map to 10,000 client entries to prevent unbounded memory growth.

## Defaults

- Window: 60 seconds
- Room creation: 10 requests per IP
- Room join: 300 requests per IP
- Metrics: disabled
- Proxy address trust: disabled except in the Termux profile

## Verification

Unit tests cover limiter reset, client isolation, proxy address validation, and metrics authorization. Relay smoke tests cover `401`, authenticated `200`, and `429` responses with `Retry-After`.
