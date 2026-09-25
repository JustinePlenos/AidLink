import { assistanceTypes } from '../../shared/assistanceTypes.js';

const reportStatuses = ['pending', 'under_review', 'correction_requested', 'approved', 'ready_for_claiming', 'denied'];
const terminalStatuses = new Set(['approved', 'ready_for_claiming', 'denied']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_REPORT_PARAMETERS';
  return error;
}

function validDate(value, label) {
  if (!value) return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw invalid(`${label} must use YYYY-MM-DD format.`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) throw invalid(`${label} must be a valid calendar date.`);
  return normalized;
}

function stringParameter(value, label) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 160) throw invalid(`${label} is invalid.`);
  return normalized;
}

export function parseReportParameters(input = {}, data = {}) {
  const source = input?.parameters && typeof input.parameters === 'object' ? input.parameters : input;
  const dateFrom = validDate(source?.dateFrom, 'Start date');
  const dateTo = validDate(source?.dateTo, 'End date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw invalid('Start date cannot be after end date.');
  const status = stringParameter(source?.status, 'Status');
  if (status && !reportStatuses.includes(status)) throw invalid('Status is not supported by this report.');
  const assistanceType = stringParameter(source?.assistanceType, 'Assistance type');
  const historicalTypes = new Set([...(data.requests || []).map((request) => String(request.assistanceType || '').trim()).filter(Boolean), ...assistanceTypes]);
  if (assistanceType && !historicalTypes.has(assistanceType)) throw invalid('Assistance type is not recognized by the system.');
  const facility = stringParameter(source?.facility, 'Facility');
  return { dateFrom, dateTo, status, assistanceType, facility };
}

function countBy(items, valueFor) {
  return items.reduce((result, item) => {
    const value = String(valueFor(item) || 'Unknown');
    result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
}

function toRows(record, key) {
  return Object.entries(record).map(([value, count]) => ({ [key]: value, count })).sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));
}

function facilityName(request) {
  return String(request.facilityEvidence?.facilityName || request.assignedFacility?.name || 'No facility evidence').trim();
}

function dateInRange(value, parameters) {
  const date = String(value || '').slice(0, 10);
  if (!date) return false;
  return (!parameters.dateFrom || date >= parameters.dateFrom) && (!parameters.dateTo || date <= parameters.dateTo);
}

function requestMatches(request, parameters) {
  if (!dateInRange(request.dateSubmitted, parameters)) return false;
  if (parameters.status && request.status !== parameters.status) return false;
  if (parameters.assistanceType && request.assistanceType !== parameters.assistanceType) return false;
  if (parameters.facility && facilityName(request).toLocaleLowerCase() !== parameters.facility.toLocaleLowerCase()) return false;
  return true;
}

function percent(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

function auditTimestamp(entry) {
  return entry.timestamp || entry.performedAt || entry.createdAt || '';
}

function auditActorId(entry) {
  return String(entry.actor?.id || entry.performedById || entry.actorId || '');
}

function auditMatchesDate(entry, parameters) {
  if (!parameters.dateFrom && !parameters.dateTo) return true;
  return dateInRange(auditTimestamp(entry), parameters);
}

function processingHours(request) {
  if (!terminalStatuses.has(request.status)) return null;
  const start = new Date(request.dateSubmitted).getTime();
  const end = new Date(request.processedAt || request.lastUpdatedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 3_600_000;
}

function hadCorrection(request, auditLogs) {
  if (request.status === 'correction_requested' || request.correctionRequest || (request.correctionHistory || []).length) return true;
  return auditLogs.some((entry) => entry.requestId === request.id && (entry.action === 'correction_requested' || entry.status === 'correction_requested'));
}

function documentFailureRows(requests, auditLogs) {
  const failures = new Map();
  const seen = new Set();
  const add = (issue, identity) => {
    const code = String(issue?.code || issue?.reason || issue || 'unknown_failure').trim() || 'unknown_failure';
    const key = `${identity}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    const current = failures.get(code) || { code, label: String(issue?.message || code).replaceAll('_', ' '), count: 0 };
    current.count += 1;
    failures.set(code, current);
  };
  for (const request of requests) {
    const documents = [...(request.documents || []), ...(request.documentHistory || [])];
    for (const correction of request.correctionHistory || []) documents.push(...(correction.replacements || []));
    if (request.correctionRequest) documents.push(...(request.correctionRequest.replacements || []));
    for (const document of documents) {
      for (const issue of document.analysis?.issues || []) add(issue, `${request.id}:${document.id || document.name}`);
    }
  }
  for (const entry of auditLogs) {
    const issues = entry.details?.analysis?.issues || entry.details?.issues || [];
    for (const issue of Array.isArray(issues) ? issues : [issues]) add(issue, `audit:${entry.id}`);
  }
  return [...failures.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function reportLines(report) {
  const params = Object.entries(report.parameters).map(([key, value]) => `${key}=${value || 'All'}`).join(', ');
  const lines = [
    report.organizationName,
    'System Administrator Report',
    `Generated: ${report.generatedAt}`,
    `Parameters: ${params}`,
    '',
    `Applications: ${report.totalRequests}`,
    `Approval rate: ${report.outcomes.approvalRate}% (${report.outcomes.approved})`,
    `Denial rate: ${report.outcomes.denialRate}% (${report.outcomes.denied})`,
    `Correction rate: ${report.outcomes.correctionRate}% (${report.outcomes.correctionRequested})`,
    `Average processing time: ${report.outcomes.averageProcessingTimeHours ?? 'N/A'} hours`,
    '', 'Applications by date',
    ...report.applicationsByDate.map((row) => `${row.date}: ${row.count}`),
    '', 'Applications by assistance type',
    ...report.applicationsByAssistanceType.map((row) => `${row.assistanceType}: ${row.count}`),
    '', 'Applications by status',
    ...report.applicationsByStatus.map((row) => `${row.status}: ${row.count}`),
    '', 'Facility workload',
    ...report.facilityWorkload.map((row) => `${row.facility}: ${row.total} total; ${row.pending} pending; ${row.underReview} under review; ${row.correctionRequested} correction; ${row.approved} approved; ${row.denied} denied`),
    '', 'Document failure reasons',
    ...(report.documentFailureReasons.length ? report.documentFailureReasons.map((row) => `${row.label} (${row.code}): ${row.count}`) : ['No stored document failures for these parameters.']),
    '', `Active applicants: ${report.activeUsers.activeApplicants}; active staff: ${report.activeUsers.activeStaff}`,
    'Staff activity',
    ...(report.staffActivity.length ? report.staffActivity.map((row) => `${row.name} (${row.role}): ${row.eventCount} events`) : ['No staff activity for this period.']),
    '', `Audit activity: ${report.auditActivity.totalEvents} events`,
    ...report.auditActivity.byAction.map((row) => `${row.action}: ${row.count}`),
  ];
  return lines.flatMap((line) => {
    const text = String(line);
    if (text.length <= 96) return [text];
    const pieces = [];
    let remaining = text;
    while (remaining.length > 96) {
      let cut = remaining.lastIndexOf(' ', 96);
      if (cut < 40) cut = 96;
      pieces.push(remaining.slice(0, cut));
      remaining = `  ${remaining.slice(cut).trimStart()}`;
    }
    pieces.push(remaining);
    return pieces;
  });
}

function pdfEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)').replace(/[^\x20-\x7E]/g, '?');
}

export function reportToPdf(report) {
  const chunks = [];
  const lines = reportLines(report);
  for (let index = 0; index < lines.length; index += 48) chunks.push(lines.slice(index, index + 48));
  const pageIds = chunks.map((_, index) => 4 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  chunks.forEach((pageLines, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const content = `BT\n/F1 9 Tf\n11 TL\n48 748 Td\n${pageLines.map((line, lineIndex) => `${lineIndex ? 'T*\n' : ''}(${pdfEscape(line)}) Tj`).join('\n')}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, 'latin1'));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, 'latin1');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, 'latin1');
}

