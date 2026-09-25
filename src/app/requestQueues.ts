import type { AssistanceRequest } from './types';

export type RequestStatus = AssistanceRequest['status'];
export type RequestQueueKey = 'pending' | 'under_review' | 'correction_requested' | 'approved' | 'ready_for_claiming' | 'denied' | 'stale';

export interface RequestFilters {
  dateFrom: string;
  dateTo: string;
  assistanceType: string;
  facilityId: string;
  status: RequestStatus | '';
  staleOnly: boolean;
}

export const emptyRequestFilters: RequestFilters = {
  dateFrom: '',
  dateTo: '',
  assistanceType: '',
  facilityId: '',
  status: '',
  staleOnly: false,
};

export const staleAfterDays = 7;
const finalStatuses: RequestStatus[] = ['ready_for_claiming', 'denied'];

export const queueDefinitions: Array<{ key: RequestQueueKey; label: string; description: string }> = [
  { key: 'pending', label: 'New or pending', description: 'Awaiting initial review' },
  { key: 'under_review', label: 'Under review', description: 'Currently being assessed' },
  { key: 'correction_requested', label: 'Correction requested', description: 'Waiting for applicant updates' },
  { key: 'approved', label: 'Approved - preparation', description: 'Complete claiming details and letter' },
  { key: 'ready_for_claiming', label: 'Ready for claiming', description: 'Released with protected letter access' },
  { key: 'denied', label: 'Denied', description: 'Closed without approval' },
  { key: 'stale', label: 'Overdue or stale', description: `No activity for ${staleAfterDays}+ days` },
];

export function isStaleRequest(request: AssistanceRequest, now = Date.now()) {
  if (finalStatuses.includes(request.status)) return false;
  const activityTime = new Date(request.lastUpdatedAt || request.dateSubmitted).getTime();
  return Number.isFinite(activityTime) && now - activityTime >= staleAfterDays * 24 * 60 * 60 * 1000;
}

export function applyRequestFilters(requests: AssistanceRequest[], filters: RequestFilters) {
  return requests.filter((request) => {
    const submittedDate = request.dateSubmitted.slice(0, 10);
    const matchesDate = (!filters.dateFrom || submittedDate >= filters.dateFrom) && (!filters.dateTo || submittedDate <= filters.dateTo);
    const matchesType = !filters.assistanceType || request.assistanceType === filters.assistanceType;
    const facilityName = request.facilityEvidence?.facilityName || request.assignedFacility?.name || '';
    const matchesFacility = !filters.facilityId
      || (filters.facilityId === 'unassigned' ? !facilityName : facilityName === filters.facilityId);
    const matchesStatus = !filters.status || request.status === filters.status;
    return matchesDate && matchesType && matchesFacility && matchesStatus && (!filters.staleOnly || isStaleRequest(request));
  });
}

export function requestsInQueue(requests: AssistanceRequest[], queue: RequestQueueKey) {
  return queue === 'stale' ? requests.filter((request) => isStaleRequest(request)) : requests.filter((request) => request.status === queue);
}

export function filtersForQueue(filters: RequestFilters, queue: RequestQueueKey): RequestFilters {
  return { ...filters, status: queue === 'stale' ? '' : queue, staleOnly: queue === 'stale' };
}
