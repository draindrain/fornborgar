/**
 * The non-3D chrome: title, loading progress, fatal errors, the persistent
 * exaggeration indicator (PLAN §6.1 requires it whenever exaggeration ≠ 1.0), and
 * the attribution footer rendered straight from `manifest.attribution`.
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
  private readonly footerEl: HTMLElement;

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

    this.footerEl = el('footer', 'hud-footer');

    this.root.append(header, this.exaggerationEl, this.loadingEl, this.footerEl);
    parent.append(this.root);
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
