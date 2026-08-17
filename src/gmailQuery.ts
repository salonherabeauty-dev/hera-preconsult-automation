// Deliberately broad Timely discovery query. We do not depend on subject wording
// because Timely uses both admin-notification subjects ("Appointment confirmed…")
// and customer-notification subjects ("Your appointment booking … is confirmed").
// Exact lifecycle detection happens after fetching the message body.
export const TIMELY_EVENT_GMAIL_QUERY = [
  'from:noreply@gettimely.com',
  '-subject:"day sheet"',
].join(' ');

export function timelyGmailQueryWithLookback(days = 2): string {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('INVALID_GMAIL_LOOKBACK_DAYS');
  return `${TIMELY_EVENT_GMAIL_QUERY} newer_than:${days}d`;
}
