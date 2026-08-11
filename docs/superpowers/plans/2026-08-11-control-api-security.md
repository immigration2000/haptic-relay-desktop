# Control API Security Implementation Plan

1. Define limiter, client address, and metrics authorization behavior in a failing unit test.
2. Implement the bounded in-memory security helpers.
3. Define failing relay integration tests for protected metrics and rate-limited control routes.
4. Integrate environment-driven policies into the relay server.
5. Update phone and hosted deployment settings and run full verification.
