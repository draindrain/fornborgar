/**
 * The Fornsök popup card for a selected registered site (Phase 5, PLAN §3).
 *
 * A fixed panel rather than a floating balloon: KMR descriptions run long, and a
 * scrollable card with a stable position works at every viewport size. Content
 * comes verbatim from `sites.json` (contract §3); the provenance badge states the
 * layer's honesty class (PLAN §6.1 — registry data is "measured").
 */

import type { SiteRecord } from '../overlays/sites';
import { BADGE_FOR_TIER, type Tier } from '../overlays/reconstruction/schema';
import type { MonumentSummary } from '../overlays/reconstruction/layer';

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

export class SitePanel {
  readonly root: HTMLElement;
  /** Fired when the user closes the card (X or Escape). */
  onClose: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('aside', 'site-panel');
    this.root.hidden = true;
    parent.append(this.root);

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !this.root.hidden) {
        this.hide();
        this.onClose();
      }
    });
  }

  show(site: SiteRecord, reconstruction?: MonumentSummary | null): void {
    this.root.replaceChildren();

    const header = el('header', 'site-panel-header');
    const title = el('h2', 'site-panel-title', site.name);
    const close = el('button', 'site-panel-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => {
      this.hide();
      this.onClose();
    });
    header.append(title, close);

    const meta = el('div', 'site-panel-meta');
    meta.append(el('span', 'site-panel-type', site.lamningstyp));
    meta.append(el('span', 'site-panel-badge', `KMR · ${site.provenance}`));
    meta.append(el('span', 'site-panel-id', site.id));

    this.root.append(header, meta);

    if (reconstruction) this.appendReconstruction(reconstruction);

    if (site.description) {
      this.root.append(el('p', 'site-panel-description', site.description));
    }

    if (site.fornsokUrl) {
      const link = el('a', 'site-panel-link', 'Öppna i Fornsök ↗');
      link.href = site.fornsokUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      this.root.append(link);
    }

    this.root.hidden = false;
  }

  /**
   * The reconstruction's own account of itself (docs/reconstruction-mode.md §9).
   *
   * §9.1 is the rule this method exists for: **a reconstructed monument is not
   * one badge.** A mound is Measured in plan, Model in profile and Conjecture in
   * surface, and averaging that to a single reassuring label is exactly the
   * failure the whole provenance scheme is meant to prevent. So the card states
   * a badge *per part*, quotes the §5 transform that produced the profile next
   * to the ruin measurement it ran on, and names every field that fell back to
   * an archetype default.
   */
  private appendReconstruction(summary: MonumentSummary): void {
    const { monument } = summary;
    const box = el('div', 'site-panel-recon');
    box.append(el('h3', 'site-panel-recon-title', 'Reconstruction'));

    const parts: Array<[string, Tier, string]> = [
      ['Plan', monument.tiers.plan, describePlan(monument)],
      ['Profile', monument.tiers.profile, describeProfile(monument)],
      ['Surface', monument.tiers.surface, describeSurface(monument)],
    ];
    if (monument.tiers.placement) {
      parts.push(['Placement', monument.tiers.placement, describePlacement(summary)]);
    }

    const list = el('dl', 'site-panel-recon-parts');
    for (const [label, tier, text] of parts) {
      const term = el('dt', 'site-panel-recon-part');
      term.append(
        el('span', 'site-panel-recon-label', label),
        el('span', `site-panel-recon-badge is-${BADGE_FOR_TIER[tier]}`, BADGE_FOR_TIER[tier]),
      );
      list.append(term, el('dd', 'site-panel-recon-value', text));
    }
    box.append(list);

    if (summary.fortDowngraded) {
      // §6.A.1: roughly four in five registered `Fornborg` records are probably
      // not Migration Period forts, and a site the app cannot classify should
      // look unresolved rather than confidently Migration Period.
      box.append(
        el(
          'p',
          'site-panel-recon-note',
          'Drawn as a low bank, not a standing rampart: this record does not meet the ' +
            'published test for a Middle Iron Age fort (dry-stone walling preserved, a wall ' +
            '1 m or more high, running right round or across the non-steep side).',
        ),
      );
    }
    if (monument.damaged) {
      box.append(
        el(
          'p',
          'site-panel-recon-note',
          'The register records damage to this monument — the reconstruction stands over a ' +
            'disturbed original.',
        ),
      );
    }
    for (const warning of monument.warnings ?? []) {
      box.append(el('p', 'site-panel-recon-note', warning));
    }
    // The sampler's own warnings, which are about this scene rather than about
    // the record: a shortfall against a stated count is never silent (§15.3).
    for (const warning of summary.warnings) {
      box.append(el('p', 'site-panel-recon-note', warning));
    }
    if (monument.fallbacks.length > 0) {
      box.append(
        el(
          'p',
          'site-panel-recon-note',
          `No value in the record for ${monument.fallbacks.join(', ')} — archetype defaults used.`,
        ),
      );
    }
    box.append(
      el(
        'p',
        'site-panel-recon-confidence',
        `Parsed ${Math.round(monument.parseConfidence * 100)} % of what this archetype can use ` +
          'from the register.',
      ),
    );
    this.root.append(box);
  }

  hide(): void {
    this.root.hidden = true;
  }

  get open(): boolean {
    return !this.root.hidden;
  }
}


