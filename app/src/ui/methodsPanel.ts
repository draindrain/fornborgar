/**
 * The methods & sources modal (Phase 6, PLAN §6.2).
 *
 * Thin DOM rendering over `methodsModel.ts`; the content itself (and the §6.2
 * disclosure requirements) live there, unit-tested. The dialog shell — backdrop,
 * Escape, click-outside, close button — is ui/modal.ts, shared with the legend
 * and the menu's own panels.
 *
 * It is reached from the kebab menu and from the time bar's "?" button, which
 * keeps it one click from the default screen as §6.1 requires.
 */

import { Modal } from './modal';
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
  private readonly modal: Modal;

  constructor(parent: HTMLElement) {
    this.modal = new Modal(parent, 'Methods and sources');
  }

  setContent(model: MethodsModel): void {
    this.modal.setTitle(`${model.siteName} — methods & sources`);
    this.modal.body.replaceChildren();

    for (const section of model.sections) {
      const block = el('section', 'methods-section');
      const h = el('h3', 'methods-section-title', section.title);
      if (section.badge) h.append(badgeEl(section.badge));
      block.append(h);
      for (const paragraph of section.paragraphs) {
        block.append(el('p', 'methods-paragraph', paragraph));
      }
      this.modal.body.append(block);
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
    this.modal.body.append(sources);
  }

  show(): void {
    this.modal.show();
  }

  hide(): void {
    this.modal.hide();
  }

  toggle(): void {
    this.modal.toggle();
  }

  get open(): boolean {
    return this.modal.open;
  }
}
