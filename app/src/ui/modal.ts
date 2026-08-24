/**
 * The shared dialog shell.
 *
 * Extracted from ui/methodsPanel.ts, which was the app's only modal until the
 * default screen was stripped back (PLAN §6.1, 2026-08-23b amendment): the
 * Legend, the camera help and the credits all became things you open from the
 * kebab menu rather than things that sit on top of the terrain. They are the
 * same dialog with different bodies, so the backdrop, the Escape key, the
 * click-outside and the close button live here once.
 *
 * Hand-rolled DOM in the same idiom as the rest of ui/: a local `el` helper,
 * every rule in style.css.
 */

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

export class Modal {
  /** Content host. Callers own everything inside it. */
  readonly body: HTMLElement;

  private readonly backdrop: HTMLElement;
  private readonly titleEl: HTMLElement;

  constructor(parent: HTMLElement, ariaLabel: string) {
    this.backdrop = el('div', 'modal-backdrop');
    this.backdrop.hidden = true;

    const dialog = el('div', 'modal');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', ariaLabel);

    const header = el('header', 'modal-header');
    this.titleEl = el('h2', 'modal-title', ariaLabel);
    const close = el('button', 'modal-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    header.append(this.titleEl, close);

    this.body = el('div', 'modal-body');
    dialog.append(header, this.body);
    this.backdrop.append(dialog);
    parent.append(this.backdrop);

    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) this.hide();
    });
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !this.backdrop.hidden) this.hide();
    });
  }

  setTitle(text: string): void {
    this.titleEl.textContent = text;
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
