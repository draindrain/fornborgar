/** Types for `console-triage.mjs`, so `tests/` can import it under `tsc --noEmit`. */

export declare const NON_ESSENTIAL_RESOURCES: readonly string[];

export interface ConsoleEntry {
  text: string;
  url?: string;
}

export interface RequestFailure {
  url: string;
  errorText: string;
}

export interface Triage {
  pageErrors: ConsoleEntry[];
  environmental: { text: string; url: string }[];
  unexpectedRequestFailures: RequestFailure[];
}

export declare function isTransportFailure(text: string): boolean;

export declare function triageConsoleErrors(input: {
  consoleErrors: ConsoleEntry[];
  requestFailures?: RequestFailure[];
  nonEssential?: readonly string[];
}): Triage;

export declare function describeEnvironmental(
  environmental: { text: string; url: string }[],
): string[];
