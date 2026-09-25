CREATE TABLE facility_directory_versions (
  id text PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version > 0),
  directory_version text NOT NULL UNIQUE,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  directory jsonb NOT NULL CHECK (jsonb_typeof(directory) = 'object'),
  actor_id text REFERENCES staff_accounts(id) ON DELETE SET NULL,
  old_value jsonb,
  new_value jsonb NOT NULL,
  authoritative_source text NOT NULL,
  justification text NOT NULL CHECK (length(trim(justification)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE OR REPLACE FUNCTION prevent_facility_directory_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'facility directory versions are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER facility_directory_versions_no_update
  BEFORE UPDATE ON facility_directory_versions FOR EACH ROW EXECUTE FUNCTION prevent_facility_directory_mutation();
CREATE TRIGGER facility_directory_versions_no_delete
  BEFORE DELETE ON facility_directory_versions FOR EACH ROW EXECUTE FUNCTION prevent_facility_directory_mutation();

ALTER TABLE facilities
  ADD COLUMN directory_entry_key text,
  ADD COLUMN directory_version_id text REFERENCES facility_directory_versions(id) ON DELETE RESTRICT,
  ADD COLUMN tier text CHECK (tier IN ('public', 'private')),
  ADD COLUMN classification_category text
    CHECK (classification_category IN ('hospital', 'district_health_unit', 'clinic', 'doctor', 'pharmacy', 'other'));

CREATE TABLE facility_resolution_results (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  directory_version_id text NOT NULL REFERENCES facility_directory_versions(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('resolved', 'human_review_required', 'correction_required')),
  reason_code text NOT NULL,
  facility_id text REFERENCES facilities(id) ON DELETE SET NULL,
  resolved_tier text CHECK (resolved_tier IN ('public', 'private')),
  resolved_category text
    CHECK (resolved_category IN ('hospital', 'district_health_unit', 'clinic', 'doctor', 'pharmacy', 'other')),
  evidence_date date,
  evidence_fingerprint text NOT NULL,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  resolver_version text NOT NULL,
  resolved_by text,
  resolved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facility_resolution_request_history
  ON facility_resolution_results (request_id, resolved_at DESC);

ALTER TABLE requests
  ADD COLUMN facility_resolution_id text REFERENCES facility_resolution_results(id) ON DELETE SET NULL,
  ADD COLUMN facility_tier_snapshot text CHECK (facility_tier_snapshot IN ('public', 'private')),
  ADD COLUMN facility_category_snapshot text
    CHECK (facility_category_snapshot IN ('hospital', 'district_health_unit', 'clinic', 'doctor', 'pharmacy', 'other')),
  ADD COLUMN partner_pricing_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (partner_pricing_status IN ('not_applicable', 'locked', 'unlocked'));

CREATE TABLE staff_capabilities (
  staff_id text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  capability text NOT NULL CHECK (capability IN ('cho_prescription_validate')),
  assigned_by text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  justification text NOT NULL CHECK (length(trim(justification)) > 0),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  PRIMARY KEY (staff_id, capability, assigned_at)
);
CREATE UNIQUE INDEX staff_active_capability
  ON staff_capabilities (staff_id, capability) WHERE revoked_at IS NULL;

CREATE TABLE private_prescription_validation_events (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE RESTRICT,
  prescription_document_id text NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  prescribing_facility_id text REFERENCES facilities(id) ON DELETE SET NULL,
  directory_version_id text NOT NULL REFERENCES facility_directory_versions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  actor_id text REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR length(trim(reason)) > 0)
);
CREATE INDEX private_prescription_validation_history
  ON private_prescription_validation_events (request_id, prescription_document_id, created_at DESC);

INSERT INTO facility_directory_versions (
  id, version, directory_version, effective_from, directory,
  old_value, new_value, authoritative_source, justification
) VALUES (
  'facility-directory-v1', 1, 'facility-directory:v1', '1970-01-01T00:00:00Z',
  '{
    "status":"awaiting_private_partner_list",
    "requiredPrivatePartnerCount":42,
    "maxEvidenceAgeDays":365,
    "entries":[{
      "key":"spmc",
      "canonicalName":"Southern Philippines Medical Center",
      "aliases":["SPMC","Southern Philippines Medical Center"],
      "tier":"public",
      "category":"hospital",
      "effectiveFrom":"1970-01-01"
    }],
    "rules":[{
      "key":"district-health-units",
      "match":"district health unit",
      "tier":"public",
      "category":"district_health_unit",
      "effectiveFrom":"1970-01-01"
    }]
  }'::jsonb,
  NULL,
  '{
    "status":"awaiting_private_partner_list",
    "requiredPrivatePartnerCount":42,
    "maxEvidenceAgeDays":365,
    "entries":[{"key":"spmc","canonicalName":"Southern Philippines Medical Center","aliases":["SPMC","Southern Philippines Medical Center"],"tier":"public","category":"hospital","effectiveFrom":"1970-01-01"}],
    "rules":[{"key":"district-health-units","match":"district health unit","tier":"public","category":"district_health_unit","effectiveFrom":"1970-01-01"}]
  }'::jsonb,
  'Client-approved public classification requirement; private partner list pending.',
  'Configure SPMC and district health units as public without inventing the 42 private partners.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO audit_logs (
  id, actor_id, actor_type, action_type, affected_record_type,
  affected_record_id, new_value, justification
) VALUES (
  'audit-facility-directory-v1', 'system', 'system', 'facility_directory_version_created',
  'facility_directory', 'facility-directory-v1',
  '{"directoryVersion":"facility-directory:v1","publicEntries":["SPMC","district health units"],"privatePartnerStatus":"awaiting_client_list"}'::jsonb,
  'Configure the approved public tier while leaving the private partner directory empty pending the authoritative client list.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_reason_codes (code, category, severity, description) VALUES
  ('FACILITY_RESOLVED_PUBLIC', 'evidence', 'information', 'Facility evidence resolved to the public tier.'),
  ('FACILITY_RESOLVED_PRIVATE', 'evidence', 'information', 'Facility evidence resolved to an effective private partner entry.'),
  ('FACILITY_UNKNOWN', 'evidence', 'review', 'Facility evidence could not be matched to the effective directory.'),
  ('FACILITY_EVIDENCE_STALE', 'expiry', 'warning', 'Facility evidence is older than the directory evidence limit.'),
  ('PRIVATE_PARTNER_LIST_PENDING', 'system', 'review', 'The authoritative 42-partner private directory has not been configured.'),
  ('CHO_VALIDATION_PENDING', 'evidence', 'review', 'A private prescription requires City Health Office validation.'),
  ('CHO_VALIDATION_APPROVED', 'evidence', 'information', 'City Health Office approved the private prescription.'),
  ('CHO_VALIDATION_REJECTED', 'evidence', 'review', 'City Health Office rejected the private prescription.')
ON CONFLICT (code) DO NOTHING;
