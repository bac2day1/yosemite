const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const PROPERTIES = {
  Y: {
    code: 'Y',
    name: 'Yosemite Valley Lodge',
    dropdownLabel: 'Yosemite Valley Lodge',
    bookingUrl: 'https://reservations.ahlsmsworld.com/Yosemite/Plan-Your-Trip/Accommodations/Yosemite-Valley-Lodge',
    location: 'Yosemite Valley (near Yosemite Falls)',
    kind: 'hotel',
    description: 'Classic hotel rooms, bunk rooms & family rooms.'
  },
  M: {
    code: 'M',
    name: 'The Ahwahnee',
    dropdownLabel: 'The Ahwahnee',
    bookingUrl: 'https://reservations.ahlsmsworld.com/Yosemite/Plan-Your-Trip/Accommodations/The-Ahwahnee',
    location: 'Yosemite Valley',
    kind: 'hotel',
    description: 'Historic luxury hotel rooms & cottages.'
  },
  D: {
    code: 'D',
    name: 'Curry Village',
    dropdownLabel: 'Curry Village',
    bookingUrl: 'https://reservations.ahlsmsworld.com/Yosemite/Plan-Your-Trip/Accommodations/Curry-Village',
    location: 'Yosemite Valley (below Glacier Point)',
    kind: 'mixed',
    description: 'Stoneman cottages and wooden cabins with bath. Tents are skipped by your room rules.'
  },
  H: {
    code: 'H',
    name: 'Housekeeping Camp',
    dropdownLabel: 'Housekeeping Camp',
    bookingUrl: 'https://reservations.ahlsmsworld.com/Yosemite/Plan-Your-Trip/Accommodations/Housekeeping-Camp',
    location: 'Yosemite Valley (along Merced River)',
    kind: 'housekeeping',
    description: 'Riverside units with concrete walls and a canvas roof.'
  }
};

function generateTopic() {
  return 'yosemite-watch-' + crypto.randomBytes(5).toString('hex');
}

function createDefaultConfig() {
  return {
    alerts: {
      ntfyEnabled: true,
      ntfyServer: 'https://ntfy.sh',
      ntfyTopic: generateTopic(),
      desktopEnabled: true,
      browserEnabled: true,
      soundEnabled: true
    },
    watches: [
      {
        id: 'watch-valley-rooms',
        name: 'Yosemite Valley — Indoor Rooms (Both Families)',
        enabled: true,
        checkIn: '2027-06-07',
        checkOut: '2027-06-11',
        roomSlots: [
          { id: 'room-family-1', label: 'Family 1', adults: 2, children: 2, bookedNights: [] },
          { id: 'room-family-2', label: 'Family 2', adults: 2, children: 2, bookedNights: [] }
        ],
        properties: ['Y', 'M', 'D'],
        excludeTents: true,
        requirePrivateBath: true,
        maxPricePerNight: null,
        matchMode: 'both', // 'full' | 'both'
        intervalMinutes: 10,
        notes: 'Two families (2 adults + 2 kids each), each booking their own room, one at a time. Indoor rooms & wooden cabins with bath only — no tents, no offsite.'
      },
      {
        id: 'watch-housekeeping-family2',
        name: 'Housekeeping Camp — Family 2 Option',
        enabled: true,
        checkIn: '2027-06-07',
        checkOut: '2027-06-11',
        roomSlots: [
          { id: 'room-family-2', label: 'Family 2', adults: 2, children: 2, bookedNights: [] }
        ],
        properties: ['H'],
        excludeTents: false,
        requirePrivateBath: false,
        maxPricePerNight: null,
        matchMode: 'both',
        intervalMinutes: 10,
        notes: 'One of the two families is happy with Housekeeping Camp in Yosemite Valley.'
      }
    ]
  };
}

function createDefaultState() {
  return {
    watchResults: {},
    watchErrors: {},
    alertHistory: [],
    seenKeys: {}
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    const cfg = createDefaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const defaults = createDefaultConfig();
    return {
      alerts: { ...defaults.alerts, ...(raw.alerts || {}) },
      watches: Array.isArray(raw.watches) ? raw.watches.map(normalizeWatch) : defaults.watches
    };
  } catch {
    const cfg = createDefaultConfig();
    saveConfig(cfg);
    return cfg;
  }
}

function saveConfig(config) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    return createDefaultState();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      watchResults: raw.watchResults || {},
      watchErrors: raw.watchErrors || {},
      alertHistory: Array.isArray(raw.alertHistory) ? raw.alertHistory : [],
      seenKeys: raw.seenKeys || {}
    };
  } catch {
    return createDefaultState();
  }
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function nightsInStay(checkIn, checkOut) {
  return Math.round((new Date(checkOut + 'T00:00:00Z') - new Date(checkIn + 'T00:00:00Z')) / 86400000);
}

