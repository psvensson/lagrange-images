export const VERSION = '0.1.0-test';

export function createEmbeddedLagrange() {
  let started = false;
  const database = Object.freeze({
    async query() { return {success: true, rows: [], rowCount: 0}; },
    async transaction(work) {
      return await work(this);
    },
  });
  return Object.freeze({
    async start() { started = true; },
    openApplicationDatabase() {
      if (!started) throw new TypeError('runtime is not started');
      return database;
    },
    async stop() { started = false; },
  });
}
