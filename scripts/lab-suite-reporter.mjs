// The node:test reporter the lab fan-out runs on each worker (scripts/lab-suite.mjs).
//
// It turns the test runner's event stream into one line per fact the controller needs, each
// prefixed `LAB ` and JSON-encoded, so the controller can aggregate several workers' runs without
// parsing TAP:
//
//   {t: 'result', lane, file, name, nesting, status, ms, error?}
//        every top-level (nesting 0) result, for per-file timings, and every failure at any
//        nesting, with the failure's own message, so a failing assertion is reported where it is;
//   {t: 'summary', lane, key, value}
//        the runner's own end-of-run counts (tests, pass, fail, cancelled, skipped, todo,
//        duration_ms), taken from its nesting-0 diagnostics so the aggregate equals what the same
//        files would report in one run.
//
// The lane comes from LAB_LANE in the worker's environment. Nothing here decides what a test
// means; it only reshapes the runner's events.

const SUMMARY_KEYS = new Set(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']);

function errorMessage(error) {
  if (!error) return null;
  const inner = error.cause ?? error;
  const message = typeof inner?.message === 'string' ? inner.message : String(inner);
  return {
    message: message.length > 2000 ? `${message.slice(0, 2000)}…` : message,
    name: inner?.name ?? null,
    code: inner?.code ?? error.code ?? null,
    failureType: error.failureType ?? null,
  };
}

function line(fact) {
  return `LAB ${JSON.stringify(fact)}\n`;
}

export default async function* labTestReporter(source) {
  const lane = process.env.LAB_LANE ?? null;
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const failed = event.type === 'test:fail';
      if (data.nesting !== 0 && !failed) continue;
      const status = failed ? 'fail' : data.skip ? 'skip' : data.todo ? 'todo' : 'pass';
      yield line({
        t: 'result',
        lane,
        file: data.file ?? null,
        name: data.name,
        nesting: data.nesting,
        status,
        ms: data.details?.duration_ms ?? null,
        ...(failed ? {error: errorMessage(data.details?.error)} : {}),
      });
    } else if (event.type === 'test:diagnostic' && data.nesting === 0) {
      const match = /^(\w+) (\d+(?:\.\d+)?)$/.exec(data.message ?? '');
      if (match && SUMMARY_KEYS.has(match[1])) {
        yield line({t: 'summary', lane, key: match[1], value: Number(match[2])});
      }
    }
  }
}
