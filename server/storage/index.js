import { readStorageConfig, publicStorageConfig } from './config.js';
import { createDatabase } from './database.js';
import { createLegacyJsonStore } from './legacyJsonStore.js';
import { migrationStatus, runMigrations } from './migrationRunner.js';
import { createPostgresRepositories } from './postgresRepositories.js';
import { createPostgresSnapshotStore } from './postgresSnapshotStore.js';

function hasLegacyRecords(data) {
  return ['applicants', 'authUsers', 'requests', 'auditLogs'].some((key) => Array.isArray(data?.[key]) && data[key].length > 0);
}

export function createStorageFoundation({ env = process.env, baseDirectory = process.cwd() } = {}) {
  const config = readStorageConfig(env, baseDirectory);
  const legacyStore = createLegacyJsonStore({ filePath: config.legacyJsonPath, readOnly: config.driver === 'postgres' });
  const database = config.driver === 'postgres' ? createDatabase(config) : null;
  const dataStore = database ? createPostgresSnapshotStore(database) : legacyStore;
  const repositories = database ? createPostgresRepositories(database) : null;
  let initialized = false;

  async function initialize() {
    if (initialized) return;
    if (!database) {
      const state = await legacyStore.health();
      if (state.status !== 'ok') throw new Error('The configured JSON data file is unavailable.');
      initialized = true;
      return;
    }
    if (config.autoMigrate) await runMigrations(database);
    const status = await migrationStatus(database);
    if (status.status !== 'current') {
      throw new Error('PostgreSQL migrations are not current. Run npm run db:migrate before starting AidLink.');
    }
    const snapshot = await database.query(`SELECT source_sha256 FROM application_snapshots WHERE id = 'primary'`);
    if (!snapshot.rows[0]) {
      let legacyData = null;
      try { legacyData = await legacyStore.read(); } catch { /* an empty deployment may not have a legacy file */ }
      if (hasLegacyRecords(legacyData)) {
        throw new Error('Legacy data has not been imported. Run npm run db:migrate:legacy and verify its report before enabling PostgreSQL.');
      }
      await dataStore.initializeEmpty();
    } else if (snapshot.rows[0].source_sha256 && !config.migrationVerified) {
      throw new Error('The imported database is not marked verified. Set AIDLINK_DB_MIGRATION_VERIFIED=true only after reviewing the migration report.');
    }
    initialized = true;
  }

  async function health() {
    if (!database) return { ...(await legacyStore.health()), configuration: publicStorageConfig(config) };
    const connection = await database.health();
    if (connection.status !== 'ok') return { ...connection, configuration: publicStorageConfig(config) };
    let migrations;
    try { migrations = await migrationStatus(database); } catch { migrations = { status: 'unavailable' }; }
    return { ...connection, migrations, configuration: publicStorageConfig(config) };
  }

  return Object.freeze({
    config,
    dataStore,
    legacyStore,
    database,
    repositories,
    initialize,
    health,
    close: () => database?.close(),
  });
}
