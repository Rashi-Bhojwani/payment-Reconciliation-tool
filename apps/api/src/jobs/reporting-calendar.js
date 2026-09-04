// The dashboard's range arrives as instants: the UI picks IST calendar days
// and sends their midnights in UTC, so "21 Jul" travels as
// 2026-07-20T18:30:00.000Z. That is correct for the timestamptz columns
// (posted_date), which are compared as instants - but return_date,
// reimbursement_date, invoice_date, snapshot_date and sales_traffic_daily.date
// are plain DATE columns holding the calendar day Amazon reported, and those
// were being filtered with `$n::date`.
//
// Postgres parses a *string literal* to date textually: it takes the date
// part and discards the time and the Z entirely. Verified on 16.x, and the
// answer does not depend on the server timezone - under both Etc/UTC and
// Asia/Kolkata, '2026-07-20T18:30:00.000Z'::date is 2026-07-20. So every
// date-column window silently ran one day early: an extra day at the front,
// and the last day of the range missing. Returns, return rate, net quantity,
// reimbursements and GST invoice value all inherited that shift.
//
// Converting the instant to its IST calendar day first - the day the user
// actually picked - is what those columns should have been compared against
// all along. Doing it here rather than in SQL keeps one definition of the
// boundary instead of repeating a hardcoded time zone at ten call sites.
const REPORT_TIME_ZONE = 'Asia/Kolkata';
const calendarDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export function calendarDay(value) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw Object.assign(new Error(`Not a date: ${value}`), { statusCode: 400 });
  return calendarDayFormatter.format(instant);
}
/** Half-open [startDay, endDay) in the reporting time zone, for DATE columns. */
export function calendarDays(range) { return [calendarDay(range.start), calendarDay(range.end)]; }
