export const meta = {
  name: 'pilot-batch',
  description: 'Build and publish a list of registry fornborg sites to the object host',
  whenToUse:
    'Phase 9b/9c batch runs: pass a list of registry slugs and this builds, QA-gates ' +
    'and uploads each one, then rebuilds the national index and QA contact sheet. ' +
    'Resumable — a site whose R2 bundle already matches its local state is skipped.',
  phases: [
    { title: 'Build', detail: 'one agent per site, running the batch CLI', model: 'haiku' },
    { title: 'Publish', detail: 'national index.json + QA contact sheet' },
  ],
};

// ---------------------------------------------------------------------------
// Phase 9b/9c batch orchestration (docs/national-scaleout.md §7).
//
// The division of labour here is deliberate and is the whole point of the file:
//
//   * The per-site agents run a FINISHED CLI. `fornborg_pipeline.batch` already
//     does build -> QA -> upload -> record -> evict, decides for itself what can
//     be skipped, and prints a one-line verdict with a meaningful exit code.
//     There is no problem left for an agent to solve, so they run on Haiku at
//     low effort and are told, in as many words, not to attempt fixes.
//   * Every judgement call — a QA gate that fired, a site that failed twice, a
//     decision to change code and re-run — happens in the main session, or in a
//     single stronger agent if a failure genuinely needs investigating. A
//     cheap runner that starts debugging is worse than one that reports and
//     stops, because its guesses arrive dressed as findings.
//
// Politeness and disk are structural, not advisory:
//   * CONCURRENCY caps how many sites fetch from Lantmäteriet at once. The
//     pipeline is already 429-aware (Retry-After honoured, five attempts), so
//     this is about not being rude in the first place. Bulk fetching CC BY open
//     data is legitimate; the manner should still be courteous.
//   * Each site evicts its scratch bundle and its cached DEM mosaics after a
//     successful upload, so peak disk is roughly CONCURRENCY x ~60 MB of
//     mosaics rather than the whole batch's worth.
//
// Resumability: `batch --slug` consults the per-site state file first, so a
// rerun over the same list does the new and failed sites and skips the rest for
// the price of one hash comparison per file. Rerunning is the recovery
// procedure, and rerunning a finished batch is nearly free.
//
// Usage:
//   Workflow({ scriptPath: '.claude/workflows/pilot-batch.mjs',
//              args: { slugs: ['l1976-4254', ...], concurrency: 3 } })
// ---------------------------------------------------------------------------

const input = args ?? {};
const SLUGS = Array.isArray(input) ? input : (input.slugs ?? []);
// Keep it low: three concurrent site builds is a handful of windowed reads at a
// time against api.lantmateriet.se, not a crawl.
const CONCURRENCY = Math.max(1, Math.min(3, input.concurrency ?? 3));
const REPO = input.repo ?? '/home/user/fornborgar';
const EXTRA_FLAGS = input.flags ?? '';

if (SLUGS.length === 0) {
  log('No slugs given — pass { slugs: [...] } as args. Nothing to do.');
  return { built: [], failed: [], skipped: [] };
}

// The runner prompt is fixed text on purpose. These agents are a transport for
// a CLI's stdout; anything that invites them to interpret it invites them to
// improvise, and an improvised fix in a batch of 25 is 25 different bundles.
function runnerPrompt(slug) {
  return [
    `Run exactly this command and nothing else:`,
    ``,
    `cd ${REPO}/pipeline && python3 -m fornborg_pipeline.batch --slug ${slug}${EXTRA_FLAGS ? ' ' + EXTRA_FLAGS : ''}`,
    ``,
    `Then report, as your entire final message:`,
    `  1. the command's exit code;`,
    `  2. the final "== ..." summary line verbatim;`,
    `  3. every line beginning with "  [warn]" or "  [fail]" verbatim.`,
    ``,
    `If the command fails for any reason, report the exit code and the last 30`,
    `lines of output VERBATIM. Do NOT diagnose it, do NOT edit any file, do NOT`,
    `re-run it, and do NOT try an alternative command. Reporting the failure`,
    `accurately IS the successful outcome of your task — someone else fixes it.`,
  ].join('\n');
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'exitCode', 'summary'],
  properties: {
    slug: { type: 'string' },
    exitCode: { type: 'integer' },
    summary: { type: 'string', description: 'The == summary line, verbatim' },
    qaLines: { type: 'array', items: { type: 'string' }, description: 'warn/fail lines, verbatim' },
    output: { type: 'string', description: 'Last 30 lines of output, only when the command failed' },
  },
};

phase('Build');
log(`${SLUGS.length} site(s), ${CONCURRENCY} at a time (429-aware, scratch evicted after each upload)`);

const results = [];
for (let start = 0; start < SLUGS.length; start += CONCURRENCY) {
  const group = SLUGS.slice(start, start + CONCURRENCY);
  // A barrier per group is exactly what the concurrency cap means: no fourth
  // site starts fetching until one of these three is done.
  const groupResults = await parallel(
    group.map((slug) => () =>
      agent(runnerPrompt(slug), {
        label: `build:${slug}`,
        phase: 'Build',
        schema: RESULT_SCHEMA,
        model: 'claude-haiku-4-5-20251001',
        effort: 'low',
      }).then((r) => r ?? { slug, exitCode: -1, summary: `${slug}: runner produced no result` }),
    ),
  );
  for (const result of groupResults) {
    results.push(result ?? { slug: 'unknown', exitCode: -1, summary: 'runner died' });
  }
  const done = Math.min(start + CONCURRENCY, SLUGS.length);
  const ok = results.filter((r) => r.exitCode === 0).length;
  log(`${done}/${SLUGS.length} attempted, ${ok} succeeded so far`);
}

const succeeded = results.filter((r) => r.exitCode === 0);
const failed = results.filter((r) => r.exitCode !== 0);
const skipped = succeeded.filter((r) => (r.summary ?? '').includes('SKIPPED'));

// The index and the contact sheet are aggregate views over the per-site state
// files, so they are rebuilt once at the end rather than after every site — and
// they are rebuilt even when some sites failed, because the sites that DID
// publish should be reachable while the failures are being sorted out.
phase('Publish');
const publish = await agent(
  [
    `Run exactly this command and nothing else:`,
    ``,
    `cd ${REPO}/pipeline && python3 -m fornborg_pipeline.batch --index --contact-sheet`,
    ``,
    `Then report, as your entire final message: the exit code and every "== " line verbatim.`,
    `Do NOT edit any file and do NOT attempt any fix if it fails — report it verbatim.`,
  ].join('\n'),
  {
    label: 'publish:index+sheet',
    phase: 'Publish',
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['exitCode', 'lines'],
      properties: {
        exitCode: { type: 'integer' },
        lines: { type: 'array', items: { type: 'string' } },
      },
    },
  },
);

log(`done: ${succeeded.length} ok (${skipped.length} already published), ${failed.length} failed`);

return {
  attempted: SLUGS.length,
  succeeded: succeeded.map((r) => r.summary),
  skipped: skipped.map((r) => r.slug),
  failed: failed.map((r) => ({ slug: r.slug, exitCode: r.exitCode, summary: r.summary, output: r.output })),
  // Every warn/fail line any gate produced, for the main session to judge.
  qa: results.flatMap((r) => (r.qaLines ?? []).map((line) => `${r.slug}: ${line}`)),
  publish: publish ?? { exitCode: -1, lines: ['publish agent produced no result'] },
};
