INSERT INTO policy_configurations (
  id, policy_key, version, policy_version, assistance_type, configuration,
  effective_from, effective_date, old_value, new_value, justification
) VALUES (
  'policy-submission-gates-global-v2', 'submission_gates', 2,
  'submission_gates:global:v2', NULL,
  '{"cooldownDays":30,"calendarYearDocumentTypes":["Barangay Certificate of Indigency","Recent facility receipt or billing document"]}'::jsonb,
  now(), now(),
  '{"cooldownDays":30,"calendarYearDocumentTypes":["Recent facility receipt or billing document"]}'::jsonb,
  '{"cooldownDays":30,"calendarYearDocumentTypes":["Barangay Certificate of Indigency","Recent facility receipt or billing document"]}'::jsonb,
  'Apply the active calendar-year rule to dated indigency and receipt evidence while preserving long-lived valid IDs.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO audit_logs (
  id, actor_id, actor_type, action_type, affected_record_type,
  affected_record_id, old_value, new_value, justification
) VALUES (
  'audit-policy-submission-gates-global-v2', 'system', 'system',
  'policy_version_created', 'policy_configuration', 'policy-submission-gates-global-v2',
  '{"policyVersion":"submission_gates:global:v1","configuration":{"cooldownDays":30,"calendarYearDocumentTypes":["Recent facility receipt or billing document"]}}'::jsonb,
  '{"policyVersion":"submission_gates:global:v2","configuration":{"cooldownDays":30,"calendarYearDocumentTypes":["Barangay Certificate of Indigency","Recent facility receipt or billing document"]}}'::jsonb,
  'Apply the active calendar-year rule to dated indigency and receipt evidence while preserving long-lived valid IDs.'
) ON CONFLICT (id) DO NOTHING;
