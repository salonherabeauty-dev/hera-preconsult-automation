import type { ClassificationResult, ServiceRule } from './types.js';

export function canonicalServiceName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const RULES: ServiceRule[] = [
  {
    id: 'explicit-exclusions',
    priority: 2000,
    category: 'EXCLUDED',
    preconsultRequired: false,
    exactNames: [
      'ROOT Colour+Wash & Styling (Medium)',
      'Toning Alone treatment',
    ],
    notes: 'Business-approved exact exclusions. Exact exclusions always win.',
  },
  {
    id: 'exact-root-shadow-full-toning',
    priority: 1950,
    category: 'COLOUR',
    preconsultRequired: true,
    exactNames: ['Root Shadow (Full toning)'],
    notes: 'Business-approved exact positive service.',
  },
  {
    id: 'colour-correction',
    priority: 1900,
    category: 'COLOUR_CORRECTION',
    preconsultRequired: true,
    includeAny: ['colour correction', 'color correction', 'corrective colour', 'corrective color'],
  },
  {
    id: 'universal-curly-haircut',
    priority: 1800,
    category: 'CURLY_HAIRCUT',
    preconsultRequired: true,
    includeAll: ['curly'],
    includeAny: ['haircut', 'hair cut', ' cut'],
    notes: 'All genuine curly haircut/cut services qualify; curly extensions/treatments do not.',
  },
  {
    id: 'universal-balayage-airtouch',
    priority: 1700,
    category: 'BALAYAGE',
    preconsultRequired: true,
    includeAny: ['balayage', 'airtouch', 'air touch'],
    notes: 'All Balayage/AirTouch services qualify unless explicitly excluded.',
  },
  {
    id: 'universal-highlights',
    priority: 1600,
    category: 'HIGHLIGHTS',
    preconsultRequired: true,
    includeAny: ['highlight', 'foilage', 'foilyage'],
    notes: 'All Highlights variants qualify unless explicitly excluded.',
  },
  {
    id: 'universal-full-colour',
    priority: 1500,
    category: 'COLOUR',
    preconsultRequired: true,
    includeAny: ['full colour', 'full color'],
    notes: 'All Full Colour/Color services qualify unless explicitly excluded.',
  },
  {
    id: 'mens-hair-colouring',
    priority: 1450,
    category: 'COLOUR',
    preconsultRequired: true,
    regexAny: ["\\bmen(?:'s|s)?\\s+hair\\s+colou?ring\\b"],
    notes: 'All Men’s Hair Colouring/Coloring wording variants qualify.',
  },
];

export const INITIAL_HERA_RULES: ServiceRule[] = [...RULES].sort((a, b) => b.priority - a.priority);

function matchesRule(serviceName: string, rule: ServiceRule): boolean {
  const s = canonicalServiceName(serviceName);

  if (rule.exactNames?.some((name) => canonicalServiceName(name) === s)) return true;

  const includesAll = rule.includeAll?.every((term) => s.includes(canonicalServiceName(term))) ?? true;
  const includesAny = rule.includeAny?.some((term) => s.includes(canonicalServiceName(term))) ?? true;
  const regexAny = rule.regexAny?.some((pattern) => new RegExp(pattern, 'i').test(s)) ?? true;
  const excludes = rule.excludeAny?.some((term) => s.includes(canonicalServiceName(term))) ?? false;

  const hasRuleTerms = Boolean(rule.includeAll?.length || rule.includeAny?.length || rule.regexAny?.length);
  return hasRuleTerms && includesAll && includesAny && regexAny && !excludes;
}

const TARGET_DOMAIN_TERMS = [
  'curly', 'colour', 'color', 'highlight', 'balayage', 'airtouch', 'air touch',
  'bleach', 'blond', 'grey blend', 'gray blend', 'toner', 'toning', 'regrowth',
  'root', 'non-bleach', 'extension', 'weft', 'keratin bond', 'perm', 'rebond',
  'smoothing', 'foilage', 'foilyage',
];

function looksLikeTargetDomain(serviceName: string): boolean {
  const s = canonicalServiceName(serviceName);
  return TARGET_DOMAIN_TERMS.some((term) => s.includes(canonicalServiceName(term)));
}

export function classifyService(
  serviceName: string,
  rules: ServiceRule[] = INITIAL_HERA_RULES,
): ClassificationResult {
  for (const rule of [...rules].sort((a, b) => b.priority - a.priority)) {
    if (!matchesRule(serviceName, rule)) continue;
    const exact = rule.exactNames?.some(
      (name) => canonicalServiceName(name) === canonicalServiceName(serviceName),
    ) ?? false;
    return {
      category: rule.category,
      preconsultRequired: rule.preconsultRequired,
      matchedRuleId: rule.id,
      confidence: exact ? 'EXACT' : 'RULE',
      reason: exact
        ? `Exact Timely service match: ${serviceName}`
        : `Matched configured service rule: ${rule.id}`,
    };
  }

  if (!looksLikeTargetDomain(serviceName)) {
    return {
      category: 'EXCLUDED',
      preconsultRequired: false,
      matchedRuleId: 'non-target-service',
      confidence: 'RULE',
      reason: `Service is outside configured pre-consult target domain: ${serviceName}`,
    };
  }

  return {
    category: 'MANUAL_REVIEW',
    preconsultRequired: false,
    matchedRuleId: 'unknown-target-service-rule-required',
    confidence: 'UNKNOWN',
    reason: `Target-domain service has no established Hera business rule: ${serviceName}`,
  };
}

export function classifyAppointment(
  serviceNames: string[],
  rules: ServiceRule[] = INITIAL_HERA_RULES,
) {
  const classifications = serviceNames.map((serviceName) => ({
    serviceName,
    ...classifyService(serviceName, rules),
  }));
  const preconsultRequired = classifications.some((classification) => classification.preconsultRequired);
  return { classifications, preconsultRequired };
}
