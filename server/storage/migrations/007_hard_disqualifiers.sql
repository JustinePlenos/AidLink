CREATE TABLE hard_disqualifier_evidence (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  rule_code text NOT NULL CHECK (rule_code IN ('motorcycle_helmet','impairment','active_crime','armed_group_restriction')),
  evidence_type text NOT NULL CHECK (evidence_type IN ('police_accident_report','traffic_accident_report','toxicology_report','court_record','official_law_enforcement_record','authorized_restriction_decision')),
  source_authority text NOT NULL CHECK (length(trim(source_authority)) > 0),
  source_reference text NOT NULL CHECK (length(trim(source_reference)) > 0),
  evidence_document_id text NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'object'),
  authorized boolean NOT NULL DEFAULT true CHECK (authorized = true),
  recorded_by text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE staff_capabilities DROP CONSTRAINT staff_capabilities_capability_check;
ALTER TABLE staff_capabilities ADD CONSTRAINT staff_capabilities_capability_check
  CHECK (capability IN ('cho_prescription_validate','hard_disqualifier_exception'));
CREATE INDEX hard_disqualifier_evidence_history ON hard_disqualifier_evidence (request_id, rule_code, recorded_at DESC);

CREATE TABLE hard_disqualifier_evaluations (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  policy_version_id text REFERENCES policy_configurations(id) ON DELETE RESTRICT,
  policy_version text,
  outcome text NOT NULL CHECK (outcome IN ('clear','evidence_required','human_review_required','blocked')),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  required_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_evidence) = 'array'),
  evidence_fingerprint text NOT NULL,
  evaluator_version text NOT NULL,
  evaluated_by text REFERENCES staff_accounts(id) ON DELETE SET NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text
);
CREATE INDEX hard_disqualifier_evaluation_history ON hard_disqualifier_evaluations (request_id, evaluated_at DESC);