function csvCell(value) {
  const normalized = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${normalized.replaceAll('"', '""')}"`;
}

export function reportToCsv(report) {
  const rows = [['AidLink System Administrator Report'], ['Generated at', report.generatedAt], ['Report parameters', JSON.stringify(report.parameters)], [], ['Summary', 'Value'], ['Applications', report.totalRequests], ['Approval rate (%)', report.outcomes.approvalRate], ['Denial rate (%)', report.outcomes.denialRate], ['Correction rate (%)', report.outcomes.correctionRate], ['Average processing time (hours)', report.outcomes.averageProcessingTimeHours ?? 'Not available']];
  const section = (title, headers, dataRows) => rows.push([], [title], headers, ...dataRows);
  section('Applications by date', ['Date', 'Count'], report.applicationsByDate.map((row) => [row.date, row.count]));
  section('Applications by assistance type', ['Assistance type', 'Count'], report.applicationsByAssistanceType.map((row) => [row.assistanceType, row.count]));
  section('Applications by status', ['Status', 'Count'], report.applicationsByStatus.map((row) => [row.status, row.count]));
  section('Facility workload', ['Facility', 'Total', 'Pending', 'Under review', 'Correction requested', 'Approved', 'Denied'], report.facilityWorkload.map((row) => [row.facility, row.total, row.pending, row.underReview, row.correctionRequested, row.approved, row.denied]));
  section('Document failure reasons', ['Code', 'Reason', 'Count'], report.documentFailureReasons.map((row) => [row.code, row.label, row.count]));
  section('Active users', ['Metric', 'Count'], Object.entries(report.activeUsers).filter(([, value]) => typeof value === 'number'));
  section('Staff activity', ['Staff', 'Role', 'Events', 'Last activity'], report.staffActivity.map((row) => [row.name, row.role, row.eventCount, row.lastActivityAt || '']));
  section('Audit activity', ['Action', 'Count'], report.auditActivity.byAction.map((row) => [row.action, row.count]));
  return Buffer.from(`\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`, 'utf8');
}

