# test-pages/

Static HTML fixtures for manually or automatically exercising TesterBrowser's
own features (cookies/localStorage, console/error capture, network recording,
downloads, popups/iframes, permission prompts, and performance edge cases).

**These are dev/CI fixtures only.** They are never packaged into the app —
`package.json`'s `build.files` allowlist only includes `dist/**/*`,
`renderer/**/*`, and `package.json`, so this directory is excluded
automatically with no extra build config.

## Using them

- **Manually**: open `test-pages/index.html` directly in TesterBrowser
  (`file://` works for anything that doesn't need the dynamic server routes
  below), or serve the directory with any static file server.
- **In e2e tests**: import `startFixtureServer` from `e2e/fixtures/server.ts`.
  It serves this directory as-is plus a few dynamic routes a static server
  can't fake:
  - `GET /network/status/:code` — respond with an arbitrary status code
  - `GET /network/slow?ms=N` — delay N ms before responding
  - `GET /network/redirect?hops=N` — chain of N redirects
  - `GET /downloads/file?name=&size=&type=` — generated download of a given size
  - `GET /storage/set-cookie?name=&value=` — sets an HttpOnly cookie via response header
  - `GET /perf/echo` — near-instant response, for burst/concurrency tests

  The server is plain `.ts` with no build step, so it costs nothing outside
  the Playwright run itself — see `e2e/fixtures.spec.ts` for example usage.
  It runs inside the existing `e2e` CI job, which already runs in parallel
  with `build-windows`, so it adds no CI time.

## Layout

```
test-pages/
  index.html              directory of links, for manual poking
  shared.css               shared styling for all fixture pages
  storage/                 cookies, localStorage/sessionStorage
  console/                 log levels, uncaught errors
  network/                 status codes, slow/hanging responses, redirects
  downloads/               static + generated downloads
  windows/                 window.open, iframe, link targets
  permissions/             geolocation, notifications, media, clipboard
  performance/             heavy DOM, console flood, network flood,
                           long-task/jank, memory growth
```

## Adding a new fixture

Drop a new `.html` file under the relevant category (or a new one), link it
from `index.html`, and — if it needs server-side behavior a static file
can't provide — add a route to `e2e/fixtures/server.ts`. Keep pages
self-contained (inline `<script>`, shared `shared.css` for styling) so they
don't need a build step.
