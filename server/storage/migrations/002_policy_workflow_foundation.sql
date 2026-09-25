CREATE TABLE offices (
  id text PRIMARY KEY,
  office_code text NOT NULL UNIQUE,
  name text NOT NULL,
  office_type text NOT NULL CHECK (office_type IN ('central', 'district_satellite')),
  district_code text,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE staff_accounts DROP CONSTRAINT staff_accounts_role_check;
ALTER TABLE staff_accounts ADD CONSTRAINT staff_accounts_role_check
  CHECK (role IN ('Case Worker', 'System Administrator', 'Super Admin'));

CREATE TABLE staff_office_assignments (
  staff_id text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  office_id text NOT NULL REFERENCES offices(id) ON DELETE RESTRICT,
  assigned_by text REFERENCES staff_accounts(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, office_id)
);

ALTER TABLE policy_configurations
  ADD COLUMN policy_version text,
  ADD COLUMN effective_date timestamptz,
  ADD COLUMN actor_id text REFERENCES staff_accounts(id) ON DELETE SET NULL,
  ADD COLUMN old_value jsonb,
  ADD COLUMN new_value jsonb,
  ADD COLUMN justification text;

UPDATE policy_configurations
SET policy_version = concat(policy_key, ':', COALESCE(assistance_type, 'global'), ':v', version),
    effective_date = effective_from,
    actor_id = created_by,
    new_value = configuration,
    justification = 'Migrated existing policy configuration.'
WHERE policy_version IS NULL;

ALTER TABLE policy_configurations
  ALTER COLUMN policy_version SET NOT NULL,
  ALTER COLUMN effective_date SET NOT NULL,
  ALTER COLUMN new_value SET NOT NULL,
  ALTER COLUMN justification SET NOT NULL;
ALTER TABLE policy_configurations ADD CONSTRAINT policy_justification_required
  CHECK (length(trim(justification)) > 0);
CREATE UNIQUE INDEX policy_version_identifier_unique ON policy_configurations (policy_version);

ALTER TABLE requests
  ADD COLUMN originating_office_id text REFERENCES offices(id) ON DELETE SET NULL,
  ADD COLUMN policy_version text,
  ADD COLUMN policy_findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN required_reviews jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE requests r
SET policy_version = p.policy_version
FROM policy_configurations p
WHERE r.policy_version_id = p.id AND r.policy_version IS NULL;

ALTER TABLE requests ADD CONSTRAINT request_policy_findings_array
  CHECK (jsonb_typeof(policy_findings) = 'array');
ALTER TABLE requests ADD CONSTRAINT request_required_reviews_array
  CHECK (jsonb_typeof(required_reviews) = 'array');
CREATE INDEX requests_originating_office_queue
  ON requests (originating_office_id, status, submitted_at DESC);

CREATE TABLE policy_reason_codes (
  code text PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('eligibility', 'coverage', 'expiry', 'budget', 'evidence', 'system')),
  severity text NOT NULL CHECK (severity IN ('information', 'warning', 'review')),
  description text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO policy_reason_codes (code, category, severity, description) VALUES
  ('POLICY_FOUNDATION_ONLY', 'system', 'information', 'No blocking policy rule is enabled.'),
  ('POLICY_NOT_CONFIGURED', 'system', 'review', 'No effective policy configuration was found.'),
  ('EVIDENCE_REVIEW_REQUIRED', 'evidence', 'review', 'Submitted evidence requires staff review.'),
  ('POLICY_INPUT_INCOMPLETE', 'system', 'review', 'One or more policy inputs are incomplete.'),
  ('LEGACY_REQUEST_METADATA_DEFAULTED', 'system', 'information', 'Legacy request policy metadata was defaulted for compatibility.');

CREATE TABLE policy_evaluations (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  policy_version_id text REFERENCES policy_configurations(id) ON DELETE RESTRICT,
  policy_version text,
  evaluator_name text NOT NULL,
  evaluator_version text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('advisory', 'review_required', 'not_applicable')),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  required_reviews jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_reviews) = 'array'),
  decision_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluated_by text REFERENCES staff_accounts(id) ON DELETE SET NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text
);
CREATE INDEX policy_evaluations_request_history
  ON policy_evaluations (request_id, evaluated_at DESC);

COMMENT ON TABLE policy_evaluations IS 'Backend-only policy results. Foundation outcomes are advisory and cannot make an eligibility or authenticity decision.';
COMMENT ON COLUMN requests.decision_snapshot IS 'Immutable-at-decision backend snapshot used to reproduce historical policy and coverage decisions.';
