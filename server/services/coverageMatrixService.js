export const CoverageOutcome = Object.freeze({ ELIGIBLE: 'eligible', PARTIALLY_COVERED: 'partially_covered', INELIGIBLE: 'ineligible' });
export const CoverageReasonCode = Object.freeze({
  POLICY_PENDING: 'COVERAGE_MATRIX_PENDING_CLIENT_VALUES',
  HARD_DISQUALIFIER: 'HARD_DISQUALIFIER_NOT_CLEARED',
  PAYER_DATA_REQUIRED: 'VERIFIED_PAYER_DATA_REQUIRED',
  PAYER_IGNORED: 'UNVERIFIED_OR_UNAPPROVED_PAYER_IGNORED',
  PAYER_DEDUCTED: 'VERIFIED_PAYER_DEDUCTION_APPLIED',
  NO_BALANCE: 'NO_POSITIVE_REMAINING_BALANCE',
  ROOM_REDUCTION: 'PUBLIC_HOSPITAL_UPGRADED_ROOM_REDUCTION',
  MEDICINE_REDUCTION: 'OUTSIDE_PHARMACY_MEDICINE_REDUCTION',
  SUBSIDY_SCALED: 'PARTIAL_INDIGENT_SUBSIDY_SCALED',
  SUBSIDY_BAND_REQUIRED: 'VERIFIED_SUBSIDY_BAND_REQUIRED',
  POLICY_CAP: 'COVERAGE_POLICY_CAP_APPLIED',
  NO_COVERAGE: 'NO_COVERED_AMOUNT',
});

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const rate = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw Object.assign(new Error(`${label} must be between 0 and 1.`), { code: 'INVALID_COVERAGE_POLICY' });
  return number;
};
const amount = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw Object.assign(new Error(`${label} must be zero or greater.`), { code: 'INVALID_COVERAGE_INPUT' });
  return money(number);
};
const adjustment = (code, message, amountValue = 0, extra = {}) => ({ code, message, amount: money(amountValue), ...extra });

export function validateCoveragePolicyConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw Object.assign(new Error('Coverage-matrix configuration must be an object.'), { code: 'INVALID_COVERAGE_POLICY' });
  if (configuration.status === 'awaiting_client_values') return configuration;
  if (configuration.status !== 'active') throw Object.assign(new Error('Coverage-matrix status must be active or awaiting_client_values.'), { code: 'INVALID_COVERAGE_POLICY' });
  const forbidden = JSON.stringify(configuration).match(/philhealth(number|toggle)|applicantphilhealth/i);
  if (forbidden) throw Object.assign(new Error('Applicant PhilHealth fields are not permitted in coverage policy.'), { code: 'APPLICANT_PAYER_FIELD_FORBIDDEN' });
  rate(configuration.publicHospitalRoomReductions?.semi_private, 'Semi-private room reduction');
  rate(configuration.publicHospitalRoomReductions?.private, 'Private room reduction');
  rate(configuration.outsidePharmacyMedicineReductionRate, 'Outside-pharmacy medicine reduction');
  if (!Array.isArray(configuration.partialIndigentSubsidyBands) || !configuration.partialIndigentSubsidyBands.length) throw Object.assign(new Error('At least one client-approved partial-indigent subsidy band is required.'), { code: 'INVALID_COVERAGE_POLICY' });
  const codes = new Set();
  for (const band of configuration.partialIndigentSubsidyBands) {
    const code = String(band?.code || '').trim();
    if (!code || codes.has(code)) throw Object.assign(new Error('Subsidy-band codes must be present and unique.'), { code: 'INVALID_COVERAGE_POLICY' });
    codes.add(code); rate(band.rate, `Subsidy rate for ${code}`);
  }
  amount(configuration.coverageCaps?.default, 'Default coverage cap');
  for (const [type, cap] of Object.entries(configuration.coverageCaps?.byAssistanceType || {})) amount(cap, `Coverage cap for ${type}`);
  const payer = configuration.payerDeductions || { enabled: false };
  if (payer.enabled === true) {
    if (!String(payer.clientApprovalReference || '').trim() || !Array.isArray(payer.approvedPayerTypes) || !payer.approvedPayerTypes.length) throw Object.assign(new Error('Payer deductions require a client approval reference and approved payer types.'), { code: 'PAYER_APPROVAL_REQUIRED' });
    if (!Array.isArray(payer.verificationMethods) || payer.verificationMethods.some((item) => !['staff', 'integration'].includes(item))) throw Object.assign(new Error('Payer deductions may only use staff or integration verification.'), { code: 'INVALID_PAYER_VERIFICATION' });
  }
  return configuration;
}