/** Keeps only valid, unique booked nights that fall inside the stay (check-in through the night before check-out). */
function normalizeBookedNights(nights, checkIn, checkOut) {
  const list = Array.isArray(nights) ? nights : [];
  const valid = list.filter(n => /^\d{4}-\d{2}-\d{2}$/.test(String(n)) && n >= checkIn && n < checkOut);
  return [...new Set(valid)].sort();
}

const MAX_ROOMS = 6;

/**
 * The rooms a watch needs. Each room is searched on its own and tracks its own booked nights.
 * Accepts the roomSlots shape, or the older rooms/adults/children fields (converted to separate rooms).
 * Booked nights always come from the stored room, never from the request, so editing a watch can't wipe them.
 */
function normalizeRoomSlots(input, existingSlots, checkIn, checkOut) {
  const existing = new Map((existingSlots || []).map(slot => [slot.id, slot]));
  let raw = Array.isArray(input.roomSlots) ? input.roomSlots : null;
  if (!raw) {
    const count = Math.min(MAX_ROOMS, Math.max(1, parseInt(input.rooms, 10) || 1));
    raw = Array.from({ length: count }, () => ({ adults: input.adults, children: input.children }));
  }
  raw = raw.slice(0, MAX_ROOMS);
  if (raw.length === 0) {
    throw new Error('Add at least one room to look for.');
  }
  const used = new Set();
  return raw.map((room, index) => {
    const known = typeof room.id === 'string' && existing.has(room.id) && !used.has(room.id);
    const id = known ? room.id : 'room-' + crypto.randomBytes(3).toString('hex');
    used.add(id);
    return {
      id,
      label: String(room.label || '').trim().slice(0, 30) || `Room ${index + 1}`,
      adults: Math.min(9, Math.max(1, parseInt(room.adults, 10) || 2)),
      children: Math.min(9, Math.max(0, parseInt(room.children, 10) || 0)),
      bookedNights: normalizeBookedNights(known ? existing.get(id).bookedNights : room.bookedNights, checkIn, checkOut)
    };
  });
}

/** Upgrades a watch saved before rooms were tracked individually. */
function normalizeWatch(watch) {
  if (Array.isArray(watch.roomSlots)) return watch;
  const roomSlots = normalizeRoomSlots({ rooms: watch.rooms, adults: watch.adults, children: watch.children }, [], watch.checkIn, watch.checkOut);
  if (roomSlots.length === 1) {
    roomSlots[0].bookedNights = normalizeBookedNights(watch.bookedNights, watch.checkIn, watch.checkOut);
  }
  const { rooms, adults, children, bookedNights, ...rest } = watch;
  return { ...rest, roomSlots };
}

function validateWatchInput(input, existingId = null, existingWatch = null) {
  const name = String(input.name || '').trim() || 'Untitled Yosemite Watch';
  const checkIn = String(input.checkIn || '').trim();
  const checkOut = String(input.checkOut || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    throw new Error('Check-in and check-out dates must be valid YYYY-MM-DD dates.');
  }
  const dIn = new Date(checkIn + 'T00:00:00Z');
  const dOut = new Date(checkOut + 'T00:00:00Z');
  if (Number.isNaN(dIn.getTime()) || Number.isNaN(dOut.getTime()) || dOut <= dIn) {
    throw new Error('Check-out date must be after check-in date.');
  }
  const nights = Math.round((dOut - dIn) / 86400000);
  if (nights > 14) {
    throw new Error('Please keep each watch request to 14 nights or fewer.');
  }

  const rawProps = Array.isArray(input.properties) ? input.properties : [];
  const properties = [...new Set(rawProps.filter(code => Boolean(PROPERTIES[code])))];
  if (properties.length === 0) {
    throw new Error('Select at least one Yosemite Valley property.');
  }

  const roomSlots = normalizeRoomSlots(input, existingWatch?.roomSlots, checkIn, checkOut);
  const intervalMinutes = Math.min(1440, Math.max(2, parseInt(input.intervalMinutes, 10) || 10));

  let maxPricePerNight = null;
  if (input.maxPricePerNight !== null && input.maxPricePerNight !== undefined && String(input.maxPricePerNight).trim() !== '') {
    const parsed = Number(input.maxPricePerNight);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('Max price per night must be a positive number or left blank.');
    }
    maxPricePerNight = Math.round(parsed);
  }

  const matchMode = input.matchMode === 'full' ? 'full' : 'both';

  return {
    id: existingId || 'watch-' + crypto.randomBytes(4).toString('hex'),
    name,
    enabled: input.enabled !== false,
    checkIn,
    checkOut,
    roomSlots,
    properties,
    excludeTents: Boolean(input.excludeTents),
    requirePrivateBath: Boolean(input.requirePrivateBath),
    maxPricePerNight,
    matchMode,
    intervalMinutes,
    notes: String(input.notes || '').trim()
  };
}

module.exports = {
  PROPERTIES,
  DATA_DIR,
  MAX_ROOMS,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  validateWatchInput,
  normalizeBookedNights,
  normalizeRoomSlots,
  normalizeWatch,
  nightsInStay,
  generateTopic
};
