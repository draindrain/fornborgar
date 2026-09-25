# Running the headless checks

*How to run the four verify scripts from a clean checkout, and the one rule
about what they are allowed to forgive.*

The unit tests (`npm test`) pin geometry in isolation. The four scripts in
`app/scripts/verify-*.mjs` assert the things that only exist once the real
bundle is loaded into a real renderer: that the terrain builds, that monuments
stand on exaggerated ground at true height, that the HUD's buttons do what the
state setters do, that the far field stays lazy, that the sky is wired in.

---

## 1. Running them

```bash
cd app
npm ci
npm run build
npx vite preview --port 4173 &

npm run verify:reconstruction -- --base http://localhost:4173 --site broborg
npm run verify:sites          -- --base http://localhost:4173 --site broborg
npm run verify:night-sky      -- --base http://localhost:4173 --site broborg
npm run verify:far-field      -- --base http://localhost:4173 --site broborg
```

Each exits `0` only if everything it checks passed, and prints its report as
JSON on stdout with the `PASS`/`FAIL` lines on stderr.

**Expect this to be slow.** These runs fall back to software WebGL, where one
frame of the 4 M-vertex terrain is measured in *seconds* — a full
`verify-reconstruction` run is around an hour. That is also why its frame-time
check is a *ratio* between two modes in the same page rather than an absolute
number, and why its click timeout is enormous: Playwright will not click until
an element's bounding box is stable across two consecutive frames, and two
frames here can outrun a timeout that would be absurd in a real browser.

### Why playwright is pinned exactly

`app/package.json` pins `playwright` to an exact version, with no caret. That
is deliberate, and the caret is the bug it prevents.

The playwright **npm package** and the **browser build** on disk have to agree:
each release pins a chromium revision in its own `browsers.json`, and launching
with a revision that is not installed dies on `Executable doesn't exist`. A
caret range lets the next `npm install` race ahead of whatever browsers the
image has. Pin it, and check the pin against the machine rather than against
memory:

```bash
ls "$PLAYWRIGHT_BROWSERS_PATH"          # e.g. chromium-1194
node -e 'console.log(require("playwright-core/browsers.json").browsers
  .filter(b => b.name === "chromium").map(b => b.revision))'
```

If those two disagree, change the pin — not the browsers.

---

## 2. A page failure and an environment failure are not the same finding

`app/index.html` loads the drnz.se consent notice:

```html
<script src="https://drnz.se/analytics.js" defer></script>
```

In a sandbox whose outbound HTTPS goes through a proxy that substitutes its own
certificate, headless Chromium — which is not given that proxy's CA — rejects
the response and logs `net::ERR_CERT_AUTHORITY_INVALID`. An earlier container
failed the same load as `net::ERR_CONNECTION_RESET`. So for a while every run
of the suite was red, on `main`, for a reason no commit in this repo could fix.

That is its own harm. A check that fails identically on every run teaches
nobody anything and trains people to skip past a red suite — which is exactly
the §0 lesson of this project (a check that quietly stopped covering the HUD
button) repeated one level up.

But suppressing a console error to get green is the move this project forbids.
If the page genuinely fails to load a script in some real visitor's browser,
the check is right and the page is wrong.

So `app/scripts/console-triage.mjs` does neither. It **classifies, and it
reports.** An excused failure is still printed as a `NOTE environment —` line
and still appears in the JSON report under `environment.excusedResourceFailures`.
Nothing is hidden; one thing is filed under the right heading.

### What may be excused

All three of these must hold:

1. the failing URL is on `NON_ESSENTIAL_RESOURCES` — an explicit list which
   today holds exactly one entry;
2. the message is a **transport** failure (`net::ERR_…`) — the request never
   got an answer from a server;
3. a matching `requestfailed` event confirms it at the network layer.

`analytics.js` earns its place on that list on its own terms. It is
*first-party* — drnz.se is this project's own apex domain, and the script is
the consent notice that asks before anything reaches Google, not an ungated
third-party tracker. And its first act is to leave unless it is running on the
apex:

```js
var host = location.hostname;
if (host !== "drnz.se" && !/\.drnz\.se$/.test(host)) return;
```

On the `localhost` preview these checks run against, the script is therefore a
deliberate no-op **by its own design**. There is no behaviour for its absence to
change, and no app code reads anything it defines.

### What may never be excused

- any JS exception, from anywhere — including from an excused script that did
  manage to load;
- any `console.error` written by app code;
- an **HTTP** error from the excused URL (`404`, `500`). Those are not `net::`
  failures, so if the apex ever stops serving `analytics.js` the check goes red
  and says why;
- a transport failure from any URL that is *not* on the list.

### Why this is not an ignore-list

The distinction is load-bearing, not rhetorical. `VITE_DATA_BASE_URL` can move
the app's **data** to an object host (`docs/national-scaleout.md` §3), so a rule
shaped *"cross-origin failures don't count"* would quietly excuse the terrain
failing to load entirely — the single worst failure the app has, passing as
green. An origin is not a safe discriminator here.

Hence the companion check in `verify-reconstruction.mjs`,
**`no-unexpected-request-failures`**, which is *stricter* than what `main` did:
it fails a request that died at the transport layer whether or not it also
reached the console. `main` could only ever notice a failed load that happened
to log one.

`net::ERR_ABORTED` is not counted. An abort is a request cancelled on purpose —
by a navigation superseding an in-flight fetch, or by a `route()` handler — not
a resource that could not be had.

### Keeping it honest

`app/tests/consoleTriage.test.ts` is the proof, and it is mostly a list of
things the classifier must **refuse** to excuse: an app `console.error`, an
uncaught exception raised while the analytics load is being excused, a 404 from
the excused URL itself, a transport failure from any other host, and a failed
data fetch from an object host.

To confirm end to end rather than in unit isolation, put a `console.error` into
`app/src/main.ts`, rebuild, and run `verify:reconstruction`: `no-console-errors`
fails and names it. Take it out again.
