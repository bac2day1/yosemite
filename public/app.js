(() => {
  const appState = {
    properties: {},
    config: { alerts: {}, watches: [] },
    state: { watchResults: {}, alertHistory: [] },
    runtime: { running: null, queue: [], nextRunAt: {} }
  };

  const $ = id => document.getElementById(id);

  // Theme handling (light mode default, dark mode toggle persisted)
  function initTheme() {
    const saved = localStorage.getItem('yosemite-theme') || 'light';
    applyTheme(saved);
    $('btnTheme').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('yosemite-theme', next);
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $('btnTheme').textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  function showToast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('toastStack').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function playChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [587.33, 880, 1174.66];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.12);
        osc.stop(ctx.currentTime + i * 0.12 + 0.38);
      });
    } catch {
      // Browser audio blocked until user interaction
    }
  }

  function updateBrowserNotificationUI() {
    const badge = $('browserPermBadge');
    const btn = $('btnEnableBrowser');
    if (!('Notification' in window)) {
      badge.textContent = 'Not supported';
      badge.className = 'status-pill warn';
      btn.classList.add('hidden');
      return;
    }
    if (Notification.permission === 'granted') {
      badge.textContent = 'Browser alerts ON';
      badge.className = 'status-pill ok';
      btn.classList.add('hidden');
    } else if (Notification.permission === 'denied') {
      badge.textContent = 'Blocked in browser';
      badge.className = 'status-pill warn';
      btn.classList.add('hidden');
    } else {
      badge.textContent = 'Click Enable';
      badge.className = 'status-pill';
      btn.classList.remove('hidden');
    }
  }

  async function requestBrowserNotifications() {
    if (!('Notification' in window)) return;
    await Notification.requestPermission();
    updateBrowserNotificationUI();
  }

  function triggerBrowserNotification(payload) {
    if (payload.soundEnabled) playChime();
    if (payload.browserEnabled && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(payload.title || 'Yosemite Lodging Alert', {
        body: payload.message || ''
      });
      if (payload.clickUrl) {
        n.onclick = () => window.open(payload.clickUrl, '_blank');
      }
    }
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTimeAgo(iso) {
    if (!iso) return 'Not checked yet';
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatCountdown(epochMs) {
    if (!epochMs) return 'Paused';
    const diffSec = Math.max(0, Math.round((epochMs - Date.now()) / 1000));
    if (diffSec <= 5) return 'Checking shortly...';
    const m = Math.floor(diffSec / 60);
    const s = diffSec % 60;
    return m > 0 ? `Next check in ${m}m ${s}s` : `Next check in ${s}s`;
  }

  function formatDateRange(checkIn, checkOut) {
    const fmt = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
    });
    const nights = Math.round((new Date(checkOut + 'T00:00:00Z') - new Date(checkIn + 'T00:00:00Z')) / 86400000);
    return `${fmt(checkIn)} – ${fmt(checkOut)} (${nights} ${nights === 1 ? 'night' : 'nights'})`;
  }

  function renderProgress() {
    const run = appState.runtime.running;
    const banner = $('progressBanner');
    if (!run) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    $('progressWatchName').textContent = `Checking: ${run.watchName || 'Yosemite Watch'}`;
    $('progressDetail').textContent = run.propertyName
      ? `${run.propertyName} · ${run.segmentLabel}`
      : (run.segmentLabel || 'Starting...');
    const pct = run.totalSteps > 0 ? Math.round((run.step / run.totalSteps) * 100) : 10;
    $('progressCounter').textContent = run.totalSteps > 0 ? `${run.step} / ${run.totalSteps}` : 'Starting';
    $('progressFill').style.width = `${pct}%`;
  }

  function renderSummary() {
    const activeCount = appState.config.watches.filter(w => w.enabled).length;
    $('statActiveWatches').textContent = String(activeCount);

    let totalMatches = 0;
    for (const w of appState.config.watches) {
      const r = appState.state.watchResults[w.id];
      if (r && Array.isArray(r.matches)) totalMatches += r.matches.length;
    }
    $('statOpenings').textContent = String(totalMatches);
    $('statTopic').textContent = appState.config.alerts.ntfyTopic || 'Not set';
  }

  function renderWatches() {
    const container = $('watchesContainer');
    const watches = appState.config.watches;

    if (!watches.length) {
      container.innerHTML = `<div class="card empty-state">No watch requests yet. Click <strong>+ New Watch Request</strong> to start watching Yosemite Valley rooms!</div>`;
      return;
    }

    container.innerHTML = watches.map(w => {
      const res = appState.state.watchResults[w.id];
      const matches = res?.matches || [];
      const isRunning = appState.runtime.running?.watchId === w.id;
      const isQueued = appState.runtime.queue.includes(w.id);

      const rulesList = [];
      if (w.excludeTents) rulesList.push('No tents');
      if (w.requirePrivateBath) rulesList.push('Private bath only');
      if (w.maxPricePerNight) rulesList.push(`Max $${w.maxPricePerNight}/night`);
      if (w.matchMode === 'both') rulesList.push('Full stay + individual nights');
      else rulesList.push('Full stay only');

      const matchesHtml = matches.length > 0 ? `
        <div class="matches-box">
          <div class="matches-box-title">🎉 ${matches.length} Matching Opening${matches.length === 1 ? '' : 's'} Available Right Now!</div>
          <div class="match-grid">
            ${matches.map(m => `
              <div class="match-item">
                <div class="match-prop">${escapeHtml(m.propertyName)} · ${escapeHtml(m.segmentLabel)}</div>
                <div class="match-room">${escapeHtml(m.roomName)}</div>
                <div class="match-footer">
                  <span class="match-price">${escapeHtml(m.priceText || 'See rate')}/night</span>
                  <a class="btn btn-primary btn-sm" href="${escapeHtml(m.bookingUrl)}" target="_blank" rel="noopener">Book Now →</a>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : '';

      const propsHtml = w.properties.map(code => {
        const prop = appState.properties[code] || { name: code, bookingUrl: '#' };
        const segMap = res?.segmentStatus?.[code] || {};
        const segEntries = Object.values(segMap);
        const excluded = res?.excludedCountByProperty?.[code] || 0;

        const pillsHtml = segEntries.length > 0
          ? segEntries.map(s => {
              const shortLbl = s.kind === 'full' ? 'Full Stay' : s.label.replace('Night of ', '');
              if (s.status === 'available') {
                return `<a class="seg-pill open" href="${escapeHtml(prop.bookingUrl)}" target="_blank" rel="noopener">✓ ${escapeHtml(shortLbl)} (${s.matchCount})</a>`;
              }
              if (s.status === 'error') {
                return `<span class="seg-pill err" title="${escapeHtml(s.error || 'Temporary error')}">⚠ ${escapeHtml(shortLbl)}</span>`;
              }
              return `<span class="seg-pill">✕ ${escapeHtml(shortLbl)}</span>`;
            }).join('')
          : `<span class="seg-pill">Waiting for first check...</span>`;

        const footNote = excluded > 0
          ? `<div class="prop-footnote">${excluded} tent/non-matching unit${excluded === 1 ? '' : 's'} filtered out</div>`
          : '';

        return `
          <div class="prop-box">
            <div class="prop-box-header">
              <span class="prop-name">${escapeHtml(prop.name)}</span>
              <a class="prop-link" href="${escapeHtml(prop.bookingUrl)}" target="_blank" rel="noopener">Official Page ↗</a>
            </div>
            <div class="seg-pills">${pillsHtml}</div>
            ${footNote}
          </div>
        `;
      }).join('');

      const nextText = isRunning
        ? 'Checking live now...'
        : isQueued
          ? 'Queued to check next...'
          : (w.enabled ? formatCountdown(appState.runtime.nextRunAt[w.id]) : 'Paused');

      return `
        <article class="watch-card ${w.enabled ? '' : 'paused'} ${matches.length > 0 ? 'has-matches' : ''}" data-watch-id="${escapeHtml(w.id)}">
          <div class="watch-top">
            <div class="watch-title-row">
              <h3 class="watch-title">${escapeHtml(w.name)}</h3>
              <span class="badge ${w.enabled ? 'badge-active' : 'badge-paused'}">${w.enabled ? 'Active' : 'Paused'}</span>
            </div>
            <div class="watch-actions">
              <button class="btn btn-secondary btn-sm" data-action="check" data-id="${escapeHtml(w.id)}" ${isRunning ? 'disabled' : ''}>${isRunning ? 'Checking...' : 'Check Now'}</button>
              <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${escapeHtml(w.id)}">Edit</button>
              <button class="btn btn-ghost btn-sm" data-action="toggle" data-id="${escapeHtml(w.id)}">${w.enabled ? 'Pause' : 'Resume'}</button>
              <button class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(w.id)}">Delete</button>
            </div>
          </div>

          <div class="watch-meta">
            <span>📅 <strong>${escapeHtml(formatDateRange(w.checkIn, w.checkOut))}</strong></span>
            <span>👨‍👩‍👧‍👦 ${w.rooms} room · ${w.adults} adults${w.children > 0 ? `, ${w.children} kids` : ''}</span>
            <span>⏱ Every ${w.intervalMinutes} min</span>
            <span>🛡 ${escapeHtml(rulesList.join(' · '))}</span>
          </div>

          ${w.notes ? `<p class="watch-notes">${escapeHtml(w.notes)}</p>` : ''}

          ${matchesHtml}

          <div class="prop-grid">${propsHtml}</div>

          <div class="watch-footer">
            <span>Last checked: <strong>${escapeHtml(formatTimeAgo(res?.checkedAt))}</strong></span>
            <span>${escapeHtml(nextText)}</span>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderHistory() {
    const container = $('historyContainer');
    const items = appState.state.alertHistory || [];
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">No alerts sent yet. Use <strong>Send Test</strong> above to verify your phone and desktop notifications.</div>`;
      return;
    }

    container.innerHTML = items.slice(0, 25).map(item => `
      <div class="history-item">
        <div class="history-top">
          <strong>${escapeHtml(item.title)}</strong>
          <span class="muted" style="font-size:0.8rem">${new Date(item.timestamp).toLocaleString()}</span>
        </div>
        <div class="history-msg">${escapeHtml(item.message)}</div>
        ${item.bookingUrl ? `<a class="prop-link" href="${escapeHtml(item.bookingUrl)}" target="_blank" rel="noopener">Open Yosemite Booking Page →</a>` : ''}
      </div>
    `).join('');
  }

  function renderAll() {
    renderProgress();
    renderSummary();
    renderWatches();
    renderHistory();
  }

  // Modals
  function openModal(id) {
    $(id).classList.remove('hidden');
  }
  function closeModal(id) {
    $(id).classList.add('hidden');
  }

  function renderPropertyCheckboxes(selectedCodes) {
    const selected = new Set(selectedCodes || ['Y', 'M', 'D']);
    const grid = $('wfPropertiesGrid');
    grid.innerHTML = Object.values(appState.properties).map(p => `
      <label class="prop-check-card">
        <input type="checkbox" name="wfProps" value="${escapeHtml(p.code)}" ${selected.has(p.code) ? 'checked' : ''} />
        <span>
          <span class="prop-check-title">${escapeHtml(p.name)}</span>
          <span class="prop-check-desc">${escapeHtml(p.description)}</span>
        </span>
      </label>
    `).join('');
  }

  function openWatchEditor(watch = null) {
    $('wfError').classList.add('hidden');
    $('watchModalTitle').textContent = watch ? 'Edit Watch Request' : 'New Watch Request';
    $('wfId').value = watch?.id || '';
    $('wfName').value = watch?.name || '';
    $('wfCheckIn').value = watch?.checkIn || '2027-06-07';
    $('wfCheckOut').value = watch?.checkOut || '2027-06-11';
    $('wfRooms').value = watch?.rooms ?? 1;
    $('wfAdults').value = watch?.adults ?? 2;
    $('wfChildren').value = watch?.children ?? 2;
    $('wfExcludeTents').checked = watch ? Boolean(watch.excludeTents) : true;
    $('wfRequireBath').checked = watch ? Boolean(watch.requirePrivateBath) : true;
    $('wfMatchMode').value = watch?.matchMode || 'both';
    $('wfInterval').value = String(watch?.intervalMinutes || 10);
    $('wfMaxPrice').value = watch?.maxPricePerNight ?? '';
    $('wfNotes').value = watch?.notes || '';
    $('wfCheckNow').checked = true;
    renderPropertyCheckboxes(watch?.properties || ['Y', 'M', 'D']);
    openModal('watchModal');
  }

  function openAlertsEditor() {
    const a = appState.config.alerts || {};
    $('afNtfyEnabled').checked = Boolean(a.ntfyEnabled);
    $('afNtfyTopic').value = a.ntfyTopic || '';
    $('afNtfyServer').value = a.ntfyServer || 'https://ntfy.sh';
    $('afDesktopEnabled').checked = Boolean(a.desktopEnabled);
    $('afBrowserEnabled').checked = Boolean(a.browserEnabled);
    $('afSoundEnabled').checked = Boolean(a.soundEnabled);
    $('afFeedback').classList.add('hidden');
    openModal('alertsModal');
  }

  // API helpers
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  async function refreshFullState() {
    const data = await api('/api/state');
    appState.properties = data.properties || {};
    appState.config = data.config || appState.config;
    appState.state = data.state || appState.state;
    appState.runtime = data.runtime || appState.runtime;
    renderAll();
  }

  async function sendTestAlert(feedbackEl = null) {
    try {
      const res = await api('/api/alerts/test', { method: 'POST' });
      const parts = [];
      if (res.delivery?.ntfy?.sent) parts.push('Phone push sent');
      else if (res.delivery?.ntfy?.error) parts.push(`Phone push error: ${res.delivery.ntfy.error}`);
      if (res.delivery?.desktop?.sent) parts.push('Desktop alert sent');
      parts.push('Browser alert triggered');
      const msg = parts.join(' · ');
      showToast(msg);
      if (feedbackEl) {
        feedbackEl.textContent = msg;
        feedbackEl.classList.remove('hidden');
      }
      await refreshFullState();
    } catch (err) {
      showToast('Test alert failed: ' + err.message);
    }
  }

  // Event listeners
  function bindEvents() {
    $('btnNewWatch').addEventListener('click', () => openWatchEditor(null));
    $('btnAlertsSettings').addEventListener('click', openAlertsEditor);
    $('btnEnableBrowser').addEventListener('click', requestBrowserNotifications);
    $('btnTestAlertQuick').addEventListener('click', () => sendTestAlert());
    $('btnTestAlertModal').addEventListener('click', () => sendTestAlert($('afFeedback')));

    $('btnCheckAll').addEventListener('click', async () => {
      try {
        await api('/api/check-all', { method: 'POST' });
        showToast('Checking all active Yosemite watches now...');
      } catch (err) {
        showToast(err.message);
      }
    });

    $('btnCopyTopicQuick').addEventListener('click', async () => {
      const topic = appState.config.alerts.ntfyTopic || '';
      if (!topic) return;
      await navigator.clipboard?.writeText(topic).catch(() => {});
      showToast(`Copied topic: ${topic}`);
    });

    $('btnClearHistory').addEventListener('click', async () => {
      await api('/api/alerts/history', { method: 'DELETE' });
      appState.state.alertHistory = [];
      renderHistory();
    });

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close-modal')));
    });

    // Delegate watch card buttons
    $('watchesContainer').addEventListener('click', async e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      const watch = appState.config.watches.find(w => w.id === id);
      if (!watch) return;

      if (action === 'edit') {
        openWatchEditor(watch);
      } else if (action === 'check') {
        await api(`/api/watches/${id}/check`, { method: 'POST' });
        showToast(`Queued live check for "${watch.name}"`);
      } else if (action === 'toggle') {
        await api(`/api/watches/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...watch, enabled: !watch.enabled })
        });
        showToast(watch.enabled ? `Paused "${watch.name}"` : `Resumed "${watch.name}"`);
        await refreshFullState();
      } else if (action === 'delete') {
        if (!confirm(`Delete watch request "${watch.name}"?`)) return;
        await api(`/api/watches/${id}`, { method: 'DELETE' });
        showToast(`Deleted "${watch.name}"`);
        await refreshFullState();
      }
    });

    // Save Watch Request form
    $('watchForm').addEventListener('submit', async e => {
      e.preventDefault();
      $('wfError').classList.add('hidden');
      const id = $('wfId').value.trim();
      const props = [...document.querySelectorAll('input[name="wfProps"]:checked')].map(el => el.value);

      const payload = {
        name: $('wfName').value.trim(),
        checkIn: $('wfCheckIn').value,
        checkOut: $('wfCheckOut').value,
        rooms: Number($('wfRooms').value),
        adults: Number($('wfAdults').value),
        children: Number($('wfChildren').value),
        properties: props,
        excludeTents: $('wfExcludeTents').checked,
        requirePrivateBath: $('wfRequireBath').checked,
        matchMode: $('wfMatchMode').value,
        intervalMinutes: Number($('wfInterval').value),
        maxPricePerNight: $('wfMaxPrice').value ? Number($('wfMaxPrice').value) : null,
        notes: $('wfNotes').value.trim(),
        enabled: true,
        checkImmediately: $('wfCheckNow').checked
      };

      try {
        if (id) {
          await api(`/api/watches/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
          showToast('Watch request updated!');
        } else {
          await api('/api/watches', { method: 'POST', body: JSON.stringify(payload) });
          showToast('New watch request added!');
        }
        closeModal('watchModal');
        await refreshFullState();
      } catch (err) {
        $('wfError').textContent = err.message;
        $('wfError').classList.remove('hidden');
      }
    });

    // Save Alert Settings form
    $('alertsForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api('/api/alerts', {
          method: 'PUT',
          body: JSON.stringify({
            ntfyEnabled: $('afNtfyEnabled').checked,
            ntfyTopic: $('afNtfyTopic').value.trim(),
            ntfyServer: $('afNtfyServer').value.trim(),
            desktopEnabled: $('afDesktopEnabled').checked,
            browserEnabled: $('afBrowserEnabled').checked,
            soundEnabled: $('afSoundEnabled').checked
          })
        });
        $('afFeedback').textContent = 'Alert settings saved!';
        $('afFeedback').classList.remove('hidden');
        showToast('Alert settings saved!');
        await refreshFullState();
      } catch (err) {
        showToast('Failed to save alerts: ' + err.message);
      }
    });
  }

  // Live SSE updates
  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('open', () => {
      $('connectionStatus').textContent = 'Live updates connected';
    });
    es.addEventListener('error', () => {
      $('connectionStatus').textContent = 'Reconnecting...';
    });
    es.addEventListener('progress', e => {
      appState.runtime.running = JSON.parse(e.data);
      renderProgress();
      renderWatches();
    });
    es.addEventListener('watchResult', e => {
      const data = JSON.parse(e.data);
      appState.state.watchResults[data.watchId] = data.result;
      if (data.nextRunAt) appState.runtime.nextRunAt[data.watchId] = data.nextRunAt;
      renderAll();
    });
    es.addEventListener('configChanged', e => {
      const data = JSON.parse(e.data);
      appState.config = data.config;
      appState.runtime = data.runtime;
      renderAll();
    });
    es.addEventListener('alert', e => {
      const payload = JSON.parse(e.data);
      triggerBrowserNotification(payload);
      showToast(payload.title || 'Yosemite opening found!');
      refreshFullState();
    });
    es.addEventListener('historyCleared', () => {
      appState.state.alertHistory = [];
      renderHistory();
    });
  }

  // Refresh countdowns smoothly every 10s
  setInterval(() => renderWatches(), 10000);

  initTheme();
  updateBrowserNotificationUI();
  bindEvents();

  // Wait for authentication before loading protected data & SSE stream
  window.YosemiteAuth.boot(() => {
    refreshFullState();
    connectEvents();
  });
})();
