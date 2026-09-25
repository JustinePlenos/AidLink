UPDATE staff_accounts
SET role = 'System Administrator', updated_at = now()
WHERE role = 'Super Admin';

ALTER TABLE staff_accounts DROP CONSTRAINT staff_accounts_role_check;
ALTER TABLE staff_accounts ADD CONSTRAINT staff_accounts_role_check
  CHECK (role IN ('Case Worker', 'System Administrator'));

COMMENT ON COLUMN staff_accounts.role IS 'System Administrator is the single administrative role; legacy Super Admin accounts are migrated to it.';
