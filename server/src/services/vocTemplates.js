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
//               competent. A task may name a `section`; the form and the
//               certificate put a heading wherever the section changes.
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
    title: 'Confined Space Drone',
    equipmentLabel: 'Confined Space Drone',
    // Drawn from the AUAV Scout Operator Training Agenda, plus the
    // confined space entry tasks.
    tasks: [
      { section: 'Setup & systems', key: 'core_setup', label: 'Setup and assembly of core systems' },
      { section: 'Setup & systems', key: 'tether_setup', label: 'Tether setup procedures' },
      { section: 'Setup & systems', key: 'utm', label: 'UTM assembly, attachment procedures and readings' },
      { section: 'Setup & systems', key: 'ups', label: 'UPS setup and procedure' },
      { section: 'Setup & systems', key: 'ui', label: 'UI navigation and features, button mapping / presets' },
      { section: 'Planning & permits', key: 'avcrm_job', label: 'Job set-up, risk assessment and JSA in AVCRM' },
      { section: 'Planning & permits', key: 'permit', label: 'Entry permit, authorisation and confined space risk assessment' },
      { section: 'Planning & permits', key: 'flight_planning', label: 'Flight planning, including sea state limitations' },
      { section: 'Planning & permits', key: 'inspectors', label: 'Working with inspectors' },
      { section: 'Flight', key: 'presession', label: 'Pre-session checks' },
      { section: 'Flight', key: 'gas_testing', label: 'Gas testing and gas detection' },
      { section: 'Flight', key: 'tether_management', label: 'Tether management and the tether team' },
      { section: 'Flight', key: 'standby', label: 'Communication with the standby person' },
      { section: 'Flight', key: 'navigation', label: 'Navigation techniques, including camera or lidar failure' },
      { section: 'Flight', key: 'collision', label: 'Collision avoidance settings and lidar limitations (blind spots)' },
      { section: 'Flight', key: 'tether_snag', label: 'Strain indication and tether snag procedures' },
      { section: 'Flight', key: 'failsafe', label: 'Failsafe features and emergency actions' },
      { section: 'Flight', key: 'camera', label: 'Camera settings, image quality and optimal focus' },
      { section: 'Flight', key: 'manoeuvres', label: 'Flight manoeuvres and pilot competency' },
      { section: 'Post-flight & data', key: 'crash_extraction', label: 'Crash, black box and drone extraction from confined spaces' },
      { section: 'Post-flight & data', key: 'postflight', label: 'Post-flight checks, AVCRM flight logging and maintenance triggers' },
      { section: 'Post-flight & data', key: 'data', label: 'Data backup (Beyond Compare) and Scout Portal upload' },
      { section: 'Maintenance', key: 'maintenance', label: 'Prop / motor replacement, cleaning and re-calibration' },
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
