const { chromium } = require('playwright');
const { PROPERTIES } = require('./config');
const { buildDateSegments, roomMatchesWatch, toUsDate, parsePrice } = require('./filter');

const SEARCH_LANDING_URL = 'https://reservations.ahlsmsworld.com/Yosemite/Plan-Your-Trip/Accommodations/Yosemite-Valley-Lodge';

const BLOCKED_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'facebook.com',
  'facebook.net',
  'marinsm.com',
  'hotjar.com',
  'bing.com'
];

class YosemiteScraper {
  constructor() {
    this.browser = null;
  }

  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    try {
      this.browser = await chromium.launch({
        channel: 'chromium',
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      });
    } catch (err) {
      throw new Error(`Could not start the browser: ${String(err.message).split('\n')[0]}`);
    }
    return this.browser;
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  async createConfiguredPage(context) {
    const page = await context.newPage();
    await page.route('**/*', route => {
      const url = route.request().url();
      if (BLOCKED_DOMAINS.some(d => url.includes(d))) {
        return route.abort();
      }
      return route.continue();
    });
    return page;
  }

  /**
   * Perform a single live search on reservations.ahlsmsworld.com for one property and date range.
   */
  async searchOnce(page, { propertyCode, checkIn, checkOut, rooms, adults, children }) {
    const prop = PROPERTIES[propertyCode];
    if (!prop) {
      throw new Error(`Unknown property code: ${propertyCode}`);
    }

    // Ensure we are on a page with the live search widget loaded
    const currentUrl = page.url();
    if (!currentUrl.startsWith('https://reservations.ahlsmsworld.com/Yosemite/')) {
      await page.goto(SEARCH_LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    const visSelects = page.locator('select:visible');
    await visSelects.nth(0).waitFor({ state: 'visible', timeout: 25000 });

    // Wait for loading overlay to clear if present
    await page.locator('.wxa-loading-overlay, .blockUI').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

    // Select property, rooms, adults, children
    await visSelects.nth(0).selectOption({ label: prop.dropdownLabel });
    await page.waitForTimeout(350);
    await visSelects.nth(1).selectOption(String(rooms));
    await visSelects.nth(2).selectOption(String(adults));
    await visSelects.nth(3).selectOption(String(children));

    // Fill Check-in & Check-out in MM/DD/YYYY format
    const visInputs = page.locator('input[type="text"]:visible');
    await visInputs.nth(0).fill(toUsDate(checkIn));
    await visInputs.nth(1).fill(toUsDate(checkOut));
    await visInputs.nth(1).press('Tab').catch(() => {});
    await page.waitForTimeout(250);

    // Click Check Availability (or Search)
    const submitBtn = page.getByRole('button', { name: /Check Availability|Search/i }).first();
    await submitBtn.click();

    // Wait through PleaseWait -> Results (or detect temporary rejection fast)
    await page.waitForFunction(() => {
      const href = location.href;
      if (href.includes('/PleaseWait')) return false;
      const bodyText = document.body ? document.body.innerText : '';
      if (/Action not allowed/i.test(bodyText)) return true;
      const hasResults = document.querySelectorAll('.panel-rate-result-item').length > 0;
      const hasNoResults = /couldn't find any results|no availability|not available/i.test(bodyText);
      return href.includes('/Accommodation-Search/Results') && (hasResults || hasNoResults);
    }, { timeout: 35000 });

    const rejected = await page.evaluate(() => /Action not allowed/i.test(document.body?.innerText || ''));
    if (rejected) {
      throw new Error('Yosemite reservation site temporarily paused this request; will retry on next cycle.');
    }

    // Extract all room cards across all DataTables pages
    const rawRooms = await page.evaluate((code) => {
      let containers = [];
      try {
        if (window.jQuery && window.jQuery('.dataTable').length && window.jQuery.fn.DataTable) {
          const dt = window.jQuery('.dataTable').DataTable();
          const nodes = dt.rows().nodes().toArray();
          containers = nodes
            .map(row => row.querySelector('.panel-rate-result-item'))
            .filter(Boolean);
        }
      } catch {
        // fallback to DOM query
      }
      if (containers.length === 0) {
        containers = [...document.querySelectorAll('.panel-rate-result-item')];
      }

      return containers.map(panel => {
        const propName = panel.querySelector('h4.rate-result-prop-name')?.textContent?.trim() || '';
        const roomName = panel.querySelector('h3:not(.rate-result-item-price)')?.textContent?.trim() || '';
        const priceText = panel.querySelector('h3.rate-result-item-price')?.textContent?.trim() || '';
        const description = panel.querySelector('.body-copy')?.textContent?.trim() || '';
        return {
          propertyCode: code,
          propertyName: propName,
          roomName,
          priceText,
          description
        };
      });
    }, propertyCode);

    return rawRooms.map(r => ({
      ...r,
      propertyName: r.propertyName || prop.name,
      pricePerNight: parsePrice(r.priceText),
      bookingUrl: prop.bookingUrl
    }));
  }

  /**
   * Run a complete availability check for one Watch Request across all its
   * selected properties and date segments (full stay + optional individual nights).
   */
  async checkWatch(watch, onProgress) {
    const segments = buildDateSegments(watch.checkIn, watch.checkOut, watch.matchMode);
    const totalSteps = watch.properties.length * segments.length;
    let completedSteps = 0;

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const matches = [];
    const excludedCountByProperty = {};
    const errors = [];
    const segmentStatus = {}; // { [propertyCode]: { [checkIn + ':' + checkOut]: { status, matchCount, excludedCount, rooms } } }

    try {
      const page = await this.createConfiguredPage(context);

      for (const propCode of watch.properties) {
        const prop = PROPERTIES[propCode];
        if (!prop) continue;
        segmentStatus[propCode] = {};
        excludedCountByProperty[propCode] = 0;

        for (const seg of segments) {
          completedSteps += 1;
          if (typeof onProgress === 'function') {
            onProgress({
              watchId: watch.id,
              step: completedSteps,
              totalSteps,
              propertyCode: propCode,
              propertyName: prop.name,
              segmentLabel: seg.label
            });
          }

          const segKey = `${seg.checkIn}:${seg.checkOut}`;
          try {
            const rawRooms = await this.searchOnce(page, {
              propertyCode: propCode,
              checkIn: seg.checkIn,
              checkOut: seg.checkOut,
              rooms: watch.rooms,
              adults: watch.adults,
              children: watch.children
            });

            const matchedRooms = [];
            let excludedCount = 0;
            for (const room of rawRooms) {
              const check = roomMatchesWatch(room, watch);
              if (check.matched) {
                matchedRooms.push(room);
                matches.push({
                  key: `${watch.id}|${propCode}|${seg.checkIn}|${seg.checkOut}|${room.roomName}`,
                  watchId: watch.id,
                  watchName: watch.name,
                  propertyCode: propCode,
                  propertyName: room.propertyName,
                  roomName: room.roomName,
                  priceText: room.priceText,
                  pricePerNight: room.pricePerNight,
                  description: room.description,
                  bookingUrl: room.bookingUrl,
                  segmentKind: seg.kind,
                  segmentLabel: seg.label,
                  checkIn: seg.checkIn,
                  checkOut: seg.checkOut,
                  nights: seg.nights
                });
              } else {
                excludedCount += 1;
              }
            }

            excludedCountByProperty[propCode] += excludedCount;
            segmentStatus[propCode][segKey] = {
              kind: seg.kind,
              label: seg.label,
              checkIn: seg.checkIn,
              checkOut: seg.checkOut,
              status: matchedRooms.length > 0 ? 'available' : 'sold_out',
              matchCount: matchedRooms.length,
              excludedCount,
              rooms: matchedRooms
            };
          } catch (err) {
            errors.push({
              propertyCode: propCode,
              propertyName: prop.name,
              segmentLabel: seg.label,
              message: err.message
            });
            segmentStatus[propCode][segKey] = {
              kind: seg.kind,
              label: seg.label,
              checkIn: seg.checkIn,
              checkOut: seg.checkOut,
              status: 'error',
              matchCount: 0,
              excludedCount: 0,
              error: err.message,
              rooms: []
            };
            // Reload landing page on error so next step starts cleanly
            await page.goto(SEARCH_LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          }
        }
      }
    } finally {
      await context.close().catch(() => {});
    }

    return {
      watchId: watch.id,
      checkedAt: new Date().toISOString(),
      segments,
      matches,
      segmentStatus,
      excludedCountByProperty,
      errors
    };
  }
}

module.exports = { YosemiteScraper };
