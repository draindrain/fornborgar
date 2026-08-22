/// <reference types="vite/client" />

/**
 * Build-time configuration this app reads. Declared explicitly so a typo in a
 * variable name is a type error rather than a silently-undefined string.
 */
interface ImportMetaEnv {
  /**
   * Where site bundles are fetched from (docs/national-scaleout.md §3).
   *
   * Unset — the default, and what every build through Phase 8 did — means
   * repo-relative `data/` under `BASE_URL`. Set, it is the object host's
   * versioned prefix, e.g. `https://<host>/v1`, and bundles resolve to
   * `<prefix>/<siteId>/…`. Trailing slash optional.
   */
  readonly VITE_DATA_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
