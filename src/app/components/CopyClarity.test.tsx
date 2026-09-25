import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { Sidebar } from './Sidebar';

describe('plain-language staff workflows', () => {
  it('keeps sign-in instructions and labels without environment details', () => {
    render(<LoginPage onLogin={vi.fn()} />);

    expect(screen.getByLabelText('Work email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Use the credentials assigned by your CMO administrator.')).toBeInTheDocument();
    expect(screen.queryByText(/API LATENCY/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Audit logging active/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/PRODUCTION/i)).not.toBeInTheDocument();
  });

  it('keeps accessible navigation without a static environment badge', () => {
    render(<Sidebar currentView="dashboard" onViewChange={vi.fn()} canManageStaff />);

    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assistance requests' })).toBeInTheDocument();
    expect(screen.queryByText(/v1\.4\.2/i)).not.toBeInTheDocument();
  });
});
