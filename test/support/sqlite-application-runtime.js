import {DatabaseSync} from 'node:sqlite';

function isReader(sql) {
  return /^\s*SELECT\b/iu.test(sql) || /\bRETURNING\b/iu.test(sql);
}

function execute(database, sql, params = []) {
  const statement = database.prepare(sql);
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

  return {
    async start() {
      database = new DatabaseSync(filename);
      applicationDatabase = Object.freeze({
        async query(sql, params = []) {
          return execute(database, sql, params);
        },
        async transaction(work) {
          database.exec('BEGIN');
          let active = true;
          const transaction = Object.freeze({
            async query(sql, params = []) {
              if (!active) throw new TypeError('application transaction is closed');
              return execute(database, sql, params);
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
