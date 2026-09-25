import path from 'path';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function integerValue(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function readStorageConfig(env = process.env, baseDirectory = process.cwd()) {
  const driver = String(env.AIDLINK_STORAGE_DRIVER || 'json').trim().toLowerCase();
  if (!['json', 'postgres'].includes(driver)) {
    throw new Error('AIDLINK_STORAGE_DRIVER must be either json or postgres.');
  }

  const legacyJsonPath = path.resolve(env.AIDLINK_DATA_PATH || path.join(baseDirectory, 'server', 'data.json'));
  const databaseUrl = String(env.DATABASE_URL || '').trim();
  const database = databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: String(env.PGHOST || '127.0.0.1'),
        port: integerValue(env.PGPORT, 5432),
        database: String(env.PGDATABASE || 'aidlink'),
        user: String(env.PGUSER || 'aidlink'),
        password: String(env.PGPASSWORD || ''),
      };

  return Object.freeze({
    driver,
    legacyJsonPath,
    database,
    databaseUrlConfigured: Boolean(databaseUrl),
    ssl: booleanValue(env.AIDLINK_DB_SSL, false)
      ? { rejectUnauthorized: booleanValue(env.AIDLINK_DB_SSL_REJECT_UNAUTHORIZED, true) }
      : false,
    maxConnections: integerValue(env.AIDLINK_DB_POOL_MAX, 10),
    connectionTimeoutMs: integerValue(env.AIDLINK_DB_CONNECT_TIMEOUT_MS, 5000),
    idleTimeoutMs: integerValue(env.AIDLINK_DB_IDLE_TIMEOUT_MS, 30000),
    autoMigrate: booleanValue(env.AIDLINK_DB_AUTO_MIGRATE, false),
    migrationVerified: booleanValue(env.AIDLINK_DB_MIGRATION_VERIFIED, false),
    compatibilitySnapshot: true,
  });
}

export function publicStorageConfig(config) {
  return {
    driver: config.driver,
    sslEnabled: Boolean(config.ssl),
    maxConnections: config.maxConnections,
    autoMigrate: config.autoMigrate,
    migrationVerified: config.migrationVerified,
    compatibilitySnapshot: config.compatibilitySnapshot,
  };
}
