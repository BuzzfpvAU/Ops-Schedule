// ── Validation of Competency (VOC) categories ────────────────────────
// What a VOC can assess, one entry per category. The V2 client builds the
// assessment form from these (GET /api/vocs/categories); the server checks
// submissions and lays out the certificate from the same definition, and
// stores a copy with each assessment so it reads the same after a change.
//
// Each category has:
//   equipment — the models it was assessed on. The pick-list is not fixed
//               here: it grows from what assessors type in (voc_equipment).
//   tasks     — the practical checklist, each marked Competent or Not yet
//               competent.
//   plus a Theory and a Practical result (Pass / Fail).
//
// A category is Competent only when every task is Competent and both the
// theory and practical were passed. A competent category is valid for one
// year from the date of assessment and appears in Certificates as
// "VOC – <title>", so jobs can require it.
//
// The task lists are starting points and can be tuned here; keys must stay
// stable, as stored assessments refer to them.

export const VOC_VALID_YEARS = 1;

const preflight = [
  { key: 'planning', label: 'Flight planning – airspace, NOTAMs, weather and site assessment / JSA' },
  { key: 'preflight_inspection', label: 'Pre-flight inspection of aircraft, controller and ground equipment' },
  { key: 'batteries', label: 'Battery inspection, handling, charging and transport' },
  { key: 'setup', label: 'Controller set-up, failsafe and return-to-home settings' },
];
const flight = [
  { key: 'takeoff_landing', label: 'Take-off, hover and landing' },
  { key: 'manual_flight', label: 'Manual flight manoeuvres, including without GNSS assistance' },
  { key: 'mission_flight', label: 'Automated / mission flight' },
  { key: 'emergencies', label: 'Emergency procedures – lost link, low battery, fly-away, flight termination' },
  { key: 'postflight', label: 'Post-flight inspection, flight logging and data handling' },
];

export const VOC_CATEGORIES = [
  {
    key: 'confined-space',
    title: 'Confined space',
    equipmentLabel: 'Confined space equipment',
    tasks: [
      { key: 'permit', label: 'Entry permit, authorisation and confined space risk assessment' },
      { key: 'gas_testing', label: 'Atmospheric testing – gas detector bump test and readings' },
      { key: 'isolation', label: 'Isolation and lock-out / tag-out of the space' },
      { key: 'ppe', label: 'Selection, fit and inspection of PPE / RPE' },
      { key: 'standby', label: 'Communication with the standby person' },
      { key: 'equipment_check', label: 'Inspection and set-up of confined space equipment' },
      { key: 'operation', label: 'Entry, work and exit procedures / operating the equipment in the space' },
      { key: 'rescue', label: 'Emergency and rescue procedures' },
    ],
  },
  {
    key: 'small-multirotor',
    title: 'Small multirotors',
    equipmentLabel: 'Aircraft',
    tasks: [...preflight, ...flight],
  },
  {
    key: 'large-multirotor',
    title: 'Large multirotors',
    equipmentLabel: 'Aircraft',
    tasks: [
      { key: 'transport_assembly', label: 'Transport, assembly and arming / disarming' },
      ...preflight,
      { key: 'crew', label: 'Crew briefing and communication (RPIC, observer, payload operator)' },
      ...flight,
    ],
  },
  {
    key: 'payload',
    title: 'Payloads',
    equipmentLabel: 'Payloads',
    tasks: [
      { key: 'mounting', label: 'Mounting, securing and removing the payload; balance / CoG check' },
      { key: 'configuration', label: 'Configuration and calibration' },
      { key: 'mission_setup', label: 'Mission set-up for the payload (overlap, speed, altitude, settings)' },
      { key: 'operation', label: 'In-flight operation and data capture' },
      { key: 'quality', label: 'On-site data quality check' },
      { key: 'download', label: 'Data download, backup and hand-over' },
      { key: 'care', label: 'Cleaning, storage and transport of the payload' },
    ],
  },
];

export const getCategory = (key) => VOC_CATEGORIES.find((c) => c.key === key) || null;

// The certificate type each category keeps up to date in Certificates.
export const vocCertTypeId = (key) => `cert-voc-${key}`;
export const vocCertTypeName = (category) => `VOC – ${category.title}`;

// "VOC-0007" — how certificate numbers are printed and listed.
export const certNumber = (n) => `VOC-${String(n).padStart(4, '0')}`;
