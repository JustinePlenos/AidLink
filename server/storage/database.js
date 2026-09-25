import pg from 'pg';

const { Pool } = pg;

function isolationSql(value) {
  const normalized = String(value || 'READ COMMITTED').toUpperCase();
  const allowed = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
  if (!allowed.has(normalized)) throw new Error('Unsupported transaction isolation level.');
  return normalized;
}

export function createDatabase(config, { PoolClass = Pool } = {}) {
  if (!config?.database) throw new Error('Database configuration is required.');
  const pool = new PoolClass({
    ...config.database,
    ssl: config.ssl,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    application_name: 'aidlink-api',
  });

  pool.on?.('error', () => {
    // Deliberately omit the error object: drivers may include connection details.
    console.error('An idle PostgreSQL connection failed.');
  });

  async function withTransaction(work, options = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationSql(options.isolationLevel)}`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function health() {
    const started = Date.now();
    try {
      const result = await pool.query('SELECT current_database() AS database, NOW() AS checked_at');
      return {
        status: 'ok',
        driver: 'postgres',
        latencyMs: Date.now() - started,
        checkedAt: result.rows[0]?.checked_at,
      };
    } catch {
      return { status: 'unavailable', driver: 'postgres', latencyMs: Date.now() - started };
    }
  }

  return Object.freeze({ pool, query: (...args) => pool.query(...args), withTransaction, health, close: () => pool.end() });
}
