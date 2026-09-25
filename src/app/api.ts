import type { AppNotification, AssistanceRequest, AuditLog, GuaranteeLetterTracking, User } from './types';

export interface AdminLoginPayload {
  email: string;
  password: string;
}

export interface AdminUser {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  address: string;
  dateOfBirth: string;
  role: string;
  active: boolean;
  passwordChangedAt?: string;
  registeredDate?: string;
}

interface LoginResponse {
  user: AdminUser;
  token: string;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export type ProtectedDocumentFailure = 'expired' | 'unauthorized' | 'missing' | 'unavailable';
export class ProtectedDocumentAccessError extends Error {
  constructor(message: string, public readonly failure: ProtectedDocumentFailure, public readonly status: number, public readonly code?: string) { super(message); this.name = 'ProtectedDocumentAccessError'; }
}

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); this.name = 'ApiRequestError'; }
}

function safeApiMessage(status: number, data: any, fallback: string) {
  if (status === 401) return 'Your session has expired. Sign in again to continue.';
  if (status === 403) return 'You do not have permission to perform this action.';
  if (status >= 500) return 'AidLink could not complete this action. Try again in a moment.';
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  return message || fallback;
}

export function getActionErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiRequestError || error instanceof ProtectedDocumentAccessError) return error.message;
  if (error instanceof TypeError) return 'AidLink could not be reached. Check your connection and try again.';
  return error instanceof Error && error.message ? error.message : fallback;
}

async function apiFetch<T>(path: string, init: RequestInit = {}) {
  const token = window.localStorage.getItem('aidlink_admin_token');
  const isFormData = init.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: {
        ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      ...init,
    });
  } catch {
    throw new ApiRequestError('AidLink could not be reached. Check your connection and try again.', 0, 'NETWORK_UNAVAILABLE');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || (response.status === 403 && /deactivated/i.test(data?.message || ''))) {
      window.dispatchEvent(new CustomEvent('aidlink:session-expired', { detail: { message: 'Your session has expired. Sign in again to continue.' } }));
    }
    throw new ApiRequestError(safeApiMessage(response.status, data, 'The action could not be completed. Try again.'), response.status, String(data?.code || ''));
  }

  return data as T;
}

async function fetchProtectedDocumentObjectUrl(value: string, expireApplicationSession: boolean) {
  const apiBase = new URL(API_BASE_URL, window.location.origin);
  const suppliedTarget = new URL(value, apiBase);
  // Older records contain an absolute localhost API URL. In development the
  // portal is served by Vite on another port, so route AidLink-owned files
  // through the configured API origin (or the Vite proxy) before authorizing
  // them. This also avoids sending the bearer token to arbitrary file hosts.
  const isAidLinkDocument = suppliedTarget.pathname.startsWith('/uploads/')
    || suppliedTarget.pathname.startsWith('/api/applicant-verifications/');
  const target = isAidLinkDocument
    ? new URL(`${suppliedTarget.pathname}${suppliedTarget.search}`, apiBase)
    : suppliedTarget;
  const token = window.localStorage.getItem('aidlink_admin_token');
  const isAuthorizedRequest = isAidLinkDocument && target.origin === apiBase.origin && Boolean(token);
  let response: Response;
  try { response = await fetch(target, {
    headers: isAuthorizedRequest ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
  }); } catch { throw new ProtectedDocumentAccessError('The identity proof is unavailable. Check your connection and try again.', 'unavailable', 0, 'DOCUMENT_SERVICE_UNAVAILABLE'); }
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    if (response.status === 401 && expireApplicationSession && isAuthorizedRequest) {
      window.dispatchEvent(new Event('aidlink:session-expired'));
    }
    const code = String(error?.code || '');
    const failure: ProtectedDocumentFailure = response.status === 401 ? 'expired' : response.status === 403 ? 'unauthorized' : response.status === 404 ? 'missing' : 'unavailable';
    const fallback = failure === 'expired' ? 'Your administrator session has expired. Sign in again, then reopen the identity proof.'
      : failure === 'unauthorized' ? 'You are not authorized to open this identity proof. A System Administrator account is required.'
      : failure === 'missing' ? 'The identity-proof file is missing. Ask the applicant to upload it again.'
      : 'The identity proof is temporarily unavailable. Try again or contact a System Administrator.';
    throw new ProtectedDocumentAccessError(fallback, failure, response.status, code);
  }
  return URL.createObjectURL(await response.blob());
}

