CREATE TABLE workflow_policy_evaluations (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('ready_for_decision','human_review_required')),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  required_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_evidence) = 'array'),
  coverage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(coverage) = 'object'),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
  policy_versions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy_versions) = 'object'),
  human_review_flags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(human_review_flags) = 'array'),
  input_fingerprint text NOT NULL,
  evaluator_version text NOT NULL,
  remarks text NOT NULL CHECK (length(trim(remarks)) >= 10),
  evaluated_by text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_evaluation_history ON workflow_policy_evaluations (request_id, evaluated_at DESC);

CREATE TABLE workflow_evaluation_confirmations (
  id text PRIMARY KEY,
  evaluation_id text NOT NULL UNIQUE REFERENCES workflow_policy_evaluations(id) ON DELETE RESTRICT,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  evidence_reviewed boolean NOT NULL CHECK (evidence_reviewed = true),
  coverage_confirmed boolean NOT NULL CHECK (coverage_confirmed = true),
  remarks text NOT NULL CHECK (length(trim(remarks)) >= 10),
  confirmed_by text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_confirmation_history ON workflow_evaluation_confirmations (request_id, confirmed_at DESC);

ALTER TABLE requests
  ADD COLUMN latest_workflow_evaluation_id text REFERENCES workflow_policy_evaluations(id) ON DELETE SET NULL,
  ADD COLUMN latest_workflow_confirmation_id text REFERENCES workflow_evaluation_confirmations(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION prevent_workflow_evaluation_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow evaluations and confirmations are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_evaluations_no_update BEFORE UPDATE ON workflow_policy_evaluations FOR EACH ROW EXECUTE FUNCTION prevent_workflow_evaluation_mutation();
CREATE TRIGGER workflow_evaluations_no_delete BEFORE DELETE ON workflow_policy_evaluations FOR EACH ROW EXECUTE FUNCTION prevent_workflow_evaluation_mutation();
CREATE TRIGGER workflow_confirmations_no_update BEFORE UPDATE ON workflow_evaluation_confirmations FOR EACH ROW EXECUTE FUNCTION prevent_workflow_evaluation_mutation();
CREATE TRIGGER workflow_confirmations_no_delete BEFORE DELETE ON workflow_evaluation_confirmations FOR EACH ROW EXECUTE FUNCTION prevent_workflow_evaluation_mutation();

INSERT INTO policy_reason_codes (code, category, severity, description) VALUES
  ('WORKFLOW_EVALUATION_REQUIRED', 'system', 'review', 'A current staff policy evaluation is required before approval.'),
  ('WORKFLOW_EVALUATION_CHANGED', 'system', 'review', 'Documents, policy, deductions, or budget changed after staff confirmation.'),
  ('WORKFLOW_EVIDENCE_REVIEW_REQUIRED', 'evidence', 'review', 'One or more findings require human evidence review.'),
  ('WORKFLOW_COVERAGE_CONFIRMATION_REQUIRED', 'coverage', 'review', 'Case Worker coverage confirmation is required before approval.')
ON CONFLICT (code) DO NOTHING;