CREATE TABLE hard_disqualifier_exceptions (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  evaluation_id text NOT NULL UNIQUE REFERENCES hard_disqualifier_evaluations(id) ON DELETE RESTRICT,
  evidence_fingerprint text NOT NULL,
  evidence_authority text NOT NULL CHECK (length(trim(evidence_authority)) > 0),
  evidence_reference text NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  evidence_document_id text NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  justification text NOT NULL CHECK (length(trim(justification)) >= 10),
  actor_id text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hard_disqualifier_exception_lookup ON hard_disqualifier_exceptions (request_id, evidence_fingerprint, created_at DESC);

ALTER TABLE hard_disqualifier_evaluations
  ADD COLUMN exception_applied_id text REFERENCES hard_disqualifier_exceptions(id) ON DELETE RESTRICT;

ALTER TABLE requests
  ADD COLUMN hard_disqualifier_outcome text NOT NULL DEFAULT 'not_evaluated'
    CHECK (hard_disqualifier_outcome IN ('not_evaluated','clear','evidence_required','human_review_required','blocked','exception_applied')),
  ADD COLUMN hard_disqualifier_evaluation_id text REFERENCES hard_disqualifier_evaluations(id) ON DELETE SET NULL,
  ADD COLUMN hard_disqualifier_exception_id text REFERENCES hard_disqualifier_exceptions(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION prevent_hard_disqualifier_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'hard-disqualifier evidence, evaluations, and exceptions are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hard_disqualifier_evidence_no_update BEFORE UPDATE ON hard_disqualifier_evidence FOR EACH ROW EXECUTE FUNCTION prevent_hard_disqualifier_event_mutation();
CREATE TRIGGER hard_disqualifier_evidence_no_delete BEFORE DELETE ON hard_disqualifier_evidence FOR EACH ROW EXECUTE FUNCTION prevent_hard_disqualifier_event_mutation();
CREATE TRIGGER hard_disqualifier_evaluations_no_update BEFORE UPDATE ON hard_disqualifier_evaluations FOR EACH ROW EXECUTE FUNCTION prevent_hard_disqualifier_event_mutation();
CREATE TRIGGER hard_disqualifier_evaluations_no_delete BEFORE DELETE ON hard_disqualifier_evaluations FOR EACH ROW EXECUTE FUNCTION prevent_hard_disqualifier_event_mutation();
CREATE TRIGGER hard_disqualifier_exceptions_no_update BEFORE UPDATE ON hard_disqualifier_exceptions FOR EACH ROW EXECUTE FUNCTION prevent_hard_disqualifier_event_mutation();
CREATE TRIGGER hard_disqualifier_exceptions_no_delete BEFORE DELETE ON hard_disqualifier_exceptions FOR EACH ROW EXECUTE FUNCTION prevent_hard_disqualifier_event_mutation();

INSERT INTO policy_configurations (
  id, policy_key, version, policy_version, assistance_type, configuration,
  effective_from, effective_date, active, created_by, actor_id, old_value, new_value, justification
) VALUES (
  'policy-hard-disqualifiers-v1', 'hard_disqualifiers', 1, 'hard_disqualifiers:global:v1', NULL,
  '{"rules":{"noHelmet":{"enabled":true,"requiredEvidenceTypes":["police_accident_report","traffic_accident_report"]},"impairment":{"enabled":true},"activeCrime":{"enabled":true,"authorizedEvidenceTypes":["official_law_enforcement_record","court_record"]},"armedGroup":{"enabled":false,"clientApprovalReference":null,"legalApprovalReference":null,"authorizedDecisionProcess":null}},"evaluationOrder":"before_coverage"}'::jsonb,
  '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z', true, NULL, NULL, NULL,
  '{"rules":{"noHelmet":{"enabled":true,"requiredEvidenceTypes":["police_accident_report","traffic_accident_report"]},"impairment":{"enabled":true},"activeCrime":{"enabled":true,"authorizedEvidenceTypes":["official_law_enforcement_record","court_record"]},"armedGroup":{"enabled":false,"clientApprovalReference":null,"legalApprovalReference":null,"authorizedDecisionProcess":null}},"evaluationOrder":"before_coverage"}'::jsonb,
  'Enable explainable hard disqualifiers while keeping the armed-group restriction disabled pending client and legal approval.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_reason_codes (code, category, severity, description) VALUES
  ('MOTORCYCLE_ACCIDENT_DETAILS_REQUIRED', 'evidence', 'review', 'Authorized accident evidence must identify whether the incident involved a motorcycle.'),
  ('MOTORCYCLE_ACCIDENT_REPORT_REQUIRED', 'evidence', 'review', 'A motorcycle accident requires a police or traffic accident report with a clear helmet finding.'),
  ('MOTORCYCLE_NO_HELMET', 'eligibility', 'review', 'Authorized accident evidence states that the rider was not wearing a helmet.'),
  ('DUI_OR_DANGEROUS_DRUG_IMPAIRMENT', 'eligibility', 'review', 'Authorized evidence records DUI or dangerous-drug impairment.'),
  ('ACTIVE_CRIME_OFFENSE', 'eligibility', 'review', 'Authorized evidence records an active crime offense connected to the request.'),
  ('ARMED_GROUP_RESTRICTION', 'eligibility', 'review', 'A client- and legal-approved documented process returned a restricted decision.'),
  ('HARD_DISQUALIFIER_EXCEPTION_APPLIED', 'eligibility', 'warning', 'A System Administrator applied an evidence-backed exception to a hard disqualifier.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO audit_logs (
  id, actor_id, actor_type, action_type, affected_record_type,
  affected_record_id, new_value, justification
) VALUES (
  'audit-hard-disqualifiers-v1', 'system', 'system', 'policy_version_created',
  'policy_configuration', 'policy-hard-disqualifiers-v1',
  '{"policyVersion":"hard_disqualifiers:global:v1","evaluationOrder":"before_coverage","armedGroupEnabled":false}'::jsonb,
  'Enable evidence-based hard disqualifiers and explicitly leave the armed-group restriction inactive pending approvals.'
) ON CONFLICT (id) DO NOTHING;
