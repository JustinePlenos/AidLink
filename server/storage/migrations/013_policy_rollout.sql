ALTER TABLE submission_policy_gate_evaluations
  ADD COLUMN raw_outcome text CHECK (raw_outcome IS NULL OR raw_outcome IN ('passed','correction_required','human_review_required','blocked')),
  ADD COLUMN enforcement_mode text NOT NULL DEFAULT 'report_only' CHECK (enforcement_mode IN ('disabled','report_only','enabled')),
  ADD COLUMN enforced_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(enforced_reason_codes) = 'array'),
  ADD COLUMN report_only_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(report_only_reason_codes) = 'array'),
  ADD COLUMN rollout_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rollout_snapshot) = 'object');

ALTER TABLE workflow_policy_evaluations
  ADD COLUMN rollout_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rollout_snapshot) = 'object'),
  ADD COLUMN enforced_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(enforced_reason_codes) = 'array'),
  ADD COLUMN report_only_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(report_only_reason_codes) = 'array');

CREATE TABLE policy_decision_comparisons (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  workflow_evaluation_id text REFERENCES workflow_policy_evaluations(id) ON DELETE RESTRICT,
  predicted_decision text NOT NULL CHECK (predicted_decision IN ('approve','deny_or_review')),
  staff_decision text NOT NULL CHECK (staff_decision IN ('approved','denied')),
  matched boolean NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
  rollout_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rollout_snapshot) = 'object'),
  actor_id text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  compared_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_decision_comparison_history ON policy_decision_comparisons (request_id, compared_at DESC);

CREATE TRIGGER policy_decision_comparisons_no_update BEFORE UPDATE ON policy_decision_comparisons FOR EACH ROW EXECUTE FUNCTION prevent_workflow_evaluation_mutation();
CREATE TRIGGER policy_decision_comparisons_no_delete BEFORE DELETE ON policy_decision_comparisons FOR EACH ROW EXECUTE FUNCTION prevent_workflow_evaluation_mutation();

INSERT INTO policy_configurations (
  id, policy_key, version, policy_version, assistance_type, configuration,
  effective_from, effective_date, old_value, new_value, justification, published_at
) VALUES (
  'policy-rollout-global-v1', 'policy_rollout', 1, 'policy_rollout:global:v1', NULL,
  '{"rules":{"thresholds":{"mode":"report_only","approvalReference":null},"facility_directory":{"mode":"report_only","approvalReference":null},"residency":{"mode":"report_only","approvalReference":null},"cooldown":{"mode":"report_only","approvalReference":null},"document_year":{"mode":"report_only","approvalReference":null},"coverage_reductions":{"mode":"report_only","approvalReference":null},"hard_rejections":{"mode":"report_only","approvalReference":null},"payer_deductions":{"mode":"report_only","approvalReference":null},"budget":{"mode":"report_only","approvalReference":null}}}'::jsonb,
  '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z', NULL,
  '{"rules":{"thresholds":{"mode":"report_only","approvalReference":null},"facility_directory":{"mode":"report_only","approvalReference":null},"residency":{"mode":"report_only","approvalReference":null},"cooldown":{"mode":"report_only","approvalReference":null},"document_year":{"mode":"report_only","approvalReference":null},"coverage_reductions":{"mode":"report_only","approvalReference":null},"hard_rejections":{"mode":"report_only","approvalReference":null},"payer_deductions":{"mode":"report_only","approvalReference":null},"budget":{"mode":"report_only","approvalReference":null}}}'::jsonb,
  'Initial guarded rollout. Every new policy rule is report-only until separately approved and enabled.', now()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_reason_codes (code, category, severity, description) VALUES
  ('POLICY_REPORT_ONLY', 'system', 'information', 'A policy finding was recorded for comparison but was not enforced.'),
  ('CLIENT_APPROVAL_REQUIRED', 'system', 'review', 'Client approval must be recorded before a policy rule can block a request.')
ON CONFLICT (code) DO NOTHING;
