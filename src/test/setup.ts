import '@testing-library/jest-dom/vitest';

Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  writable: true,
  value: () => 'blob:identity-proof',
});

Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  writable: true,
  value: () => undefined,
});
