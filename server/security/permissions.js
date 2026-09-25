export const Roles = Object.freeze({
  CITIZEN: 'Citizen',
  CASE_WORKER: 'Case Worker',
  SYSTEM_ADMINISTRATOR: 'System Administrator',
});

export const Permissions = Object.freeze({
  APPLICANT_DOCUMENTS: 'applicant:documents',
  APPLICANT_APPLICATIONS: 'applicant:applications',
  APPLICANT_REQUESTS: 'applicant:requests',
  APPLICANT_PROFILE: 'applicant:profile',
  APPLICANT_NOTIFICATIONS: 'applicant:notifications',
  STAFF_IDENTITY: 'staff:identity',
  REQUESTS_VIEW: 'requests:view',
  REQUESTS_PROCESS: 'requests:process',
  REQUESTS_AUDIT: 'requests:audit',
  REQUESTORS_VIEW: 'requestors:view',
  STAFF_NOTIFICATIONS_VIEW: 'staff-notifications:view',
  SMS_MANAGE: 'sms:manage',
  STAFF_MANAGE: 'staff:manage',
  CONFIGURATION_MANAGE: 'configuration:manage',
  SYSTEM_MANAGE: 'system:manage',
  AUDIT_SYSTEM: 'audit:system',
  REPORTS_GENERATE: 'reports:generate',
  IDENTITY_APPROVE: 'identity:approve',
  POLICY_VIEW: 'policy:view',
  POLICY_EVALUATE: 'policy:evaluate',
  POLICY_CONFIGURE: 'policy:configure',
  POLICY_OVERRIDE: 'policy:override',
  OFFICES_MANAGE: 'offices:manage',
  FACILITY_DIRECTORY_VIEW: 'facility-directory:view',
  FACILITY_DIRECTORY_MANAGE: 'facility-directory:manage',
  CHO_PRESCRIPTION_VALIDATE: 'cho:prescription-validate',
  CHO_CAPABILITY_MANAGE: 'cho:capability-manage',
  HARD_DISQUALIFIER_EVIDENCE: 'hard-disqualifier:evidence',
  HARD_DISQUALIFIER_EVALUATE: 'hard-disqualifier:evaluate',
  HARD_DISQUALIFIER_EXCEPTION: 'hard-disqualifier:exception',
  HARD_DISQUALIFIER_EXCEPTION_MANAGE: 'hard-disqualifier:exception-manage',
});

const citizenPermissions = [
  Permissions.APPLICANT_DOCUMENTS, Permissions.APPLICANT_APPLICATIONS,
  Permissions.APPLICANT_REQUESTS, Permissions.APPLICANT_PROFILE,
  Permissions.APPLICANT_NOTIFICATIONS,
];
const caseWorkerPermissions = [
  Permissions.STAFF_IDENTITY, Permissions.REQUESTS_VIEW, Permissions.REQUESTS_PROCESS,
  Permissions.REQUESTS_AUDIT, Permissions.REQUESTORS_VIEW,
  Permissions.STAFF_NOTIFICATIONS_VIEW, Permissions.SMS_MANAGE,
  Permissions.POLICY_VIEW, Permissions.POLICY_EVALUATE,
  Permissions.POLICY_OVERRIDE,
  Permissions.FACILITY_DIRECTORY_VIEW, Permissions.CHO_PRESCRIPTION_VALIDATE,
  Permissions.HARD_DISQUALIFIER_EVIDENCE, Permissions.HARD_DISQUALIFIER_EVALUATE,
];
const systemAdministratorPermissions = [
  Permissions.STAFF_IDENTITY, Permissions.REQUESTS_VIEW, Permissions.REQUESTS_AUDIT,
  Permissions.REQUESTORS_VIEW, Permissions.STAFF_MANAGE, Permissions.CONFIGURATION_MANAGE,
  Permissions.SYSTEM_MANAGE, Permissions.AUDIT_SYSTEM, Permissions.REPORTS_GENERATE,
  Permissions.IDENTITY_APPROVE, Permissions.STAFF_NOTIFICATIONS_VIEW,
  Permissions.SMS_MANAGE, Permissions.POLICY_VIEW, Permissions.POLICY_CONFIGURE,
  Permissions.POLICY_EVALUATE, Permissions.POLICY_OVERRIDE, Permissions.OFFICES_MANAGE,
  Permissions.FACILITY_DIRECTORY_VIEW, Permissions.FACILITY_DIRECTORY_MANAGE,
  Permissions.CHO_PRESCRIPTION_VALIDATE, Permissions.CHO_CAPABILITY_MANAGE,
  Permissions.HARD_DISQUALIFIER_EVIDENCE, Permissions.HARD_DISQUALIFIER_EVALUATE,
  Permissions.HARD_DISQUALIFIER_EXCEPTION,
  Permissions.HARD_DISQUALIFIER_EXCEPTION_MANAGE,
];

export const rolePermissions = Object.freeze({
  [Roles.CITIZEN]: new Set(citizenPermissions),
  [Roles.CASE_WORKER]: new Set(caseWorkerPermissions),
  [Roles.SYSTEM_ADMINISTRATOR]: new Set(systemAdministratorPermissions),
});

export function canonicalRole(role) {
  if (role === 'Applicant') return Roles.CITIZEN;
  if (role === 'Super Admin') return Roles.SYSTEM_ADMINISTRATOR;
  if (role === 'Administrator' || role === 'Reviewer') return Roles.CASE_WORKER;
  return role;
}

export function canonicalStaffRole(role) {
  const canonical = canonicalRole(role);
  return canonical === Roles.CITIZEN ? role : canonical;
}

export function hasPermission(role, permission) {
  return rolePermissions[canonicalRole(role)]?.has(permission) === true;
}

export function isSystemAdministrator(role) {
  return canonicalRole(role) === Roles.SYSTEM_ADMINISTRATOR;
}

export function canManageRole(actorRole, _targetRole) {
  return hasPermission(actorRole, Permissions.STAFF_MANAGE);
}

export const staffRoles = Object.freeze([
  Roles.SYSTEM_ADMINISTRATOR,
  Roles.CASE_WORKER,
]);
