ALTER TABLE policy_configurations
  ADD COLUMN published_at timestamptz;

UPDATE policy_configurations SET published_at = created_at WHERE published_at IS NULL;
ALTER TABLE policy_configurations ALTER COLUMN published_at SET NOT NULL;

CREATE OR REPLACE FUNCTION prevent_policy_configuration_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'published policy versions are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER policy_configurations_no_update
  BEFORE UPDATE ON policy_configurations FOR EACH ROW EXECUTE FUNCTION prevent_policy_configuration_mutation();
CREATE TRIGGER policy_configurations_no_delete
  BEFORE DELETE ON policy_configurations FOR EACH ROW EXECUTE FUNCTION prevent_policy_configuration_mutation();

CREATE OR REPLACE FUNCTION prevent_policy_evaluation_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'policy evaluations are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER policy_evaluations_no_update
  BEFORE UPDATE ON policy_evaluations FOR EACH ROW EXECUTE FUNCTION prevent_policy_evaluation_mutation();
CREATE TRIGGER policy_evaluations_no_delete
  BEFORE DELETE ON policy_evaluations FOR EACH ROW EXECUTE FUNCTION prevent_policy_evaluation_mutation();

CREATE TABLE office_boundary_versions (
  id text PRIMARY KEY,
  office_id text NOT NULL REFERENCES offices(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  boundary_version text NOT NULL UNIQUE,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  boundary jsonb NOT NULL CHECK (jsonb_typeof(boundary) = 'object'),
  actor_id text NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  old_value jsonb,
  new_value jsonb NOT NULL,
  justification text NOT NULL CHECK (length(trim(justification)) >= 10),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (office_id, version),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX office_boundary_effective_lookup
  ON office_boundary_versions (office_id, effective_from DESC);

INSERT INTO office_boundary_versions (
  id, office_id, version, boundary_version, effective_from, boundary,
  actor_id, new_value, justification
)
SELECT concat('office-boundary-legacy-', o.id), o.id, o.boundary_version,
       concat('residency:', o.office_code, ':v', o.boundary_version), o.created_at,
       o.residency_boundary, COALESCE((SELECT id FROM staff_accounts WHERE role = 'System Administrator' ORDER BY created_at LIMIT 1),
       (SELECT id FROM staff_accounts ORDER BY created_at LIMIT 1)), o.residency_boundary,
       'Migrated existing residency boundary configuration.'
FROM offices o
WHERE EXISTS (SELECT 1 FROM staff_accounts)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_office_boundary_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'published office boundary versions are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER office_boundary_versions_no_update
  BEFORE UPDATE ON office_boundary_versions FOR EACH ROW EXECUTE FUNCTION prevent_office_boundary_version_mutation();
CREATE TRIGGER office_boundary_versions_no_delete
  BEFORE DELETE ON office_boundary_versions FOR EACH ROW EXECUTE FUNCTION prevent_office_boundary_version_mutation();

ALTER TABLE budgets
  ADD COLUMN version integer,
  ADD COLUMN budget_version text,
  ADD COLUMN published_at timestamptz;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY COALESCE(assistance_type, '') ORDER BY created_at, id)::integer AS version
  FROM budgets
)
UPDATE budgets b
SET version = n.version,
    budget_version = concat('budget:', COALESCE(b.assistance_type, 'global'), ':v', n.version),
    published_at = b.created_at
FROM numbered n WHERE b.id = n.id;

ALTER TABLE budgets
  ALTER COLUMN version SET NOT NULL,
  ALTER COLUMN budget_version SET NOT NULL,
  ALTER COLUMN published_at SET NOT NULL;
CREATE UNIQUE INDEX budget_version_identifier_unique ON budgets (budget_version);
CREATE UNIQUE INDEX budget_scope_version_unique ON budgets ((COALESCE(assistance_type, '')), version);

CREATE OR REPLACE FUNCTION protect_budget_publication_fields() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.assistance_type IS DISTINCT FROM OLD.assistance_type
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount
     OR NEW.assistance_limit IS DISTINCT FROM OLD.assistance_limit
     OR NEW.depletion_threshold_amount IS DISTINCT FROM OLD.depletion_threshold_amount
     OR NEW.guarantee_letter_validity_days IS DISTINCT FROM OLD.guarantee_letter_validity_days
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.justification IS DISTINCT FROM OLD.justification
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.budget_version IS DISTINCT FROM OLD.budget_version
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'published budget configuration fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER budgets_protect_publication_fields
  BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION protect_budget_publication_fields();

