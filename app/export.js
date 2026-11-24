// Turns the saved receipts into the files that go in the ZIP.
// Pure functions (no DOM), so they can be unit-tested in Node.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n, w = 2) => String(n).padStart(w, '0');

export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localStamp = (d) => `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fileStamp = (d) => `${isoDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`;

export function utcOffset(d) {
  const mins = -d.getTimezoneOffset();
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  return `UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function slug(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();

/**
 * @param {{capturedAt: number, description: string, photo: ArrayBuffer|Uint8Array}[]} receipts
 * @param {{tripName?: string, now?: Date}} opts
 * @returns {{zipName: string, markdown: string, entries: {name: string, data: Uint8Array, date: Date}[]}}
 */
export function buildExport(receipts, { tripName = '', now = new Date() } = {}) {
  const items = [...receipts].sort((a, b) => a.capturedAt - b.capturedAt);
  if (items.length === 0) throw new Error('No receipts to export');

  const first = new Date(items[0].capturedAt);
  const last = new Date(items[items.length - 1].capturedAt);
  const range = isoDate(first) === isoDate(last) ? isoDate(first) : `${isoDate(first)}_to_${isoDate(last)}`;
  const base = ['receipts', slug(tripName), range].filter(Boolean).join('_');
  const width = Math.max(2, String(items.length).length);

  const entries = [];
  const sections = [];
  items.forEach((r, i) => {
    const n = i + 1;
    const taken = new Date(r.capturedAt);
    const photo = `photos/receipt-${pad(n, width)}_${fileStamp(taken)}.jpg`;
    const data = r.photo instanceof Uint8Array ? r.photo : new Uint8Array(r.photo);
    entries.push({ name: `${base}/${photo}`, data, date: taken });
    const desc = oneLine(r.description);
    sections.push(
      [
        `## Receipt ${n}`,
        '',
        `- Photo: \`${photo}\``,
        `- Taken: ${localStamp(taken)} (${DAYS[taken.getDay()]})`,
        `- Description: ${desc || '(nothing dictated)'}`,
      ].join('\n'),
    );
  });

  const title = oneLine(tripName) ? `# Receipts: ${oneLine(tripName)}` : '# Receipts';
  const dates = range.replace('_to_', ' to ');
  const markdown = [
    title,
    '',
    `- Exported: ${localStamp(now)} (${utcOffset(now)})`,
    `- Receipts: ${items.length}`,
    `- Photos taken: ${dates}`,
    '',
    'Each entry pairs one receipt photo in `photos/` with the description the claimant dictated ' +
      'when taking it (purpose, who was involved, general context). Descriptions are speech-to-text, ' +
      'so names may be misspelt. "Taken" is when the photo was taken, which can differ from the ' +
      'date printed on the receipt.',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');

  entries.unshift({ name: `${base}/receipts.md`, data: new TextEncoder().encode(markdown), date: now });
  return { zipName: `${base}.zip`, markdown, entries };
}
