// ── Dangerous goods ─────────────────────────────────────────────────────
// UN numbers commonly carried with drone and survey kit. An item stores its
// codes as one comma-separated string ("UN3480,UN3481"); codes not in this
// list are still allowed, they just have no description to show.

export const UN_CODES = [
  { code: 'UN3480', cls: '9', label: 'Lithium ion batteries', hint: 'spare batteries packed on their own' },
  { code: 'UN3481', cls: '9', label: 'Lithium ion batteries in or with equipment', hint: 'fitted in, or packed with, a drone or controller' },
  { code: 'UN3090', cls: '9', label: 'Lithium metal batteries', hint: 'spare non-rechargeable lithium cells' },
  { code: 'UN3091', cls: '9', label: 'Lithium metal batteries in or with equipment', hint: 'e.g. coin cells in a beacon or tracker' },
  { code: 'UN3171', cls: '9', label: 'Battery-powered equipment', hint: 'e.g. a large unit with a non-removable battery' },
  { code: 'UN2800', cls: '8', label: 'Batteries, wet, non-spillable', hint: 'sealed lead-acid (AGM / gel)' },
  { code: 'UN3473', cls: '3', label: 'Fuel cell cartridges, flammable liquid', hint: 'fuel cells for long-endurance airframes' },
  { code: 'UN1203', cls: '3', label: 'Petrol (motor spirit)', hint: 'jerry cans for generators or fuel-powered drones' },
  { code: 'UN1202', cls: '3', label: 'Diesel fuel', hint: '' },
  { code: 'UN1863', cls: '3', label: 'Aviation turbine fuel (Jet A-1)', hint: '' },
  { code: 'UN3528', cls: '3', label: 'Engine or machinery, flammable-liquid powered', hint: 'e.g. a generator or fuel-powered drone' },
  { code: 'UN1993', cls: '3', label: 'Flammable liquid, n.o.s.', hint: 'not otherwise specified' },
  { code: 'UN1263', cls: '3', label: 'Paint', hint: 'e.g. ground-marking paint' },
  { code: 'UN1950', cls: '2', label: 'Aerosols', hint: 'spray paint, lubricant, cleaner' },
  { code: 'UN2037', cls: '2', label: 'Gas cartridges', hint: 'small receptacles, e.g. butane' },
  { code: 'UN1075', cls: '2.1', label: 'LPG', hint: 'liquefied petroleum gas' },
];

const BY_CODE = new Map(UN_CODES.map((c) => [c.code, c]));

// "3480", "un 3480" and "UN3480" all mean UN3480.
export function normalizeUnCode(raw) {
  const m = String(raw || '').trim().toUpperCase().replace(/\s+/g, '').match(/^(?:UN)?(\d{4})$/);
  return m ? `UN${m[1]}` : null;
}

// Split a stored or typed list into valid codes (deduplicated, in order)
// and whatever could not be read as one.
export function parseUnCodes(text) {
  const codes = [];
  const invalid = [];
  for (const part of String(text || '').split(/[,;\n]+/)) {
    if (!part.trim()) continue;
    const code = normalizeUnCode(part);
    if (!code) invalid.push(part.trim());
    else if (!codes.includes(code)) codes.push(code);
  }
  return { codes, invalid };
}

export const formatUnCodes = (codes) => codes.join(',');

export function describeUnCode(code) {
  const c = BY_CODE.get(code);
  return c ? `${c.code} — ${c.label} (Class ${c.cls})` : code;
}

export const isKnownUnCode = (code) => BY_CODE.has(code);

// Tooltip text for an item: one line per code it carries.
export function dgSummary(item) {
  const { codes } = parseUnCodes(item?.un_codes);
  if (!codes.length) return 'Contains dangerous goods';
  return ['Contains dangerous goods:', ...codes.map(describeUnCode)].join('\n');
}

// The whole reference list, for the help tooltip in the details drawer.
export const UN_CODE_HELP = UN_CODES
  .map((c) => `${c.code} — ${c.label} (Class ${c.cls})${c.hint ? `: ${c.hint}` : ''}`)
  .join('\n');
