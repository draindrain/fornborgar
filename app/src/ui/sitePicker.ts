/**
 * The national site picker (docs/national-scaleout.md §6) — MVP.
 *
 * A SWEREF-projected dot map of every published fort plus a name/county search.
 * No map library: 1,304 points in an inline SVG is a few hundred kilobytes of
 * DOM at worst, the projection is a linear rescale (the index already carries
 * EPSG:3006 metres), and a basemap would only add a tile dependency to
 * something whose whole job is "which of these dots do you want".
 *
 * Two honesty rules the picker inherits from the rest of the app:
 *
 *  * every site in the index is shown, including the ones KMR grades *Möjlig
 *    fornlämning* or *Övrig kulturhistorisk lämning* — with that grade on a
 *    badge. Hand-filtering the dubious records would quietly assert a
 *    confidence the register itself does not have;
 *  * the picker only lists what is actually fetchable. It is built from
 *    `index.json`, which the pipeline writes only for uploaded, QA-clean
 *    bundles — so a dot never leads to a 404.
 *
 * Deep links stay `?site=<slug>`; picking a site navigates there, which reloads
 * the scene through exactly the same path a pasted URL does.
 */

import { matchesQuery, type SiteIndex, type SiteIndexEntry } from '../state/siteIndex';

/**
 * SWEREF 99 TM bounds used to lay out the dot map, in metres.
 *
 * Deliberately a fixed frame rather than the data's own extent: sites appear in
 * the index a county at a time, and a map that reshaped itself after every
 * batch would move every dot the reader had learned. These bounds hold all of
 * Sweden with a little margin.
 */
export const MAP_BOUNDS = { minE: 200_000, maxE: 950_000, minN: 6_100_000, maxN: 7_700_000 };
const MAP_WIDTH = 220;

/** Aspect-correct height for `MAP_WIDTH`, so the country is not stretched. */
export const MAP_HEIGHT = Math.round(
  (MAP_WIDTH * (MAP_BOUNDS.maxN - MAP_BOUNDS.minN)) / (MAP_BOUNDS.maxE - MAP_BOUNDS.minE),
);

/** EPSG:3006 metres -> SVG user units. North is up, so the N axis is flipped. */
export function projectToMap(centerE: number, centerN: number): { x: number; y: number } {
  const { minE, maxE, minN, maxN } = MAP_BOUNDS;
  return {
    x: ((centerE - minE) / (maxE - minE)) * MAP_WIDTH,
    y: ((maxN - centerN) / (maxN - minN)) * MAP_HEIGHT,
  };
}

/** The short badge line under a site's name in the result list. */
export function badgeText(entry: SiteIndexEntry): string {
  const parts = [entry.county].filter(Boolean);
  if (entry.antikvariskBedomning && entry.antikvariskBedomning !== 'Fornlämning') {
    // Only the *unusual* gradings are worth the reader's attention; labelling
    // 94 % of the register "Fornlämning" would be noise that hides the rest.
    parts.push(entry.antikvariskBedomning);
  }
  if (entry.features.water) parts.push('water');
  if (entry.extentPreset === 'large') parts.push('large');
  return parts.join(' · ');
}

/** Result ordering: exact-ish name matches first, then county, then name. */
export function rankResults(entries: SiteIndexEntry[], query: string): SiteIndexEntry[] {
  const needle = query.trim().toLowerCase();
  const scored = entries.map((entry) => {
    const name = entry.name.toLowerCase();
    let score = 3;
    if (needle && name === needle) score = 0;
    else if (needle && name.startsWith(needle)) score = 1;
    else if (needle && name.includes(needle)) score = 2;
    return { entry, score };
  });
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.county.localeCompare(b.entry.county, 'sv') ||
      a.entry.name.localeCompare(b.entry.name, 'sv'),
  );
  return scored.map((s) => s.entry);
}

export function filterSites(index: SiteIndex, query: string, limit = 200): SiteIndexEntry[] {
  return rankResults(index.sites.filter((site) => matchesQuery(site, query)), query).slice(0, limit);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class SitePicker {
  readonly root: HTMLElement;
  /** Called with a slug when the user picks a site. */
  onPick: (slug: string) => void = () => {};

  private readonly index: SiteIndex;
  private readonly currentSlug: string;
  private readonly list: HTMLElement;
  private readonly map: SVGSVGElement;
  private readonly count: HTMLElement;
  private readonly dots = new Map<string, SVGCircleElement>();
  private query = '';

  constructor(parent: HTMLElement, index: SiteIndex, currentSlug: string) {
    this.index = index;
    this.currentSlug = currentSlug;

    this.root = el('aside', 'site-picker');
    this.root.hidden = true;

    const header = el('header', 'site-picker-header');
    header.append(el('h2', 'site-picker-title', 'Choose a fort'));
    const close = el('button', 'site-picker-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    header.append(close);

    const search = el('input', 'site-picker-search');
    search.type = 'search';
    search.placeholder = 'Name, county or lämningsnummer';
    search.setAttribute('aria-label', 'Search forts');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.render();
    });

    this.map = document.createElementNS(SVG_NS, 'svg');
    this.map.setAttribute('class', 'site-picker-map');
    this.map.setAttribute('viewBox', `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`);
    this.map.setAttribute('role', 'img');
    this.map.setAttribute('aria-label', `${index.count} published forts, plotted over Sweden`);

    this.count = el('p', 'site-picker-count');
    this.list = el('ul', 'site-picker-list');

    this.root.append(header, search, this.map, this.count, this.list);
    parent.append(this.root);

    this.buildMap();
    this.render();

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !this.root.hidden) this.hide();
    });
  }

  private buildMap(): void {
    for (const site of this.index.sites) {
      const { x, y } = projectToMap(site.centerE, site.centerN);
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', y.toFixed(1));
      dot.setAttribute('r', site.slug === this.currentSlug ? '3' : '1.8');
      dot.setAttribute(
        'class',
        site.slug === this.currentSlug ? 'site-dot site-dot-current' : 'site-dot',
      );
      dot.addEventListener('click', () => this.onPick(site.slug));
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${site.name} (${site.county})`;
      dot.append(title);
      this.map.append(dot);
      this.dots.set(site.slug, dot);
    }
  }

  private render(): void {
    const matches = filterSites(this.index, this.query);
    const shown = new Set(matches.map((m) => m.slug));
    for (const [slug, dot] of this.dots) {
      dot.classList.toggle('site-dot-dim', !shown.has(slug));
    }

    this.count.textContent =
      this.query.trim()
        ? `${matches.length} of ${this.index.count} published forts`
        : `${this.index.count} published forts of ${this.index.totalRegistered} registered`;

    this.list.replaceChildren();
    for (const site of matches) {
      const item = el('li', 'site-picker-item');
      const button = el('button', 'site-picker-entry');
      button.type = 'button';
      if (site.slug === this.currentSlug) button.classList.add('site-picker-entry-current');
      button.append(el('span', 'site-picker-name', site.name));
      button.append(el('span', 'site-picker-badge', badgeText(site)));
      button.addEventListener('click', () => this.onPick(site.slug));
      item.append(button);
      this.list.append(item);
    }
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }
}
