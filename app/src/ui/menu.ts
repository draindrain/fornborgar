/**
 * The kebab menu: one ⋮ button in the top right corner, and everything the
 * default screen used to say.
 *
 * The screen is the scene (PLAN §6.1, 2026-08-23b amendment). What survives on
 * top of the terrain is the fort name, the time bar and the fort browser; the
 * legend, the methods panel, the camera help and the data attribution are one
 * click away in here.
 *
 * Closing follows the idiom the other overlays already use: Escape, a click
 * outside, and — unlike a panel — selecting anything at all.
 */

import { Modal } from './modal';
import { CAMERA_HELP, type AboutModel } from './menuContent';

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

export class Menu {
  readonly button: HTMLButtonElement;

  private readonly popover: HTMLElement;

  constructor(parent: HTMLElement) {
    const root = el('div', 'app-menu');

    this.button = el('button', 'app-menu-button', '⋮');
    this.button.type = 'button';
    this.button.setAttribute('aria-label', 'Menu');
    this.button.setAttribute('aria-haspopup', 'menu');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.addEventListener('click', () => this.toggle());

    this.popover = el('div', 'app-menu-popover');
    this.popover.setAttribute('role', 'menu');
    this.popover.hidden = true;

    root.append(this.button, this.popover);
    parent.append(root);

    // Pointerdown rather than click, so the menu is already gone by the time a
    // click on the canvas reaches the orbit controls.
    window.addEventListener('pointerdown', (event) => {
      if (this.popover.hidden) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !this.popover.hidden) this.close();
    });
  }

  /** Append one row. Selecting it closes the menu, then runs `onSelect`. */
  addItem(label: string, onSelect: () => void): HTMLButtonElement {
    const item = el('button', 'app-menu-item', label);
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => {
      this.close();
      onSelect();
    });
    this.popover.append(item);
    return item;
  }

  open(): void {
    this.popover.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
  }

  close(): void {
    this.popover.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }

  toggle(): void {
    if (this.popover.hidden) this.open();
    else this.close();
  }

  get isOpen(): boolean {
    return !this.popover.hidden;
  }
}

/**
 * "Controls & camera" — the mode hint that used to sit above the footer, given
 * room to say the whole thing instead of one line's worth.
 */
export class CameraHelpPanel {
  private readonly modal: Modal;

  constructor(parent: HTMLElement) {
    this.modal = new Modal(parent, 'Controls & camera');
    for (const line of CAMERA_HELP) {
      this.modal.body.append(el('p', 'methods-paragraph', line));
    }
  }

  show(): void {
    this.modal.show();
  }

  hide(): void {
    this.modal.hide();
  }

  get open(): boolean {
    return this.modal.open;
  }
}

/**
 * "About & credits" — what this site's terrain is, what is measured and what is
 * modelled, and the data attribution.
 *
 * Rebuilt on every open, because the exaggeration sentence has to state the
 * value in force now rather than the one at load.
 */
export class AboutPanel {
  private readonly modal: Modal;

  constructor(
    parent: HTMLElement,
    private readonly model: () => AboutModel,
  ) {
    this.modal = new Modal(parent, 'About & credits');
  }

  show(): void {
    const model = this.model();
    this.modal.setTitle(model.title);
    this.modal.body.replaceChildren();

    for (const paragraph of model.paragraphs) {
      this.modal.body.append(el('p', 'methods-paragraph', paragraph));
    }

    if (model.attribution.length > 0) {
      const section = el('section', 'methods-section');
      section.append(el('h3', 'methods-section-title', 'Data & attribution'));
      const list = el('ul', 'methods-citations');
      for (const entry of model.attribution) {
        const item = el('li');
        if (entry.url) {
          const a = el('a', undefined, entry.text);
          a.href = entry.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          item.append(a);
        } else {
          item.textContent = entry.text;
        }
        list.append(item);
      }
      section.append(list);
      this.modal.body.append(section);
    }

    this.modal.show();
  }

  hide(): void {
    this.modal.hide();
  }

  get open(): boolean {
    return this.modal.open;
  }
}
