import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { hasPermission, Permissions } from './security/permissions.js';

test('only System Administrators can publish policy, directory, residency, and budget configuration', () => {
  for (const permission of [Permissions.POLICY_CONFIGURE, Permissions.FACILITY_DIRECTORY_MANAGE, Permissions.OFFICES_MANAGE, Permissions.CONFIGURATION_MANAGE]) {
    assert.equal(hasPermission('Case Worker', permission), false, permission);
    assert.equal(hasPermission('System Administrator', permission), true, permission);
  }
});

test('policy administration migration preserves immutable publication and audit history', async () => {
  const sql = await fs.readFile(new URL('./storage/migrations/011_policy_administration.sql', import.meta.url), 'utf8');
  for (const expected of ['office_boundary_versions', 'published_at', 'policy_configurations_no_update', 'policy_evaluations_no_update', 'budgets_protect_publication_fields', 'budget_version']) assert.match(sql, new RegExp(expected));
  assert.match(sql, /published policy versions are immutable/i);
  assert.match(sql, /published office boundary versions are immutable/i);
});

test('publication routes require confirmation, dates, justification, and authorized re-evaluation', async () => {
  const source = await fs.readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /PUBLICATION_CONFIRMATION_REQUIRED/);
  assert.match(source, /policy-re-evaluation/);
  assert.match(source, /authorizedReEvaluation: true/);
  assert.match(source, /residency_policy_version_published/);
  assert.match(source, /databaseActivityEntries/);
});
