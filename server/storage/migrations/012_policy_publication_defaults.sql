ALTER TABLE policy_configurations ALTER COLUMN published_at SET DEFAULT now();
ALTER TABLE budgets ALTER COLUMN published_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION fill_budget_publication_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.version IS NULL THEN
    SELECT COALESCE(max(version), 0) + 1 INTO NEW.version
    FROM budgets WHERE assistance_type IS NOT DISTINCT FROM NEW.assistance_type;
  END IF;
  IF NEW.budget_version IS NULL THEN
    NEW.budget_version := concat('budget:', COALESCE(NEW.assistance_type, 'global'), ':v', NEW.version);
  END IF;
  IF NEW.published_at IS NULL THEN NEW.published_at := now(); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER budgets_fill_publication_identity
  BEFORE INSERT ON budgets FOR EACH ROW EXECUTE FUNCTION fill_budget_publication_identity();
