/**
 * Where bundles are fetched from (docs/national-scaleout.md §3).
 *
 * The whole point of this change is that there is exactly ONE code path: unset
 * `VITE_DATA_BASE_URL` must behave byte-for-byte as every build through Phase 8
 * did, and setting it must move every asset — not just the manifest — to the
 * object host. So the tests check both ends against the same helper the loader
 * actually calls.
 */

import { describe, expect, it } from 'vitest';

import {
  dataBaseUrl,
  isNetworkFailure,
  loadFailureHint,
  siteDataUrl,
  siteIndexUrl,
} from '../src/state/loader';

describe('data base URL resolution (§3)', () => {
  it('falls back to repo-relative data/ when nothing is configured', () => {
    expect(dataBaseUrl('/', undefined)).toBe('/data/');
    expect(siteDataUrl('broborg', '/', undefined)).toBe('/data/broborg/');
  });

  it('honours a GitHub Pages project subpath', () => {
    expect(siteDataUrl('broborg', '/fornborgar/', undefined)).toBe('/fornborgar/data/broborg/');
    expect(siteDataUrl('broborg', './', undefined)).toBe('./data/broborg/');
  });

  it('adds the missing trailing slash to an app base', () => {
    expect(siteDataUrl('broborg', '/fornborgar', undefined)).toBe('/fornborgar/data/broborg/');
  });

  it('uses the configured object host when one is set', () => {
    const base = 'https://pub-example.r2.dev/v1';
    expect(dataBaseUrl('/', base)).toBe('https://pub-example.r2.dev/v1/');
    expect(siteDataUrl('l1943-7827', '/', base)).toBe('https://pub-example.r2.dev/v1/l1943-7827/');
  });

  it('tolerates a configured base that already ends in a slash', () => {
    expect(siteDataUrl('x', '/', 'https://h/v1/')).toBe('https://h/v1/x/');
  });

  it('ignores a blank or whitespace-only configuration', () => {
    // An unset variable in a .env file often arrives as an empty string; that
    // must mean "not configured", not "fetch from the empty host".
    expect(dataBaseUrl('/', '')).toBe('/data/');
    expect(dataBaseUrl('/', '   ')).toBe('/data/');
  });

  it('does not consult the app base once a host is configured', () => {
    // Otherwise a Pages subpath would be prepended to an absolute URL.
    expect(siteDataUrl('x', '/fornborgar/', 'https://h/v1')).toBe('https://h/v1/x/');
  });

  it('puts the index at the base, not inside a site directory', () => {
    expect(siteIndexUrl('/', 'https://h/v1')).toBe('https://h/v1/index.json');
    expect(siteIndexUrl('/', undefined)).toBe('/data/index.json');
  });
});

describe('what the fatal-error panel offers as a remedy', () => {
  const HOST = 'https://pub-example.r2.dev/v1';
  const APP = 'https://fornborgar.drnz.se';

  it('recognises a fetch rejection as a network-level failure', () => {
    // Chrome, Safari and Firefox each word it differently; none carries a status.
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkFailure(new Error('Load failed'))).toBe(true);
    expect(isNetworkFailure(new Error('NetworkError when attempting to fetch resource.'))).toBe(
      true,
    );
  });

  it('does not mistake an HTTP failure for a network one', () => {
    expect(isNetworkFailure(new Error('Could not load …/manifest.json (404 Not Found).'))).toBe(
      false,
    );
  });

  it('names the bundle host and this origin when the request never got a response', () => {
    // The domain-move failure: the allowlist still names the old origin, so the
    // browser refuses the response and the app has no status to report.
    const hint = loadFailureHint(new TypeError('Failed to fetch'), HOST, APP);
    expect(hint).toContain(HOST);
    expect(hint).toContain(APP);
    expect(hint).toContain('CORS');
    expect(hint).not.toContain('app/public/data');
  });

  it('does not blame CORS when this build reads its own data/ directory', () => {
    const hint = loadFailureHint(new TypeError('Failed to fetch'), undefined, APP);
    expect(hint).not.toContain('CORS');
  });

  it('keeps the repo-relative remedy for an HTTP failure with no host configured', () => {
    const hint = loadFailureHint(new Error('404 Not Found'), undefined, APP);
    expect(hint).toContain('app/public/data/<siteId>/');
    expect(hint).toContain('?site=testsite');
  });

  it('points an object-host build at the host, not at a directory it never reads', () => {
    const hint = loadFailureHint(new Error('404 Not Found'), HOST, APP);
    expect(hint).toContain(HOST);
    expect(hint).not.toContain('app/public/data');
  });
});
