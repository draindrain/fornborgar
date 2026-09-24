/**
 * Telling a page failure from an environment failure (§9).
 *
 * `no-console-errors` was red on every run of the reconstruction checker, on
 * `main`, because the sandbox's egress proxy substitutes its own certificate
 * and headless Chromium rejects the drnz.se consent notice. The fix classifies
 * that failure instead of suppressing it — which is only defensible if the
 * classifier is narrow. So these tests are mostly about what it must **not**
 * excuse.
 *
 * The one that matters: `VITE_DATA_BASE_URL` can move the app's data to an
 * object host, so a rule like "cross-origin failures don't count" would excuse
 * the terrain failing to load at all. It must not.
 */

import { describe, expect, it } from 'vitest';

import {
  NON_ESSENTIAL_RESOURCES,
  isTransportFailure,
  triageConsoleErrors,
} from '../scripts/console-triage.mjs';

const ANALYTICS = 'https://drnz.se/analytics.js';

/** The exact pair of events the sandbox produces, measured from a live run. */
const certConsole = {
  text: 'Failed to load resource: net::ERR_CERT_AUTHORITY_INVALID',
  url: ANALYTICS,
};
const certRequest = { url: ANALYTICS, errorText: 'net::ERR_CERT_AUTHORITY_INVALID' };

describe('what may be excused', () => {
  it('excuses the analytics notice when the wire kills it, and keeps it visible', () => {
    const t = triageConsoleErrors({
      consoleErrors: [certConsole],
      requestFailures: [certRequest],
    });
    expect(t.pageErrors).toEqual([]);
    // Excused is not hidden: it is still reported.
    expect(t.environmental).toEqual([{ text: certConsole.text, url: ANALYTICS }]);
    expect(t.unexpectedRequestFailures).toEqual([]);
  });

  it('excuses the other interception signature seen in an earlier container', () => {
    const t = triageConsoleErrors({
      consoleErrors: [{ text: 'Failed to load resource: net::ERR_CONNECTION_RESET', url: ANALYTICS }],
      requestFailures: [{ url: ANALYTICS, errorText: 'net::ERR_CONNECTION_RESET' }],
    });
    expect(t.pageErrors).toEqual([]);
    expect(t.environmental).toHaveLength(1);
  });

  it('holds the allowlist to exactly one URL', () => {
    expect([...NON_ESSENTIAL_RESOURCES]).toEqual([ANALYTICS]);
  });
});

describe('what may never be excused', () => {
  it('fails a console.error written by app code', () => {
    const entry = { text: 'reconstruction: archetype H gate evaluated twice', url: 'http://localhost:4173/assets/index.js' };
    const t = triageConsoleErrors({ consoleErrors: [entry], requestFailures: [certRequest] });
    expect(t.pageErrors).toEqual([entry]);
    expect(t.environmental).toEqual([]);
  });

  it('fails an uncaught exception even while the analytics load is being excused', () => {
    const boom = { text: 'Uncaught TypeError: cannot read properties of undefined', url: 'http://localhost:4173/' };
    const t = triageConsoleErrors({
      consoleErrors: [certConsole, boom],
      requestFailures: [certRequest],
    });
    expect(t.pageErrors).toEqual([boom]);
    expect(t.environmental).toHaveLength(1);
  });

  it('fails an HTTP error from the excused URL — the apex has stopped serving it', () => {
    const notFound = {
      text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
      url: ANALYTICS,
    };
    const t = triageConsoleErrors({ consoleErrors: [notFound], requestFailures: [] });
    expect(t.pageErrors).toEqual([notFound]);
  });

  it('fails a transport error from a URL that is not on the list', () => {
    const other = {
      text: 'Failed to load resource: net::ERR_CERT_AUTHORITY_INVALID',
      url: 'https://cdn.example.com/tracker.js',
    };
    const t = triageConsoleErrors({
      consoleErrors: [other],
      requestFailures: [{ url: other.url, errorText: 'net::ERR_CERT_AUTHORITY_INVALID' }],
    });
    expect(t.pageErrors).toEqual([other]);
    expect(t.unexpectedRequestFailures).toHaveLength(1);
  });

  it('does not excuse a message that merely quotes an error code with no failed request', () => {
    // A script that loaded fine and then logged this is reporting a real problem.
    const quoted = { text: 'analytics: giving up after net::ERR_CONNECTION_RESET', url: ANALYTICS };
    const t = triageConsoleErrors({ consoleErrors: [quoted], requestFailures: [] });
    expect(t.pageErrors).toEqual([quoted]);
  });

  it('flags a failed data fetch from an object host — the VITE_DATA_BASE_URL case', () => {
    // The whole reason the rule is an allowlist and not "cross-origin doesn't
    // count": this is the terrain failing to load, and it must be loud.
    const dem = 'https://data.example.r2.dev/data/broborg/dem.tif';
    const t = triageConsoleErrors({
      consoleErrors: [certConsole],
      requestFailures: [certRequest, { url: dem, errorText: 'net::ERR_CONNECTION_RESET' }],
    });
    expect(t.unexpectedRequestFailures).toEqual([
      { url: dem, errorText: 'net::ERR_CONNECTION_RESET' },
    ]);
  });
});

describe('aborted requests', () => {
  it('does not count a cancelled request as a failure', () => {
    expect(isTransportFailure('net::ERR_ABORTED')).toBe(false);
    const t = triageConsoleErrors({
      consoleErrors: [],
      requestFailures: [{ url: 'http://localhost:4173/data/broborg/dem.tif', errorText: 'net::ERR_ABORTED' }],
    });
    expect(t.unexpectedRequestFailures).toEqual([]);
  });
});
