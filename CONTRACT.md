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
explicit busy behavior; return submitted, not guaranteed acceptance. Explicit steering/follow-up
messages may share one reservation while the same identified run is active. Idle or uncertain
preflight submissions remain exclusive until a real run starts; reservation reuse must revalidate
ownership. Deduplicate prompt request IDs at the target adapter. Browser disconnect must not abort
work. Heartbeat every 5s; daemon closes an endpoint after 20s silence. Child endpoints are rejected;
registry disappearance removes access.
RPC timeout is 10s; no automatic retry of writes. Snapshot uses bounded latest 100 messages, with
`before` optional pagination cursor and `hasMore`. A snapshot result has this shape:

```json
{"sessionId":"pi-id","generation":"uuid","seq":4,"state":{"busy":false,"runId":null,"editorBusy":false,"terminalRequired":false},"messages":[{"id":"entry-id","role":"user","text":"Hi"}],"hasMore":false,"before":null}
```

State may additionally include `model: { id, provider, name } | null` and
`context: { tokens, contextWindow } | null`. Model strings are bounded to 200 characters;
context values are safe integers with a positive window and nonnegative usage. Unknown usage is
`tokens: null`, not zero. Counts come from Pi's public context-usage API and are estimates, not
billing totals. Older adapters may omit both fields. Registration, live state events, snapshots,
and the session list use the same validated projection, excluding arbitrary model configuration.

Snapshots may include `commands: [{ name, description, source }]`, with source `skill` or `prompt`.
Only commands loaded in that session are exposed, using Pi's native `getCommands()` ordering;
extension commands suppress same-named templates or skills. Discovery is bounded to 128 entries,
names to 100 characters, and descriptions to 240 characters. Provenance paths and resource contents
are not included. Older adapters may omit the catalog. Browser completion only inserts text; it
never sends or expands locally. Native expansion is enabled only for a currently approved skill or
prompt command, not arbitrary slash commands, because expansion also enables extension dispatch.
Trusted native input hooks still apply. Commands use the ordinary generation-bound submission,
deduplication, image, and delivery-mode rules; resource expansion does not establish execution.

Browser steering receipts are private, bounded, in-memory UI feedback, not additional Pi messages.
They distinguish submitting, submitted, rejected, and uncertain delivery. A matching later live
user message may replace a visual receipt, but matching content does not establish execution or
resolve uncertain delivery. Receipts are never retried automatically or stored by the service
worker; logout clears them.

Snapshot messages may include one current partial assistant message. Tool messages use role `tool`.
Visible Paj custom messages retain `role: "assistant"` with optional `customType: "paj-messages"`
for purple-panel Markdown rendering. The marker is included in snapshots and live final messages;
custom message details and arbitrary custom types are not transmitted. All HTML stays literal,
transcript image payloads are omitted, and explicit links allow only HTTP(S). User image messages
carry a bounded `imageCount` and image-only placeholders. Other messages remain plain text.
Never include system prompts, hidden custom messages, thinking, or unbounded payloads.

## Photo input

Prompt requests may include `images: [{ mimeType, data }]`, with canonical base64, no data URLs.
Limits are three images, 512 KiB per image, 1 MiB combined decoded bytes, 2048 pixels per side, and
4 MiPixels. JPEG, PNG, and nonanimated WebP headers/structure are checked at both HTTP and adapter
boundaries. Prompt HTTP bodies are capped at 1536 KiB; other bodies remain capped at 128 KiB, and
IPC frames remain capped at 2 MiB. Image-only messages may have empty text.

The session-list response advertises `imageUploads: true`; the browser requires this marker so an
older daemon cannot silently discard photos. Browser photos also use the dedicated `image-prompt`
HTTP route so a service downgrade fails rather than treating them as text-only input. The optional
state boolean `supportsImages` advertises adapter support and current model capability. HTTP rejects
photos when this capability is absent. Compatible adapters resolve duplicates before checking their
current model, so a replay remains idempotent after model changes. New unsupported image requests
are rejected before SDK dispatch. Native text/image content arrays carry accepted submissions;
deduplication hashes image content rather than retaining image bytes.

The browser prepares JPEGs with a maximum 1600-pixel long side and a per-photo budget of one third
of the total limit. Canvas encoding strips original metadata. HEIC/HEIF require native browser
decoding support. Draft previews use short-lived blob URLs, revoked on removal, logout, session
change, or successful submission. Drafts stay in memory, never cached or queued offline.
No upload files are written by paj-rc; Pi and its model provider handle images as normal user input.
Transcript snapshots/events contain only image counts/placeholders, never image bytes or URLs.

## Browser authentication

Pairing uses the owner-private configured key. Browser cookies contain canonical random opaque
256-bit tokens, not the pairing key. Their hashes and CSRF values are stored atomically beside
configuration in mode-0600 `browser-sessions.json`, bound to the current pairing-key fingerprint.
Remembered credentials have no server expiry (`expires: null`, store version 2). Active version-1
credentials migrate without changing their tokens; expired records do not migrate. The browser
cookie has a 400-day lifetime, renewed on authenticated requests. Logout durably removes the
record before reporting success; key rotation invalidates prior records. Cookies are HttpOnly and
SameSite=Strict, with Secure set for HTTPS. Same-user local processes remain trusted.

## Installable app shell

A same-origin manifest, service worker, and PNG icons enable standalone home-screen installation.
Only explicit public shell paths can be cached, using credential-free requests. APIs, history,
authentication, SSE, and writes bypass the worker; offline writes are never queued or retried.
The worker can serve cached public assets on network or temporary server failure, not permission
failure. Private responses remain `no-store`. New composer sessions select steering by default.

## Browser HTTP

All JSON API responses use `{ ... }` on success or `{ error: { code, message } }` on failure.
No CORS. Exact Host/Origin validation, login rate limit, body limits, HttpOnly session cookie,
and CSRF token for authenticated writes. UI assets only same-origin, no remote dependencies.

- `GET /api/auth`: `{ authenticated, csrfToken? }`.
- `POST /api/login` with `{ key }`: sets cookie and returns `{ csrfToken }`.
- `POST /api/logout` with `X-CSRF-Token`: clears cookie.
- `GET /api/sessions`: `{ sessions: [{ id, piSessionId, generation, name, projectRoot, branch,
  state }], imageUploads: true }`. `id` is Paj registration ID and is the route key.
- `GET /api/sessions/:id/snapshot?before=...`: snapshot result above.
- `POST /api/sessions/:id/prompt`: `{ generation, requestId, text, deliverAs }`.
- `POST /api/sessions/:id/image-prompt`: `{ generation, requestId, text, deliverAs, images }`.
- `POST /api/sessions/:id/abort`: `{ generation, runId }`.
- `GET /api/events`: authenticated SSE. Named events `sessions` (refetch list), `session`
  (`{ id, generation, seq, event }`), `resync` (refetch list and selected snapshot).

SSE is notification-only; disconnect never cancels RPC or Pi. On reconnect resnapshot. Browser
subscribes before fetching snapshot and buffers events until snapshot is applied. Server closes
slow streams rather than blocking Pi. Browser treats response uncertainty honestly and does not
retry POST automatically. Render all transcript content as text, not raw HTML.