export function getProtectedDocumentObjectUrl(value: string) {
  return fetchProtectedDocumentObjectUrl(value, true);
}

export function getIdentityProofObjectUrl(value: string) {
  // Identity proof is previewed inside the current administrator session. A
  // document-specific 401 is reported in place and must not clear the portal.
  return fetchProtectedDocumentObjectUrl(value, false);
}

export async function openProtectedDocument(value: string) {
  const opened = window.open('about:blank', '_blank');
  if (!opened) {
    throw new Error('Allow pop-ups to open this protected document.');
  }
  opened.opener = null;
  const documentUrl = await getProtectedDocumentObjectUrl(value).catch((error) => {
    opened.close();
    throw error;
  });
  opened.location.replace(documentUrl);
  window.setTimeout(() => URL.revokeObjectURL(documentUrl), 60_000);
}

export async function downloadProtectedDocument(value: string, fileName: string) {
  const documentUrl = await getProtectedDocumentObjectUrl(value);
  const link = document.createElement('a');
  link.href = documentUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(documentUrl), 1_000);
}

export async function loginAdmin(payload: AdminLoginPayload) {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getCurrentAdmin() {
  return apiFetch<AdminUser>('/api/auth/me');
}

export async function logoutAdmin() {
  return apiFetch<{ message: string }>('/api/auth/logout', { method: 'POST' });
}

export async function getRequests() {
  return apiFetch<AssistanceRequest[]>('/api/requests');
}

export async function getRequest(requestId: string) {
  return apiFetch<AssistanceRequest>(`/api/requests/${requestId}`);
}

interface RequestStatusOptions {
  correctionDocumentIds?: string[];
  guaranteeLetterTracking?: Pick<GuaranteeLetterTracking, 'claimReference' | 'scheduledFor' | 'status' | 'claimingTime' | 'claimingLocation'>;
}

export async function uploadGuaranteeLetter(requestId: string, letter: File) {
  const form = new FormData();
  form.append('letter', letter);
  return apiFetch<NonNullable<AssistanceRequest['protectedLetter']>>(`/api/requests/${encodeURIComponent(requestId)}/letter`, { method: 'POST', body: form });
}

export async function previewGuaranteeLetter(requestId: string) {
  const token = window.localStorage.getItem('aidlink_admin_token');
  const response = await fetch(`${API_BASE_URL}/api/requests/${encodeURIComponent(requestId)}/letter/preview`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
  if (!response.ok) { const error = await response.json().catch(() => null); throw new ApiRequestError(safeApiMessage(response.status, error, 'Unable to preview the converted letter.'), response.status, String(error?.code || '')); }
  return URL.createObjectURL(await response.blob());
}

export async function confirmGuaranteeLetter(requestId: string, version: number) {
  return apiFetch<AssistanceRequest>(`/api/requests/${encodeURIComponent(requestId)}/letter/confirm`, { method: 'POST', body: JSON.stringify({ version, confirmed: true }) });
}

export async function revokeGuaranteeLetter(requestId: string, reason: string) {
  return apiFetch<AssistanceRequest>(`/api/requests/${encodeURIComponent(requestId)}/letter/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function updateRequestStatus(requestId: string, status: 'under_review' | 'correction_requested' | 'approved' | 'denied', remarks: string, options: RequestStatusOptions = {}) {
  return apiFetch<AssistanceRequest>(`/api/requests/${requestId}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status, remarks, ...options }),
  });
}

