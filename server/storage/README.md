# AidLink storage foundation

PostgreSQL is the production persistence target. JSON remains the default
compatibility adapter until a migration has been imported and verified. Both
adapters implement a storage boundary, so request and policy services do not
open JSON files or issue ad hoc SQL.

## Data model

Migration `001_production_foundation.sql` creates normalized relationships for
applicants, beneficiaries, staff accounts, requests, private document metadata,
document analyses, corrections and replacements, receipt-identified facilities,
versioned policy configurations, coverage decisions, budgets and reservations,
Guarantee Letters, notifications, and append-only audit logs.

Every request stores the policy-version ID and the decision snapshot used at the
time. Later policy changes therefore do not rewrite a historical decision.
Facility rows identify the party shown by receipt evidence; they are not an
accreditation registry.

Uploaded bytes never belong in PostgreSQL. `documents.storage_key` and the
Guarantee Letter storage-key columns refer to private file/object storage.
Authenticated endpoints must resolve those keys. Public URLs and document
contents must not be written to logs.

## Transactions and idempotency

`PostgresAidLinkRepository` owns transactional operations for request
submission, correction creation, document replacement, review decisions,
budget reservation, private Guarantee Letter storage/release/expiry,
notification enqueueing, and related audit entries. Request submissions,
replacements, budget reservations, and delivery records have database-enforced
idempotency keys. Budget rows are locked with `FOR UPDATE`; decision plus
reservation uses a serializable transaction.

Audit records contain actor, time, action, affected record, old/new values, and
justification. Update and delete triggers make the ledger append-only.

`application_snapshots` is a temporary compatibility bridge for existing
handlers while new policy services use normalized repositories. It stores
application state metadata in PostgreSQL, not uploaded binary files.

## Safe rollout and recovery

1. Back up PostgreSQL and copy the legacy JSON file. Never run the first import
   against the only copy.
2. Run `npm run db:migrate:dry-run -- --source <copy>`. This does not connect
   to or change PostgreSQL.
3. Run `npm run db:migrate`.
4. Run `npm run db:migrate:legacy -- --source <copy>`. Repeating the command
   with the same source checksum is safe and reports a replay.
5. Run `npm run db:verify:legacy -- --source <copy>`. It compares stable IDs,
   the import checksum, and the compatibility snapshot.
6. Set `AIDLINK_STORAGE_DRIVER=postgres` and
   `AIDLINK_DB_MIGRATION_VERIFIED=true` only after verification.
7. Retain the JSON source as a read-only backup through the agreed verification
   window.

Each migration and the entire legacy import run in transactions. If a migration
fails, its transaction is rolled back. If verification fails before cutover,
continue using JSON. After cutover, restore the PostgreSQL backup or temporarily
return to the unchanged JSON backup according to the deployment recovery plan;
do not manually edit migration history.

## Health and tests

`GET /api/status` reports only the storage driver, safe configuration flags,
connection state, and migration state. It never returns a URL, username, or
password.

Run `npm test` for migration-plan, legacy-read, transaction rollback,
repository idempotency, audit-schema, health, and empty-startup coverage. Set
`AIDLINK_TEST_DATABASE_URL` to a dedicated PostgreSQL test database and run
`npm run test:postgres` to also run real migrations, concurrent budget
reservations, transaction rollback, and audit immutability. The integration
test creates and removes only its randomly named schema.
