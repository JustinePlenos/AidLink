export const assistanceTypes = Object.freeze([
  'Hospital Assistance',
  'Funeral Assistance',
  'Procedure',
  'Laboratory',
  'Dialysis',
  'Apparatus',
]);

export function normalizeAssistanceType(value) {
  return String(value ?? '').trim();
}

export function isValidAssistanceType(value) {
  return assistanceTypes.includes(normalizeAssistanceType(value));
}
