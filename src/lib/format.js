// Report timestamps use the machine's time zone (Node reads it from the OS, or
// from the TZ environment variable when set, e.g. TZ=America/Argentina/Buenos_Aires).
const REPORT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// "YYYY-MM-DD HH:mm:ss GMT-3". The locale only affects the shape of the parts;
// formatToParts lets us assemble the string ourselves, and hourCycle h23 avoids
// the "24:00:00" midnight quirk that hour12:false produces.
function formatTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short'
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

// "YYYY-MM-DD-HHmmss", safe for file names.
function timestampSlug(date) {
  return formatTimestamp(date)
    .replace(/ \S+$/, '')
    .replace(' ', '-')
    .replace(/:/g, '');
}

module.exports = { REPORT_TIME_ZONE, formatTimestamp, timestampSlug };
