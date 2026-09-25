
  # Admin System UI Design

  This is a code bundle for Admin System UI Design. The original project is available at https://www.figma.com/design/zXFSU3d2yk4UlgBbWu0GCv/Admin-System-UI-Design.

  ## Running the code

  Run `npm i` to install the dependencies.

  Run `npm run dev` to start the development server.

  ## Configuration

  The frontend uses `VITE_API_BASE_URL` and defaults to `http://localhost:5000`.
  The backend supports these environment variables:

  - `PORT`: API listen port, default `5000`.
  - `AIDLINK_PUBLIC_BASE_URL`: externally reachable API/file origin, such as `https://aidlink.example.gov`. QR and applicant-document URLs use this value.
  - `AIDLINK_STORAGE_DRIVER`: `json` (default for local development/migration) or `postgres`.
  - `AIDLINK_DATA_PATH`: optional path to the legacy JSON data file. It remains the read-only recovery backup after PostgreSQL is enabled.
  - `DATABASE_URL`: PostgreSQL connection string. It is read only by the backend and must never be exposed through `VITE_*` variables.
  - `AIDLINK_DB_SSL`: enable PostgreSQL TLS. `AIDLINK_DB_SSL_REJECT_UNAUTHORIZED` defaults to `true`.
  - `AIDLINK_DB_AUTO_MIGRATE`: run pending migrations under a database advisory lock at startup. It defaults to `false`; controlled deployments should normally run `npm run db:migrate` before starting.
  - `AIDLINK_DB_MIGRATION_VERIFIED`: set to `true` only after `npm run db:verify:legacy` reports `verified`.
  - `AIDLINK_UPLOADS_PATH`: optional path for uploaded files. Keep the existing uploads directory when deploying.
  - `AIDLINK_LETTERS_PATH`: required private durable storage for original and converted guarantee letters. Do not serve this directory through a web server.
  - `AIDLINK_LIBREOFFICE_PATH`: optional absolute path to the LibreOffice `soffice` executable. Defaults to `soffice` on the server `PATH`.
  - `AIDLINK_TOKEN_SECRET`: required production signing secret; replace the development default.
  - `AIDLINK_MFA_ENCRYPTION_SECRET`: required production key used to encrypt applicant TOTP secrets and key one-way recovery/OTP hashes. Keep it separate from the token signing secret.
  - `AIDLINK_MFA_AUDIT_SECRET`: optional secret shared only with the trusted MFA provider. The MFA event callback is disabled when this is not configured.

  Example production configuration:

  ```powershell
  $env:VITE_API_BASE_URL = 'https://aidlink.example.gov'
  $env:AIDLINK_PUBLIC_BASE_URL = 'https://aidlink.example.gov'
  $env:AIDLINK_TOKEN_SECRET = 'replace-with-a-long-random-secret'
  $env:AIDLINK_MFA_ENCRYPTION_SECRET = 'replace-with-a-separate-long-random-secret'
  $env:AIDLINK_MFA_AUDIT_SECRET = 'replace-with-a-separate-provider-secret'
  $env:AIDLINK_SMS_STATUS_SECRET = 'replace-with-a-separate-sms-callback-secret'
  $env:AIDLINK_DATA_PATH = 'D:\AidLink\data.json'
  $env:AIDLINK_UPLOADS_PATH = 'D:\AidLink\uploads'
  $env:AIDLINK_LETTERS_PATH = 'D:\AidLink\private-letters'
  $env:AIDLINK_LIBREOFFICE_PATH = 'C:\Program Files\LibreOffice\program\soffice.exe'
  ```

  ## PostgreSQL migration

  JSON remains the default so an install cannot silently switch stores. Use a copy
  of the current JSON file for the first three commands:

  ```powershell
  Copy-Item 'D:\AidLink\data.json' 'D:\AidLink\migration\data-copy.json'
  $env:DATABASE_URL = 'postgresql://aidlink_app:REPLACE_ME@127.0.0.1:5432/aidlink'
  npm run db:migrate:dry-run -- --source 'D:\AidLink\migration\data-copy.json'
  npm run db:migrate
  npm run db:migrate:legacy -- --source 'D:\AidLink\migration\data-copy.json'
  npm run db:verify:legacy -- --source 'D:\AidLink\migration\data-copy.json'
  ```

  Review the reports in `docs/outputs`. Only when verification reports `verified`
  should deployment set:

  ```powershell
  $env:AIDLINK_STORAGE_DRIVER = 'postgres'
  $env:AIDLINK_DB_MIGRATION_VERIFIED = 'true'
  ```

  Keep the original JSON file and upload directories unchanged and read-only
  during the verification period. If startup or verification fails, unset
  `AIDLINK_STORAGE_DRIVER` (or set it back to `json`) and point
  `AIDLINK_DATA_PATH` at the unchanged backup. Imports and each schema migration
  are transactional, so a failed run rolls back instead of leaving a partial
  application-data import. See `server/storage/README.md` for schema, recovery,
  repository, and integration-test details.

  Required-document mappings, receipt-validity rules, and identity-verification metadata remain readable from legacy JSON during migration and are represented by versioned PostgreSQL policy records after import. Historical facility and guarantee-letter metadata remains readable, but there is no current accredited-facility administration workflow. Uploaded files use the authenticated compatibility `/uploads` route; production deployments should also place the API behind HTTPS and use encrypted private object storage where practical.

  Document quality analysis is provider-neutral through
  `server/services/documentAnalyzer.js`. The deterministic adapter is active by
  default and handles file validity, format, resolution, blur, brightness,
  glare, page boundaries, cropping, and orientation. Future AI/hybrid adapters
  may add classification, missing-page or readability signals, confidence, and
  explanations, but the normalization layer never permits automated
  authenticity or eligibility decisions. Low-confidence results are marked for
  Case Worker review.

  The built-in `/uploads/:fileName` route now requires an authenticated
  applicant owner or an authorized staff account and sends private, no-store
  headers. Analyzer-derived buffers are wiped immediately, and original upload
  buffers are wiped after a required workflow copy is stored. Production should
  still use HTTPS, encrypted durable storage, backups with restricted access,
  and a documented retention/deletion schedule.

  ## Staff account provisioning

  Public staff registration is disabled. `POST /api/auth/register` always
  returns HTTP 403; applicant registration at
  `POST /api/applicant/auth/register` remains available.

  Staff accounts are managed from **Staff accounts** in the authenticated
  operations portal:

  - A System Administrator creates, deactivates, and manages staff accounts,
    resets passwords, and assigns the System Administrator or Case Worker role.
  - A Case Worker cannot access staff management or change any role.
  - A staff member cannot deactivate their own account or change their own
    privileged role.

  Deactivation is checked by the API on every protected request. Password
  resets increment the account session version, invalidating previously issued
  tokens. All staff-account changes are recorded in the server audit log
  without storing the supplied password.

  For compatibility with an existing installation, if no System Administrator
  exists, the first active legacy Administrator is promoted once when the data
  file is loaded. Remaining legacy Administrator and Reviewer accounts migrate
  to Case Worker. Confirm the promoted account with the client before deployment.

  ## Role separation

  Backend permissions, rather than navigation visibility, enforce every
  authenticated operation:

  - Case Workers can see unassigned requests and requests explicitly assigned
    or permitted to them. They can review documents and request audit history,
    request corrections, validate receipt-derived facility evidence, and
    approve or deny those requests. They may view and flag applicant identity
    proof but cannot make the final verification decision.
  - System Administrators can manage staff, active assistance types, required
    documents, receipt-validity rules, applicant identity decisions, and system settings. They can view global audit
    activity and generate reports, but cannot change request status.

  System Administrator endpoints include `/api/staff`,
  `/api/system/configuration`, `/api/system/settings`,
  `/api/audit-logs`, and `/api/reports/summary`. Case Worker access to a
  request is additionally checked against `assignedCaseWorkerId`,
  `assignedToId`, or `permittedCaseWorkerIds` when those restrictions are
  present.

  ## Application work queues

  The operations dashboard and request table share one request collection and
  one set of filters for submitted date, assistance type, receipt facility,
  and status. Queue shortcuts cover new or pending, under review, correction
  requested, approved for claiming, denied, and overdue or stale applications.
  An active request is considered stale after seven days without a submission
  or status update. Because stale is an age condition, a stale request also
  remains part of its current status queue.

  ## AidLink protected guarantee-letter workflow

  A permitted Case Worker uploads PDF, DOC, or DOCX before approval, previews
  the server-produced watermarked PDF, and explicitly confirms the current
  version. Approval is rejected until those steps are complete. DOC/DOCX
  conversion runs through the free LibreOffice headless CLI; production must
  install LibreOffice. AidLink detects the usual Windows installation paths;
  set `AIDLINK_LIBREOFFICE_PATH` for a custom installation or when `soffice`
  is not on `PATH` elsewhere. Conversion failures remain visible and cannot
  be approved.

  Originals and converted PDFs are stored under `AIDLINK_LETTERS_PATH`, never
  under `/uploads`. The requestor receives only a version-bound AidLink QR.
  Scanning opens an AidLink page which renders the PDF without download or
  print controls using a five-minute signed PDF access grant. Replacement or
  revocation immediately invalidates the earlier QR and a newly confirmed
  version receives a new token. UI controls and PDF watermarking discourage
  copying but cannot completely prevent screenshots, photographs, browser
  tools, or other capture methods. This is an AidLink protected-letter QR, not
  an official client-system QR or client-approved document template.

  Claim reference, date, time, location, and state remain recorded alongside
  the protected letter for SMS and operational tracking. Historical
  `guaranteeLetter` metadata remains readable without being migrated into the
  new workflow.

  ## Administrator activity ledger

  The **System activity** page and `GET /api/audit-logs` require the
  System Administrator audit permission. New activity records use a canonical
  schema containing the actor, action, affected record, timestamp, and
  structured details while older records are normalized when read.

  Recorded actions cover successful and failed logins, explicit logout,
  account administration, applications and document uploads, request and
  correction processing, identity verification, workflow/configuration/settings changes, and report
  generation or export. `POST /api/auth/logout` records website sign-out before
  local credentials are cleared. `POST /api/reports/export` records report
  downloads server-side.

  Applicant MFA is enforced by the backend after password verification. A TOTP
  authenticator app is the primary factor; SMS uses the provider-neutral SMS
  adapter only as a recovery/accessibility fallback. Recovery codes are returned
  once at enrollment or regeneration and only keyed one-way hashes are stored.
  TOTP secrets are encrypted with `AIDLINK_MFA_ENCRYPTION_SECRET`.

  MFA login challenges expire after five minutes, allow at most five failed
  attempts, and do not contain a full applicant session. Changing an applicant
  email, phone number, password, MFA state, or recovery codes requires a fresh
  five-minute step-up token. Step-up tokens are bound to the account/session and
  consumed after one sensitive operation. Successful sensitive changes
  invalidate other applicant sessions.

  Enrollment, verification success/failure, SMS recovery, recovery-code use,
  recovery-code regeneration, disabling MFA, and account-security changes are
  recorded in the administrator activity ledger without codes or secrets. The
  optional `POST /api/internal/mfa-events` compatibility endpoint remains
  available for trusted external identity-provider events when
  `AIDLINK_MFA_AUDIT_SECRET` is configured.

  ## Provider-neutral approval SMS

  Approval creates a persistent SMS delivery record. Claiming time/location
  and the public help channel are configured as workflow settings, while the
  provider remains a deployment adapter in
  `server/services/smsNotificationService.js`. The built-in unconfigured
  adapter never claims delivery. A later vendor adapter supplies only
  `name` and `send({ to, body, clientReference, metadata })`, keeping
  business logic independent of vendor SDKs.

  Retryable errors are scheduled with bounded exponential backoff and processed
  by the production retry worker. Case Workers can retry messages only for
  requests they are permitted to process; System Administrators can inspect
  system-wide delivery records. Provider callbacks require the separate
  `AIDLINK_SMS_STATUS_SECRET`, and every state transition is audited.
  
