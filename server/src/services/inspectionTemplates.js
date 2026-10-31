// ── Inspection templates ─────────────────────────────────────────────
// The question sets behind the equipment inspection webform, one per kind
// of kit. The V2 client fetches these (GET /api/inspections/templates) and
// builds the form from them; the server validates submissions and lays out
// the PDF from the same definition, and stores a copy with each report.
//
// A template has:
//   details — header fields asked once (text, number, date or choice)
//   areas   — the checklist. Every area asks "Defects observed?" (Yes/No);
//             Yes needs a note. `photos` is how many views the form asks
//             for; any area asking for photos needs at least one.
//
// "Basic Drone Inspection" follows the Microsoft Form it replaces
// (forms.office.com/r/sA21EeyjrS): the same eleven areas and photo counts.
// The others are starting points for each category and can be tuned here.

const REASONS = [
  'Scheduled maintenance',
  'Before dispatch',
  'Return from job / hire',
  'After incident or damage',
  'After repair or modification',
  'Other',
];

const reason = { key: 'reason', label: 'Reason for inspection', type: 'choice', options: REASONS, required: true };
const assignment = { key: 'assignment', label: 'Assignment', type: 'text', placeholder: 'e.g. Hire – JamieH, or job code' };

export const TEMPLATES = [
  {
    id: 'drone-basic',
    title: 'Basic Drone Inspection',
    reportTitle: 'RPAS Inspection Report',
    itemLabel: 'Aircraft',
    categories: ['Drones'],
    details: [
      assignment,
      reason,
      {
        key: 'inspection_type', label: 'Inspection type', type: 'choice', required: true,
        options: ['Pre-dispatch', '25 hr', '50 hr', '100 hr', '200 hr', 'Annual', 'Other'],
      },
    ],
    areas: [
      { key: 'airframe_overall', label: 'Airframe – overall (front, back, left, right)', photos: 4 },
      { key: 'airframe_underneath', label: 'Airframe – underneath (front, back, left, right)', photos: 4 },
      { key: 'collision_sensors', label: 'Collision avoidance sensors (F, B, L, R, top, bottom)', photos: 6 },
      { key: 'motor_1', label: 'Motor 1 (FR)', photos: 3 },
      { key: 'motor_2', label: 'Motor 2 (FL)', photos: 3 },
      { key: 'motor_3', label: 'Motor 3 (RL)', photos: 3 },
      { key: 'motor_4', label: 'Motor 4 (RR)', photos: 3 },
      { key: 'prop_1', label: 'Propeller 1 (FR)', photos: 6 },
      { key: 'prop_2', label: 'Propeller 2 (FL)', photos: 6 },
      { key: 'prop_3', label: 'Propeller 3 (RL)', photos: 6 },
      { key: 'prop_4', label: 'Propeller 4 (RR)', photos: 6 },
    ],
  },
  {
    id: 'battery',
    title: 'Battery Inspection',
    reportTitle: 'Battery Inspection Report',
    itemLabel: 'Battery',
    categories: ['Batteries'],
    details: [
      reason,
      { key: 'cycle_count', label: 'Cycle count', type: 'number' },
      { key: 'charge_level', label: 'Charge level on inspection', type: 'text', placeholder: 'e.g. 55% / 3.85 V per cell' },
    ],
    areas: [
      { key: 'casing', label: 'Casing – swelling, cracks, punctures (top, bottom)', photos: 2 },
      { key: 'terminals', label: 'Terminals and connectors – burns, bent pins, debris', photos: 1 },
      { key: 'cell_balance', label: 'Cell voltages balanced (app or charger screen)', photos: 1 },
      { key: 'latches', label: 'Latches, clips and buttons', photos: 0 },
      { key: 'labels', label: 'Labels and DG markings legible', photos: 1 },
    ],
  },
  {
    id: 'payload',
    title: 'Payload Inspection',
    reportTitle: 'Payload Inspection Report',
    itemLabel: 'Payload',
    categories: ['Payloads'],
    details: [
      assignment,
      reason,
      { key: 'firmware', label: 'Firmware version', type: 'text' },
    ],
    areas: [
      { key: 'lens', label: 'Lens / sensor glass – scratches, dust, cracks', photos: 2 },
      { key: 'gimbal', label: 'Gimbal – free movement, dampers, no grinding', photos: 2 },
      { key: 'mount', label: 'Mount / quick-release and connector pins', photos: 2 },
      { key: 'housing', label: 'Housing and seals', photos: 1 },
      { key: 'function', label: 'Function test – image, zoom, thermal, laser as fitted', photos: 1 },
    ],
  },
  {
    id: 'survey',
    title: 'Survey Equipment Inspection',
    reportTitle: 'Survey Equipment Inspection Report',
    itemLabel: 'Instrument',
    categories: ['Survey Equip'],
    details: [
      assignment,
      reason,
      { key: 'calibration_due', label: 'Calibration due', type: 'date' },
    ],
    areas: [
      { key: 'body', label: 'Instrument body and screen', photos: 2 },
      { key: 'mounts', label: 'Tripod, pole and mounts', photos: 2 },
      { key: 'power', label: 'Batteries and charger', photos: 1 },
      { key: 'cables', label: 'Cables, radio and antennas', photos: 1 },
      { key: 'calibration', label: 'Calibration current', photos: 0 },
      { key: 'case', label: 'Case and foam', photos: 1 },
    ],
  },
  {
    id: 'vehicle',
    title: 'Vehicle Inspection',
    reportTitle: 'Vehicle Inspection Report',
    itemLabel: 'Vehicle',
    categories: ['Vehicles'],
    details: [
      reason,
      { key: 'odometer', label: 'Odometer (km)', type: 'number', required: true },
      { key: 'rego_expiry', label: 'Registration expiry', type: 'date' },
      { key: 'service_due', label: 'Next service due', type: 'text', placeholder: 'date or km' },
    ],
    areas: [
      { key: 'exterior', label: 'Exterior body (front, back, left, right)', photos: 4 },
      { key: 'tyres', label: 'Tyres including spare – tread, pressure, damage', photos: 4 },
      { key: 'lights', label: 'Lights and indicators', photos: 1 },
      { key: 'fluids', label: 'Fluids – oil, coolant, washer', photos: 1 },
      { key: 'interior', label: 'Interior, seatbelts and dash warnings', photos: 1 },
      { key: 'safety_kit', label: 'Safety kit – first aid, fire extinguisher', photos: 1 },
      { key: 'cargo', label: 'Cargo area and load restraints', photos: 1 },
    ],
  },
  {
    id: 'general',
    title: 'General Equipment Inspection',
    reportTitle: 'Equipment Inspection Report',
    itemLabel: 'Item',
    categories: ['Accessories', 'Spare Parts'],
    details: [assignment, reason],
    areas: [
      { key: 'condition', label: 'Overall condition', photos: 2 },
      { key: 'complete', label: 'Complete – matches the box contents list', photos: 1 },
      { key: 'function', label: 'Function check', photos: 0 },
      { key: 'case', label: 'Case or packaging', photos: 1 },
    ],
  },
  // Our own pre-check of kit going to a Woodside site, done before Woodside's
  // T4 sign-off. DRAFT: built without Woodside's T4 definition or forms (the
  // i99 hazardous-area form is the only known reference), so the areas are a
  // proposed structure. Tune them once the Woodside requirement is in hand.
  // Not tied to a category: pick it from the form for any item.
  {
    id: 'woodside-t4',
    title: 'Woodside T4 Pre-Deployment (draft)',
    reportTitle: 'Woodside T4 Pre-Deployment Inspection',
    itemLabel: 'Item',
    categories: [],
    details: [
      {
        key: 'site', label: 'Woodside site / facility', type: 'choice', required: true,
        options: ['Karratha Gas Plant', 'Pluto LNG', 'Offshore facility', 'Other'],
      },
      { key: 'site_detail', label: 'Facility name / location', type: 'text', placeholder: 'e.g. Goodwyn A, or the area on the plant' },
      { key: 'job_ref', label: 'Job / PO / work order reference', type: 'text', required: true },
      { key: 'asset_tag', label: 'Asset tag #', type: 'text' },
      { key: 'part_number', label: 'Part / model #', type: 'text' },
      { key: 'test_tag_date', label: 'Electrical test & tag date (AS/NZS 3760)', type: 'date' },
      { key: 'test_tag_due', label: 'Test & tag next due', type: 'date' },
      {
        key: 'dg_class', label: 'Dangerous goods', type: 'choice', required: true,
        options: ['Not DG', 'Class 9 – Li-ion battery (UN3480)', 'Class 9 – Li-ion packed with / in equipment (UN3481)', 'Other DG'],
      },
      { key: 'state_of_charge', label: 'Battery state of charge for transport', type: 'text', placeholder: 'e.g. 30% – n/a if not DG' },
    ],
    areas: [
      { key: 'condition', label: 'Overall condition – damage, cracks, corrosion, loose parts', photos: 4 },
      { key: 'identification', label: 'Asset tag, serial and part # fitted, legible and match the paperwork', photos: 1 },
      { key: 'dropped_objects', label: 'Dropped-object risks – fasteners secure, loose items tethered or removed', photos: 2 },
      { key: 'electrical', label: 'Electrical – leads, plugs, chargers undamaged; test & tag current', photos: 2 },
      { key: 'hazardous_area', label: 'Hazardous-area suitability – Ex rating, or controls for use outside zoned areas', photos: 1 },
      { key: 'batteries', label: 'Batteries – no swelling or damage, terminals protected, DG labels fitted', photos: 2 },
      { key: 'lifting_tether', label: 'Lifting points, tethers and rigging – tagged, WLL marked, in date (n/a if none)', photos: 1 },
      { key: 'function', label: 'Function test passed', photos: 0 },
      { key: 'case', label: 'Case / packaging – latches, foam, weight and dimensions labelled', photos: 2 },
      { key: 'paperwork', label: 'Paperwork ready – manuals, certificates, DG declaration, manifest details', photos: 1 },
    ],
  },
];

export const DEFAULT_TEMPLATE_ID = 'general';

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

// The template an item of this category starts on. Uncategorised kit, and
// categories added later, fall back to the general checklist.
export function templateForCategory(category) {
  return TEMPLATES.find((t) => t.categories.includes(category)) || getTemplate(DEFAULT_TEMPLATE_ID);
}