export async function evaluateRequestWorkflow(requestId: string, remarks: string) {
  return apiFetch<import('./types').WorkflowEvaluation>(`/api/requests/${encodeURIComponent(requestId)}/workflow-evaluation`, { method: 'POST', body: JSON.stringify({ remarks }) });
}

export async function confirmRequestWorkflowEvaluation(requestId: string, evaluationId: string, input: { evidenceReviewed: boolean; coverageConfirmed: boolean; remarks: string }) {
  return apiFetch<{ id: string; evaluation_id: string; confirmed_at: string }>(`/api/requests/${encodeURIComponent(requestId)}/workflow-evaluations/${encodeURIComponent(evaluationId)}/confirm`, { method: 'POST', body: JSON.stringify(input) });
}

export async function updateGuaranteeLetterTracking(requestId: string, tracking: Pick<GuaranteeLetterTracking, 'claimReference' | 'scheduledFor' | 'status' | 'claimingTime' | 'claimingLocation'>) {
  return apiFetch<AssistanceRequest>(`/api/requests/${encodeURIComponent(requestId)}/guarantee-letter-tracking`, {
    method: 'PUT',
    body: JSON.stringify(tracking),
  });
}

export async function releaseClaimingPreparation(requestId: string) {
  return apiFetch<AssistanceRequest>(`/api/requests/${encodeURIComponent(requestId)}/claiming/release`, { method: 'POST' });
}

export async function retryApprovalSms(notificationId: string) {
  return apiFetch<NonNullable<AssistanceRequest['approvalSms']>>(`/api/sms-notifications/${encodeURIComponent(notificationId)}/retry`, { method: 'POST' });
}

export async function getRequiredDocuments() {
  return apiFetch<Record<string, string[]>>('/api/assistance-types/required-documents');
}

export async function updateRequiredDocuments(type: string, documents: string[]) {
  return apiFetch<{ type: string; documents: string[] }>(`/api/assistance-types/${encodeURIComponent(type)}/required-documents`, { method: 'PUT', body: JSON.stringify({ documents }) });
}

export async function getNotifications() {
  return apiFetch<AppNotification[]>('/api/notifications');
}

export async function markNotificationRead(notificationId: string) {
  return apiFetch<AppNotification>(`/api/notifications/${notificationId}/read`, { method: 'PUT' });
}

export async function getRequestAudit(requestId: string) {
  return apiFetch<AuditLog[]>(`/api/requests/${requestId}/audit`);
}

export async function getUsers() {
  return apiFetch<User[]>('/api/users');
}

export async function getUserRequests(userId: string) {
  return apiFetch<AssistanceRequest[]>(`/api/users/${encodeURIComponent(userId)}/requests`);
}

export const staffRoles = ['System Administrator', 'Case Worker'] as const;
export type StaffRole = typeof staffRoles[number];
export type StaffAccount = AdminUser;

export interface CreateStaffPayload {
  fullName: string;
  email: string;
  password: string;
  role: StaffRole;
}

export async function getStaffAccounts() {
  return apiFetch<StaffAccount[]>('/api/staff');
}

export async function createStaffAccount(payload: CreateStaffPayload) {
  return apiFetch<StaffAccount>('/api/staff', { method: 'POST', body: JSON.stringify(payload) });
}