export function buildSystemReport(data, parameters, generatedAt = new Date().toISOString()) {
  const requests = (data.requests || []).filter((request) => requestMatches(request, parameters));
  const requestIds = new Set(requests.map((request) => request.id));
  const dateAuditLogs = (data.auditLogs || []).filter((entry) => auditMatchesDate(entry, parameters));
  const relevantRequestAudit = dateAuditLogs.filter((entry) => requestIds.has(entry.requestId));
  const hasRequestDimensionFilter = Boolean(parameters.status || parameters.assistanceType || parameters.facility);
  const scopedAuditLogs = hasRequestDimensionFilter ? relevantRequestAudit : dateAuditLogs;
  const statusCounts = countBy(requests, (request) => request.status);
  const typeCounts = countBy(requests, (request) => request.assistanceType);
  const dateCounts = countBy(requests, (request) => String(request.dateSubmitted || '').slice(0, 10) || 'Unknown');
  const approved = (statusCounts.approved || 0) + (statusCounts.ready_for_claiming || 0);
  const denied = statusCounts.denied || 0;
  const decided = approved + denied;
  const corrected = requests.filter((request) => hadCorrection(request, data.auditLogs || [])).length;
  const durations = requests.map(processingHours).filter((value) => value != null);
  const facilities = new Map();
  for (const request of requests) {
    const name = facilityName(request);
    const row = facilities.get(name) || { facility: name, total: 0, pending: 0, underReview: 0, correctionRequested: 0, approved: 0, denied: 0 };
    row.total += 1;
    if (request.status === 'pending') row.pending += 1;
    if (request.status === 'under_review') row.underReview += 1;
    if (request.status === 'correction_requested') row.correctionRequested += 1;
    if (request.status === 'approved' || request.status === 'ready_for_claiming') row.approved += 1;
    if (request.status === 'denied') row.denied += 1;
    facilities.set(name, row);
  }
  const staffById = new Map((data.authUsers || []).map((user) => [String(user.id), user]));
  const staffEvents = new Map();
  for (const entry of scopedAuditLogs) {
    const staff = staffById.get(auditActorId(entry));
    if (!staff) continue;
    const row = staffEvents.get(staff.id) || { staffId: staff.id, name: staff.fullName, role: staff.role, eventCount: 0, lastActivityAt: null };
    row.eventCount += 1;
    const timestamp = auditTimestamp(entry) || null;
    if (timestamp && (!row.lastActivityAt || timestamp > row.lastActivityAt)) row.lastActivityAt = timestamp;
    staffEvents.set(staff.id, row);
  }
  const activeApplicantKeys = new Set(requests.map((request) => String(request.applicantId || request.email || '').toLowerCase()).filter(Boolean));
  const auditActionCounts = countBy(scopedAuditLogs, (entry) => entry.action || 'unknown');
  const roleCounts = countBy(data.authUsers || [], (user) => user.role);
  const availableFacilities = [...new Set((data.requests || []).map(facilityName))].sort();
  const availableTypes = [...new Set([...(data.requests || []).map((request) => request.assistanceType).filter(Boolean), ...assistanceTypes])].sort();
  return {
    organizationName: data.systemSettings?.organizationName || 'AidLink',
    generatedAt,
    parameters,
    availableFilters: { statuses: reportStatuses, assistanceTypes: availableTypes, facilities: availableFacilities },
    totalRequests: requests.length,
    applicationsByDate: toRows(dateCounts, 'date').sort((a, b) => a.date.localeCompare(b.date)),
    applicationsByAssistanceType: toRows(typeCounts, 'assistanceType'),
    applicationsByStatus: toRows(statusCounts, 'status'),
    requestsByStatus: statusCounts,
    requestsByAssistanceType: typeCounts,
    outcomes: {
      approved,
      denied,
      decided,
      approvalRate: percent(approved, decided),
      denialRate: percent(denied, decided),
      correctionRequested: corrected,
      correctionRate: percent(corrected, requests.length),
      processedApplications: durations.length,
      averageProcessingTimeHours: durations.length ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2)) : null,
    },
    facilityWorkload: [...facilities.values()].sort((a, b) => b.total - a.total || a.facility.localeCompare(b.facility)),
    documentFailureReasons: documentFailureRows(requests, relevantRequestAudit),
    activeUsers: {
      totalApplicants: (data.applicants || []).length,
      verifiedApplicants: (data.applicants || []).filter((applicant) => applicant.verificationStatus === 'approved' || applicant.accountStatus === 'verified').length,
      activeApplicants: activeApplicantKeys.size,
      totalStaff: (data.authUsers || []).length,
      activeStaff: (data.authUsers || []).filter((user) => user.active !== false).length,
    },
    staffActivity: [...staffEvents.values()].sort((a, b) => b.eventCount - a.eventCount || a.name.localeCompare(b.name)),
    auditActivity: { totalEvents: scopedAuditLogs.length, byAction: toRows(auditActionCounts, 'action') },
    staff: { total: (data.authUsers || []).length, active: (data.authUsers || []).filter((user) => user.active !== false).length, byRole: roleCounts },
    auditEvents: scopedAuditLogs.length,
  };
}
