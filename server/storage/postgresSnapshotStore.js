const emptyApplicationState = () => ({
  authUsers: [],
  nextAuthUserId: 1,
  nextUserId: 1,
  nextRequestId: 1,
  users: [],
  requests: [],
  auditLogs: [],
  nextAuditId: 1,
  applicants: [],
  nextApplicantId: 1,
  notifications: [],
  nextNotificationId: 1,
  facilities: [],
  requiredDocuments: {},
  systemSettings: {},
  assistanceTypeSettings: {},
  smsNotifications: [],
  nextSmsNotificationId: 1,
  documentUploads: [],
  mfaChallenges: [],
  nextMfaChallengeId: 1,
  usedStepUpTokens: [],
});

export function createPostgresSnapshotStore(database) {
  let queue = Promise.resolve();

  async function read() {
    const result = await database.query(`SELECT payload FROM application_snapshots WHERE id = 'primary'`);
    if (!result.rows[0]) throw new Error('PostgreSQL storage has not been initialized. Run the legacy migration or empty-database initialization first.');
    return structuredClone(result.rows[0].payload);
  }

  async function write(value) {
    await database.withTransaction(async (client) => {
      await client.query(`SELECT id FROM application_snapshots WHERE id = 'primary' FOR UPDATE`);
      await client.query(`
        INSERT INTO application_snapshots (id, payload)
        VALUES ('primary', $1)
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload,
          revision = application_snapshots.revision + 1, updated_at = now()
      `, [value]);
    });
  }

  async function transaction(work) {
    const pending = queue.then(() => database.withTransaction(async (client) => {
      const current = await client.query(`SELECT payload FROM application_snapshots WHERE id = 'primary' FOR UPDATE`);
      const draft = structuredClone(current.rows[0]?.payload || emptyApplicationState());
      const result = await work(draft, client);
      await client.query(`
        INSERT INTO application_snapshots (id, payload)
        VALUES ('primary', $1)
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload,
          revision = application_snapshots.revision + 1, updated_at = now()
      `, [draft]);
      return result;
    }));
    queue = pending.catch(() => undefined);
    return pending;
  }

  async function initializeEmpty() {
    await database.query(`
      INSERT INTO application_snapshots (id, payload) VALUES ('primary', $1)
      ON CONFLICT (id) DO NOTHING
    `, [emptyApplicationState()]);
  }

  return Object.freeze({ read, write, transaction, initializeEmpty, health: database.health });
}

export { emptyApplicationState };
