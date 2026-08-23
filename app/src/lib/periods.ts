/**
 * South-Scandinavian archaeological periods, as data.
 *
 * The names already appeared as prose in ui/methodsModel.ts ("Broborg itself is
 * dated ~400–550 CE (Migration Period) by excavation"); this is the first time
 * they are something the app can look up, so the year slider can say what age it
 * is scrubbing through.
 *
 * These boundaries are **conventions**, not events. They are the periodisation in
 * ordinary Swedish use (RAÄ, museum labels, textbooks), they vary by region and by
 * author — a Scanian and a Norrland chronology disagree by decades — and nothing
 * changed on a particular midsummer. The UI says so next to the readout; the
 * methods panel says so at length. Treat a period name as a caption, never as a
 * date.
 *
 * The table covers exactly the span the shoreline tables reach (Broborg:
 * −1050…1150) with no gaps, and is padded either side so a site with a wider
 * table still gets a name.
 */

export interface Period {
  /** Inclusive start, signed astronomical year. */
  fromYearCE: number;
  /** Exclusive end. */
  toYearCE: number;
  /** English name, used in the UI. */
  name: string;
  /** The Swedish term, used in the methods panel. */
  swedish: string;
}

/** Ordered, contiguous, no gaps. */
export const PERIODS: readonly Period[] = [
  { fromYearCE: -Infinity, toYearCE: -3900, name: 'Mesolithic', swedish: 'jägarstenålder' },
  { fromYearCE: -3900, toYearCE: -1700, name: 'Neolithic', swedish: 'bondestenålder' },
  { fromYearCE: -1700, toYearCE: -500, name: 'Bronze Age', swedish: 'bronsålder' },
  { fromYearCE: -500, toYearCE: 0, name: 'Pre-Roman Iron Age', swedish: 'förromersk järnålder' },
  { fromYearCE: 0, toYearCE: 400, name: 'Roman Iron Age', swedish: 'romersk järnålder' },
  { fromYearCE: 400, toYearCE: 550, name: 'Migration Period', swedish: 'folkvandringstid' },
  { fromYearCE: 550, toYearCE: 800, name: 'Vendel Period', swedish: 'vendeltid' },
  { fromYearCE: 800, toYearCE: 1050, name: 'Viking Age', swedish: 'vikingatid' },
  { fromYearCE: 1050, toYearCE: 1520, name: 'Middle Ages', swedish: 'medeltid' },
  { fromYearCE: 1520, toYearCE: Infinity, name: 'Early Modern', swedish: 'nyare tid' },
];

/**
 * The period a year falls in. Never null — the table is padded at both ends, so
 * every finite year has a name.
 */
export function periodAt(yearCE: number): Period {
  const y = Math.round(yearCE);
  for (const period of PERIODS) {
    if (y >= period.fromYearCE && y < period.toYearCE) return period;
  }
  // Unreachable given the ±Infinity padding, but a total function beats a cast.
  return PERIODS[PERIODS.length - 1];
}

/** The one-line honesty note the UI and the methods panel share. */
export const PERIOD_CONVENTION_NOTE =
  'Period boundaries are conventions in general Swedish use, not events; they vary by ' +
  'region and by author by decades.';
