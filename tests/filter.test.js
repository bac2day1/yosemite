const test = require('node:test');
const assert = require('node:assert/strict');
const { roomMatchesWatch, buildDateSegments, parsePrice, detectSiteOutage } = require('../src/filter');
const { validateWatchInput } = require('../src/config');

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
