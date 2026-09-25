import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { readStorageConfig } from '../storage/config.js';
import { createDatabase } from '../storage/database.js';
import { migrateLegacyJsonFile, verifyLegacyJsonMigration } from '../storage/legacyImporter.js';
import { migrationStatus, runMigrations } from '../storage/migrationRunner.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..');

function argumentsMap(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) continue;
    const [key, inline] = value.split('=', 2);
    if (inline !== undefined) result.set(key, inline);
    else if (args[index + 1] && !args[index + 1].startsWith('--')) result.set(key, args[++index]);
    else result.set(key, true);
  }
  return result;
}

const command = process.argv[2] || 'status';
const args = argumentsMap(process.argv.slice(3));
const config = readStorageConfig({ ...process.env, AIDLINK_STORAGE_DRIVER: 'postgres' }, projectRoot);
const database = createDatabase(config);

try {
  if (command === 'migrate') {
    const result = await runMigrations(database);
    console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
  } else if (command === 'status') {
    console.log(JSON.stringify(await migrationStatus(database), null, 2));
  } else if (command === 'import-legacy') {
    const sourcePath = path.resolve(String(args.get('--source') || config.legacyJsonPath));
    const dryRun = args.has('--dry-run');
    if (!dryRun) await runMigrations(database);
    const report = await migrateLegacyJsonFile(database, sourcePath, { dryRun });
    const defaultName = dryRun ? 'legacy-migration-dry-run.json' : 'legacy-migration-report.json';
    const reportPath = path.resolve(String(args.get('--report') || path.join(projectRoot, 'docs', 'outputs', defaultName)));
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({
      status: dryRun ? 'dry_run_complete' : 'import_complete',
      reportPath,
      replayed: Boolean(report.replayed),
      invalidRecords: report.invalid?.length || 0,
      duplicateRecords: report.duplicates?.length || 0,
    }, null, 2));
  } else if (command === 'verify-legacy') {
    const sourcePath = path.resolve(String(args.get('--source') || config.legacyJsonPath));
    const report = await verifyLegacyJsonMigration(database, sourcePath);
    const reportPath = path.resolve(String(args.get('--report') || path.join(projectRoot, 'docs', 'outputs', 'legacy-migration-verification.json')));
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ status: report.status, reportPath, mismatches: report.mismatches.length }, null, 2));
    if (report.status !== 'verified') process.exitCode = 2;
  } else {
    throw new Error('Use migrate, status, import-legacy, or verify-legacy.');
  }
} catch (error) {
  // Never print driver error details because they may contain connection configuration.
  const safeMessage = String(error?.message || '').startsWith('Applied migration ')
    ? error.message
    : 'Database operation failed. Check the server-side database configuration.';
  console.error(JSON.stringify({ status: 'failed', message: safeMessage }));
  process.exitCode = 1;
} finally {
  await database.close();
}
