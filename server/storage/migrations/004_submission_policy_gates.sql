ALTER TABLE offices
  ADD COLUMN residency_boundary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN boundary_version integer NOT NULL DEFAULT 1 CHECK (boundary_version > 0);

ALTER TABLE applicants
  ADD COLUMN originating_office_id text REFERENCES offices(id) ON DELETE SET NULL;

ALTER TABLE requests
  ADD COLUMN patient_identity_key text,
  ADD COLUMN submission_fingerprint text,
  ADD COLUMN policy_gate_outcome text
    CHECK (policy_gate_outcome IN ('passed', 'correction_required', 'human_review_required', 'blocked')),
  ADD COLUMN cooldown_until timestamptz;

CREATE INDEX requests_patient_policy_history
  ON requests (applicant_id, patient_identity_key, assistance_type, submitted_at DESC);

CREATE TABLE request_number_counters (
  calendar_year integer PRIMARY KEY CHECK (calendar_year >= 2000),
  next_value integer NOT NULL CHECK (next_value > 0)
);

INSERT INTO request_number_counters (calendar_year, next_value)
SELECT year_value, COALESCE(max(sequence_value), 0) + 1
FROM (
  SELECT substring(request_number FROM 'LINGAP-([0-9]{4})-')::integer AS year_value,
         substring(request_number FROM 'LINGAP-[0-9]{4}-([0-9]+)$')::integer AS sequence_value
  FROM requests
  WHERE request_number ~ '^LINGAP-[0-9]{4}-[0-9]+$'
) existing
GROUP BY year_value
ON CONFLICT (calendar_year) DO NOTHING;

CREATE TABLE request_submission_guards (
  applicant_id text NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  patient_identity_key text NOT NULL,
  assistance_type text NOT NULL,
  current_request_id text REFERENCES requests(id) ON DELETE SET NULL,
  cooldown_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (applicant_id, patient_identity_key, assistance_type)
);

CREATE TABLE submission_policy_gate_evaluations (
  id text PRIMARY KEY,
  applicant_id text NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  candidate_key text NOT NULL,
  request_id text REFERENCES requests(id) ON DELETE SET NULL,
  existing_request_id text REFERENCES requests(id) ON DELETE SET NULL,
  existing_request_reference text,
  submission_fingerprint text NOT NULL,
  originating_office_id text REFERENCES offices(id) ON DELETE SET NULL,
  boundary_version integer,
  policy_version_id text REFERENCES policy_configurations(id) ON DELETE RESTRICT,
  policy_version text,
  outcome text NOT NULL CHECK (outcome IN ('passed', 'correction_required', 'human_review_required', 'blocked')),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  required_reviews jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_reviews) = 'array'),
  cooldown_end_date timestamptz,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluator_version text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submission_gate_candidate_history
  ON submission_policy_gate_evaluations (applicant_id, candidate_key, evaluated_at DESC);

CREATE TABLE submission_policy_gate_overrides (
  id text PRIMARY KEY,
  evaluation_id text NOT NULL REFERENCES submission_policy_gate_evaluations(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX submission_gate_active_override
  ON submission_policy_gate_overrides (evaluation_id);

INSERT INTO policy_reason_codes (code, category, severity, description) VALUES
  ('AUTHENTICATED_APPLICANT_MISMATCH', 'eligibility', 'review', 'The request owner does not match the authenticated applicant.'),
  ('BENEFICIARY_RELATIONSHIP_INVALID', 'eligibility', 'review', 'The beneficiary relationship is missing or inconsistent.'),
  ('ORIGINATING_OFFICE_REQUIRED', 'eligibility', 'review', 'An originating district satellite office could not be established.'),
  ('ORIGINATING_OFFICE_INACTIVE', 'eligibility', 'review', 'The originating district satellite office is inactive.'),
  ('RESIDENCY_OUTSIDE_BOUNDARY', 'eligibility', 'review', 'The beneficiary residence is outside the configured office boundary.'),
  ('RESIDENCY_REVIEW_REQUIRED', 'eligibility', 'review', 'Residency could not be determined automatically.'),
  ('REQUIRED_DOCUMENT_MISSING', 'evidence', 'warning', 'A configured supporting document is missing.'),
  ('DOCUMENT_QUALITY_FAILED', 'evidence', 'warning', 'A supporting document failed quality analysis.'),
  ('DOCUMENT_REVIEW_REQUIRED', 'evidence', 'review', 'A supporting document requires human review.'),
  ('RECEIPT_CONTEXT_INVALID', 'evidence', 'warning', 'Receipt evidence does not match the request context.'),
  ('DOCUMENT_YEAR_EXPIRED', 'expiry', 'warning', 'A calendar-year document is no longer active.'),
  ('DUPLICATE_SUBMISSION', 'eligibility', 'review', 'An active request already exists for this patient and assistance type.'),
  ('PATIENT_COOLDOWN_ACTIVE', 'eligibility', 'review', 'The per-patient submission cooldown has not ended.'),
  ('RESIDENCY_OVERRIDE_APPLIED', 'eligibility', 'information', 'Authorized staff overrode the residency finding with a recorded reason.')
ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE submission_policy_gate_evaluations IS 'Pre-decision backend policy gates; outcomes never approve or deny assistance.';

INSERT INTO policy_configurations (
  id, policy_key, version, policy_version, assistance_type, configuration,
  effective_from, effective_date, old_value, new_value, justification
) VALUES (
  'policy-submission-gates-global-v1', 'submission_gates', 1,
  'submission_gates:global:v1', NULL,
  '{"cooldownDays":30,"calendarYearDocumentTypes":["Recent facility receipt or billing document"]}'::jsonb,
  '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z', NULL,
  '{"cooldownDays":30,"calendarYearDocumentTypes":["Recent facility receipt or billing document"]}'::jsonb,
  'Initial non-decision submission policy gates.'
) ON CONFLICT (id) DO NOTHING;