export function calculateCoverageMatrix({ request, input, policy, hardDisqualifierOutcome }) {
  const configuration = validateCoveragePolicyConfiguration(policy?.configuration || { status: 'awaiting_client_values' });
  const policyVersion = policy?.policy_version || policy?.policyVersion || null;
  if (configuration.status !== 'active') return { outcome: CoverageOutcome.INELIGIBLE, calculationEnabled: false, reasonCodes: [CoverageReasonCode.POLICY_PENDING], adjustments: [adjustment(CoverageReasonCode.POLICY_PENDING, 'Coverage values are awaiting client approval; no coverage calculation was enabled.')], grossAmount: null, verifiedPayerDeductions: 0, patientBalance: null, eligibleBase: null, coveredAmount: 0, netRemainingBalance: null, policyVersion };
  if (!['clear', 'exception_applied'].includes(hardDisqualifierOutcome)) return { outcome: CoverageOutcome.INELIGIBLE, calculationEnabled: true, reasonCodes: [CoverageReasonCode.HARD_DISQUALIFIER], adjustments: [adjustment(CoverageReasonCode.HARD_DISQUALIFIER, 'Coverage cannot be calculated until hard disqualifiers are cleared.')], grossAmount: null, verifiedPayerDeductions: 0, patientBalance: null, eligibleBase: null, coveredAmount: 0, netRemainingBalance: null, policyVersion };
  const grossAmount = amount(input?.grossAmount, 'Gross amount');
  const adjustments = [];
  const payerConfiguration = configuration.payerDeductions || { enabled: false, required: false };
  const payerItems = Array.isArray(input?.payerDeductions) ? input.payerDeductions : [];
  if (payerConfiguration.enabled && payerConfiguration.required && !payerItems.length) return { outcome: CoverageOutcome.INELIGIBLE, calculationEnabled: true, reasonCodes: [CoverageReasonCode.PAYER_DATA_REQUIRED], adjustments: [adjustment(CoverageReasonCode.PAYER_DATA_REQUIRED, 'Verified payer data from authorized staff or an approved integration is required.')], grossAmount, verifiedPayerDeductions: 0, patientBalance: grossAmount, eligibleBase: 0, coveredAmount: 0, netRemainingBalance: grossAmount, policyVersion };
  let payerTotal = 0;
  for (const item of payerItems) {
    const approved = payerConfiguration.enabled === true && item?.verified === true
      && payerConfiguration.approvedPayerTypes.includes(String(item.payerType || ''))
      && payerConfiguration.verificationMethods.includes(String(item.verificationMethod || ''))
      && String(item.reference || '').trim();
    if (!approved) { adjustments.push(adjustment(CoverageReasonCode.PAYER_IGNORED, 'A payer entry was ignored because it was unverified or not client-approved.', 0, { payerType: String(item?.payerType || '') })); continue; }
    const deduction = amount(item.amount, `Payer deduction for ${item.payerType}`);
    payerTotal += deduction;
    adjustments.push(adjustment(CoverageReasonCode.PAYER_DEDUCTED, `Verified ${item.payerType} deduction applied.`, -deduction, { payerType: item.payerType, reference: item.reference }));
  }
  payerTotal = money(Math.min(grossAmount, payerTotal));
  const patientBalance = money(Math.max(0, grossAmount - payerTotal));
  if (patientBalance <= 0) return { outcome: CoverageOutcome.INELIGIBLE, calculationEnabled: true, reasonCodes: [...new Set([...adjustments.map((item) => item.code), CoverageReasonCode.NO_BALANCE])], adjustments: [...adjustments, adjustment(CoverageReasonCode.NO_BALANCE, 'No positive balance remains after verified payer deductions.')], grossAmount, verifiedPayerDeductions: payerTotal, patientBalance, eligibleBase: 0, coveredAmount: 0, netRemainingBalance: 0, policyVersion };
  let eligibleBase = patientBalance;
  const facilityTier = request?.facility_tier_snapshot || request?.facilityTier || input?.facilityTier;
  const roomClass = String(input?.roomClass || 'standard').toLowerCase().replace('-', '_');
  if (facilityTier === 'public' && ['semi_private', 'private'].includes(roomClass)) {
    const roomCharges = amount(input?.roomCharges || 0, 'Room charges');
    const reductionRate = rate(configuration.publicHospitalRoomReductions[roomClass], `${roomClass} room reduction`);
    const reduction = money(Math.min(eligibleBase, roomCharges * reductionRate));
    eligibleBase = money(eligibleBase - reduction);
    if (reduction > 0) adjustments.push(adjustment(CoverageReasonCode.ROOM_REDUCTION, `${roomClass.replace('_', '-')} public-hospital room reduction applied.`, -reduction, { rate: reductionRate, roomCharges }));
  }
  const medicineRate = rate(configuration.outsidePharmacyMedicineReductionRate, 'Outside-pharmacy medicine reduction');
  const affectedMedicineAmount = (Array.isArray(input?.medicineItems) ? input.medicineItems : []).reduce((total, item) => total + ((!item.pharmacyAccredited && (item.formulary === false || item.branded === true)) ? amount(item.amount, 'Medicine amount') : 0), 0);
  const medicineReduction = money(Math.min(eligibleBase, affectedMedicineAmount * medicineRate));
  if (medicineReduction > 0) { eligibleBase = money(eligibleBase - medicineReduction); adjustments.push(adjustment(CoverageReasonCode.MEDICINE_REDUCTION, 'Reduction applied to non-formulary or branded medicine from an unaccredited outside pharmacy.', -medicineReduction, { rate: medicineRate, affectedMedicineAmount: money(affectedMedicineAmount) })); }
  const bandCode = String(input?.subsidyBand || '').trim();
  const band = configuration.partialIndigentSubsidyBands.find((item) => item.code === bandCode);
  if (!band || input?.subsidyBandVerified !== true) return { outcome: CoverageOutcome.INELIGIBLE, calculationEnabled: true, reasonCodes: [...new Set([...adjustments.map((item) => item.code), CoverageReasonCode.SUBSIDY_BAND_REQUIRED])], adjustments: [...adjustments, adjustment(CoverageReasonCode.SUBSIDY_BAND_REQUIRED, 'A verified client-approved partial-indigent subsidy band is required.')], grossAmount, verifiedPayerDeductions: payerTotal, patientBalance, eligibleBase, coveredAmount: 0, netRemainingBalance: patientBalance, policyVersion };
  const subsidyRate = rate(band.rate, `Subsidy rate for ${bandCode}`);
  adjustments.push(adjustment(CoverageReasonCode.SUBSIDY_SCALED, `Verified subsidy band ${bandCode} applies a scaled subsidy.`, 0, { bandCode, rate: subsidyRate }));
  const uncapped = money(eligibleBase * subsidyRate);
  const configuredCap = configuration.coverageCaps.byAssistanceType?.[request?.assistance_type || request?.assistanceType] ?? configuration.coverageCaps.default;
  const cap = amount(configuredCap, 'Coverage cap');
  const coveredAmount = money(Math.min(uncapped, cap));
  if (coveredAmount < uncapped) adjustments.push(adjustment(CoverageReasonCode.POLICY_CAP, 'The client-approved coverage cap limited the subsidy.', coveredAmount - uncapped, { cap, uncappedAmount: uncapped }));
  const netRemainingBalance = money(Math.max(0, patientBalance - coveredAmount));
  const outcome = coveredAmount <= 0 ? CoverageOutcome.INELIGIBLE : netRemainingBalance <= 0 ? CoverageOutcome.ELIGIBLE : CoverageOutcome.PARTIALLY_COVERED;
  if (coveredAmount <= 0) adjustments.push(adjustment(CoverageReasonCode.NO_COVERAGE, 'The applied matrix produced no covered amount.'));
  return { outcome, calculationEnabled: true, reasonCodes: [...new Set(adjustments.map((item) => item.code))], adjustments, grossAmount, verifiedPayerDeductions: payerTotal, patientBalance, eligibleBase, subsidyBand: bandCode, subsidyRate, policyCap: cap, uncappedCoverage: uncapped, coveredAmount, netRemainingBalance, policyVersion, calculatorVersion: 'coverage-matrix-1' };
}
