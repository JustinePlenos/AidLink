import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { readStorageConfig, publicStorageConfig } from './storage/config.js';
import { createDatabase } from './storage/database.js';
import { createLegacyJsonStore } from './storage/legacyJsonStore.js';
import { buildLegacyImportPlan } from './storage/legacyImporter.js';
import { runMigrations } from './storage/migrationRunner.js';
import { PostgresAidLinkRepository } from './storage/postgresRepositories.js';
import { createPostgresSnapshotStore } from './storage/postgresSnapshotStore.js';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1')), '..');

test('storage configuration defaults to JSON and never exposes credentials', () => {
  const config = readStorageConfig({
    AIDLINK_STORAGE_DRIVER: 'postgres',
    DATABASE_URL: 'postgresql://private-user:private-password@database.internal/aidlink',
    AIDLINK_DB_SSL: 'true',
  }, projectRoot);
  const publicConfig = publicStorageConfig(config);
  assert.equal(config.driver, 'postgres');
  assert.equal(publicConfig.sslEnabled, true);
  assert.doesNotMatch(JSON.stringify(publicConfig), /private-user|private-password|database\.internal/);
});

test('legacy JSON store reads existing records, commits atomically, and rolls back failed work', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlink-json-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'data.json');
  await fs.writeFile(filePath, JSON.stringify({ requests: [{ id: 'request-stable' }] }), 'utf8');
  const store = createLegacyJsonStore({ filePath });
  assert.equal((await store.read()).requests[0].id, 'request-stable');
  await store.transaction((draft) => draft.requests.push({ id: 'request-new' }));
  assert.deepEqual((await store.read()).requests.map((item) => item.id), ['request-stable', 'request-new']);
  await assert.rejects(store.transaction((draft) => {
    draft.requests.push({ id: 'request-rolled-back' });
    throw new Error('stop');
  }), /stop/);
  assert.deepEqual((await store.read()).requests.map((item) => item.id), ['request-stable', 'request-new']);
  const backup = createLegacyJsonStore({ filePath, readOnly: true });
  await assert.rejects(backup.write({}), /read-only/);
});

test('migration planner reads a copy of current JSON and preserves every request stable ID', async () => {
  const source = JSON.parse(await fs.readFile(path.join(projectRoot, 'server', 'data.json'), 'utf8'));
  const copy = structuredClone(source);
  const { plan, report } = buildLegacyImportPlan(copy, { sourceName: 'data-copy.json' });
  assert.deepEqual(copy, source);
  assert.equal(plan.requests.length, source.requests.length);
  assert.deepEqual(new Set(plan.requests.map((item) => item.id)), new Set(source.requests.map((item) => String(item.id))));
  assert.equal(report.invalid.length, 0);
  assert.equal(report.duplicates.length, 0);
  assert.ok(plan.requests.every((item) => item.policyVersionId && item.decisionSnapshot.source === 'legacy_json_migration'));
  assert.ok(plan.documents.every((item) => item.storageKey.startsWith('legacy/')));
  assert.ok(plan.documents.every((item) => !item.storageKey.startsWith('http')));
});

test('foundation migration defines required relationships and immutable audit records', async () => {
  const sql = await fs.readFile(path.join(projectRoot, 'server', 'storage', 'migrations', '001_production_foundation.sql'), 'utf8');
  for (const table of [
    'applicants', 'applicant_aliases', 'beneficiaries', 'staff_accounts', 'staff_account_aliases', 'requests', 'documents', 'document_analyses',
    'correction_requests', 'facilities', 'policy_configurations', 'coverage_decisions', 'budgets',
    'budget_reservations', 'guarantee_letters', 'notifications', 'audit_logs',
  ]) assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
  assert.match(sql, /request_submission_idempotency/);
  assert.match(sql, /UNIQUE \(correction_id, original_document_id, idempotency_key\)/);
  assert.match(sql, /UNIQUE \(budget_id, idempotency_key\)/);
  assert.match(sql, /UNIQUE \(channel, delivery_key\)/);
  assert.match(sql, /policy_version_id/);
  assert.match(sql, /decision_snapshot jsonb NOT NULL/);
  assert.match(sql, /audit_logs_no_update/);
  assert.match(sql, /audit_logs_no_delete/);
  assert.doesNotMatch(sql, /bytea/i);
});

