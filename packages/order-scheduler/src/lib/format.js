// Display helpers. Storage is always UTC; everything a human reads is rendered
// in the seller's timezone (Asia/Kolkata by default).
import { formatInTimeZone } from 'date-fns-tz';
import Decimal from 'decimal.js';
import { config } from '../config.js';

const DEFAULT_TZ = config.marketplace.defaultTimezone;

export function formatDateTime(value, timeZone = DEFAULT_TZ) {
  if (!value) return '—';
  return formatInTimeZone(new Date(value), timeZone, 'dd MMM yyyy, HH:mm');
}

export function formatDate(value, timeZone = DEFAULT_TZ) {
  if (!value) return '—';
  return formatInTimeZone(new Date(value), timeZone, 'dd MMM yyyy');
}

/** Money never goes through a JS float. */
export function formatMoney(amount, currency = 'INR') {
  if (amount === null || amount === undefined || amount === '') return '—';
  const value = new Decimal(amount).toFixed(2);
  const symbol = { INR: '₹', USD: '$', GBP: '£', EUR: '€', AED: 'AED ' }[currency] ?? `${currency} `;
  return `${symbol}${value}`;
}

/** Grams in, human-readable mass out. */
export function formatWeight(grams) {
  if (grams === null || grams === undefined || grams === '') return '—';
  const g = new Decimal(grams);
  return g.gte(1000) ? `${g.div(1000).toFixed(2)} kg` : `${g.toFixed(0)} g`;
}

export function formatDimensions(lengthCm, widthCm, heightCm) {
  if ([lengthCm, widthCm, heightCm].some((v) => v === null || v === undefined || v === '')) return '—';
  const n = (v) => new Decimal(v).toFixed(1).replace(/\.0$/, '');
  return `${n(lengthCm)} × ${n(widthCm)} × ${n(heightCm)} cm`;
}

/**
 * Milliseconds until a deadline, plus the urgency band the review queue colours
 * on (rule R6: latest_ship_date is the priority signal).
 */
export function shipByUrgency(latestShipDate, now = new Date()) {
  if (!latestShipDate) return { level: 'none', label: 'No deadline', hoursLeft: null };
  const hoursLeft = (new Date(latestShipDate).getTime() - now.getTime()) / 3_600_000;
  if (hoursLeft < 0) {
    return { level: 'overdue', label: `Overdue by ${formatDuration(-hoursLeft)}`, hoursLeft };
  }
  const label = `${formatDuration(hoursLeft)} left`;
  if (hoursLeft < 6) return { level: 'critical', label, hoursLeft };
  if (hoursLeft < 12) return { level: 'warning', label, hoursLeft };
  return { level: 'ok', label, hoursLeft };
}

function formatDuration(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function titleCase(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
