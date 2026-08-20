/**
 * The Fornsök popup card for a selected registered site (Phase 5, PLAN §3).
 *
 * A fixed panel rather than a floating balloon: KMR descriptions run long, and a
 * scrollable card with a stable position works at every viewport size. Content
 * comes verbatim from `sites.json` (contract §3); the provenance badge states the
 * layer's honesty class (PLAN §6.1 — registry data is "measured").
 */

import type { SiteRecord } from '../overlays/sites';

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

  show(site: SiteRecord): void {
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

  hide(): void {
    this.root.hidden = true;
  }

  get open(): boolean {
    return !this.root.hidden;
  }
}
