# Termux Relay Bundle Implementation Plan

1. Add a failing artifact contract test for the generated Termux bundle.
2. Make Redis a runtime-only dynamic dependency for Redis deployments.
3. Add bundle templates and a deterministic bundle generator.
4. Add npm commands and deployment documentation.
5. Build the artifact, install its production dependency in isolation, and run a health-check smoke test.
