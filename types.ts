export type TimelyEventType = 'CONFIRMED' | 'CHANGED' | 'CANCELLED';

export interface TimelyServiceLine {
  serviceName: string;
  staffName: string;
  serviceTime: string;
}

export interface TimelyAppointmentEvent {
  parserVersion: 'TIMELY_EMAIL_V1';
  eventType: TimelyEventType;
  subject: string;
  gmailMessageId?: string;
  customer: {
    name: string;
    email?: string;
    mobile?: string;
    timelyCustomerId?: string;
  };
  appointment: {
    localIso: string;
    displayText: string;
    previousDisplayText?: string;
    previousLocalIso?: string;
    locationName?: string;
    totalPrice?: number;
    cancellationReason?: string;
    services: TimelyServiceLine[];
  };
  source: {
    bookingOrigin: 'ONLINE' | 'STAFF' | 'UNKNOWN';
    changedBy?: string;
  };
  warnings: string[];
}

export type ServiceCategory =
  | 'CURLY_HAIRCUT'
  | 'CURLY_COLOUR'
  | 'CURLY_HIGHLIGHTS_BALAYAGE'
  | 'HIGHLIGHTS'
  | 'BALAYAGE'
  | 'COLOUR'
  | 'COLOUR_CORRECTION'
  | 'ROUTINE_COLOUR'
  | 'EXCLUDED'
  | 'MANUAL_REVIEW';

export interface ServiceRule {
  id: string;
  priority: number;
  category: ServiceCategory;
  preconsultRequired: boolean;
  exactNames?: string[];
  includeAll?: string[];
  includeAny?: string[];
  excludeAny?: string[];
  notes?: string;
}

export interface ClassificationResult {
  category: ServiceCategory;
  preconsultRequired: boolean;
  matchedRuleId: string;
  confidence: 'EXACT' | 'RULE' | 'UNKNOWN';
  reason: string;
}
