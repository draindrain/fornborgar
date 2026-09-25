/**
 * Telling a *page* failure from an *environment* failure, for the verify scripts.
 *
 * ## Why this exists
 *
 * `no-console-errors` failed on every run of `verify-reconstruction.mjs`, on
 * `main`, for a reason that had nothing to do with the app. `index.html` loads
 * the drnz.se consent notice:
 *
 *     <script src="https://drnz.se/analytics.js" defer></script>
 *
 * In the sandbox these checks run in, outbound HTTPS goes through an egress
 * proxy that substitutes its own certificate. Headless Chromium is not given
 * that proxy's CA, so it rejects the response and logs
 * `net::ERR_CERT_AUTHORITY_INVALID`. An earlier container failed the same load
 * as `net::ERR_CONNECTION_RESET`. The page is fine; the wire is not.
 *
 * A check that is red on every run for a reason no commit can fix teaches
 * nobody anything, and trains people to skip past a red suite — which is the
 * §0 lesson of this project one level up. But suppressing a console error to
 * get green is the move this project forbids outright. So this module does
 * neither. It **classifies and reports**: an excused failure is still printed,
 * still counted, and still lands in the JSON report. Nothing is hidden; one
 * thing is filed under the right heading.
 *
 * ## What may be excused, and what may never be
 *
 * A console error is environmental only when **all** of these hold:
 *
 *   1. the failing URL is on `NON_ESSENTIAL_RESOURCES` — an explicit, tiny
 *      list of resources this app is documented not to depend on;
 *   2. the message is a *transport* failure (`net::ERR_…`) — the request never
 *      got an answer from the server;
 *   3. a matching `requestfailed` event confirms it at the network layer.
 *
 * Everything else is a page error. In particular these still fail, by design:
 *
 *   • any JS exception, from anywhere, including from an excused script that
 *     did manage to load;
 *   • any `console.error` written by app code;
 *   • an **HTTP** error from an excused URL (`404`, `500`) — that is not a
 *     `net::` failure, so if the apex ever stops serving `analytics.js` the
 *     check goes red and says so;
 *   • a transport failure from any URL that is *not* on the list.
 *
 * That last point is the one that matters most, and it is why this is not an
 * ignore-list. `VITE_DATA_BASE_URL` can move the app's **data** to an object
 * host (docs/national-scaleout.md §3), so a rule of the shape "cross-origin
 * failures don't count" would quietly excuse a real, total failure to load the
 * terrain. `unexpectedRequestFailures` exists precisely to catch that, and it
 * is stricter than what `main` did: it fails a request that died at the
 * transport layer **whether or not** it also reached the console.
 *
 * `net::ERR_ABORTED` is not counted as a failure. An abort is a request the
 * page or the harness cancelled on purpose — a navigation superseding an
 * in-flight fetch, or a `route()` handler — not a resource that could not be
 * had.
 */

/**
 * Resources the app is documented not to depend on.
 *
 * Exact URLs, not origins or prefixes: the point is to excuse one known asset,
 * not to open a host. `analytics.js` qualifies on its own terms — it is the
 * drnz.se consent notice, served from the project's own apex, and its first
 * act is to leave unless it is running on drnz.se:
 *
 *     var host = location.hostname;
 *     if (host !== "drnz.se" && !/\.drnz\.se$/.test(host)) return;
 *
 * So on the `localhost` preview these checks run against, the script is a
 * deliberate no-op by its own design. There is no behaviour for its absence to
 * change, and the app never reads anything it defines.
 */
export const NON_ESSENTIAL_RESOURCES = Object.freeze(['https://drnz.se/analytics.js']);

/** A request that died before the server answered, e.g. `net::ERR_CONNECTION_RESET`. */
const TRANSPORT_FAILURE = /net::ERR_[A-Z0-9_]+/;

/** Cancelled on purpose — by a navigation, or by a `route()` handler. Not a failure. */
const ABORTED = 'net::ERR_ABORTED';

/**
 * @param {string} text
 * @returns {boolean} whether `text` names a transport-layer failure.
 */
export function isTransportFailure(text) {
  return TRANSPORT_FAILURE.test(String(text ?? '')) && !String(text).includes(ABORTED);
}

/**
 * Sort a run's console errors and failed requests into what the page did wrong
 * and what the environment did to it.
 *
 * @param {object} input
 * @param {{ text: string, url?: string }[]} input.consoleErrors
 *   Console messages of type `error`, each with `msg.location().url`.
 * @param {{ url: string, errorText: string }[]} [input.requestFailures]
 *   `requestfailed` events seen during the run.
 * @param {readonly string[]} [input.nonEssential]
 *   Override the allowlist; defaults to `NON_ESSENTIAL_RESOURCES`.
 * @returns {{
 *   pageErrors: { text: string, url?: string }[],
 *   environmental: { text: string, url: string }[],
 *   unexpectedRequestFailures: { url: string, errorText: string }[],
 * }}
 */
export function triageConsoleErrors({ consoleErrors, requestFailures = [], nonEssential = NON_ESSENTIAL_RESOURCES }) {
  const allowed = new Set(nonEssential);

  // A URL is only excusable if the network layer also says it never landed.
  // Matching on the console text alone would excuse a script that loaded and
  // then *logged* something that happened to quote an error code.
  const failedAtTransport = new Set(
    requestFailures.filter((r) => isTransportFailure(r.errorText)).map((r) => r.url),
  );

  const pageErrors = [];
  const environmental = [];
  for (const entry of consoleErrors) {
    const url = entry.url ?? '';
    const excusable =
      allowed.has(url) && isTransportFailure(entry.text) && failedAtTransport.has(url);
    if (excusable) environmental.push({ text: entry.text, url });
    else pageErrors.push(entry);
  }

  const unexpectedRequestFailures = requestFailures.filter(
    (r) => isTransportFailure(r.errorText) && !allowed.has(r.url),
  );

  return { pageErrors, environmental, unexpectedRequestFailures };
}

/** One-line summaries, for printing a run's excused failures so they stay visible. */
export function describeEnvironmental(environmental) {
  return environmental.map((e) => `${e.url} — ${e.text}`);
}
