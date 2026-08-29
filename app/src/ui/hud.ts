/**
 * The non-3D chrome that is left on the default screen: the fort's name, the
 * fort-browser button, loading progress, and fatal errors.
 *
 * Everything else this used to carry — the technical subtitle, the exaggeration
 * indicator, the camera hint, the attribution footer — moved into the kebab menu
 * with the 2026-08-23b amendment to PLAN §6.1. The scene is the screen.
 *
 * The caveat toast stays, unused outside `?debug=1`: §6.1's first-enable rule
 * still holds for a layer switched on from the debug panel.
 */

import { loadFailureHint } from '../state/loader';

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
  private readonly loadingEl: HTMLElement;
  private readonly loadingLabel: HTMLElement;
  private readonly loadingBar: HTMLElement;
  private readonly caveatEl: HTMLElement;
  private readonly pickerButton: HTMLButtonElement;
  /** Phase 12: the reconstruction-mode switch. Hidden unless the site ships §14. */
  private readonly modeButton: HTMLButtonElement;
  private readonly caveatsShown = new Set<string>();
  private caveatTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');

    const header = el('header', 'hud-header');
    this.titleEl = el('h1', 'hud-title', 'Fornborg Explorer');
    // Phase 9 §6: only rendered once a site index exists to pick from, so a
    // repo-relative build (two fixtures, nothing to choose) shows no button.
    this.pickerButton = el('button', 'hud-picker-button', 'Browse forts');
    this.pickerButton.type = 'button';
    this.pickerButton.hidden = true;
    // Reconstruction mode *replaces* the markers rather than drawing on top of
    // them (owner decision, docs/reconstruction-mode.md §11.1) — one monument
    // rendered both as a 3D mound and as a flat coloured dot is worse than
    // either. So it is a hard toggle, one click from the default screen, and it
    // names the mode it switches *to*.
    this.modeButton = el('button', 'hud-mode-button', 'Reconstruction');
    this.modeButton.type = 'button';
    this.modeButton.hidden = true;
    header.append(this.titleEl, this.pickerButton, this.modeButton);

    this.loadingEl = el('div', 'hud-loading');
    this.loadingLabel = el('div', 'hud-loading-label', 'Starting…');
    const track = el('div', 'hud-loading-track');
    this.loadingBar = el('div', 'hud-loading-bar');
    track.append(this.loadingBar);
    this.loadingEl.append(this.loadingLabel, track);

    this.caveatEl = el('div', 'hud-caveat');
    this.caveatEl.hidden = true;

    this.root.append(header, this.loadingEl, this.caveatEl);
    parent.append(this.root);
  }

  setSite(name: string): void {
    this.titleEl.textContent = name;
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

  /** Phase 9 §6: reveal the picker toggle, wired to `handler`. */
  setSitePickerToggle(handler: () => void): void {
    this.pickerButton.hidden = false;
    this.pickerButton.addEventListener('click', handler);
  }

  /**
   * Show the reconstruction-mode switch. Only called for a site that ships the
   * §14 asset — a bundle without one has no mode to switch to, exactly as a
   * bundle without `assets.rampart` has no palisade.
   */
  enableModeSwitch(handler: (on: boolean) => void): void {
    this.modeButton.hidden = false;
    this.modeButton.addEventListener('click', () => {
      handler(this.modeButton.dataset['on'] !== 'true');
    });
  }

  /** Reflect the mode the app is actually in; the label names the way *out*. */
  setMode(on: boolean): void {
    this.modeButton.dataset['on'] = on ? 'true' : 'false';
    this.modeButton.textContent = on ? 'Registered sites' : 'Reconstruction';
    this.modeButton.title = on
      ? 'Back to the register: flat markers coloured by lämningstyp'
      : 'Show the monuments as they may have looked when in use (interpretation)';
    this.modeButton.classList.toggle('is-active', on);
  }

  /**
   * PLAN §6.1: toggling a model or conjecture layer on for the **first** time
   * surfaces its one-line caveat. Keyed by layer id, so it appears once per
   * session and never nags afterwards; the uncertainty text also stays
   * permanently next to the control itself.
   */
  /**
   * Suppress a layer's own caveat, because something else has already said it.
   * Used at startup when the model and conjecture layers come up already on: one
   * combined line is shown instead of three toasts racing a 9-second timer.
   */
  markCaveatShown(layerId: string): void {
    this.caveatsShown.add(layerId);
  }

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

  showError(error: unknown): void {
    this.loadingEl.hidden = true;
    const message = error instanceof Error ? error.message : String(error);
    const box = el('div', 'hud-error');
    box.append(el('h2', undefined, 'Could not load this site'));
    box.append(el('pre', undefined, message));
    // The remedy depends on where this build reads bundles from, and a
    // network-level rejection ("Failed to fetch") carries no status to explain
    // itself — so the hint is computed rather than fixed.
    box.append(el('p', 'hud-error-hint', loadFailureHint(error)));
    this.root.append(box);
    console.error(error);
  }
}
