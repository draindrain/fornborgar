/**
 * The methods & sources modal (Phase 6, PLAN §6.2) — one click from anywhere.
 *
 * Thin DOM rendering over `methodsModel.ts`; the content itself (and the §6.2
 * disclosure requirements) live there, unit-tested. The trigger button sits in
 * the HUD header; Escape or the backdrop closes.
 */

import type { MethodsModel, Provenance } from './methodsModel';

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

export function badgeEl(badge: Provenance): HTMLElement {
  return el('span', `provenance-badge provenance-${badge}`, badge);
}

export class MethodsPanel {
  readonly button: HTMLButtonElement;
  private readonly backdrop: HTMLElement;
  private readonly modal: HTMLElement;

  constructor(parent: HTMLElement) {
    this.button = el('button', 'methods-button', 'Methods & sources');
    this.button.type = 'button';

    this.backdrop = el('div', 'methods-backdrop');
    this.backdrop.hidden = true;
    this.modal = el('div', 'methods-modal');
    this.modal.setAttribute('role', 'dialog');
    this.modal.setAttribute('aria-label', 'Methods and sources');
    this.backdrop.append(this.modal);
    parent.append(this.backdrop);

    this.button.addEventListener('click', () => this.toggle());
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) this.hide();
    });
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !this.backdrop.hidden) this.hide();
    });
  }

  setContent(model: MethodsModel): void {
    this.modal.replaceChildren();

    const header = el('header', 'methods-header');
    header.append(el('h2', 'methods-title', `${model.siteName} — methods & sources`));
    const close = el('button', 'methods-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    header.append(close);
    this.modal.append(header);

    for (const section of model.sections) {
      const block = el('section', 'methods-section');
      const h = el('h3', 'methods-section-title', section.title);
      if (section.badge) h.append(badgeEl(section.badge));
      block.append(h);
      for (const paragraph of section.paragraphs) {
        block.append(el('p', 'methods-paragraph', paragraph));
      }
      this.modal.append(block);
    }

    const sources = el('section', 'methods-section');
    sources.append(el('h3', 'methods-section-title', 'Sources & literature'));
    const list = el('ul', 'methods-citations');
    for (const citation of model.citations) list.append(el('li', undefined, citation));
    sources.append(list);
    const repo = el('p', 'methods-paragraph');
    repo.append('Code, pipeline and data provenance: ');
    const a = el('a', undefined, model.repositoryUrl.replace('https://', ''));
    a.href = model.repositoryUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    repo.append(a);
    sources.append(repo);
    this.modal.append(sources);
  }

  show(): void {
    this.backdrop.hidden = false;
  }

  hide(): void {
    this.backdrop.hidden = true;
  }

  toggle(): void {
    this.backdrop.hidden = !this.backdrop.hidden;
  }

  get open(): boolean {
    return !this.backdrop.hidden;
  }
}
