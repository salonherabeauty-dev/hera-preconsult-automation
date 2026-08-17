export interface GmailIngestionConfig {
  timezone: 'Asia/Singapore';
  dailyRunTime: '10:00';
  strategy: 'since_last_successful_sync';
  overlapMinutes: number;
  sender: string;
  dryRun: boolean;
}

export interface SyncWindowInput {
  now: Date;
  lastSuccessfulSync?: Date | null;
  overlapMinutes?: number;
}

export interface SyncWindow {
  from: Date;
  to: Date;
  source: 'last_successful_sync' | 'initial_lookback' | 'forced_lookback';
}

const DEFAULT_OVERLAP_MINUTES = 60;
const INITIAL_LOOKBACK_HOURS = 26;

/**
 * Builds a loss-resistant Gmail ingestion window.
 *
 * - Normal runs start one hour before the last successful sync to tolerate
 *   delayed Gmail indexing, clock boundaries and transient cron delays.
 * - Gmail message-id deduplication makes the generous overlap safe.
 * - First run looks back 26 hours so a 10:00 SGT run captures at least the
 *   prior calendar day's booking activity plus the current morning.
 */
export function buildSyncWindow(input: SyncWindowInput): SyncWindow {
  const overlapMinutes = input.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES;
  const to = new Date(input.now);

  if (input.lastSuccessfulSync) {
    return {
      from: new Date(input.lastSuccessfulSync.getTime() - overlapMinutes * 60_000),
      to,
      source: 'last_successful_sync',
    };
  }

  return {
    from: new Date(to.getTime() - INITIAL_LOOKBACK_HOURS * 60 * 60_000),
    to,
    source: 'initial_lookback',
  };
}

/** Convert a Date to epoch seconds for Gmail's after:/before: search syntax. */
export function gmailEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function buildLifecycleQueryForWindow(window: SyncWindow): string {
  const after = gmailEpochSeconds(window.from);
  // Gmail before: is exclusive. Add one second to avoid a boundary miss.
  const before = gmailEpochSeconds(window.to) + 1;

  return [
    'from:noreply@gettimely.com',
    '-subject:"day sheet"',
    `after:${after}`,
    `before:${before}`,
  ].join(' ');
}

export type AppointmentTiming = 'PAST' | 'SAME_DAY_URGENT' | 'UPCOMING';

/**
 * Classifies appointment timing in Singapore without relying on server locale.
 * iso must include an offset, e.g. 2026-08-25T13:15:00+08:00.
 */
export function classifyAppointmentTiming(
  appointmentIso: string,
  now: Date,
): AppointmentTiming {
  const appointment = new Date(appointmentIso);
  if (appointment.getTime() < now.getTime()) return 'PAST';

  const sgFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  if (sgFormatter.format(appointment) === sgFormatter.format(now)) {
    return 'SAME_DAY_URGENT';
  }

  return 'UPCOMING';
}