// --------------------------------------------------------------------------- //
// per-part descriptions — the arithmetic, not the conclusion (§9.3)
// --------------------------------------------------------------------------- //

function metres(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} m`;
}

function describePlan(monument: MonumentSummary['monument']): string {
  const { plan } = monument;
  const shape =
    plan.lengthM !== null && plan.widthM !== null
      ? `${metres(plan.lengthM)} × ${metres(plan.widthM)}`
      : `${metres(plan.diameterM)} across`;
  const form = plan.form === 'round' ? 'Round' : plan.form[0].toUpperCase() + plan.form.slice(1);
  const source = plan.source === 'measured' ? 'as recorded' : 'archetype default';
  return `${form}, ${shape} (${source}).`;
}

function describeProfile(monument: MonumentSummary['monument']): string {
  const { profile } = monument;
  const ruin = `Register records ${metres(profile.presentDiameterM)} × ${metres(profile.presentHeightM)} high.`;
  switch (profile.transform) {
    case 'none':
      return `${ruin} Not inflated — flatness is the type, so the recorded height is close to original.`;
    case 'pit-omit':
      return `${ruin} Not inflated; the recorded robbing pits are simply not modelled.`;
    case 'kerb-fixed':
    case 'kerb-fixed+pit-fill':
      return (
        `${ruin} A recorded kantkedja fixes the original footprint, so the diameter is kept and ` +
        `the surface restored to a smooth cap through the kerb: ${metres(profile.diameterM)} × ` +
        `${metres(profile.heightM)}` +
        (profile.transform.endsWith('pit-fill') ? ', with the recorded pits filled.' : '.')
      );
    case 'repose-reprofile':
    case 'repose-reprofile+pit-fill':
      return (
        `${ruin} No kerb is recorded, so the base may have crept outward: rebuilt conserving ` +
        `volume at the material's angle of repose to ${metres(profile.diameterM)} × ` +
        `${metres(profile.heightM)} — narrower and taller` +
        (profile.transform.endsWith('pit-fill') ? ', with the recorded pits filled.' : '.')
      );
    case 'rampart-apron-conservation':
      return (
        `Wall still standing, plus the height its own collapse apron represents: ` +
        `${metres(profile.heightM)}.`
      );
    default:
      return ruin;
  }
}

function describeSurface(monument: MonumentSummary['monument']): string {
  const [lo, hi] = monument.surface.stoneM;
  const stone =
    monument.surface.source === 'measured' || monument.surface.source === 'derived'
      ? `Stone ${lo}–${hi} m, as recorded.`
      : `Stone ${lo}–${hi} m (archetype default).`;
  const turf = monument.surface.turfed
    ? ' The register notes turf or moss cover, which is a ruin state: the reconstruction strips it back off.'
    : '';
  return stone + turf;
}

function describePlacement(summary: MonumentSummary): string {
  const placed = `${summary.sampled} of ${summary.requested} monuments placed`;
  const rules =
    'positions are inferred from landscape rules — dry ground, local prominence, slope, ' +
    'clustering — not from the record, which states only what is here and how big.';
  const shortfall =
    summary.sampled < summary.requested
      ? ' The rest had nowhere dry and level enough inside the extent to stand.'
      : '';
  return `${placed}; ${rules}${shortfall}`;
}
