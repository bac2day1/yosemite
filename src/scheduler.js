const { dispatchAlerts } = require('./notifier');
const { saveState } = require('./config');

class WatchScheduler {
  constructor({ scraper, getConfig, getState, broadcast }) {
    this.scraper = scraper;
    this.getConfig = getConfig;
    this.getState = getState;
    this.broadcast = broadcast;

    this.queue = [];
    this.running = null; // { watchId, step, totalSteps, propertyName, segmentLabel, startedAt }
    this.nextRunAt = {}; // { [watchId]: epochMs }
    this.timer = null;
  }

  start() {
    this.syncSchedules();
    this.timer = setInterval(() => this.tick(), 5000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  syncSchedules() {
    const cfg = this.getConfig();
    const now = Date.now();
    const validIds = new Set(cfg.watches.map(w => w.id));

    for (const id of Object.keys(this.nextRunAt)) {
      if (!validIds.has(id)) delete this.nextRunAt[id];
    }

    for (const w of cfg.watches) {
      if (!w.enabled) {
        delete this.nextRunAt[w.id];
      } else if (!this.nextRunAt[w.id]) {
        // Schedule shortly after startup so first check begins automatically
        this.nextRunAt[w.id] = now + 3000;
      }
    }
  }

  enqueueWatch(watchId, { priority = false } = {}) {
    if (this.running && this.running.watchId === watchId) {
      return false;
    }
    if (this.queue.includes(watchId)) {
      return false;
    }
    if (priority) {
      this.queue.unshift(watchId);
    } else {
      this.queue.push(watchId);
    }
    this.processQueue();
    return true;
  }

  enqueueAllActive() {
    const cfg = this.getConfig();
    let count = 0;
    for (const w of cfg.watches) {
      if (w.enabled) {
        if (this.enqueueWatch(w.id)) count += 1;
      }
    }
    return count;
  }

  tick() {
    const cfg = this.getConfig();
    const now = Date.now();
    for (const w of cfg.watches) {
      if (!w.enabled) continue;
      const due = this.nextRunAt[w.id] || 0;
      if (now >= due) {
        this.nextRunAt[w.id] = now + w.intervalMinutes * 60 * 1000;
        this.enqueueWatch(w.id);
      }
    }
  }

  getRuntimeStatus() {
    return {
      running: this.running,
      queue: [...this.queue],
      nextRunAt: { ...this.nextRunAt }
    };
  }

  async processQueue() {
    if (this.running || this.queue.length === 0) return;

    const watchId = this.queue.shift();
    const cfg = this.getConfig();
    const watch = cfg.watches.find(w => w.id === watchId);
    if (!watch) {
      this.processQueue();
      return;
    }

    this.running = {
      watchId: watch.id,
      watchName: watch.name,
      step: 0,
      totalSteps: 0,
      propertyName: '',
      segmentLabel: 'Starting search...',
      startedAt: new Date().toISOString()
    };
    this.broadcast('progress', this.running);

    try {
      const result = await this.scraper.checkWatch(watch, progress => {
        this.running = {
          ...this.running,
          ...progress
        };
        this.broadcast('progress', this.running);
      });

      const state = this.getState();
      state.watchResults[watch.id] = result;

      // Determine newly opened rooms compared to previous check for this watch
      const prevKeys = new Set(state.seenKeys[watch.id] || []);
      const currentKeys = result.matches.map(m => m.key);
      const newMatches = result.matches.filter(m => !prevKeys.has(m.key));

      state.seenKeys[watch.id] = currentKeys;

      if (newMatches.length > 0) {
        await this.notifyNewMatches(watch, newMatches, state);
      }

      saveState(state);
      this.nextRunAt[watch.id] = Date.now() + watch.intervalMinutes * 60 * 1000;

      this.broadcast('watchResult', {
        watchId: watch.id,
        result,
        newMatchesCount: newMatches.length,
        nextRunAt: this.nextRunAt[watch.id]
      });
    } catch (err) {
      this.broadcast('watchError', {
        watchId: watch.id,
        message: err.message
      });
      this.nextRunAt[watch.id] = Date.now() + Math.min(watch.intervalMinutes, 5) * 60 * 1000;
    } finally {
      this.running = null;
      this.broadcast('progress', null);
      this.processQueue();
    }
  }

  async notifyNewMatches(watch, newMatches, state) {
    const cfg = this.getConfig();
    const fullStayMatches = newMatches.filter(m => m.segmentKind === 'full');
    const top = fullStayMatches[0] || newMatches[0];

    const headline = fullStayMatches.length > 0
      ? `FULL STAY OPEN: ${top.propertyName} (${watch.checkIn} to ${watch.checkOut})`
      : `Yosemite Opening: ${top.propertyName} — ${top.segmentLabel}`;

    const lines = newMatches.slice(0, 6).map(m => {
      const price = m.priceText ? ` (${m.priceText}/night)` : '';
      return `• ${m.propertyName}: ${m.roomName}${price} — ${m.segmentLabel}`;
    });
    if (newMatches.length > 6) {
      lines.push(`...and ${newMatches.length - 6} more matching option(s).`);
    }

    const payload = {
      title: headline,
      message: lines.join('\n'),
      clickUrl: top.bookingUrl,
      priority: fullStayMatches.length > 0 ? 'urgent' : 'high',
      tags: fullStayMatches.length > 0 ? 'rotating_light,national_park' : 'national_park,bed',
      watchId: watch.id,
      watchName: watch.name
    };

    const delivery = await dispatchAlerts(cfg.alerts, payload, this.broadcast);

    state.alertHistory.unshift({
      id: 'alert-' + Date.now(),
      timestamp: new Date().toISOString(),
      watchId: watch.id,
      watchName: watch.name,
      title: payload.title,
      message: payload.message,
      bookingUrl: payload.clickUrl,
      matchCount: newMatches.length,
      delivery
    });
    state.alertHistory = state.alertHistory.slice(0, 100);
  }
}

module.exports = { WatchScheduler };
