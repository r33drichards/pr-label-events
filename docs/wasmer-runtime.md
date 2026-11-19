# Wasmer runtime verification — 2026-11-19

## Verified locally

The official [Node/QuickJS beta announcement](https://wasmer.io/posts/nodejs-support-in-wasmer-edge-beta) specifies Node 24 compatibility, QuickJS as the available engine, and Node MCP support. We tested the application rather than relying on that claim:

- Host: macOS arm64; official Wasmer CLI **7.5.0** with Cranelift.
- Guest: **wasmer/edgejs-quickjs@0.2.5**, reports Node **24.13.2**, Edge **0.0.0-gf3170cc**.
- Registry package SHA-256: `812c1d8078e47291e1f024588d818aed4fedeaa3b8db03e411b5ea3a540ab124`.
- `scripts/runtime-smoke.js` imports the real service, HTTP handler, `pg`, and MCP SDK client/server. It passes HTTP health, signed and tampered raw payloads, signed-content replay under a different delivery ID, MCP initialization, admin subscribe, read-only tool discovery, and event retrieval.
- Database: a **new temporary localhost PostgreSQL 14** cluster with SCRAM-SHA-256 password authentication, certificate-verified TLS with a synthetic localhost certificate. The smoke checks `pg_stat_ssl.ssl=true` and rejects the same server when its CA is not trusted.
- `wasmer package build` succeeds. Running that resulting `.webc` executes the actual `src/main.js` entry point with only production dependencies and returns `{"ok":true}` from health backed by the isolated TLS database.

This proves local WASIX compatibility for the tested paths. It does **not** verify hosted Wasmer Edge ingress/Host preservation, production secrets, remote Neon connectivity, platform scheduling, billing eligibility, cold starts, or hosted concurrency. No app was deployed and no cloud resource was created. No runtime port or adapter was required.

## Reproduce packaging

The manifest follows the official [Wasmer manifest format](https://docs.wasmer.io/registry/manifest/), pins the tested runtime, and packages only an explicit application allowlist.

```sh
npm ci --ignore-scripts
node scripts/prepare-wasmer.js
npm ci --prefix .wasmer-bundle --omit=dev --ignore-scripts
wasmer package build . -o /tmp/pr-label-events.webc
```

`.wasmer-bundle` contains only `src`, package metadata, and production dependencies. It excludes `.git`, environment files, credentials, docs and synthetic fixtures. Never map the whole checkout into a published package. Do not publish/deploy as part of this smoke.

To run the service, pass fresh isolated environment settings through `wasmer run --env-file` (a private file outside the checkout) plus `--net`; use `/tmp/pr-label-events.webc` as input. The package starts `/app/src/main.js`. No environment variables are embedded in the package. Use the existing production gates in README before any hosted deployment. Keep `WAKE_MODE=noop`.

To reproduce the full smoke, create a disposable local PostgreSQL cluster/database named `pr_label_smoke`, configure TLS for `localhost`, and grant its synthetic test role schema creation rights. Never use a production database: this script truncates its four fixture tables. It refuses non-localhost hosts or other database names. Mount the checkout at `/app` and the synthetic certificate directory at `/smoke`, then run:

```sh
wasmer run --net --volume "$PWD:/app" --volume "$SMOKE_CERT_DIR:/smoke" \
  --cwd /app --env "SMOKE_DATABASE_URL=$SMOKE_DATABASE_URL" \
  wasmer/edgejs-quickjs@0.2.5 -- /app/scripts/runtime-smoke.js
```

`SMOKE_DATABASE_URL` must use localhost, the temporary PostgreSQL port, database `pr_label_smoke`, `sslmode=verify-full`, and `sslrootcert=/smoke/cert.pem`. All credentials/certificates used in our run were synthetic and temporary. The local script also runs under ordinary Node, but that alone is not Wasmer evidence.

## Separate Neon Free requirements

Per the current [Neon plan documentation](https://neon.com/docs/introduction/plans), Free is $0/month with 100 CU-hours per project, 1 GB per project (20 GB account total), 5 GB project egress, and mandatory suspension after five idle minutes. Account eligibility and available capacity must still be checked before provisioning. A project inside a paid organization is not assumed free. Do not upgrade or enable paid resources.

Use a **new project** for this application, one root branch, one database `pr_label_events`, and a dedicated login role scoped only to that database/schema. Do not branch/copy another app's project or reuse its owner credentials. Current startup calls `CREATE TABLE IF NOT EXISTS`, so the role requires CREATE in its own empty schema plus ownership/DML on these four tables. It needs no role creation, superuser, replication, other-app database access, or project administration rights. If stricter DML-only runtime credentials are desired, move schema creation into a separate migration step before switching roles; the current implementation has not done that split.

Use a pooled Neon URL (`-pooler` hostname), TLS with `sslmode=verify-full`, and a unique password stored only in Wasmer secrets. `pg` uses a five-connection pool; its transactions are ordinary BEGIN/COMMIT with transaction-scoped locks, no session state. See [Neon pooling](https://neon.com/docs/connect/connection-pooling) and [secure connections](https://neon.com/docs/connect/connect-securely). Live Neon SCRAM/channel-binding and trusted public certificate validation must still be tested against the new project.

A five-second outbox polling loop or frequent database-backed health probes prevent scale-to-zero and can exhaust Free compute allowance. Keep wake disabled initially; choose a verified scheduler with bounded wake work before enabling Slack. Monitor storage because replay records are retained indefinitely. No existing Neon credentials were inspected or copied.

## Authenticated MCP connection

Endpoint: `https://<verified-new-app-host>/mcp`. A client must support Streamable HTTP **and custom Authorization headers**. This service uses separate opaque Bearer tokens, not OAuth discovery or an interactive OAuth login. Do not assume an OAuth-only client can connect, and never make `/mcp` public to work around client limitations.

`scripts/read-event.js` is an SDK client example. Set `MCP_URL` and `READ_TOKEN` in the client's secret environment and run `node scripts/read-event.js <event-uuid>`. It performs the SDK initialize handshake and `get_label_event` call. For subscription management use a separate operator client configured with `ADMIN_TOKEN` as its Bearer token; do not give that token to the event-reading automation. The Wasmer smoke verifies both client roles against the real Streamable HTTP server.

Dot's ability to attach a custom header for this connection remains a separate integration check. If Dot requires OAuth, the smallest additional component is a standards-compliant OAuth resource-server integration with independent read/admin scopes; no such OAuth capability is claimed by this repository.
