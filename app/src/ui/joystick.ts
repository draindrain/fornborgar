/**
 * A virtual thumbstick for the first-person overlay: the touch half of the
 * walk controls, one on each side of the screen (left walks, right looks).
 *
 * Pointer Events with per-pointer capture, the same idiom as viewshed/observer,
 * so both sticks can be driven at once by two thumbs — a stick that tracked
 * "the" pointer would be stolen by whichever thumb moved last. The base rect is
 * measured on pointerdown rather than per move: the widget does not move while
 * a finger is on it, and reading layout every pointermove is a scroll-jank
 * generator.
 *
 * The value is on the unit circle with +y = up the screen = forward, which is
 * what camera/firstPerson consumes; the deadzone is applied here so the camera
 * code never has to know about thumbs resting on glass.
 */

import type { StickVec } from '../camera/firstPerson';

const KNOB_TRAVEL = 0.82; // fraction of the base radius the knob may leave centre

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

/**
 * Screen-pixel offset from the stick's centre -> unit-circle value.
 *
 * Screen y grows downwards and forward is up, so the sign flips. Past `radius`
 * the value saturates at length 1 (dragging further does not go faster). Inside
 * the deadzone it is exactly zero, and beyond it the remaining range is
 * rescaled back to 0..1 — without that rescale the stick would jump to 0.15 the
 * moment it woke up.
 */
export function stickVector(dx: number, dy: number, radius: number, deadzone = 0.15): StickVec {
  if (radius <= 0) return { x: 0, y: 0 };
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  const norm = Math.min(len / radius, 1);
  if (norm <= deadzone) return { x: 0, y: 0 };
  const scaled = (norm - deadzone) / (1 - deadzone);
  const k = scaled / len;
  return { x: dx * k, y: -dy * k };
}

export type StickSide = 'fp-stick-left' | 'fp-stick-right';

export class Joystick {
  readonly root: HTMLElement;

  value: StickVec = { x: 0, y: 0 };
  onChange: (v: StickVec) => void = () => {};

  private readonly knob: HTMLElement;
  private pointerId: number | null = null;
  private centreX = 0;
  private centreY = 0;
  private radius = 1;

  constructor(parent: HTMLElement, modifierClass: StickSide) {
    this.root = el('div', `fp-stick ${modifierClass}`);
    this.knob = el('div', 'fp-stick-knob');
    this.root.append(this.knob);
    parent.append(this.root);

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerEnd = this.onPointerEnd.bind(this);

    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('pointermove', this.onPointerMove);
    this.root.addEventListener('pointerup', this.onPointerEnd);
    this.root.addEventListener('pointercancel', this.onPointerEnd);
    this.root.addEventListener('lostpointercapture', this.onPointerEnd);
  }

  dispose(): void {
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('pointermove', this.onPointerMove);
    this.root.removeEventListener('pointerup', this.onPointerEnd);
    this.root.removeEventListener('pointercancel', this.onPointerEnd);
    this.root.removeEventListener('lostpointercapture', this.onPointerEnd);
    this.root.remove();
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.pointerId !== null) return; // one thumb per stick
    this.pointerId = event.pointerId;
    // Without this the tap also lands on the canvas as a synthetic click, and
    // the canvas answers a click by asking for pointer lock.
    event.preventDefault();
    event.stopPropagation();
    const rect = this.root.getBoundingClientRect();
    this.centreX = rect.left + rect.width / 2;
    this.centreY = rect.top + rect.height / 2;
    this.radius = rect.width / 2;
    this.root.setPointerCapture(event.pointerId);
    this.root.classList.add('is-active');
    this.apply(event.clientX - this.centreX, event.clientY - this.centreY);
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault();
    this.apply(event.clientX - this.centreX, event.clientY - this.centreY);
  }

  private onPointerEnd(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.root.classList.remove('is-active');
    this.knob.style.transform = '';
    this.set({ x: 0, y: 0 });
  }

  /** Update value and knob position from a pixel offset off centre. */
  private apply(dx: number, dy: number): void {
    const v = stickVector(dx, dy, this.radius);
    const travel = this.radius * KNOB_TRAVEL;
    this.knob.style.transform = `translate(${(v.x * travel).toFixed(1)}px, ${(-v.y * travel).toFixed(1)}px)`;
    this.set(v);
  }

  private set(v: StickVec): void {
    if (v.x === this.value.x && v.y === this.value.y) return;
    this.value = v;
    this.onChange(v);
  }
}
