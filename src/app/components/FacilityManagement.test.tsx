import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FacilityManagement } from './FacilityManagement';

const apiMocks = vi.hoisted(() => ({
  createBudgetPool: vi.fn(),
  getBudgetPools: vi.fn(),
  getSystemConfiguration: vi.fn(),
  getSmsProviderStatus: vi.fn(),
  getEffectiveFacilityDirectory: vi.fn(),
  getRequiredDocuments: vi.fn(),
  setAssistanceTypeActive: vi.fn(),
  updateRequiredDocuments: vi.fn(),
  updateSystemSettings: vi.fn(),
  getPolicyVersions: vi.fn(),
  getPolicyOffices: vi.fn(),
  publishPolicyVersion: vi.fn(),
  publishFacilityDirectory: vi.fn(),
  publishOfficeBoundary: vi.fn(),
}));

vi.mock('../api', () => ({
  ...apiMocks,
  getActionErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
}));
vi.mock('../utils/toast', () => ({ showToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const settings = {
  organizationName: 'LINGAP CMO',
  notificationPollingSeconds: 30,
  receiptValidityDays: 365,
  defaultClaimingTime: '09:00',
  defaultClaimingLocation: 'LINGAP desk',
  smsHelpChannel: '09170000000',
};
const type = { name: 'Hospital Assistance', active: true, requiredDocuments: ['Valid ID', 'Recent facility receipt or billing document'] };

describe('FacilityManagement configuration feedback', () => {
  beforeEach(() => {
    apiMocks.getBudgetPools.mockResolvedValue([]);
    apiMocks.createBudgetPool.mockReset();
    apiMocks.getSystemConfiguration.mockResolvedValue({ assistanceTypes: [type], systemSettings: settings });
    apiMocks.getSmsProviderStatus.mockResolvedValue({ name: 'unconfigured', configured: false });
    apiMocks.getEffectiveFacilityDirectory.mockResolvedValue({
      id: 'facility-directory-v1', version: 1, directoryVersion: 'facility-directory:v1',
      effectiveFrom: '1970-01-01T00:00:00.000Z', effectiveUntil: null,
      authoritativeSource: 'Client-approved public classification requirement', justification: 'Public configuration',
      directory: {
        status: 'awaiting_private_partner_list', requiredPrivatePartnerCount: 42, maxEvidenceAgeDays: 365,
        entries: [{ key: 'spmc', canonicalName: 'Southern Philippines Medical Center', tier: 'public', category: 'hospital', effectiveFrom: '1970-01-01' }],
        rules: [{ key: 'district-health-units', match: 'district health unit', tier: 'public', category: 'district_health_unit', effectiveFrom: '1970-01-01' }],
      },
    });
    apiMocks.getPolicyVersions.mockResolvedValue([]);
    apiMocks.getPolicyOffices.mockResolvedValue([{ id: 'office-1', office_code: 'D1', name: 'District 1', office_type: 'district_satellite', district_code: 'D1', active: true, residency_boundary: { cities: ['Davao City'] }, boundary_version: 1 }]);
    apiMocks.publishPolicyVersion.mockReset();
    apiMocks.publishFacilityDirectory.mockReset();
    apiMocks.publishOfficeBoundary.mockReset();
    apiMocks.getRequiredDocuments.mockResolvedValue({ [type.name]: type.requiredDocuments });
    apiMocks.updateSystemSettings.mockReset();
    apiMocks.updateRequiredDocuments.mockReset();
    apiMocks.setAssistanceTypeActive.mockReset();
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  async function renderConfiguration() {
    render(<FacilityManagement />);
    await screen.findByText('System configuration loaded.');
    return userEvent.setup();
  }

  it('explains business effects without backend or adapter terminology', async () => {
    await renderConfiguration();

    expect(screen.getByText(/Applicants must complete it before submission/)).toBeInTheDocument();
    expect(screen.getByText(/Receipts older than this limit cannot be used/)).toBeInTheDocument();
    expect(screen.getByText('Southern Philippines Medical Center')).toBeInTheDocument();
    expect(screen.getByText('Private partner directory pending')).toBeInTheDocument();
    expect(screen.queryByText(/backend/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/deployment adapter/i)).not.toBeInTheDocument();
  });

  it('identifies missing and invalid workflow settings with an accessible alert', async () => {
    const user = await renderConfiguration();
    await user.clear(screen.getByLabelText('Organization name'));
    await user.click(screen.getByRole('button', { name: 'Save workflow settings' }));
    const missing = screen.getByRole('alert');
    expect(missing).toHaveTextContent('organization name');
    expect(missing).toHaveAttribute('aria-live', 'assertive');

    await user.type(screen.getByLabelText('Organization name'), 'AidLink Office');
    await user.clear(screen.getByLabelText('Notification refresh interval (seconds)'));
    await user.type(screen.getByLabelText('Notification refresh interval (seconds)'), '5');
    await user.click(screen.getByRole('button', { name: 'Save workflow settings' }));
    expect(screen.getByRole('alert')).toHaveTextContent('between 10 and 3600 seconds');
    expect(apiMocks.updateSystemSettings).not.toHaveBeenCalled();
  });

  it('keeps configuration values after a permission failure', async () => {
    const user = await renderConfiguration();
    apiMocks.updateSystemSettings.mockRejectedValue(new Error('You do not have permission to perform this action.'));
    const organization = screen.getByLabelText('Organization name');
    await user.clear(organization);
    await user.type(organization, 'Updated AidLink Office');
    await user.click(screen.getByRole('button', { name: 'Save workflow settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('do not have permission');
    expect(organization).toHaveValue('Updated AidLink Office');
  });

  it('blocks a checklist without receipt evidence and prevents duplicate saves', async () => {
    const user = await renderConfiguration();
    const checklist = screen.getByLabelText('Required documents, one per line');
    await user.clear(checklist);
    await user.type(checklist, 'Valid government ID');
    await user.click(screen.getByRole('button', { name: 'Save checklist' }));
    expect(screen.getByRole('alert')).toHaveTextContent('recent receipt or billing document');
    expect(apiMocks.updateRequiredDocuments).not.toHaveBeenCalled();

    await user.type(checklist, '{enter}Recent hospital receipt');
    let resolveSave!: (value: typeof settings) => void;
    apiMocks.updateSystemSettings.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    const save = screen.getByRole('button', { name: 'Save workflow settings' });
    await user.click(save);
    expect(apiMocks.updateSystemSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving workflow settings...' })).toBeDisabled());
    screen.getByRole('button', { name: 'Saving workflow settings...' }).click();
    expect(apiMocks.updateSystemSettings).toHaveBeenCalledTimes(1);
    resolveSave(settings);
    await waitFor(() => expect(screen.getByText('Workflow settings updated.')).toBeInTheDocument());
  });

  it('validates and creates a controlled budget pool', async () => {
    const user = await renderConfiguration();
    await user.type(screen.getByLabelText('Budget pool name'), 'Hospital 2026');
    await user.type(screen.getByLabelText('Budget effective from'), '2026-01-01');
    await user.type(screen.getByLabelText('Budget effective until'), '2026-12-31');
    await user.type(screen.getByLabelText('Budget allocation'), '100000');
    await user.type(screen.getByLabelText('Per-request assistance limit'), '10000');
    await user.clear(screen.getByLabelText('Guarantee Letter validity days'));
    await user.type(screen.getByLabelText('Guarantee Letter validity days'), '2');
    await user.type(screen.getByLabelText('Budget configuration justification'), 'Approved annual city allocation.');
    await user.click(screen.getByLabelText('Confirm budget publication'));
    await user.click(screen.getByRole('button', { name: 'Publish budget pool' }));
    expect(screen.getByRole('alert')).toHaveTextContent('3 through 14 days');
    expect(apiMocks.createBudgetPool).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Guarantee Letter validity days'));
    await user.type(screen.getByLabelText('Guarantee Letter validity days'), '3');
    apiMocks.createBudgetPool.mockResolvedValue({ id: 'budget-1', name: 'Hospital 2026', assistanceType: 'Hospital Assistance', effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31', allocatedAmount: 100000, reservedAmount: 0, spentAmount: 0, availableAmount: 100000, allocatableAmount: 100000, assistanceLimit: 10000, depletionThresholdAmount: 0, guaranteeLetterValidityDays: 3, active: true });
    await user.click(screen.getByRole('button', { name: 'Publish budget pool' }));
    await waitFor(() => expect(apiMocks.createBudgetPool).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Budget pool created and ready for its effective period.')).toBeInTheDocument();
    expect(screen.getByText('3 days')).toBeInTheDocument();
  });
});
