import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaffManagement } from './StaffManagement';

const apiMocks = vi.hoisted(() => ({
  getStaffAccounts: vi.fn(),
  createStaffAccount: vi.fn(),
  assignStaffRole: vi.fn(),
  setStaffActive: vi.fn(),
  resetStaffPassword: vi.fn(),
}));

vi.mock('../api', () => ({
  ...apiMocks,
  staffRoles: ['System Administrator', 'Case Worker'],
  getActionErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
}));

vi.mock('../utils/toast', () => ({ showToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const admin = { id: 'admin-1', fullName: 'System Admin', email: 'admin@example.com', phone: '', address: '', dateOfBirth: '', role: 'System Administrator', active: true, registeredDate: '2026-09-16' };

describe('StaffManagement action feedback', () => {
  beforeEach(() => {
    apiMocks.getStaffAccounts.mockResolvedValue([admin]);
    apiMocks.createStaffAccount.mockReset();
    apiMocks.assignStaffRole.mockReset();
    apiMocks.setStaffActive.mockReset();
    apiMocks.resetStaffPassword.mockReset();
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  async function openCreate() {
    const user = userEvent.setup();
    render(<StaffManagement currentStaffId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Create staff account' }));
    return user;
  }

  it('identifies every missing or invalid staff-account field accessibly', async () => {
    const user = await openCreate();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent('full name');
    expect(alert).toHaveTextContent('work email');
    expect(alert).toHaveTextContent('at least 8 characters');
    expect(screen.getByLabelText('Full name')).toHaveAttribute('aria-invalid', 'true');
    expect(apiMocks.createStaffAccount).not.toHaveBeenCalled();
  });

  it('keeps staff values after a permission failure and closes with Escape', async () => {
    const user = await openCreate();
    apiMocks.createStaffAccount.mockRejectedValue(new Error('You do not have permission to perform this action.'));
    await user.type(screen.getByLabelText('Full name'), 'Case Worker Two');
    await user.type(screen.getByLabelText('Work email'), 'worker2@example.com');
    await user.type(screen.getByLabelText('Temporary password'), 'Temporary123');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('do not have permission');
    expect(screen.getByLabelText('Full name')).toHaveValue('Case Worker Two');
    expect(screen.getByLabelText('Work email')).toHaveValue('worker2@example.com');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Create staff account' })).not.toBeInTheDocument();
  });

  it('prevents duplicate staff creation while showing a loading state', async () => {
    let resolveCreate!: (value: typeof admin) => void;
    apiMocks.createStaffAccount.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const user = await openCreate();
    await user.type(screen.getByLabelText('Full name'), 'Case Worker Two');
    await user.type(screen.getByLabelText('Work email'), 'worker2@example.com');
    await user.type(screen.getByLabelText('Temporary password'), 'Temporary123');
    const submit = screen.getByRole('button', { name: 'Create account' });
    submit.click();
    submit.click();

    expect(apiMocks.createStaffAccount).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Creating the staff account');
    expect(screen.getByRole('button', { name: 'Creating account...' })).toBeDisabled();
    resolveCreate({ ...admin, id: 'worker-2', fullName: 'Case Worker Two', email: 'worker2@example.com', role: 'Case Worker' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