export async function setStaffActive(id: string, active: boolean) {
  return apiFetch<StaffAccount>(`/api/staff/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ active }),
  });
}

export async function assignStaffRole(id: string, role: StaffRole) {
  return apiFetch<StaffAccount>(`/api/staff/${encodeURIComponent(id)}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
}

export async function resetStaffPassword(id: string, password: string) {
  return apiFetch<{ message: string }>(`/api/staff/${encodeURIComponent(id)}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export interface AssistanceTypeConfiguration {
  name: string;
  active: boolean;
  requiredDocuments: string[];
}

export interface SystemSettings {
  organizationName: string;
  notificationPollingSeconds: number;
  receiptValidityDays: number;
  defaultClaimingTime: string;
  defaultClaimingLocation: string;
  smsHelpChannel: string;
}

export interface BudgetPool {
  id: string;
  name: string;
  assistanceType: string | null;
  effectiveFrom: string;
  effectiveUntil: string;
  allocatedAmount: number;
  reservedAmount: number;
  spentAmount: number;
  availableAmount: number;
  allocatableAmount: number;
  assistanceLimit: number | null;
  depletionThresholdAmount: number;
  guaranteeLetterValidityDays: number | null;
  active: boolean;
  version?: number;
  budgetVersion?: string;
  publishedAt?: string;
}

export interface CreateBudgetPoolPayload {
  name: string;
  assistanceType: string;
  effectiveFrom: string;
  effectiveUntil: string;
  allocatedAmount: number;
  assistanceLimit: number;
  depletionThresholdAmount: number;
  guaranteeLetterValidityDays: number;
  justification: string;
  confirmed: boolean;
}

function budgetPool(value: Record<string, unknown>): BudgetPool {
  return {
    id: String(value.id), name: String(value.name), assistanceType: value.assistance_type == null ? null : String(value.assistance_type),
    effectiveFrom: String(value.period_start), effectiveUntil: String(value.period_end),
    allocatedAmount: Number(value.allocated_amount), reservedAmount: Number(value.reserved_amount), spentAmount: Number(value.spent_amount),
    availableAmount: Number(value.available_amount ?? Number(value.allocated_amount) - Number(value.reserved_amount) - Number(value.spent_amount)),
    allocatableAmount: Number(value.allocatable_amount ?? Number(value.allocated_amount) - Number(value.reserved_amount) - Number(value.spent_amount) - Number(value.depletion_threshold_amount || 0)),
    assistanceLimit: value.assistance_limit == null ? null : Number(value.assistance_limit), depletionThresholdAmount: Number(value.depletion_threshold_amount || 0),
    guaranteeLetterValidityDays: value.guarantee_letter_validity_days == null ? null : Number(value.guarantee_letter_validity_days), active: value.active !== false,
    version: value.version == null ? undefined : Number(value.version), budgetVersion: value.budget_version == null ? undefined : String(value.budget_version), publishedAt: value.published_at == null ? undefined : String(value.published_at),
  };
}

export interface PolicyVersion {
  id: string;
  policyKey: string;
  policyVersion: string;
  assistanceType: string | null;
  configuration: Record<string, unknown>;
  effectiveDate: string;
  effectiveUntil: string | null;
  actorId: string | null;
  justification: string;
  publishedAt?: string;
}

export async function getPolicyVersions(policyKey: string, assistanceType?: string) {
  const search = assistanceType ? `?assistanceType=${encodeURIComponent(assistanceType)}` : '';
  return apiFetch<PolicyVersion[]>(`/api/policies/${encodeURIComponent(policyKey)}/versions${search}`);
}

export async function publishPolicyVersion(policyKey: string, payload: { assistanceType?: string | null; configuration: Record<string, unknown>; effectiveDate: string; effectiveUntil?: string | null; justification: string; confirmed: boolean }) {
  return apiFetch<PolicyVersion>(`/api/policies/${encodeURIComponent(policyKey)}/versions`, { method: 'POST', body: JSON.stringify(payload) });
}

export interface OfficePolicyConfiguration {
  id: string;
  office_code: string;
  name: string;
  office_type: 'central' | 'district_satellite';
  district_code: string | null;
  active: boolean;
  residency_boundary: Record<string, unknown>;
  boundary_version: number;
}

export async function getPolicyOffices() { return apiFetch<OfficePolicyConfiguration[]>('/api/offices'); }
export async function publishOfficeBoundary(id: string, payload: { officeCode: string; name: string; officeType: string; districtCode: string | null; active: boolean; residencyBoundary: Record<string, unknown>; effectiveFrom: string; effectiveUntil?: string | null; justification: string; confirmed: boolean }) {
  return apiFetch<OfficePolicyConfiguration & { publishedBoundaryVersion: string }>(`/api/offices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export async function getBudgetPools() {
  return (await apiFetch<Array<Record<string, unknown>>>('/api/budgets')).map(budgetPool);
}

export async function createBudgetPool(payload: CreateBudgetPoolPayload) {
  return budgetPool(await apiFetch<Record<string, unknown>>('/api/budgets', { method: 'POST', body: JSON.stringify(payload) }));
}

export interface FacilityDirectoryEntry {
  key: string;
  canonicalName: string;
  aliases?: string[];
  tier: 'public' | 'private';
  category: 'hospital' | 'district_health_unit' | 'clinic' | 'doctor' | 'pharmacy' | 'other';
  effectiveFrom: string;
  effectiveUntil?: string | null;
}

export interface EffectiveFacilityDirectory {
  id: string;
  version: number;
  directoryVersion: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  directory: {
    status: string;
    requiredPrivatePartnerCount: number;
    maxEvidenceAgeDays: number;
    clientApprovalReference?: string;
    entries: FacilityDirectoryEntry[];
    rules: Array<{ key: string; match: string; tier: 'public' | 'private'; category: FacilityDirectoryEntry['category']; effectiveFrom: string; effectiveUntil?: string | null }>;
  };
  authoritativeSource: string;
  justification: string;
}

export async function getEffectiveFacilityDirectory() {
  return apiFetch<EffectiveFacilityDirectory>('/api/facility-directory/effective');
}

export async function publishFacilityDirectory(payload: { directory: EffectiveFacilityDirectory['directory']; authoritativeSource: string; effectiveFrom: string; effectiveUntil?: string | null; justification: string; confirmed: boolean }) {
  return apiFetch<EffectiveFacilityDirectory>('/api/facility-directory/versions', { method: 'POST', body: JSON.stringify(payload) });
}

export interface ApplicantVerification {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  registeredDate: string;
  accountStatus: 'basic' | 'verified';
  verificationStatus: 'unverified' | 'pending' | 'approved' | 'rejected';
  identityVerification: {
    status: string;
    document: null | { id: string; name: string; url: string; mimeType: string; sizeBytes: number; uploadedAt: string; analysis: { accepted: boolean; analyzerVersion: string; warnings: string[] } };
    decision: null | { decision: string; administratorId: string; administratorName: string; decidedAt: string; notes: string };
    auditNotes: Array<string | { note: string; type: string; createdAt: string; createdBy: string; createdById: string }>;
  } | null;
}

export async function getApplicantVerifications() {
  return apiFetch<ApplicantVerification[]>('/api/applicant-verifications');
}

export async function flagApplicantVerification(id: string, note: string) {
  return apiFetch<ApplicantVerification>(`/api/applicant-verifications/${encodeURIComponent(id)}/flag`, { method: 'POST', body: JSON.stringify({ note }) });
}

export async function decideApplicantVerification(id: string, decision: 'approved' | 'rejected', notes: string) {
  return apiFetch<ApplicantVerification>(`/api/applicant-verifications/${encodeURIComponent(id)}/decision`, { method: 'PUT', body: JSON.stringify({ decision, notes }) });
}

export async function getRuntimeSettings() {
  return apiFetch<Pick<SystemSettings, 'organizationName' | 'notificationPollingSeconds'>>('/api/system/runtime-settings');
}

export interface SmsProviderStatus {
  name: string;
  configured: boolean;
}

export async function getSmsProviderStatus() {
  return apiFetch<SmsProviderStatus>('/api/system/sms-provider');
}

export interface SystemConfiguration {
  assistanceTypes: AssistanceTypeConfiguration[];
  systemSettings: SystemSettings;
}

export interface SystemReport {
  organizationName: string;
  generatedAt: string;
  parameters: ReportParameters;
  availableFilters: { statuses: string[]; assistanceTypes: string[]; facilities: string[] };
  totalRequests: number;
  applicationsByDate: { date: string; count: number }[];
  applicationsByAssistanceType: { assistanceType: string; count: number }[];
  applicationsByStatus: { status: string; count: number }[];
  requestsByStatus: Record<string, number>;
  requestsByAssistanceType: Record<string, number>;
  outcomes: {
    approved: number;
    denied: number;
    decided: number;
    approvalRate: number;
    denialRate: number;
    correctionRequested: number;
    correctionRate: number;
    processedApplications: number;
    averageProcessingTimeHours: number | null;
  };
  facilityWorkload: { facility: string; total: number; pending: number; underReview: number; correctionRequested: number; approved: number; denied: number }[];
  documentFailureReasons: { code: string; label: string; count: number }[];
  activeUsers: { totalApplicants: number; verifiedApplicants: number; activeApplicants: number; totalStaff: number; activeStaff: number };
  staffActivity: { staffId: string; name: string; role: string; eventCount: number; lastActivityAt: string | null }[];
  auditActivity: { totalEvents: number; byAction: { action: string; count: number }[] };
  staff: { total: number; active: number; byRole: Record<string, number> };
  auditEvents: number;
}

export interface ReportParameters {
  dateFrom?: string | null;
  dateTo?: string | null;
  status?: string | null;
  assistanceType?: string | null;
  facility?: string | null;
}

export type SystemAuditEntry = Record<string, unknown> & {
  id: string;
  action: string;
  performedBy: string;
  performedAt: string;
  actor: { id: string | null; name: string; email: string | null; role: string };
  affectedRecord: { type: string; id: string; label: string };
  timestamp: string | null;
  details: Record<string, unknown>;
  actorId?: string;
  actionType?: string;
  recordId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  justification?: string | null;
};

export async function getSystemConfiguration() {
  return apiFetch<SystemConfiguration>('/api/system/configuration');
}

export async function setAssistanceTypeActive(type: string, active: boolean) {
  return apiFetch<AssistanceTypeConfiguration>(`/api/assistance-types/${encodeURIComponent(type)}/status`, {
    method: 'PUT',
    body: JSON.stringify({ active }),
  });
}

export async function updateSystemSettings(settings: SystemSettings) {
  return apiFetch<SystemSettings>('/api/system/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

export async function getSystemAuditLogs(filters: { dateFrom?: string; dateTo?: string; actionType?: string } = {}) {
  const search = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value) search.set(key, value); });
  return apiFetch<SystemAuditEntry[]>(`/api/audit-logs${search.size ? `?${search}` : ''}`);
}

function reportSearch(parameters: ReportParameters) {
  const search = new URLSearchParams();
  Object.entries(parameters).forEach(([key, value]) => { if (value) search.set(key, value); });
  const query = search.toString();
  return query ? `?${query}` : '';
}

export async function generateSystemReport(parameters: ReportParameters = {}) {
  return apiFetch<SystemReport>(`/api/reports/summary${reportSearch(parameters)}`);
}

export async function exportSystemReport(format: 'csv' | 'pdf', parameters: ReportParameters = {}) {
  const token = window.localStorage.getItem('aidlink_admin_token');
  const response = await fetch(`${API_BASE_URL}/api/reports/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ format, parameters }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (response.status === 401) window.dispatchEvent(new CustomEvent('aidlink:session-expired', { detail: { message: 'Your session has expired. Sign in again to continue.' } }));
    throw new ApiRequestError(safeApiMessage(response.status, data, 'Unable to export the system report.'), response.status, String(data?.code || ''));
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `aidlink-system-report.${format}`;
  return { blob: await response.blob(), fileName };
}
