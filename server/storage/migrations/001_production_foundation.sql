CREATE TABLE applicants (
  id text PRIMARY KEY,
  email text NOT NULL,
  full_name text NOT NULL,
  phone text,
  date_of_birth date,
  address text,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'approved', 'rejected')),
  account_status text NOT NULL DEFAULT 'basic'
    CHECK (account_status IN ('basic', 'verified', 'suspended', 'deactivated')),
  password_hash text,
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  legacy_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX applicants_email_unique ON applicants (lower(email));

CREATE TABLE applicant_aliases (
  legacy_id text PRIMARY KEY,
  applicant_id text NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  source_collection text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_accounts (
  id text PRIMARY KEY,
  email text NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('System Administrator', 'Case Worker')),
  active boolean NOT NULL DEFAULT true,
  password_hash text,
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  legacy_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_email_unique ON staff_accounts (lower(email));

CREATE TABLE staff_account_aliases (
  legacy_id text PRIMARY KEY,
  staff_id text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  source_collection text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Facilities are receipt-identified parties, not an accreditation registry.
CREATE TABLE facilities (
  id text PRIMARY KEY,
  name text NOT NULL,
  facility_type text NOT NULL CHECK (facility_type IN ('hospital', 'pharmacy', 'other')),
  normalized_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX facilities_identity_unique ON facilities (normalized_name, facility_type);

CREATE TABLE policy_configurations (
  id text PRIMARY KEY,
  policy_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  assistance_type text,
  configuration jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES staff_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE UNIQUE INDEX policy_versions_unique
  ON policy_configurations (policy_key, version, (COALESCE(assistance_type, '')));
CREATE INDEX policy_effective_lookup
  ON policy_configurations (policy_key, assistance_type, active, effective_from DESC);

CREATE TABLE beneficiaries (
  id text PRIMARY KEY,
  requester_applicant_id text NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  date_of_birth date,
  address text,
  relationship_to_applicant text,
  is_requester boolean NOT NULL DEFAULT false,
  legacy_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE requests (
  id text PRIMARY KEY,
  request_number text NOT NULL UNIQUE,
  applicant_id text NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  beneficiary_id text NOT NULL REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  assistance_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'under_review', 'correction_requested', 'approved', 'denied', 'ready_for_claiming', 'claimed', 'cancelled')),
  income_source text,
  patient_circumstance text,
  additional_details text,
  facility_id text REFERENCES facilities(id) ON DELETE SET NULL,
  facility_name_snapshot text,
  facility_type_snapshot text,
  receipt_date date,
  receipt_reference text,
  claiming_date date,
  claiming_time time,
  claiming_location text,
  policy_version_id text REFERENCES policy_configurations(id) ON DELETE RESTRICT,
  decision_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_submission_id text,
  legacy_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processed_by text REFERENCES staff_accounts(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX request_submission_idempotency
  ON requests (applicant_id, client_submission_id) WHERE client_submission_id IS NOT NULL;
CREATE INDEX requests_work_queue ON requests (status, submitted_at DESC);
CREATE INDEX requests_applicant_history ON requests (applicant_id, submitted_at DESC);
CREATE INDEX requests_policy_version ON requests (policy_version_id);

CREATE TABLE documents (
  id text PRIMARY KEY,
  request_id text REFERENCES requests(id) ON DELETE RESTRICT,
  applicant_id text REFERENCES applicants(id) ON DELETE RESTRICT,
  document_type text NOT NULL,
  display_name text NOT NULL,
  storage_provider text NOT NULL DEFAULT 'private_filesystem',
  storage_key text NOT NULL,
  mime_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_document_id text REFERENCES documents(id) ON DELETE RESTRICT,
  uploaded_by text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (storage_provider, storage_key)
);
CREATE INDEX documents_request_lookup ON documents (request_id, document_type, version DESC);
CREATE INDEX documents_applicant_lookup ON documents (applicant_id, uploaded_at DESC);

CREATE TABLE document_analyses (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  analyzer_name text NOT NULL,
  analyzer_version text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'warning', 'rejected', 'manual_review')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  orientation text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  analyzed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, analyzer_name, analyzer_version)
);

CREATE TABLE correction_requests (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  requested_by text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  remark text NOT NULL CHECK (length(trim(remark)) > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'closed', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  closed_at timestamptz
);
CREATE INDEX corrections_request_history ON correction_requests (request_id, requested_at DESC);

CREATE TABLE correction_document_requirements (
  correction_id text NOT NULL REFERENCES correction_requests(id) ON DELETE RESTRICT,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  replacement_document_id text REFERENCES documents(id) ON DELETE RESTRICT,
  PRIMARY KEY (correction_id, document_id)
);

CREATE TABLE document_replacements (
  id text PRIMARY KEY,
  correction_id text NOT NULL REFERENCES correction_requests(id) ON DELETE RESTRICT,
  original_document_id text NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  replacement_document_id text NOT NULL UNIQUE REFERENCES documents(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  replaced_by text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (correction_id, original_document_id, idempotency_key)
);

CREATE TABLE budgets (
  id text PRIMARY KEY,
  name text NOT NULL,
  assistance_type text,
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency char(3) NOT NULL DEFAULT 'PHP',
  allocated_amount numeric(16,2) NOT NULL CHECK (allocated_amount >= 0),
  reserved_amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  spent_amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  policy_version_id text REFERENCES policy_configurations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (reserved_amount + spent_amount <= allocated_amount)
);

CREATE TABLE budget_reservations (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES budgets(id) ON DELETE RESTRICT,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  amount numeric(16,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released', 'expired')),
  idempotency_key text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, idempotency_key),
  UNIQUE (request_id, idempotency_key)
);
CREATE INDEX budget_reservation_lookup ON budget_reservations (budget_id, status);

CREATE TABLE coverage_decisions (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  policy_version_id text NOT NULL REFERENCES policy_configurations(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved', 'denied', 'manual_review')),
  decision_snapshot jsonb NOT NULL,
  amount numeric(16,2) CHECK (amount IS NULL OR amount >= 0),
  decided_by text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  justification text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coverage_decision_history ON coverage_decisions (request_id, decided_at DESC);

CREATE TABLE guarantee_letters (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  source_mime_type text NOT NULL,
  original_storage_key text NOT NULL,
  pdf_storage_key text,
  conversion_status text NOT NULL CHECK (conversion_status IN ('pending', 'ready', 'failed')),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'approved', 'expired', 'revoked', 'replaced')),
  uploaded_by text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  approved_at timestamptz,
  expires_at timestamptz,
  qr_token_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (request_id, version),
  UNIQUE (original_storage_key),
  UNIQUE (pdf_storage_key)
);
CREATE UNIQUE INDEX guarantee_letter_active_version
  ON guarantee_letters (request_id) WHERE status IN ('pending', 'confirmed', 'approved');

CREATE TABLE notifications (
  id text PRIMARY KEY,
  applicant_id text REFERENCES applicants(id) ON DELETE RESTRICT,
  request_id text REFERENCES requests(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('in_app', 'sms', 'email')),
  event_type text NOT NULL,
  delivery_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'delivered', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  provider_name text,
  provider_message_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (channel, delivery_key)
);
CREATE INDEX notifications_retry_queue ON notifications (status, next_attempt_at);

CREATE TABLE audit_logs (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('applicant', 'staff', 'system')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  action_type text NOT NULL,
  affected_record_type text NOT NULL,
  affected_record_id text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  justification text,
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_record_history ON audit_logs (affected_record_type, affected_record_id, occurred_at DESC);
CREATE INDEX audit_actor_history ON audit_logs (actor_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TABLE legacy_import_runs (
  id text PRIMARY KEY,
  source_sha256 text NOT NULL UNIQUE,
  source_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'rolled_back')),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Temporary compatibility bridge while request handlers are moved to normalized repositories.
-- It contains metadata/state only; uploaded binary files remain in private storage.
CREATE TABLE application_snapshots (
  id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload jsonb NOT NULL,
  source_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
