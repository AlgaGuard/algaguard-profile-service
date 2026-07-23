# algaguard-profile-service

PostgreSQL-backed immutable algae-profile versions, cloning, organization sharing, device assignments, history, active lookup, compact configuration, and deterministic configuration hashes.

Production startup always constructs `PostgresProfileRepository`; the memory repository is an explicit test adapter only. User JWTs are validated and Access Service decisions use an OIDC client-credentials token. No scientific configuration is generated or defaulted.

```sh
npm ci
npm run migrate
npm run check
npm run test:integration
npm run dev
```

Canonical JSON recursively sorts object keys, preserves array order, rejects non-finite/non-JSON values, and hashes UTF-8 bytes with SHA-256. Each edit inserts a new immutable version. Assignment replacement and history are one transaction protected by a device-scoped advisory lock. No production deployment or scientific approval is claimed.
