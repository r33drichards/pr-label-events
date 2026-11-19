# pr-label-events

An isolated GitHub label event receiver and authenticated MCP Streamable HTTP service. The only allowed repository is `r33drichards/mcp-js`, and the only allowed label is `hclmb`. It does not modify GitHub, run prompts, cancel tasks, or execute downstream actions. It is independent of wreview and any existing app or database.

**Status:** local implementation with signed integration tests; deployment and live webhook are not configured. On 2026-11-19, read-only GitHub API inspection confirmed the repository is public but `hclmb` is absent. Do not create it without explicit user instruction.

## Run and test

Requires Node.js 24+ and an isolated PostgreSQL database for the server. Tests use embedded PostgreSQL (PGlite), including a real disk restart, and never need real service credentials.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit --audit-level=high
```

Set `DATABASE_URL`, `WEBHOOK_SECRET`, `READ_TOKEN`, `ADMIN_TOKEN`, and `PUBLIC_ORIGIN` in a secret manager or local environment; never commit them. Tokens and the webhook secret must each be at least 32 characters; generate independent cryptographically random values. `READ_TOKEN` and `ADMIN_TOKEN` must differ. Set `NODE_ENV=production` and an HTTPS public origin in production. `PORT` defaults to 8080. Database setup creates only this service's four tables; the database and role must be dedicated exclusively to this project. TLS must validate the database certificate; never disable verification.

```sh
npm start
```

Routes: `GET /health` (only a boolean; checks database connectivity), `POST /github` (raw bytes, GitHub HMAC SHA-256), `POST /mcp` (Bearer authentication on every request). Host and browser Origin are checked against `PUBLIC_ORIGIN`; configure the proxy to preserve the public Host. No CORS or public event endpoint is enabled. Deploy behind HTTPS with request-rate and connection limits. Application bodies are capped at 1 MiB. Request bodies and credentials are never logged.

## MCP tools

Use an MCP client supporting Streamable HTTP and an Authorization header. Stateless SDK transport uses JSON responses. The read token exposes only `get_label_event(event_id)`. The distinct admin token additionally exposes:

- `subscribe_label(repo,label,on_added,on_removed)` creates or reactivates a subscription.
- `update_label_subscription(repo,label,on_added,on_removed)` changes prompts and increments the version.
- `list_label_subscriptions()` includes inactive subscriptions.
- `unsubscribe_label(repo,label)` disables future event intake for that subscription.

There is no implicit subscription. After label verification, subscribe with the default text exported in `src/service.js`. Added: report the label addition, link PR/head, track the association. Removed: report removal and stop tracking. Neither handler authorizes cancellation, execution, comments, reviews, or GitHub writes. This service records the event association; an authorized consumer may report it. It does not execute the stored text. Prompt text is administrator configuration, separated from untrusted event fields, and every event pins its prompt version and text. Updates never rewrite past events. Unsubscribe does not erase history or cancel already queued notifications.

## Security and delivery semantics

The native crypto HMAC covers the exact raw request bytes, before JSON parsing. Signed body fields must identify a public allowlisted repository, a numeric PR/id, matching base repository, full head SHA, valid updated timestamp, allowed action and label. Unsigned GitHub headers are routing/dedup hints, never authorization. Changing headers cannot escape body restrictions or produce a second event from the same body.

Transactions persist event, delivery receipt, and outbox together. Delivery IDs and exact signed-content digests are independently unique. Changed content under an existing delivery ID is rejected. Add/remove/add with distinct signed payloads is retained, including repeated adds at the same head. An exactly byte-identical body is permanently deduplicated, even under new headers: GitHub does not sign a unique delivery ID, so a byte-identical legitimate event cannot be distinguished from replay. There is no unsafe time-based replay expiry. Event order is arrival order; GitHub can deliver out of order. Consumers must not treat this ledger as authoritative current GitHub label state.

Only minimal repository/PR/head/action/label identifiers, timestamps, pinned administrator prompts, hashes, and delivery metadata persist. PR bodies, titles, patches, sender details, and raw payloads do not. Events and replay receipts currently persist indefinitely; plan retention and a tombstone policy before high-volume use. Secrets are environment-only. Health and webhook replies reveal no stored event content.

The outbox leases at most ten rows per batch with `FOR UPDATE SKIP LOCKED`, retries at most five times with capped exponential delay, and survives restart. Delivery is at least once; consumers must dedup event IDs. Failed rows remain for operator inspection. No automatic destructive purge or unbounded retries. A continuously running worker is required for idle-time retries; an autoscaled platform needs a verified scheduler or separate worker before Slack is enabled.

## Optional wake adapter

Default `WAKE_MODE=noop` sends nothing and retains pending outbox entries. Tests inject an in-process adapter. The optional Slack adapter posts only `pr-label-events event_id=<UUID>` to the fixed Slack API endpoint and operator-configured channel. No MCP tool or event can set a URL, channel, credential, or adapter.

Before enabling `WAKE_MODE=slack`, an operator must verify the dedicated channel, least-privilege bot token with permission to post there, membership, and that bot-authored messages actually trigger the intended Dot automation. Obtain parent/user confirmation before posting or granting access. Set `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `SLACK_DESTINATION_VERIFIED=true` only after that verification. No Slack resource or message has been created by this project. The adapter is implemented, not live-verified.

## Wasmer deployment gates

Wasmer is the intended host; no deployment manifest claims unverified runtime compatibility. Wasmer CLI is not installed in the available local environment and no zero-cost isolated PostgreSQL resource has been verified. Do not reuse another application's database, secrets, or app. Do not provision paid resources or grant credentials implicitly.

1. Verify an existing free/zero-cost Wasmer account/runtime supporting this Node.js application and a new isolated PostgreSQL database/role, plus reliable worker scheduling if wake is enabled. Validate runtime compatibility in staging. Wasmer's [volume documentation](https://docs.wasmer.io/edge/learn/volumes/) explicitly warns that shared volumes are unsuitable for database single-writer semantics; do not substitute a SQLite file on a volume.
2. Configure fresh secrets through the platform secret manager and deploy only this new app. Verify live HTTPS `/health`, authenticated MCP roles, signed synthetic add/remove/duplicate tests, and persistence across restart against that new deployment. Synthetic tests must not send Slack messages.
3. Resolve the absent `hclmb` label with the user. Do not silently substitute `hillclimb`, `codex-hillclimb`, or any existing label.
4. Create a **new** repository webhook on `r33drichards/mcp-js`, with content type JSON, SSL verification enabled, the isolated `/github` URL and its secret, and only the GitHub `pull_request` event. GitHub event actions are filtered in the receiver to `labeled` and `unlabeled`. Do not update existing hooks. Do not add/remove a label merely to test.
5. Confirm delivery read-only and record the new hook ID and deployment URL. Verify Slack separately before enabling the optional adapter.

Until these gates pass, no GitHub hook should point to this service.
