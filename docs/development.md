# Development

[Back to pairing](../README.md#pair).

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
