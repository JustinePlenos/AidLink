CREATE TABLE coverage_input_versions (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  input_data jsonb NOT NULL CHECK (jsonb_typeof(input_data) = 'object'),
  verified_by text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  verification_source text NOT NULL CHECK (verification_source IN ('staff','integration')),
  justification text NOT NULL CHECK (length(trim(justification)) >= 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, version)
);
CREATE INDEX coverage_input_history ON coverage_input_versions (request_id, version DESC);

CREATE TABLE coverage_calculation_snapshots (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  input_version_id text NOT NULL REFERENCES coverage_input_versions(id) ON DELETE RESTRICT,
  policy_version_id text NOT NULL REFERENCES policy_configurations(id) ON DELETE RESTRICT,
  policy_version text NOT NULL,
  hard_disqualifier_evaluation_id text REFERENCES hard_disqualifier_evaluations(id) ON DELETE RESTRICT,
  calculator_version text NOT NULL,
  input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  calculated_by text REFERENCES staff_accounts(id) ON DELETE SET NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text
);
CREATE INDEX coverage_snapshot_history ON coverage_calculation_snapshots (request_id, calculated_at DESC);

ALTER TABLE requests
  ADD COLUMN coverage_matrix_outcome text NOT NULL DEFAULT 'not_calculated'
    CHECK (coverage_matrix_outcome IN ('not_calculated','eligible','partially_covered','ineligible')),
  ADD COLUMN coverage_snapshot_id text REFERENCES coverage_calculation_snapshots(id) ON DELETE SET NULL;

ALTER TABLE coverage_decisions
  ADD COLUMN coverage_snapshot_id text REFERENCES coverage_calculation_snapshots(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION prevent_coverage_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'coverage inputs and calculation snapshots are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER coverage_inputs_no_update BEFORE UPDATE ON coverage_input_versions FOR EACH ROW EXECUTE FUNCTION prevent_coverage_snapshot_mutation();
CREATE TRIGGER coverage_inputs_no_delete BEFORE DELETE ON coverage_input_versions FOR EACH ROW EXECUTE FUNCTION prevent_coverage_snapshot_mutation();
CREATE TRIGGER coverage_snapshots_no_update BEFORE UPDATE ON coverage_calculation_snapshots FOR EACH ROW EXECUTE FUNCTION prevent_coverage_snapshot_mutation();
CREATE TRIGGER coverage_snapshots_no_delete BEFORE DELETE ON coverage_calculation_snapshots FOR EACH ROW EXECUTE FUNCTION prevent_coverage_snapshot_mutation();

INSERT INTO policy_configurations (
  id, policy_key, version, policy_version, assistance_type, configuration,
  effective_from, effective_date, active, created_by, actor_id, old_value, new_value, justification
) VALUES (
  'policy-coverage-matrix-v1', 'coverage_matrix', 1, 'coverage_matrix:global:v1', NULL,
  '{"status":"awaiting_client_values","publicHospitalRoomReductions":{"semi_private":null,"private":null},"outsidePharmacyMedicineReductionRate":null,"partialIndigentSubsidyBands":[],"coverageCaps":{"default":null,"byAssistanceType":{}},"payerDeductions":{"enabled":false,"required":false,"approvedPayerTypes":[],"verificationMethods":["staff","integration"],"clientApprovalReference":null},"calculationOrder":["hard_disqualifiers","verified_payer_deductions","coverage_reductions","scaled_subsidy","policy_cap","net_remaining_balance"]}'::jsonb,
  '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z', true, NULL, NULL, NULL,
  '{"status":"awaiting_client_values","publicHospitalRoomReductions":{"semi_private":null,"private":null},"outsidePharmacyMedicineReductionRate":null,"partialIndigentSubsidyBands":[],"coverageCaps":{"default":null,"byAssistanceType":{}},"payerDeductions":{"enabled":false,"required":false,"approvedPayerTypes":[],"verificationMethods":["staff","integration"],"clientApprovalReference":null},"calculationOrder":["hard_disqualifiers","verified_payer_deductions","coverage_reductions","scaled_subsidy","policy_cap","net_remaining_balance"]}'::jsonb,
  'Create the coverage-matrix foundation without inventing client rates, caps, subsidy bands, or payer deductions.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_reason_codes (code, category, severity, description) VALUES
  ('COVERAGE_MATRIX_PENDING_CLIENT_VALUES', 'coverage', 'review', 'Coverage values are awaiting client approval.'),
  ('HARD_DISQUALIFIER_NOT_CLEARED', 'eligibility', 'review', 'Coverage cannot run until hard disqualifiers are cleared.'),
  ('VERIFIED_PAYER_DATA_REQUIRED', 'evidence', 'review', 'Verified payer data is required by the active coverage policy.'),
  ('UNVERIFIED_OR_UNAPPROVED_PAYER_IGNORED', 'evidence', 'warning', 'An unverified or unapproved payer entry was not deducted.'),
  ('VERIFIED_PAYER_DEDUCTION_APPLIED', 'coverage', 'information', 'An approved staff- or integration-verified payer deduction was applied.'),
  ('NO_POSITIVE_REMAINING_BALANCE', 'coverage', 'information', 'No positive balance remains after verified payer deductions.'),
  ('PUBLIC_HOSPITAL_UPGRADED_ROOM_REDUCTION', 'coverage', 'warning', 'Coverage was reduced for an upgraded public-hospital room.'),
  ('OUTSIDE_PHARMACY_MEDICINE_REDUCTION', 'coverage', 'warning', 'Coverage was reduced for qualifying medicine from an unaccredited outside pharmacy.'),
  ('PARTIAL_INDIGENT_SUBSIDY_SCALED', 'coverage', 'information', 'A verified partial-indigent subsidy band was applied.'),
  ('VERIFIED_SUBSIDY_BAND_REQUIRED', 'evidence', 'review', 'A verified client-approved subsidy band is required.'),
  ('COVERAGE_POLICY_CAP_APPLIED', 'coverage', 'information', 'The client-approved coverage cap limited the subsidy.'),
  ('NO_COVERED_AMOUNT', 'coverage', 'review', 'The active matrix produced no covered amount.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO audit_logs (id, actor_id, actor_type, action_type, affected_record_type, affected_record_id, new_value, justification)
VALUES ('audit-coverage-matrix-v1','system','system','policy_version_created','policy_configuration','policy-coverage-matrix-v1',
  '{"policyVersion":"coverage_matrix:global:v1","status":"awaiting_client_values","payerDeductionsEnabled":false}'::jsonb,
  'Store the pending coverage framework while requiring client-approved rates, caps, bands, and payer handling before activation.')
ON CONFLICT (id) DO NOTHING;
