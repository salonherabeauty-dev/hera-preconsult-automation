export const TIMELY_EVENT_GMAIL_QUERY = [
  'from:noreply@gettimely.com',
  '{subject:"Appointment confirmed" subject:"Appointment changed" subject:"Appointment cancelled"}',
  '-subject:"day sheet"'
].join(' ');

export function timelyGmailQueryWithLookback(days = 2): string {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('INVALID_GMAIL_LOOKBACK_DAYS');
  return `${TIMELY_EVENT_GMAIL_QUERY} newer_than:${days}d`;
}
