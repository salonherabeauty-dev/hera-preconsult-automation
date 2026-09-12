import { canonicalServiceName, classifyService, INITIAL_HERA_RULES } from './serviceRules.js';
import type { ClassificationResult, ServiceRule } from './types.js';

/** Preserve approved exact rules. Missing smoothening/keratin spellings go to review, never automatic inclusion. */
export function classifyAppointmentV2(serviceNames: string[], rules: ServiceRule[] = INITIAL_HERA_RULES) {
  const classifications = serviceNames.map((serviceName): { serviceName: string } & ClassificationResult => {
    const classification = classifyService(serviceName, rules);
    const normalized = canonicalServiceName(serviceName);
    if (classification.matchedRuleId === 'non-target-service' && /\b(?:keratin|smoothen\w*|smooth\w*|rebond\w*|perm\w*)\b/.test(normalized)) {
      return { serviceName, category: 'MANUAL_REVIEW', preconsultRequired: false, matchedRuleId: 'unknown-target-service-rule-required', confidence: 'UNKNOWN', reason: 'Unclassified texture/smoothing service requires an explicit Hera policy decision.' };
    }
    return { serviceName, ...classification };
  });
  return { classifications, preconsultRequired: classifications.some((c) => c.preconsultRequired) };
}
