ALTER TABLE budgets
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN assistance_limit numeric(16,2),
  ADD COLUMN depletion_threshold_amount numeric(16,2) NOT NULL DEFAULT 0,
  ADD COLUMN guarantee_letter_validity_days integer,
  ADD COLUMN created_by text REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN justification text;

ALTER TABLE budgets
  ADD CONSTRAINT budget_assistance_limit_valid CHECK (assistance_limit IS NULL OR assistance_limit > 0),
  ADD CONSTRAINT budget_threshold_valid CHECK (depletion_threshold_amount >= 0 AND depletion_threshold_amount <= allocated_amount),
  ADD CONSTRAINT budget_letter_validity_valid CHECK (guarantee_letter_validity_days IS NULL OR guarantee_letter_validity_days BETWEEN 3 AND 14);

CREATE INDEX budget_effective_pool_lookup
  ON budgets (assistance_type, active, period_start, period_end);

ALTER TABLE budget_reservations
  ADD COLUMN guarantee_letter_id text REFERENCES guarantee_letters(id) ON DELETE RESTRICT,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN released_at timestamptz,
  ADD COLUMN release_reason text;

CREATE UNIQUE INDEX budget_active_request_reservation
  ON budget_reservations (request_id) WHERE status = 'reserved';
CREATE UNIQUE INDEX budget_letter_reservation
  ON budget_reservations (guarantee_letter_id) WHERE guarantee_letter_id IS NOT NULL;

ALTER TABLE guarantee_letters
  ADD COLUMN budget_reservation_id text REFERENCES budget_reservations(id) ON DELETE RESTRICT,
  ADD COLUMN validity_days integer CHECK (validity_days IS NULL OR validity_days BETWEEN 3 AND 14),
  ADD COLUMN released_by text REFERENCES staff_accounts(id) ON DELETE RESTRICT;

INSERT INTO policy_reason_codes (code, category, severity, description) VALUES
  ('BUDGET_POOL_NOT_CONFIGURED', 'budget', 'review', 'No effective city budget pool is configured for this assistance type.'),
  ('BUDGET_DEPLETED', 'budget', 'review', 'The applicable city budget has reached its configured depletion threshold.'),
  ('ASSISTANCE_LIMIT_EXCEEDED', 'budget', 'review', 'The covered amount exceeds the configured per-request assistance limit.'),
  ('GUARANTEE_LETTER_VALIDITY_INVALID', 'expiry', 'review', 'Guarantee Letter validity must be configured from 3 through 14 days.'),
  ('BUDGET_ALLOCATION_RELEASED', 'budget', 'information', 'An unused Guarantee Letter allocation was returned to its budget pool.')
ON CONFLICT (code) DO NOTHING;
