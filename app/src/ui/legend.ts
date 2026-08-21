/**
 * The layer legend with the three §6.1 provenance badges (Phase 6).
 *
 * Every legend row is built from `manifest.layers` — the pipeline's provenance
 * declaration, validated on both sides of the contract — plus marker swatches
 * for the site types actually present. The three classes carry distinct visual
 * language (PLAN §6.1): measured rows plain, model rows tinted, the conjecture
 * row ghosted with a permanent "conjectural" tag.
 */

import type { LayerEntry } from '../state/manifest';
import type { LandcoverLegend } from '../landcover/legend';
import { siteStyle, type SiteRecord } from '../overlays/sites';
import { formatYear } from '../water/shoreline';
import { badgeEl } from './methodsPanel';

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

const LAYER_SWATCH: Record<string, string> = {
  terrain: '#a29b83',
  sites: '#c75146',
  water: '#254c58',
  landcover: '#6f8f52',
  palisade: '#9fd6de',
};

export class Legend {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('aside', 'legend');
    const toggle = el('button', 'legend-toggle', 'Legend');
    toggle.type = 'button';
    this.body = el('div', 'legend-body');
    toggle.addEventListener('click', () => {
      this.root.classList.toggle('is-collapsed');
    });
    this.root.append(toggle, this.body);
    // Collapsed by default on small screens (mobile degradation, PLAN §3 phase 6).
    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches) {
      this.root.classList.add('is-collapsed');
    }
    parent.append(this.root);
  }

  /**
   * `layers` comes straight from `manifest.layers`, so the model/conjecture badges
   * are the pipeline's declaration rather than the app's opinion. The optional
   * `landcover` legend adds one row per modelled class — swatch, name and the
   * informational area percentage the §10 legend carries — grouped like the site
   * markers, and states the reference century it is valid for.
   */
  setContent(layers: LayerEntry[], sites: SiteRecord[] | null, landcover: LandcoverLegend | null = null): void {
    this.body.replaceChildren();

    for (const layer of layers) {
      const row = el('div', `legend-row legend-${layer.provenance}`);
      const swatch = el('span', 'legend-swatch');
      swatch.style.background = LAYER_SWATCH[layer.id] ?? '#888';
      if (layer.provenance === 'conjecture') swatch.classList.add('legend-swatch-ghost');
      row.append(swatch, el('span', 'legend-name', layer.name), badgeEl(layer.provenance));
      this.body.append(row);
    }

    if (landcover) {
      const group = el('div', 'legend-markers');
      group.append(
        el('div', 'legend-markers-title', `Modelled land cover (${formatYear(landcover.referenceYearCE)})`),
      );
      for (const cls of landcover.classes) {
        const row = el('div', 'legend-row legend-model');
        const swatch = el('span', 'legend-swatch');
        swatch.style.background = cls.color;
        const percent =
          typeof cls.areaFraction === 'number'
            ? ` · ${(cls.areaFraction * 100).toFixed(cls.areaFraction < 0.1 ? 1 : 0)} %`
            : '';
        row.append(swatch, el('span', 'legend-name', `${cls.name}${percent}`));
        group.append(row);
      }
      this.body.append(group);
    }

    if (sites && sites.length > 0) {
      const types = [...new Set(sites.map((s) => s.lamningstyp))].sort((a, b) => a.localeCompare(b, 'sv'));
      const group = el('div', 'legend-markers');
      group.append(el('div', 'legend-markers-title', 'Site markers (KMR)'));
      for (const type of types) {
        const style = siteStyle(type);
        const row = el('div', 'legend-row');
        const swatch = el('span', `legend-marker legend-marker-${style.shape}`);
        swatch.style.setProperty('--marker-color', style.color);
        row.append(swatch, el('span', 'legend-name', type));
        group.append(row);
      }
      this.body.append(group);
    }
  }
}
