# Termux Relay Bundle Design

## Goal

Create a phone deployment artifact for the existing relay server without installing Electron, React, SerialPort, TypeScript, or other desktop-only dependencies on Android.

## Design

- Compile `server` and `src/shared` on the development PC.
- Copy `dist-server` into `release/termux-server`.
- Generate a runtime `package.json` containing only `socket.io`.
- Load Redis dynamically only when the Redis registry driver is selected. The phone profile uses the in-memory registry.
- Include Termux scripts for start, stop, restart, and health checks. Process ownership is tracked with a PID file instead of broad process-name termination.
- Include a production environment template configured for a conservative 30 Hz and 50 viewer demo limit.
- Refuse to start while the environment still contains placeholder secrets or relay URLs.

## Verification

An automated bundle test checks the artifact contents, minimal dependency set, production defaults, and script safety. A clean-room runtime check installs only the generated production dependency and verifies `/healthz` through the bundled start and stop scripts.

## Non-goals

- Cloudflare account or DNS provisioning
- Redis operation on Android
- Production capacity claims above the measured phone load
