import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const migrationDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const advisoryLockKey = 821_145_202;

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function listMigrations(directory = migrationDirectory) {
  const names = (await fs.readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await fs.readFile(path.join(directory, name), 'utf8');
    return { id: name.replace(/\.sql$/, ''), name, sql, checksum: checksum(sql) };
  }));
}

export async function runMigrations(database, { directory = migrationDirectory } = {}) {
  const client = await database.pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrations = await listMigrations(directory);
    const existing = await client.query('SELECT id, checksum FROM schema_migrations');
    const known = new Map(existing.rows.map((row) => [row.id, row.checksum]));
    for (const migration of migrations) {
      if (known.has(migration.id)) {
        if (known.get(migration.id) !== migration.checksum) {
          throw new Error(`Applied migration ${migration.id} has changed; create a new migration instead.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [migration.id, migration.checksum]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { applied, total: migrations.length };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]); } catch { /* connection cleanup releases it */ }
    client.release();
  }
}

export async function migrationStatus(database, { directory = migrationDirectory } = {}) {
  const migrations = await listMigrations(directory);
  try {
    const existing = await database.query('SELECT id, checksum FROM schema_migrations');
    const known = new Map(existing.rows.map((row) => [row.id, row.checksum]));
    const pending = migrations.filter((item) => !known.has(item.id)).map((item) => item.id);
    const changed = migrations.filter((item) => known.has(item.id) && known.get(item.id) !== item.checksum).map((item) => item.id);
    return { status: pending.length || changed.length ? 'migration_required' : 'current', pending, changed };
  } catch (error) {
    if (error?.code === '42P01') return { status: 'empty', pending: migrations.map((item) => item.id), changed: [] };
    throw error;
  }
}
