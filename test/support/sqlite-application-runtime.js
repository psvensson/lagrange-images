import {DatabaseSync} from 'node:sqlite';

function isReader(sql) {
  return /^\s*SELECT\b/iu.test(sql) || /\bRETURNING\b/iu.test(sql);
}

// The file-backed stand-in for a Lagrange application database session that the durable-restart
// proofs (M4, M5, M6, managed installation, residency, the SQL mapping restart) run on.
//
// Two settings keep it fast without weakening what those proofs claim (bead kq98). Statements are
// prepared once per SQL text per open database, because the adapter issues the same handful of
// statements thousands of times and re-preparing each one was the largest single cost of the M5
// witness (profiled on a lab worker: 27% of its 80 s). And a file database runs in WAL mode with
// synchronous=NORMAL, so a commit no longer waits for a disk sync. Every proof here restarts by
// CLOSING the runtime and opening a fresh one over the same file, which WAL makes exactly as
// durable as before: a committed transaction is in the file (or its WAL, checkpointed on close)
// when the next connection opens. What NORMAL gives up is durability across a power failure,
// which no test here simulates or claims. An in-memory database keeps SQLite's defaults.
function statementFor(cache, database, sql) {
  let statement = cache.get(sql);
  if (!statement) {
    statement = database.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

function execute(database, sql, params = [], cache = null) {
  const statement = cache ? statementFor(cache, database, sql) : database.prepare(sql);
  if (isReader(sql)) {
    const rows = statement.all(...params);
    return {success: true, rows, rowCount: rows.length};
  }
  const result = statement.run(...params);
  return {success: true, rows: [], affectedRows: Number(result.changes)};
}

function createSqliteApplicationRuntime(filename = ':memory:') {
  let database = null;
  let applicationDatabase = null;
  let statements = null;

  return {
    async start() {
      database = new DatabaseSync(filename);
      statements = new Map();
      if (filename !== ':memory:') {
        database.exec('PRAGMA journal_mode = WAL');
        database.exec('PRAGMA synchronous = NORMAL');
      }
      applicationDatabase = Object.freeze({
        async query(sql, params = []) {
          return execute(database, sql, params, statements);
        },
        async transaction(work) {
          database.exec('BEGIN');
          let active = true;
          const transaction = Object.freeze({
            async query(sql, params = []) {
              if (!active) throw new TypeError('application transaction is closed');
              return execute(database, sql, params, statements);
            },
          });
          try {
            const result = await work(transaction);
            database.exec('COMMIT');
            return result;
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          } finally {
            active = false;
          }
        },
      });
    },
    openApplicationDatabase() {
      if (!applicationDatabase) throw new TypeError('runtime is not started');
      return applicationDatabase;
    },
    async stop() {
      statements = null;
      database?.close();
      database = null;
      applicationDatabase = null;
    },
    listTables() {
      if (!database) throw new TypeError('runtime is not started');
      return database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all().map(({name}) => name);
    },
  };
}

export {createSqliteApplicationRuntime};
