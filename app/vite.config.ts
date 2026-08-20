import { defineConfig } from 'vite';

// `base: './'` keeps every emitted asset URL relative, so the build works both from
// the filesystem/preview root and from a GitHub Pages project subpath. The Pages
// workflow additionally passes `--base=/<repo>/`; both resolve correctly because all
// data fetches go through `import.meta.env.BASE_URL` (docs/data-formats.md §0).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // The DEM COGs live in public/ and are fetched at runtime, never bundled.
    assetsInlineLimit: 0,
  },
});
