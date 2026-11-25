const test = require('node:test');
const assert = require('node:assert/strict');
const { roomMatchesWatch, buildDateSegments, parsePrice, detectSiteOutage, groupRoomParties, bookedInAllRooms, roomsFullyBooked, roomsForMatch } = require('../src/filter');
const { validateWatchInput, normalizeBookedNights, normalizeWatch, nightsInStay } = require('../src/config');

const indoorWatch = {
  properties: ['Y', 'M', 'D'],
  excludeTents: true,
  requirePrivateBath: true,
  maxPricePerNight: null
};

test('excludes Curry Village canvas tent cabins and cabins without bath', () => {
  const heatedTent = {
    propertyCode: 'D',
    roomName: 'Heated Canvas Tent Cabin - 1 Double Bed and 2 Single Beds',
    description: 'Canvas tent cabin with wooden floor',
    pricePerNight: 217.61
  };
  const unheatedTent = {
    propertyCode: 'D',
    roomName: 'Unheated Canvas Tent Cabin - 1 Double Bed and 3 Single Beds',
    description: 'Canvas tent cabin',
    pricePerNight: 126.36
  };
  const cabinNoBath = {
    propertyCode: 'D',
    roomName: 'Curry Village Cabin without Bath - 1 Double Bed',
    description: 'Wooden cabin',
    pricePerNight: 199.0
  };

  assert.equal(roomMatchesWatch(heatedTent, indoorWatch).matched, false);
  assert.equal(roomMatchesWatch(unheatedTent, indoorWatch).matched, false);
  assert.equal(roomMatchesWatch(cabinNoBath, indoorWatch).matched, false);
});

test('includes Curry Village Stoneman rooms and wooden cabins with bath', () => {
  const stoneman = {
    propertyCode: 'D',
    roomName: 'Stoneman Standard with 2 Double Beds',
    description: 'Private bathroom',
    pricePerNight: 256.85
  };
  const cabinWithBath = {
    propertyCode: 'D',
    roomName: 'Curry Village Cabin with Bath - 2 Double Beds',
    description: 'Wooden cabin with private bath',
    pricePerNight: 256.85
  };

  assert.equal(roomMatchesWatch(stoneman, indoorWatch).matched, true);
  assert.equal(roomMatchesWatch(cabinWithBath, indoorWatch).matched, true);
});

test('allows Housekeeping Camp when explicitly selected in its watch', () => {
  const hkWatch = {
    properties: ['H'],
    excludeTents: true,
    requirePrivateBath: true,
    maxPricePerNight: null
  };
  const hkUnit = {
    propertyCode: 'H',
    roomName: 'Housekeeping Camp - Standard Unit',
    description: 'Canvas roof and three concrete walls',
    pricePerNight: 165.0
  };
  assert.equal(roomMatchesWatch(hkUnit, hkWatch).matched, true);
});

test('enforces optional max nightly price cap', () => {
  const cappedWatch = { ...indoorWatch, maxPricePerNight: 400 };
  assert.equal(roomMatchesWatch({ propertyCode: 'M', roomName: 'Ahwahnee Classic Room', pricePerNight: 650 }, cappedWatch).matched, false);
  assert.equal(roomMatchesWatch({ propertyCode: 'Y', roomName: 'Traditional 2 Doubles', pricePerNight: 349 }, cappedWatch).matched, true);
});

test('booked nights stop being checked but the full stay is still watched', () => {
  const segs = buildDateSegments('2027-06-07', '2027-06-11', 'both', ['2027-06-08', '2027-06-10']);
  assert.deepEqual(segs.map(s => `${s.kind}:${s.checkIn}`), ['full:2027-06-07', 'night:2027-06-07', 'night:2027-06-09']);

  const allBooked = buildDateSegments('2027-06-07', '2027-06-11', 'both', ['2027-06-07', '2027-06-08', '2027-06-09', '2027-06-10']);
  assert.deepEqual(allBooked.map(s => s.kind), ['full']);
});

test('booked nights are limited to valid dates inside the stay', () => {
  const clean = normalizeBookedNights(['2027-06-09', '2027-06-09', '2027-06-11', '2027-06-06', 'junk', 42], '2027-06-07', '2027-06-11');
  assert.deepEqual(clean, ['2027-06-09']);
  assert.deepEqual(normalizeBookedNights(undefined, '2027-06-07', '2027-06-11'), []);
  assert.equal(nightsInStay('2027-06-07', '2027-06-11'), 4);
});

const family = (id, adults, children, bookedNights = []) => ({ id, label: id, adults, children, bookedNights });

test('rooms with the same guests share one search; different guests are searched separately', () => {
  const groups = groupRoomParties([family('a', 2, 2), family('b', 2, 2), family('c', 2, 0)]);
  assert.deepEqual(groups.map(g => [g.key, g.slots.length]), [['2-2', 2], ['2-0', 1]]);
});

test('a night is only skipped once every room sharing the search has booked it', () => {
  const rooms = [family('a', 2, 2, ['2027-06-08', '2027-06-09']), family('b', 2, 2, ['2027-06-08'])];
  assert.deepEqual(bookedInAllRooms(rooms), ['2027-06-08']);
  const nights = buildDateSegments('2027-06-07', '2027-06-11', 'both', bookedInAllRooms(rooms)).filter(s => s.kind === 'night').map(s => s.checkIn);
  assert.deepEqual(nights, ['2027-06-07', '2027-06-09', '2027-06-10']);
});

