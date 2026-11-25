const express = require('express');
const path = require('path');
const {
  PROPERTIES,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  validateWatchInput,
  generateTopic
} = require('./config');
const { YosemiteScraper } = require('./scraper');
const { WatchScheduler } = require('./scheduler');
const { dispatchAlerts } = require('./notifier');
const { registerAuthRoutes, requireAuth } = require('./auth');

const PORT = parseInt(process.env.PORT || '3847', 10);
const HOST = process.env.HOST || '0.0.0.0';

let config = loadConfig();
let state = loadState();

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

const scraper = new YosemiteScraper();
const scheduler = new WatchScheduler({
  scraper,
  getConfig: () => config,
  getState: () => state,
  broadcast
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Public health check for Docker / reverse proxy
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Authentication, passkeys & admin roster routes
registerAuthRoutes(app);

// All app routes below require an authenticated session (and completed passkey setup)
app.get('/api/state', requireAuth, (req, res) => {
  res.json({
    properties: PROPERTIES,
    config,
    state: {
      watchResults: state.watchResults,
      alertHistory: state.alertHistory
    },
    runtime: scheduler.getRuntimeStatus()
  });
});

// Live SSE stream
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// Create a new watch request
app.post('/api/watches', requireAuth, (req, res) => {
  try {
    const watch = validateWatchInput(req.body);
    config.watches.push(watch);
    saveConfig(config);
    scheduler.syncSchedules();
    if (watch.enabled) {
      scheduler.enqueueWatch(watch.id, { priority: true });
    }
    broadcast('configChanged', { config, runtime: scheduler.getRuntimeStatus() });
    res.status(201).json({ watch });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update an existing watch request
app.put('/api/watches/:id', requireAuth, (req, res) => {
  const idx = config.watches.findIndex(w => w.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Watch request not found.' });
  }
  try {
    const updated = validateWatchInput(req.body, req.params.id);
    config.watches[idx] = updated;
    saveConfig(config);
    // Clear previous seenKeys if criteria changed so new matches trigger alerts cleanly
    delete state.seenKeys[updated.id];
    saveState(state);
    scheduler.syncSchedules();
    if (updated.enabled && req.body.checkImmediately) {
      scheduler.enqueueWatch(updated.id, { priority: true });
    }
    broadcast('configChanged', { config, runtime: scheduler.getRuntimeStatus() });
    res.json({ watch: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a watch request
app.delete('/api/watches/:id', requireAuth, (req, res) => {
  const before = config.watches.length;
  config.watches = config.watches.filter(w => w.id !== req.params.id);
  if (config.watches.length === before) {
    return res.status(404).json({ error: 'Watch request not found.' });
  }
  delete state.watchResults[req.params.id];
  delete state.seenKeys[req.params.id];
  saveConfig(config);
  saveState(state);
  scheduler.syncSchedules();
  broadcast('configChanged', { config, runtime: scheduler.getRuntimeStatus() });
  res.json({ ok: true });
});

// Trigger immediate check for one watch
app.post('/api/watches/:id/check', requireAuth, (req, res) => {
  const watch = config.watches.find(w => w.id === req.params.id);
  if (!watch) {
    return res.status(404).json({ error: 'Watch request not found.' });
  }
  const queued = scheduler.enqueueWatch(watch.id, { priority: true });
  res.json({ queued, runtime: scheduler.getRuntimeStatus() });
});

// Trigger immediate check for all active watches
app.post('/api/check-all', requireAuth, (req, res) => {
  const count = scheduler.enqueueAllActive();
  res.json({ queuedCount: count, runtime: scheduler.getRuntimeStatus() });
});

// Update alert settings
app.put('/api/alerts', requireAuth, (req, res) => {
  const body = req.body || {};
  const topic = String(body.ntfyTopic || '').trim() || config.alerts.ntfyTopic || generateTopic();
  const serverUrl = String(body.ntfyServer || 'https://ntfy.sh').trim().replace(/\/+$/, '');

  config.alerts = {
    ntfyEnabled: Boolean(body.ntfyEnabled),
    ntfyServer: serverUrl || 'https://ntfy.sh',
    ntfyTopic: topic,
    desktopEnabled: Boolean(body.desktopEnabled),
    browserEnabled: Boolean(body.browserEnabled),
    soundEnabled: Boolean(body.soundEnabled)
  };
  saveConfig(config);
  broadcast('configChanged', { config, runtime: scheduler.getRuntimeStatus() });
  res.json({ alerts: config.alerts });
});

// Send a live test alert to phone + desktop + browser
app.post('/api/alerts/test', requireAuth, async (req, res) => {
  const payload = {
    title: 'Test Alert — Yosemite Lodging Watcher',
    message: 'Your phone & desktop alerts are working! When a Yosemite Valley room opens for June 7–11, 2027, you will get an instant notification with a 1-tap booking link.',
    clickUrl: PROPERTIES.Y.bookingUrl,
    priority: 'default',
    tags: 'white_check_mark,national_park'
  };
  const delivery = await dispatchAlerts(config.alerts, payload, broadcast);
  state.alertHistory.unshift({
    id: 'test-' + Date.now(),
    timestamp: new Date().toISOString(),
    watchId: null,
    watchName: 'Test Alert',
    title: payload.title,
    message: payload.message,
    bookingUrl: payload.clickUrl,
    matchCount: 0,
    delivery
  });
  state.alertHistory = state.alertHistory.slice(0, 100);
  saveState(state);
  res.json({ ok: true, delivery });
});

// Clear alert history
app.delete('/api/alerts/history', requireAuth, (req, res) => {
  state.alertHistory = [];
  saveState(state);
  broadcast('historyCleared', {});
  res.json({ ok: true });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Yosemite Valley Lodging Watcher is running!`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  Phone push topic (ntfy.sh): ${config.alerts.ntfyTopic}\n`);
  if (process.env.DISABLE_AUTO_START !== '1') {
    scheduler.start();
  }
});

async function shutdown() {
  scheduler.stop();
  await scraper.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
