const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-sched-'));
const { WatchScheduler } = require('../src/scheduler');

const watch = {
  id: 'w1',
  name: 'Test watch',
  enabled: true,
  checkIn: '2027-06-07',
  checkOut: '2027-06-11',
  intervalMinutes: 10,
  roomSlots: [{ id: 'r1', label: 'Family 1', adults: 2, children: 2, bookedNights: [] }]
};

function makeScheduler(scraper) {
  const events = [];
  const state = { watchResults: {}, watchErrors: {}, seenKeys: {}, alertHistory: [] };
  const alerts = { ntfyEnabled: false, desktopEnabled: false, browserEnabled: true, soundEnabled: false };
  const scheduler = new WatchScheduler({
    scraper,
    getConfig: () => ({ alerts, watches: [watch] }),
    getState: () => state,
    broadcast: (type, data) => events.push({ type, data })
  });
  return { scheduler, events, state };
}

const match = {
  key: 'Y|2027-06-07|2027-06-11|king|2-2',
  propertyName: 'Yosemite Valley Lodge',
  roomName: 'Standard King',
  segmentKind: 'full',
  segmentLabel: 'Jun 7 – Jun 11',
  bookingUrl: 'https://example.test/book',
  partyKey: '2-2',
  adults: 2,
  children: 2
};

test('a successful check streams progress, the result, and an alert to live clients', async () => {
  const scraper = {
    async checkWatch(_w, onProgress) {
      onProgress({ step: 1, totalSteps: 1, propertyName: 'Yosemite Valley Lodge', segmentLabel: 'Full stay' });
      return { watchId: 'w1', checkedAt: new Date().toISOString(), parties: [], matches: [match], errors: [] };
    }
  };
  const { scheduler, events, state } = makeScheduler(scraper);
  scheduler.enqueueWatch('w1');
  await new Promise(resolve => setTimeout(resolve, 100));

  const types = events.map(e => e.type);
  assert.ok(types.includes('alert'), 'an alert is broadcast for the new opening');
  const result = events.find(e => e.type === 'watchResult');
  assert.equal(result.data.newMatchesCount, 1);
  assert.equal(result.data.result.matches.length, 1);
  assert.equal(events.filter(e => e.type === 'progress').at(-1).data, null, 'progress is cleared when the check ends');
  assert.equal(state.alertHistory.length, 1);
});

test('a failed check is broadcast as a watchError instead of staying silent', async () => {
  const scraper = { async checkWatch() { throw new Error('Yosemite is offline'); } };
  const { scheduler, events } = makeScheduler(scraper);
  scheduler.enqueueWatch('w1');
  await new Promise(resolve => setTimeout(resolve, 100));

  const failure = events.find(e => e.type === 'watchError');
  assert.ok(failure);
  assert.match(failure.data.message, /offline/);
});