test('database unit of work commits successful work and rolls back failures', async () => {
  class FakePool {
    static last;
    constructor(options) {
      this.options = options;
      this.queries = [];
      this.client = {
        query: async (sql) => { this.queries.push(sql); return { rows: [] }; },
        release: () => { this.released = true; },
      };
      FakePool.last = this;
    }
    on() {}
    connect() { return this.client; }
    query(sql) {
      this.queries.push(sql);
      return { rows: [{ checked_at: new Date().toISOString() }] };
    }
    end() {}
  }
  const config = readStorageConfig({ AIDLINK_STORAGE_DRIVER: 'postgres', PGPASSWORD: 'secret-value' }, projectRoot);
  const database = createDatabase(config, { PoolClass: FakePool });
  assert.equal(await database.withTransaction(async () => 'saved'), 'saved');
  assert.deepEqual(FakePool.last.queries.slice(0, 3), ['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'COMMIT']);
  FakePool.last.queries.length = 0;
  await assert.rejects(database.withTransaction(async () => { throw new Error('failed operation'); }), /failed operation/);
  assert.deepEqual(FakePool.last.queries, ['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'ROLLBACK']);
  assert.equal((await database.health()).status, 'ok');
});

test('migration runner wraps each migration in a transaction and rolls back a failed migration', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlink-migrations-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '001_ok.sql'), 'SELECT 1;', 'utf8');
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === 'SELECT id, checksum FROM schema_migrations') return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const database = { pool: { connect: async () => client } };
  const result = await runMigrations(database, { directory });
  assert.deepEqual(result.applied, ['001_ok']);
  assert.ok(queries.includes('BEGIN'));
  assert.ok(queries.includes('COMMIT'));

  await fs.writeFile(path.join(directory, '002_bad.sql'), 'BROKEN MIGRATION;', 'utf8');
  const failingClient = {
    async query(sql) {
      if (sql === 'SELECT id, checksum FROM schema_migrations') {
        return { rows: [{ id: '001_ok', checksum: (await import('node:crypto')).createHash('sha256').update('SELECT 1;').digest('hex') }] };
      }
      queries.push(sql);
      if (sql === 'BROKEN MIGRATION;') throw new Error('migration failed');
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  await assert.rejects(runMigrations({ pool: { connect: async () => failingClient } }, { directory }), /migration failed/);
  assert.equal(queries.at(-1), 'SELECT pg_advisory_unlock($1)');
  assert.ok(queries.includes('ROLLBACK'));
});

test('idempotent repository submission returns the existing request without creating another', async () => {
  const existing = { id: 'request-one', applicant_id: 'applicant-one', client_submission_id: 'tap-one' };
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM requests WHERE applicant_id')) return { rows: [existing] };
      return { rows: [] };
    },
  };
  const repository = new PostgresAidLinkRepository({
    withTransaction: (work) => work(client),
  });
  const result = await repository.submitRequest({ applicantId: 'applicant-one', idempotencyKey: 'tap-one' });
  assert.equal(result.replayed, true);
  assert.equal(result.request.id, 'request-one');
  assert.equal(queries.filter((sql) => sql.includes('INSERT INTO requests')).length, 0);
});

test('empty PostgreSQL snapshot initialization supports first startup', async () => {
  let payload = null;
  const database = {
    async query(sql, values) {
      if (sql.includes('INSERT INTO application_snapshots')) payload ??= structuredClone(values[0]);
      if (sql.includes('SELECT payload')) return { rows: payload ? [{ payload }] : [] };
      return { rows: [], rowCount: 1 };
    },
    async withTransaction(work) { return work(this); },
    async health() { return { status: 'ok', driver: 'postgres' }; },
  };
  const store = createPostgresSnapshotStore(database);
  await store.initializeEmpty();
  const state = await store.read();
  assert.deepEqual(state.requests, []);
  assert.deepEqual(state.applicants, []);
});
