'use strict';
// Government ID types accepted at check-in, with light format checks.

const ID_TYPES = {
  aadhaar:         { label: 'Aadhaar',         test: (v) => /^\d{12}$/.test(v),               hint: '12 digits' },
  driving_licence: { label: 'Driving Licence', test: (v) => /^[A-Z0-9]{8,20}$/.test(v),       hint: '8–20 letters/digits' },
  passport:        { label: 'Passport',        test: (v) => /^[A-Z][0-9]{7}$/.test(v),        hint: '1 letter + 7 digits' },
  voter_id:        { label: 'Voter ID',        test: (v) => /^[A-Z0-9]{8,12}$/.test(v),       hint: '8–12 letters/digits' },
  pan:             { label: 'PAN Card',        test: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), hint: 'e.g. ABCDE1234F' },
  other:           { label: 'Other',           test: (v) => /^[A-Z0-9/-]{3,30}$/.test(v),     hint: '3–30 characters' },
};

/** Normalise an ID number: uppercase, drop spaces and dashes (except for 'other'). */
function normaliseId(type, raw) {
  const s = String(raw || '').toUpperCase().trim();
  return type === 'other' ? s.replace(/\s+/g, '') : s.replace(/[\s-]/g, '');
}

/** Returns { type, number } or { error }. */
function validateId(type, raw) {
  if (!ID_TYPES[type]) return { error: `ID type must be one of: ${Object.values(ID_TYPES).map((t) => t.label).join(', ')}` };
  const number = normaliseId(type, raw);
  if (!number) return { error: 'ID number is required' };
  if (!ID_TYPES[type].test(number)) return { error: `${ID_TYPES[type].label} number looks wrong (${ID_TYPES[type].hint})` };
  return { type, number };
}

function idDisplay(type, last4) {
  if (!type || !last4) return null;
  return `${(ID_TYPES[type] || ID_TYPES.other).label} ••••${last4}`;
}

module.exports = { ID_TYPES, validateId, idDisplay };
