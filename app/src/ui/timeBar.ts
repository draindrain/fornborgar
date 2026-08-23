/**
 * The default control surface: three sliders across the bottom of the screen.
 *
 * Year, time of year, time of day — and nothing else. Everything that used to
 * live in the lil-gui panel (seeds, densities, viewshed parameters, vertical
 * exaggeration) is a debugging affordance and now sits behind `?debug=1`.
 *
 * Hand-rolled DOM in the same idiom as ui/hud.ts and ui/legend.ts: a local `el`
 * helper, every rule in style.css. The formatters are exported and pure so they
 * can be pinned in a test without a DOM.
 *
 * The year slider is the app clock. It drives the water level through the
 * existing water funnel and the sun's obliquity through sky/solar.ts, and it
 * names the archaeological period — with the standing caveat (lib/periods.ts)
 * that those boundaries are conventions, not events.
 */

import type { TimeState } from './controls';

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

/** "13:45". Hours are local apparent solar time, so this is a sundial reading. */
export function formatSolarTime(hour: number): string {
  const total = Math.round(((hour % 24) + 24) % 24 * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "sun 17° above the horizon" / "moon 12° below the horizon". */
export function formatAltitude(altitudeDeg: number, body = 'sun'): string {
  const rounded = Math.round(Math.abs(altitudeDeg));
  return altitudeDeg >= 0
    ? `${body} ${rounded}° above the horizon`
    : `${body} ${rounded}° below the horizon`;
}

export interface TimeBarReadouts {
  /** e.g. "400 CE · Migration Period". */
  year: string;
  /** e.g. "+11.2 m above present sea", or '' where the site ships no water. */
  yearNote: string;
  /** e.g. "21 June · midsummer". */
  season: string;
  /** e.g. "18:30 solar time · sun 17° above the horizon". */
  day: string;
  /** e.g. "sunrise 02:34 · sunset 21:26", or a polar-day/night phrase. */
  dayNote: string;
  /** e.g. "waxing gibbous 72 % · moon 23° up". The moon walks with this slider. */
  seasonNote: string;
}

export interface TimeBarOptions {
  /** [oldest, newest] yearCE the year slider spans. */
  years: [number, number];
  onChange(): void;
  readouts(): TimeBarReadouts;
  /** Opens the methods panel; wired once the panel exists. */
  onExplain?: () => void;
}

interface Row {
  input: HTMLInputElement;
  value: HTMLElement;
  note: HTMLElement;
}

export class TimeBar {
  readonly root: HTMLElement;

  private readonly year: Row;
  private readonly season: Row;
  private readonly day: Row;
  private readonly explainButton: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly state: TimeState,
    private readonly options: TimeBarOptions,
  ) {
    this.root = el('section', 'time-bar');
    this.root.setAttribute('aria-label', 'Time controls');

    const header = el('div', 'time-bar-header');
    const toggle = el('button', 'time-bar-toggle', 'Time');
    toggle.type = 'button';
    toggle.addEventListener('click', () => this.root.classList.toggle('is-collapsed'));
    this.explainButton = el('button', 'time-bar-explain', '?');
    this.explainButton.type = 'button';
    this.explainButton.title = 'How the sun, the water level and the periods are derived';
    this.explainButton.addEventListener('click', () => this.options.onExplain?.());
    header.append(toggle, this.explainButton);

    const body = el('div', 'time-bar-body');
    const [oldest, newest] = options.years;

    this.year = this.addRow(body, 'Year', oldest, newest, 10, () => this.state.yearCE, (v) => {
      this.state.yearCE = v;
    });
    // 1..365 in every year, so the slider position means the same thing however
    // far back you scrub. Leap days shift the *date* by one, which the readout
    // shows honestly rather than hiding.
    this.season = this.addRow(body, 'Time of year', 1, 365, 1, () => this.state.dayOfYear, (v) => {
      this.state.dayOfYear = v;
    });
    // 5-minute steps: finer than anyone can see the sun move, coarse enough that
    // a drag across the whole day is a manageable number of updates.
    this.day = this.addRow(body, 'Time of day', 0, 24, 1 / 12, () => this.state.solarHour, (v) => {
      this.state.solarHour = v;
    });

    this.root.append(header, body);
    // Mobile degradation, matching Legend and the old control panel: start folded
    // on a narrow viewport so the scene is not born half-covered.
    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches) {
      this.root.classList.add('is-collapsed');
    }
    parent.append(this.root);
    this.update();
  }

  /** Wire the "?" button once the methods panel exists. */
  setExplain(handler: () => void): void {
    this.options.onExplain = handler;
  }

  /** Push state -> widgets -> readouts. Dev hooks write `state` directly. */
  update(): void {
    const r = this.options.readouts();
    this.year.input.value = String(this.state.yearCE);
    this.season.input.value = String(this.state.dayOfYear);
    this.day.input.value = String(this.state.solarHour);
    this.year.value.textContent = r.year;
    this.year.note.textContent = r.yearNote;
    this.season.value.textContent = r.season;
    this.season.note.textContent = r.seasonNote;
    this.day.value.textContent = r.day;
    this.day.note.textContent = r.dayNote;
  }

  private addRow(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    read: () => number,
    write: (value: number) => void,
  ): Row {
    const row = el('div', 'time-row');
    const labelEl = el('label', 'time-row-label', label);
    const input = el('input', 'time-row-slider');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(read());
    input.setAttribute('aria-label', label);
    labelEl.htmlFor = input.id = `time-${label.replace(/\s+/g, '-').toLowerCase()}`;

    const value = el('div', 'time-row-value');
    const note = el('div', 'time-row-note');

    input.addEventListener('input', () => {
      write(Number(input.value));
      this.options.onChange();
    });

    row.append(labelEl, input, value, note);
    parent.append(row);
    return { input, value, note };
  }
}
