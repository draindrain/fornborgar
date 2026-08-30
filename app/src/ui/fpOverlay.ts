/**
 * The only chrome left on screen in first person.
 *
 * Walking is the one mode where the map furniture is in the way — panels, the
 * time bar and the kebab menu all read as a heads-up display bolted to the
 * front of the head — so entering hides everything (`body.fp-active` in
 * style.css) and this overlay puts back the minimum needed to get out again.
 *
 * What that minimum is depends on the pointer. With a mouse the controls are
 * already discoverable once named, so it is one line of text; on a touch screen
 * there is no keyboard to press F with and no pointer lock to look with, so it
 * is two thumbsticks and an Exit button. The controller merges both input
 * paths, so a hybrid device keeps its keyboard either way.
 */

import type { StickVec } from '../camera/firstPerson';
import { Joystick } from './joystick';

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

export const FP_HINT = 'F — back to orbit · WASD walk · Shift run · click to look';

export interface FpOverlayOptions {
  /** Coarse pointer: joysticks and an Exit button instead of the key hint. */
  touch: boolean;
  onExit: () => void;
  /** Analog readings, `null` at rest so the controller can skip the branch. */
  onMove: (v: StickVec | null) => void;
  onLook: (v: StickVec | null) => void;
}

const atRest = (v: StickVec): boolean => v.x === 0 && v.y === 0;

export class FirstPersonOverlay {
  readonly root: HTMLElement;

  private readonly sticks: Joystick[] = [];
  private readonly exitButton: HTMLButtonElement | null = null;
  private readonly onExit: () => void;

  constructor(parent: HTMLElement, opts: FpOverlayOptions) {
    this.onExit = opts.onExit;
    this.root = el('div', 'fp-overlay');
    this.root.hidden = true;

    if (opts.touch) {
      this.exitButton = el('button', 'fp-exit-button', 'Exit first person');
      this.exitButton.type = 'button';
      this.exitButton.addEventListener('click', this.onExit);
      this.root.append(this.exitButton);

      const move = new Joystick(this.root, 'fp-stick-left');
      move.onChange = (v) => opts.onMove(atRest(v) ? null : v);
      const look = new Joystick(this.root, 'fp-stick-right');
      look.onChange = (v) => opts.onLook(atRest(v) ? null : v);
      this.sticks.push(move, look);
    } else {
      this.root.append(el('div', 'fp-hint', FP_HINT));
    }

    parent.append(this.root);
  }

  setActive(active: boolean): void {
    this.root.hidden = !active;
  }

  dispose(): void {
    this.exitButton?.removeEventListener('click', this.onExit);
    for (const stick of this.sticks) stick.dispose();
    this.sticks.length = 0;
    this.root.remove();
  }
}