test('the watch is fully booked only when every room has every night', () => {
  const all = ['2027-06-07', '2027-06-08', '2027-06-09', '2027-06-10'];
  assert.equal(roomsFullyBooked([family('a', 2, 2, all), family('b', 2, 2, all.slice(0, 3))], '2027-06-07', '2027-06-11'), false);
  assert.equal(roomsFullyBooked([family('a', 2, 2, all), family('b', 2, 2, all)], '2027-06-07', '2027-06-11'), true);
});

test('an opening names only the rooms that still need those nights and have matching guests', () => {
  const rooms = [family('Family 1', 2, 2, ['2027-06-08']), family('Family 2', 2, 2), family('Couple', 2, 0)];
  const night = { segmentKind: 'night', checkIn: '2027-06-08', checkOut: '2027-06-09', adults: 2, children: 2 };
  assert.deepEqual(roomsForMatch(rooms, night).map(r => r.label), ['Family 2']);
  const stay = { segmentKind: 'full', checkIn: '2027-06-07', checkOut: '2027-06-11', adults: 2, children: 2 };
  assert.deepEqual(roomsForMatch(rooms, stay).map(r => r.label), ['Family 2']);
});

test('rooms needed: separate rooms, keeps booked nights on edit, and upgrades older watches', () => {
  const base = { name: 'x', checkIn: '2027-06-07', checkOut: '2027-06-11', properties: ['Y'] };
  const created = validateWatchInput({ ...base, roomSlots: [{ label: 'Family 1', adults: 2, children: 2 }, { adults: 3, children: 1 }] });
  assert.deepEqual(created.roomSlots.map(r => [r.label, r.adults, r.children]), [['Family 1', 2, 2], ['Room 2', 3, 1]]);

  const stored = { ...created, roomSlots: created.roomSlots.map((r, i) => (i === 0 ? { ...r, bookedNights: ['2027-06-08', '2027-06-10'] } : r)) };
  // The client can't change booked nights; shrinking the stay drops ones that fall outside it
  const edited = validateWatchInput({ ...base, checkOut: '2027-06-10', roomSlots: [{ id: stored.roomSlots[0].id, label: 'Family 1', adults: 2, children: 2, bookedNights: ['2027-06-09'] }] }, 'w1', stored);
  assert.deepEqual(edited.roomSlots[0].bookedNights, ['2027-06-08']);
  assert.equal(edited.roomSlots[0].id, stored.roomSlots[0].id);

  assert.throws(() => validateWatchInput({ ...base, roomSlots: [] }), /at least one room/i);
  assert.equal(validateWatchInput({ ...base, roomSlots: Array.from({ length: 20 }, () => ({})) }).roomSlots.length, 6);

  const legacy = normalizeWatch({ ...base, id: 'old', rooms: 1, adults: 2, children: 2 });
  assert.equal(legacy.rooms, undefined);
  assert.deepEqual(legacy.roomSlots.map(r => [r.adults, r.children]), [[2, 2]]);
  const twoRooms = normalizeWatch({ ...base, id: 'old2', rooms: 2, adults: 2, children: 1 });
  assert.equal(twoRooms.roomSlots.length, 2);
});

test('builds full stay plus all 4 individual nights for June 7-11, 2027', () => {
  const segs = buildDateSegments('2027-06-07', '2027-06-11', 'both');
  assert.equal(segs.length, 5);
  assert.equal(segs[0].kind, 'full');
  assert.equal(segs[0].checkIn, '2027-06-07');
  assert.equal(segs[0].checkOut, '2027-06-11');
  assert.equal(segs[0].nights, 4);
  assert.deepEqual(
    segs.slice(1).map(s => [s.checkIn, s.checkOut]),
    [
      ['2027-06-07', '2027-06-08'],
      ['2027-06-08', '2027-06-09'],
      ['2027-06-09', '2027-06-10'],
      ['2027-06-10', '2027-06-11']
    ]
  );

  const fullOnly = buildDateSegments('2027-06-07', '2027-06-11', 'full');
  assert.equal(fullOnly.length, 1);
});

test('recognizes the reservation site maintenance page but not a normal page', () => {
  const maintenance = 'Plan Your Trip Our reservations system is currently offline for maintenance. Please try your request at a later time. (ERR: SCHM02)';
  assert.equal(detectSiteOutage(maintenance), 'SCHM02');
  assert.equal(detectSiteOutage('We are currently offline for maintenance'), 'maintenance');
  assert.equal(detectSiteOutage('Curry Village Stoneman Standard $256.85 AVERAGE/NIGHT'), null);
  assert.equal(detectSiteOutage('We couldn\'t find any results for your search!'), null);
  assert.equal(detectSiteOutage(undefined), null);
});

test('parses formatted prices and validates watch inputs', () => {
  assert.equal(parsePrice('$256.85'), 256.85);
  assert.equal(parsePrice(''), null);

  assert.throws(() => validateWatchInput({
    name: 'Bad dates',
    checkIn: '2027-06-11',
    checkOut: '2027-06-07',
    properties: ['Y']
  }), /after check-in/i);

  assert.throws(() => validateWatchInput({
    name: 'Offsite rejected',
    checkIn: '2027-06-07',
    checkOut: '2027-06-11',
    properties: ['OFFSITE']
  }), /at least one Yosemite Valley property/i);
});
