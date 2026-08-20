/**
 * The non-3D chrome: title, loading progress, fatal errors, the persistent
 * exaggeration indicator (PLAN §6.1 requires it whenever exaggeration ≠ 1.0), the
 * first-enable caveat for model/conjecture layers (also §6.1), and the
 * attribution footer rendered straight from `manifest.attribution`.
 */

import type { AttributionEntry } from '../state/manifest';

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

export class Hud {
  readonly root: HTMLElement;

  private readonly titleEl: HTMLElement;
  private readonly subtitleEl: HTMLElement;
  private readonly loadingEl: HTMLElement;
  private readonly loadingLabel: HTMLElement;
  private readonly loadingBar: HTMLElement;
  private readonly exaggerationEl: HTMLElement;
  private readonly modeHintEl: HTMLElement;
  private readonly caveatEl: HTMLElement;
  private readonly footerEl: HTMLElement;
  private readonly caveatsShown = new Set<string>();
  private caveatTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');

    const header = el('header', 'hud-header');
    this.titleEl = el('h1', 'hud-title', 'Fornborg Explorer');
    this.subtitleEl = el('p', 'hud-subtitle', 'Loading site…');
    header.append(this.titleEl, this.subtitleEl);

    this.exaggerationEl = el('div', 'hud-exaggeration');
    this.exaggerationEl.hidden = true;

    this.loadingEl = el('div', 'hud-loading');
    this.loadingLabel = el('div', 'hud-loading-label', 'Starting…');
    const track = el('div', 'hud-loading-track');
    this.loadingBar = el('div', 'hud-loading-bar');
    track.append(this.loadingBar);
    this.loadingEl.append(this.loadingLabel, track);

    this.modeHintEl = el('div', 'hud-mode-hint');
    this.modeHintEl.hidden = true;

    this.caveatEl = el('div', 'hud-caveat');
    this.caveatEl.hidden = true;

    this.footerEl = el('footer', 'hud-footer');

    this.root.append(
      header,
      this.exaggerationEl,
      this.loadingEl,
      this.caveatEl,
      this.modeHintEl,
      this.footerEl,
    );
    parent.append(this.root);
  }

  /** Mount an always-visible action (the methods button) into the header. */
  mountAction(node: HTMLElement): void {
    this.root.querySelector('.hud-header')?.append(node);
  }

  setSite(name: string, subtitle: string): void {
    this.titleEl.textContent = name;
    this.subtitleEl.textContent = subtitle;
    document.title = `${name} — Fornborg Explorer`;
  }

  setProgress(label: string, fraction: number): void {
    this.loadingEl.hidden = false;
    this.loadingLabel.textContent = label;
    this.loadingBar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }

  finishLoading(): void {
    this.loadingEl.classList.add('is-done');
    window.setTimeout(() => {
      this.loadingEl.hidden = true;
    }, 700);
  }

  setExaggeration(value: number): void {
    const on = Math.abs(value - 1) > 1e-6;
    this.exaggerationEl.hidden = !on;
    this.exaggerationEl.textContent = `terrain ×${Number(value.toFixed(2))}`;
  }

  /** Camera-mode key hint just above the footer. Empty string hides it. */
  setModeHint(text: string): void {
    this.modeHintEl.hidden = text === '';
    this.modeHintEl.textContent = text;
  }

  /**
   * PLAN §6.1: toggling a model or conjecture layer on for the **first** time
   * surfaces its one-line caveat. Keyed by layer id, so it appears once per
   * session and never nags afterwards; the uncertainty text also stays
   * permanently next to the control itself.
   */
  showCaveatOnce(layerId: string, badge: string, text: string): void {
    if (this.caveatsShown.has(layerId)) return;
    this.caveatsShown.add(layerId);

    this.caveatEl.replaceChildren(el('strong', 'hud-caveat-badge', badge), el('span', undefined, text));
    this.caveatEl.hidden = false;
    this.caveatEl.classList.remove('is-fading');

    window.clearTimeout(this.caveatTimer);
    this.caveatTimer = window.setTimeout(() => {
      this.caveatEl.classList.add('is-fading');
      this.caveatTimer = window.setTimeout(() => {
        this.caveatEl.hidden = true;
      }, 600);
    }, 9000);
  }

  setAttribution(entries: AttributionEntry[]): void {
    this.footerEl.replaceChildren();
    for (const entry of entries) {
      const item = el('span', 'hud-attribution');
      if (entry.url) {
        const a = el('a');
        a.href = entry.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = entry.text;
        item.append(a);
      } else {
        item.textContent = entry.text;
      }
      this.footerEl.append(item);
    }
  }

  showError(error: unknown): void {
    this.loadingEl.hidden = true;
    const message = error instanceof Error ? error.message : String(error);
    const box = el('div', 'hud-error');
    box.append(el('h2', undefined, 'Could not load this site'));
    box.append(el('pre', undefined, message));
    box.append(
      el(
        'p',
        'hud-error-hint',
        'Site data lives in app/public/data/<siteId>/ and is described by ' +
          'docs/data-formats.md. Try ?site=testsite for the built-in synthetic fixture.',
      ),
    );
    this.root.append(box);
    console.error(error);
  }
}
