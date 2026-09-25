export const incomeSources = Object.freeze([
  'Salary or wages',
  'Self-employment or business',
  'Informal or daily-wage work',
  'Pension',
  'Government assistance',
  'Family or remittance support',
  'No income',
  'Other',
]);

export const patientCircumstances = Object.freeze([
  'Accident',
  'Disease',
  'Existing health issue',
  'Injury',
  'Other',
]);

function normalizeChoice(value, choices) {
  const candidate = String(value || '').trim().toLowerCase();
  return choices.find((choice) => choice.toLowerCase() === candidate) || '';
}

export function normalizeIncomeSource(value) {
  return normalizeChoice(value, incomeSources);
}

export function normalizePatientCircumstance(value) {
  return normalizeChoice(value, patientCircumstances);
}

export function isValidIncomeSource(value) {
  return Boolean(normalizeIncomeSource(value));
}

export function isValidPatientCircumstance(value) {
  return Boolean(normalizePatientCircumstance(value));
}
