# paj-rc reference

[Back to pairing](../README.md#pair).

## Browser controls

Select a session and type `/` for loaded extension commands, skills, and prompt templates. The list
loads in bounded pages rather than stopping after 128 entries. Insert a suggestion, add arguments,
then send. Steering and follow-ups require an explicit choice; uncertain writes are never retried.

Use **All / Working / Idle** to filter the list without changing the selected conversation. Working
and Idle use the session's explicit busy state; unknown or disconnected status appears only in All.
Captain sessions remain first within each filtered list.

Extension commands execute immediately, not as steering or follow-ups, and accept text arguments
only.
“Submitted” acknowledges dispatch, not completion or success. Dialogs, notifications, and command
errors
remain in Pi's terminal; the browser shows when terminal interaction is required. Arbitrary custom
terminal screens and built-in interactive commands such as `/model` are not browser interfaces.
Command names must contain no whitespace or control characters and fit the 16,000-character input
limit. Unsupported catalog entries do not hide other commands; invoking one is rejected, not sent to
the model as ordinary text.

A **Captain** badge marks sessions with the live [Captain](https://github.com/jlodenius/paj-captain)
capability. It follows the existing registry
poll (normally every five seconds), not names or historic mode entries. Missing, malformed, or stale
capabilities show no badge; badges are hidden while reconnecting or awaiting a fresh session list.
This is an advisory capability indicator, not authorization or an instantaneous runtime-mode
guarantee.

## Privacy

Only the public app shell is cached, never credentials, conversations, photos, or writes. Photos
stay
in browser memory until submitted; Pi and its provider then handle them as normal input. Closing the
browser does not stop work. Context counts are estimates, not billing totals.

## Develop

```sh
npm ci --cache .cache/npm
npm run typecheck
npm test
nix build
```

Node sources live in `src/`, browser sources in `browser/`, and the Pi entry in `extensions/`.
Typechecking covers all three using the pinned development SDK; it is not shipped at runtime.
The build emits executable browser JavaScript and copies static assets to `dist/public/`.
Optional integration tests use `PAJ_RC_PI_BIN`, `PAJ_RC_PI_MODULE`, or `PAJ_RC_BROWSER_BIN`; no
sibling checkout is required.
