# Runtime and protocol contract

Protocol version is 1. Runtime modules use Node built-ins and ESM JavaScript. The Pi entry point
uses TypeScript, loaded by Pi. Tests must not install services or change user networking.

## Configuration interface

`src/config.js` exports synchronous `getPaths(env = process.env)`,
`loadConfig(paths = getPaths())`, and `saveConfig(config, paths = getPaths())`.
`getPaths` returns `configDir`, `configFile`, `runtimeDir`, `socketPath`, `serviceFile`.
`loadConfig` returns null if setup has not occurred, otherwise a validated object:

```json
{
  "version": 1,
  "port": 43187,
  "idleTimeoutMs": 30000,
  "allowedOrigins": ["http://127.0.0.1:43187", "http://localhost:43187"],
  "pairingKey": "random-32-byte-base64url-secret",
  "pajCommand": "/absolute/path/to/paj"
}
```

Extra origins must be exact HTTP loopback or HTTPS origins, not wildcard/path/query/credentials.
Service setup persists the resolved Paj executable; runtime should not depend on interactive PATH.
`src/service.js` exports asynchronous `ensureService()` for extension autostart; no implicit setup.
Setup/CLI own lifecycle commands. CLI `serve` loads config and calls
`startDaemon(config, { paths })` exported from `src/daemon.js`.
`startDaemon` resolves to `{ close(), address, socketPath }`; it does not exit the host process.
It accepts an optional `onIdle` callback, invoked after the service closes itself successfully.

## Local IPC

Newline-delimited JSON on a mode-0600 Unix socket in a mode-0700 runtime directory.
Each frame is bounded to 2 MiB. Every connection belongs to one eligible Pi session.

Extension sends:

```json
{"type":"register","protocol":1,"generation":"uuid","identity":{"id":"paj-id","piSessionId":"pi-id","pid":123,"name":"agent","projectRoot":"/project","branch":"main","role":"primary","parentPiSessionId":null},"state":{"busy":false,"runId":null,"editorBusy":false,"terminalRequired":false}}
{"type":"heartbeat"}
{"type":"event","seq":1,"event":{"type":"state","state":{"busy":true,"runId":"uuid","editorBusy":false,"terminalRequired":false}}}
{"type":"event","seq":2,"event":{"type":"delta","messageId":"id","text":"Hello"}}
{"type":"event","seq":3,"event":{"type":"message","message":{"id":"id","role":"assistant","text":"Hello"}}}
{"type":"event","seq":4,"event":{"type":"reset"}}
{"type":"response","id":"request-id","ok":true,"result":{}}
{"type":"response","id":"request-id","ok":false,"error":{"code":"busy","message":"Session is busy"}}
```

Daemon validates registration against `paj --json session list --all` before acknowledging:

```json
{"type":"registered","protocol":1}
{"type":"request","id":"request-id","method":"snapshot","params":{"generation":"uuid","before":null}}
{"type":"request","id":"request-id","method":"prompt","params":{"generation":"uuid","requestId":"uuid","text":"instruction","deliverAs":"reject"}}
{"type":"request","id":"request-id","method":"abort","params":{"generation":"uuid","runId":"uuid"}}
```

Prompt `deliverAs` is `reject`, `steer`, or `followUp`. Adapter enforces editor exclusion and
explicit busy behavior; return submitted, not guaranteed acceptance. Deduplicate prompt request IDs
at target adapter. Browser disconnect must not abort work. Heartbeat every 5s; daemon closes an
endpoint after 20s silence. No child endpoint is accepted; registry disappearance removes access.
RPC timeout is 10s; no automatic retry of writes. Snapshot uses bounded latest 100 messages, with
`before` optional pagination cursor and `hasMore`. A snapshot result has this shape:

```json
{"sessionId":"pi-id","generation":"uuid","seq":4,"state":{"busy":false,"runId":null,"editorBusy":false,"terminalRequired":false},"messages":[{"id":"entry-id","role":"user","text":"Hi"}],"hasMore":false,"before":null}
```

Snapshot messages may include one current partial assistant message. Tool messages use role `tool`.
Never include system prompts, hidden custom messages, thinking, or unbounded payloads.

## Browser authentication

Pairing uses the owner-private configured key. Browser cookies contain canonical random opaque
256-bit tokens, not the pairing key. Their hashes and CSRF values are stored atomically beside
configuration in mode-0600 `browser-sessions.json`, bound to the current pairing-key fingerprint.
Sessions expire after seven days. Logout deletes the durable record before reporting success;
key rotation invalidates prior records. Cookies are HttpOnly and SameSite=Strict, with Secure set
for configured HTTPS origins. A direct local process owned by the same user remains trusted.

## Browser HTTP

All JSON API responses use `{ ... }` on success or `{ error: { code, message } }` on failure.
No CORS. Exact Host/Origin validation, login rate limit, body limits, HttpOnly session cookie,
and CSRF token for authenticated writes. UI assets only same-origin, no remote dependencies.

- `GET /api/auth`: `{ authenticated, csrfToken? }`.
- `POST /api/login` with `{ key }`: sets cookie and returns `{ csrfToken }`.
- `POST /api/logout` with `X-CSRF-Token`: clears cookie.
- `GET /api/sessions`: `{ sessions: [{ id, piSessionId, generation, name, projectRoot, branch,
  state }] }`. `id` is Paj registration ID and is the route key.
- `GET /api/sessions/:id/snapshot?before=...`: snapshot result above.
- `POST /api/sessions/:id/prompt`: `{ generation, requestId, text, deliverAs }`.
- `POST /api/sessions/:id/abort`: `{ generation, runId }`.
- `GET /api/events`: authenticated SSE. Named events `sessions` (refetch list), `session`
  (`{ id, generation, seq, event }`), `resync` (refetch list and selected snapshot).

SSE is notification-only; disconnect never cancels RPC or Pi. On reconnect resnapshot. Browser
subscribes before fetching snapshot and buffers events until snapshot is applied. Server closes
slow streams rather than blocking Pi. Browser treats response uncertainty honestly and does not
retry POST automatically. Render all transcript content as text, not raw HTML.
