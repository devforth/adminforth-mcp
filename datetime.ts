// Milliseconds cost tokens on every datetime value and are never needed to answer the user.
const ISO_MILLISECONDS_RE = /\.\d+(?=Z$)/;
const GMT_PREFIX = 'GMT';
const ZERO_OFFSET = '+00:00';

const zonedFormats = new Map<string, Intl.DateTimeFormat>();

function zonedFormat(timeZone: string): Intl.DateTimeFormat {
  let format = zonedFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
    zonedFormats.set(timeZone, format);
  }
  return format;
}

export function formatDatetime(isoUtc: string, timeZone: string | undefined): string {
  if (!timeZone) return isoUtc.replace(ISO_MILLISECONDS_RE, '');
  const parts = Object.fromEntries(
    zonedFormat(timeZone).formatToParts(new Date(isoUtc)).map(({ type, value }) => [type, value]),
  );
  const offset = parts.timeZoneName.slice(GMT_PREFIX.length) || ZERO_OFFSET;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}
