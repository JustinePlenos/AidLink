export class AidLinkRepository {
  async submitRequest(_input) { throw new Error('submitRequest must be implemented.'); }
  async submitRequestWithPolicyGates(_input) { throw new Error('submitRequestWithPolicyGates must be implemented.'); }
  async overrideSubmissionPolicyGate(_input) { throw new Error('overrideSubmissionPolicyGate must be implemented.'); }
  async requestCorrection(_input) { throw new Error('requestCorrection must be implemented.'); }
  async replaceDocument(_input) { throw new Error('replaceDocument must be implemented.'); }
  async recordDecision(_input) { throw new Error('recordDecision must be implemented.'); }
  async reserveBudget(_input) { throw new Error('reserveBudget must be implemented.'); }
  async listBudgetPools(_input) { throw new Error('listBudgetPools must be implemented.'); }
  async createBudgetPool(_input) { throw new Error('createBudgetPool must be implemented.'); }
  async storeGuaranteeLetter(_input) { throw new Error('storeGuaranteeLetter must be implemented.'); }
  async releaseGuaranteeLetter(_input) { throw new Error('releaseGuaranteeLetter must be implemented.'); }
  async expireGuaranteeLetter(_input) { throw new Error('expireGuaranteeLetter must be implemented.'); }
  async expireDueGuaranteeLetters(_input) { throw new Error('expireDueGuaranteeLetters must be implemented.'); }
  async enqueueNotification(_input) { throw new Error('enqueueNotification must be implemented.'); }
  async appendAudit(_input) { throw new Error('appendAudit must be implemented.'); }
}

export class PolicyRepository {
  async getEffectivePolicy(_input) { throw new Error('getEffectivePolicy must be implemented.'); }
  async getPolicyVersion(_input) { throw new Error('getPolicyVersion must be implemented.'); }
  async listPolicyVersions(_input) { throw new Error('listPolicyVersions must be implemented.'); }
  async createPolicyVersion(_input) { throw new Error('createPolicyVersion must be implemented.'); }
  async recordPolicyEvaluation(_input) { throw new Error('recordPolicyEvaluation must be implemented.'); }
  async getRequestPolicyHistory(_input) { throw new Error('getRequestPolicyHistory must be implemented.'); }
}

export class FacilityRoutingRepository {
  async getEffectiveDirectory(_input) { throw new Error('getEffectiveDirectory must be implemented.'); }
  async createDirectoryVersion(_input) { throw new Error('createDirectoryVersion must be implemented.'); }
  async resolveRequestFacility(_input) { throw new Error('resolveRequestFacility must be implemented.'); }
  async recordChoPrescriptionDecision(_input) { throw new Error('recordChoPrescriptionDecision must be implemented.'); }
  async setChoValidatorCapability(_input) { throw new Error('setChoValidatorCapability must be implemented.'); }
  async getRequestRoutingStatus(_input) { throw new Error('getRequestRoutingStatus must be implemented.'); }
}

export class HardDisqualifierRepository {
  async recordEvidence(_input) { throw new Error('recordEvidence must be implemented.'); }
  async evaluateRequest(_input) { throw new Error('evaluateRequest must be implemented.'); }
  async recordException(_input) { throw new Error('recordException must be implemented.'); }
  async setExceptionCapability(_input) { throw new Error('setExceptionCapability must be implemented.'); }
  async getRequestHistory(_input) { throw new Error('getRequestHistory must be implemented.'); }
}

export class CoverageMatrixRepository {
  async recordVerifiedInput(_input) { throw new Error('recordVerifiedInput must be implemented.'); }
  async calculateRequest(_input) { throw new Error('calculateRequest must be implemented.'); }
  async getRequestHistory(_input) { throw new Error('getRequestHistory must be implemented.'); }
}

export class WorkflowEvaluationRepository {
  async evaluateRequest(_input) { throw new Error('evaluateRequest must be implemented.'); }
  async confirmEvaluation(_input) { throw new Error('confirmEvaluation must be implemented.'); }
  async validateForApproval(_input) { throw new Error('validateForApproval must be implemented.'); }
  async getRequestHistory(_input) { throw new Error('getRequestHistory must be implemented.'); }
  async recordDecisionComparison(_input) { throw new Error('recordDecisionComparison must be implemented.'); }
  async listDecisionComparisons(_input) { throw new Error('listDecisionComparisons must be implemented.'); }
}

export class UnitOfWork {
  async transaction(_work, _options) { throw new Error('transaction must be implemented.'); }
}
