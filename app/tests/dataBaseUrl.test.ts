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

import { dataBaseUrl, siteDataUrl, siteIndexUrl } from '../src/state/loader';

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
