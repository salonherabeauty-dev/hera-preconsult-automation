import type { ClassificationResult, ServiceRule } from './types.js';

function canonical(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const RULES: ServiceRule[] = [
  {
    id: 'exact-curly-observed',
    priority: 1000,
    category: 'CURLY_HAIRCUT',
    preconsultRequired: true,
    exactNames: [
      "Ladies’ Curly Haircut & Curl-Defining Treatment",
      "Ladies’ Curly Haircut & Curl-Defining Treatment (XL)",
      "Ladies’ Curly Haircut & Styling",
      "Ladies’ Curly Haircut & Styling (XL)"
    ],
    notes: 'Exact names observed in real Hera Timely notification emails.'
  },
  {
    id: 'exact-highlights-observed',
    priority: 1000,
    category: 'HIGHLIGHTS',
    preconsultRequired: true,
    exactNames: [
      'FULL Head Highlights + Wash & Styling (Long)'
    ],
    notes: 'Exact name observed in real Hera Timely notification email.'
  },
  {
    id: 'exact-nonbleach-observed',
    priority: 1000,
    category: 'BALAYAGE',
    preconsultRequired: true,
    exactNames: [
      'NON-BLEACH FULL Head Balayage/Highlights/Full Colour + Wash & Styling (XL)'
    ],
    notes: 'Exact name observed in real Hera Timely notification email.'
  },
  {
    id: 'colour-correction',
    priority: 900,
    category: 'COLOUR_CORRECTION',
    preconsultRequired: true,
    includeAny: ['colour correction', 'color correction', 'corrective colour', 'corrective color']
  },
  {
    id: 'curly-highlight-balayage',
    priority: 850,
    category: 'CURLY_HIGHLIGHTS_BALAYAGE',
    preconsultRequired: true,
    includeAll: ['curly'],
    includeAny: ['highlight', 'balayage', 'airtouch']
  },
  {
    id: 'curly-haircut',
    priority: 800,
    category: 'CURLY_HAIRCUT',
    preconsultRequired: true,
    includeAll: ['curly'],
    includeAny: ['haircut', 'cut']
  },
  {
    id: 'balayage',
    priority: 750,
    category: 'BALAYAGE',
    preconsultRequired: true,
    includeAny: ['balayage', 'airtouch']
  },
  {
    id: 'highlights',
    priority: 700,
    category: 'HIGHLIGHTS',
    preconsultRequired: true,
    includeAny: ['highlight', 'foilage', 'foilyage']
  },
  {
    id: 'routine-toner',
    priority: 650,
    category: 'ROUTINE_COLOUR',
    preconsultRequired: false,
    includeAny: ['toning alone', 'toner only', 'toner alone']
  },
  {
    id: 'routine-root',
    priority: 640,
    category: 'ROUTINE_COLOUR',
    preconsultRequired: false,
    includeAny: ['root regrowth', 'root colour', 'root color', 'regrowth colour', 'regrowth color']
  },
  {
    id: 'general-colour',
    priority: 500,
    category: 'COLOUR',
    preconsultRequired: true,
    includeAny: ['colour', 'color', 'bleach', 'blond', 'grey blend', 'gray blend']
  }
];

export const INITIAL_HERA_RULES: ServiceRule[] = [...RULES].sort((a, b) => b.priority - a.priority);

function matchesRule(serviceName: string, rule: ServiceRule): boolean {
  const s = canonical(serviceName);

  if (rule.exactNames?.some((name) => canonical(name) === s)) return true;

  const includesAll = rule.includeAll?.every((term) => s.includes(canonical(term))) ?? true;
  const includesAny = rule.includeAny?.some((term) => s.includes(canonical(term))) ?? true;
  const excludes = rule.excludeAny?.some((term) => s.includes(canonical(term))) ?? false;

  const hasRuleTerms = Boolean(rule.includeAll?.length || rule.includeAny?.length);
  return hasRuleTerms && includesAll && includesAny && !excludes;
}

const TARGET_DOMAIN_TERMS = [
  'curly', 'colour', 'color', 'highlight', 'balayage', 'airtouch', 'bleach',
  'blond', 'grey blend', 'gray blend', 'toner', 'toning', 'regrowth', 'root'
];

function looksLikeTargetDomain(serviceName: string): boolean {
  const s = canonical(serviceName);
  return TARGET_DOMAIN_TERMS.some((term) => s.includes(canonical(term)));
}

export function classifyService(serviceName: string, rules: ServiceRule[] = INITIAL_HERA_RULES): ClassificationResult {
  for (const rule of [...rules].sort((a, b) => b.priority - a.priority)) {
    if (!matchesRule(serviceName, rule)) continue;
    const exact = rule.exactNames?.some((name) => canonical(name) === canonical(serviceName)) ?? false;
    return {
      category: rule.category,
      preconsultRequired: rule.preconsultRequired,
      matchedRuleId: rule.id,
      confidence: exact ? 'EXACT' : 'RULE',
      reason: exact ? `Exact Timely service match: ${serviceName}` : `Matched configured service rule: ${rule.id}`
    };
  }

  if (!looksLikeTargetDomain(serviceName)) {
    return {
      category: 'EXCLUDED',
      preconsultRequired: false,
      matchedRuleId: 'non-target-service',
      confidence: 'RULE',
      reason: `Service is outside configured colour/curly target domain: ${serviceName}`
    };
  }

  return {
    category: 'MANUAL_REVIEW',
    preconsultRequired: false,
    matchedRuleId: 'no-match',
    confidence: 'UNKNOWN',
    reason: `Target-domain service has no configured Hera rule: ${serviceName}`
  };
}

export function classifyAppointment(serviceNames: string[], rules: ServiceRule[] = INITIAL_HERA_RULES) {
  const classifications = serviceNames.map((serviceName) => ({ serviceName, ...classifyService(serviceName, rules) }));
  const preconsultRequired = classifications.some((c) => c.preconsultRequired);
  return { classifications, preconsultRequired };
}
