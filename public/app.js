(() => {
  const appState = {
    properties: {},
    config: { alerts: {}, watches: [] },
    state: { watchResults: {}, watchErrors: {}, alertHistory: [] },
    runtime: { running: null, queue: [], nextRunAt: {} }
  };

  const $ = id => document.getElementById(id);
  const PROPERTY_ICONS = { Y: 'hotel', M: 'landmark', D: 'tent-tree', H: 'tent' };
  const BASE_TITLE = document.title;
  let knownMatchKeys = null;

  const ico = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="/icons.svg#i-${name}"/></svg>`;

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  // ---------- Toasts, chime, browser notifications ----------
  function showToast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' toast-error' : ''}`;
    el.innerHTML = `${ico(type === 'error' ? 'circle-alert' : 'circle-check')}<span>${escapeHtml(msg)}</span>`;
    $('toastStack').appendChild(el);
    setTimeout(() => el.remove(), 4800);
  }
  window.UiToast = showToast;

  function playChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [587.33, 880, 1174.66].forEach((freq, i) => {
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
      // Audio is blocked until the user interacts with the page
    }
  }

  function updateBrowserNotificationUI() {
    const badge = $('browserPermBadge');
    const btn = $('btnEnableBrowser');
    if (!('Notification' in window)) {
      badge.textContent = 'Not supported';
      badge.className = 'badge badge-warn';
      btn.classList.add('hidden');
      return;
    }
    if (Notification.permission === 'granted') {
      badge.textContent = 'On';
      badge.className = 'badge badge-ok';
      btn.classList.add('hidden');
    } else if (Notification.permission === 'denied') {
      badge.textContent = 'Blocked';
      badge.className = 'badge badge-warn';
      btn.classList.add('hidden');
    } else {
      badge.textContent = 'Off';
      badge.className = 'badge';
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
      const n = new Notification(payload.title || 'Yosemite lodging alert', { body: payload.message || '' });
      if (payload.clickUrl) n.onclick = () => window.open(payload.clickUrl, '_blank');
    }
  }

  // ---------- Formatting ----------
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
    if (diffSec <= 5) return 'Checking shortly';
    const m = Math.floor(diffSec / 60);
    const s = diffSec % 60;
    return m > 0 ? `Next check in ${m}m ${s}s` : `Next check in ${s}s`;
  }

  function parseIso(iso) {
    return new Date(iso + 'T00:00:00Z');
  }

  function formatStay(checkIn, checkOut) {
    const a = parseIso(checkIn);
    const b = parseIso(checkOut);
    const nights = Math.round((b - a) / 86400000);
    const month = d => d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    const day = d => d.getUTCDate();
    const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
    const range = sameMonth
      ? `${month(a)} ${day(a)} – ${day(b)}, ${b.getUTCFullYear()}`
      : `${month(a)} ${day(a)} – ${month(b)} ${day(b)}, ${b.getUTCFullYear()}`;
    return { range, nights: plural(nights, 'night') };
  }

  // ---------- Rendering ----------
  function renderProgress() {
    const run = appState.runtime.running;
    const banner = $('progressBanner');
    banner.classList.toggle('is-active', Boolean(run));
    banner.setAttribute('aria-hidden', run ? 'false' : 'true');
    if (!run) return;
    $('progressWatchName').textContent = `Checking ${run.watchName || 'Yosemite'}`;
    $('progressDetail').textContent = run.propertyName
      ? `${run.propertyName} · ${run.segmentLabel}`
      : (run.segmentLabel || 'Starting…');
    const pct = run.totalSteps > 0 ? Math.round((run.step / run.totalSteps) * 100) : 8;
    $('progressCounter').textContent = run.totalSteps > 0 ? `${run.step} of ${run.totalSteps}` : 'Starting';
    $('progressFill').style.width = `${pct}%`;
  }

  function renderCountdown() {
    const el = $('heroCountdown');
    const today = new Date();
    const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const upcoming = appState.config.watches
      .filter(w => w.enabled)
      .map(w => ({ w, days: Math.round((parseIso(w.checkIn).getTime() - todayUtc) / 86400000) }))
      .filter(x => x.days >= 0)
      .sort((a, b) => a.days - b.days)[0];
    if (!upcoming) {
      el.classList.add('hidden');
      return;
    }
    const when = parseIso(upcoming.w.checkIn).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
    el.innerHTML = `${ico('sunrise')}<span><b>${upcoming.days}</b> ${upcoming.days === 1 ? 'day' : 'days'} until your Valley stay · ${escapeHtml(when)}</span>`;
    el.classList.remove('hidden');
  }

  // ---------- Rooms and booked nights ----------
  const addDay = (iso, n = 1) => {
    const d = parseIso(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const nightsBetween = (checkIn, checkOut) => {
    const out = [];
    for (let n = checkIn; n < checkOut; n = addDay(n)) out.push(n);
    return out;
  };
  const shortDay = iso => parseIso(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const roomsOf = watch => watch.roomSlots || [];
  const guestsText = room => `${plural(room.adults, 'adult')}${room.children > 0 ? `, ${plural(room.children, 'kid')}` : ''}`;

  // Rooms with the same guests share one search
  function partyGroups(watch) {
    const groups = new Map();
    for (const room of roomsOf(watch)) {
      const key = `${room.adults}-${room.children}`;
      if (!groups.has(key)) groups.set(key, { key, adults: room.adults, children: room.children, slots: [] });
      groups.get(key).slots.push(room);
    }
    return [...groups.values()];
  }
  const bookedInAll = slots => new Set(slots.length ? (slots[0].bookedNights || []).filter(n => slots.every(s => (s.bookedNights || []).includes(n))) : []);

  function allRoomsBooked(watch) {
    const total = nightsBetween(watch.checkIn, watch.checkOut).length;
    const rooms = roomsOf(watch);
    return total > 0 && rooms.length > 0 && rooms.every(r => (r.bookedNights || []).length >= total);
  }

  // The rooms an opening could still serve: same guests, and none of its nights booked yet
  function roomsForMatch(watch, match) {
    const nights = match.segmentKind === 'night' ? [match.checkIn] : nightsBetween(match.checkIn, match.checkOut);
    return roomsOf(watch).filter(room => {
      if (match.adults !== undefined && (room.adults !== match.adults || room.children !== match.children)) return false;
      return nights.every(n => !(room.bookedNights || []).includes(n));
    });
  }

  // Openings nobody still needs (because those nights are booked) are hidden
  const liveMatches = watch => (appState.state.watchResults[watch.id]?.matches || []).filter(m => roomsForMatch(watch, m).length > 0);

  async function setBooked(watchId, { nights, booked, roomId, partyKey }) {
    const res = await api(`/api/watches/${watchId}/booked`, { method: 'POST', body: JSON.stringify({ nights, booked, roomId, partyKey }) });
    await refreshFullState();
    const list = nights.map(shortDay).join(', ');
    const forRoom = res.watch.roomSlots.length > 1 ? ` for ${res.room.label}` : '';
    if (res.allBooked) showToast('Every room is booked for every night. This watch is paused. Enjoy the Valley!');
    else if (booked) showToast(`${list} marked as booked${forRoom}. We’ll stop looking for ${nights.length === 1 ? 'it' : 'them'}${forRoom ? '' : '.'}${forRoom ? ' there.' : ''}`);
    else showToast(`Back to watching ${list}${forRoom}.`);
  }

  function renderSummary() {
    $('statActiveWatches').textContent = String(appState.config.watches.filter(w => w.enabled).length);
    let totalMatches = 0;
    for (const w of appState.config.watches) totalMatches += liveMatches(w).length;
    $('statOpenings').textContent = String(totalMatches);
    renderCountdown();
    document.title = totalMatches > 0 ? `(${totalMatches}) ${BASE_TITLE}` : BASE_TITLE;
  }

  function segPill(seg, prop) {
    const short = seg.kind === 'full' ? 'Full stay' : seg.label.replace('Night of ', '');
    const full = seg.kind === 'full' ? ' seg-full' : '';
    if (seg.status === 'available') {
      return `<a class="seg open${full}" href="${escapeHtml(prop.bookingUrl)}" target="_blank" rel="noopener" title="Open on Yosemite’s reservation site">${ico('check')}${escapeHtml(short)}${seg.matchCount > 1 ? ` · ${seg.matchCount}` : ''}</a>`;
    }
    if (seg.status === 'error') {
      return `<span class="seg err${full}" title="${escapeHtml(seg.error || 'Temporary error')}">${ico('circle-alert')}${escapeHtml(short)}</span>`;
    }
    return `<span class="seg sold${full}">${ico('x')}${escapeHtml(short)}</span>`;
  }

  function currentMatchKeys() {
    const map = new Map();
    for (const w of appState.config.watches) map.set(w.id, new Set(liveMatches(w).map(m => m.key)));
    return map;
  }

  // Returns watch ids that gained an opening since the last render
  function detectNewOpenings() {
    const next = currentMatchKeys();
    const fresh = [];
    if (knownMatchKeys) {
      for (const [id, keys] of next) {
        const before = knownMatchKeys.get(id);
        if (before && [...keys].some(k => !before.has(k))) fresh.push(id);
      }
    }
    knownMatchKeys = next;
    return fresh;
  }

  function renderWatches() {
    const container = $('watchesContainer');
    const watches = appState.config.watches;
    const freshIds = detectNewOpenings();

    if (!watches.length) {
      container.innerHTML = `<div class="empty">${ico('radar')}<h3>No watches yet</h3><p>Add a watch request and we’ll start looking for Valley rooms right away.</p><button class="btn btn-primary" type="button" data-empty-new>${ico('plus')} New watch request</button></div>`;
      return;
    }

    container.innerHTML = watches.map(w => {
      const res = appState.state.watchResults[w.id];
      const matches = liveMatches(w);
      const isRunning = appState.runtime.running?.watchId === w.id;
      const isQueued = appState.runtime.queue.includes(w.id);
      const failure = appState.state.watchErrors?.[w.id];
      const stay = formatStay(w.checkIn, w.checkOut);
      const nights = nightsBetween(w.checkIn, w.checkOut);
      const rooms = roomsOf(w);
      const multiRoom = rooms.length > 1;
      const allBooked = allRoomsBooked(w);
      const trackNights = w.matchMode === 'both' && nights.length > 1;
      const groups = partyGroups(w);

      // One row of nights per needed room. A booked night is shown by its calendar-check icon alone.
      const nightsHtml = trackNights ? `
        <div class="nights">
          <div class="nights-head"><span class="lbl">Nights booked</span><span class="help">Booked one on Yosemite’s site? Tap that night${multiRoom ? ' under the room you booked' : ''} and we’ll stop looking for it.</span></div>
          <div class="night-rooms">${rooms.map(r => {
            const bookedSet = new Set(r.bookedNights || []);
            const who = multiRoom ? ` for ${r.label}` : '';
            return `
            <div class="night-room">
              ${multiRoom ? `<div class="night-room-name"><strong>${escapeHtml(r.label)}</strong><small>${escapeHtml(guestsText(r))}</small></div>` : ''}
              <div class="night-row">${nights.map(n => bookedSet.has(n)
                ? `<button type="button" class="night is-booked" data-action="unbook" data-id="${escapeHtml(w.id)}" data-room-id="${escapeHtml(r.id)}" data-night="${n}" aria-label="${escapeHtml(shortDay(n))}${who}: booked. Tap to undo." title="Booked. Tap to undo.">${ico('calendar-check')}<span>${escapeHtml(shortDay(n))}</span></button>`
                : `<button type="button" class="night" data-action="book" data-id="${escapeHtml(w.id)}" data-room-id="${escapeHtml(r.id)}" data-night="${n}" aria-label="Mark ${escapeHtml(shortDay(n))} as booked${escapeHtml(who)}" title="Mark as booked">${ico('calendar-days')}<span>${escapeHtml(shortDay(n))}</span></button>`).join('')}</div>
            </div>`;
          }).join('')}</div>
        </div>` : '';

      const failureHtml = failure ? `
        <div class="alert alert-warn" role="status">
          ${ico('triangle-alert')}
          <div><strong>The last check didn’t finish</strong> · ${escapeHtml(formatTimeAgo(failure.at))}<br /><span>${escapeHtml(failure.message)}${/keep trying|retry/i.test(failure.message) ? '' : ' We’ll retry automatically.'}</span></div>
        </div>` : '';
      const lastChecked = res?.checkedAt
        ? formatTimeAgo(res.checkedAt)
        : (failure ? 'never (still retrying)' : 'waiting for first check');
      // After a failed check, earlier openings are history, not live availability
      const stale = Boolean(failure && res?.checkedAt && new Date(res.checkedAt) < new Date(failure.at));

      const chips = [
        `<li class="chip">${ico('calendar-days')}<span><strong>${escapeHtml(stay.range)}</strong> · ${stay.nights}</span></li>`,
        `<li class="chip">${ico('users')}<span>${plural(rooms.length, 'room')} needed${groups.length === 1 ? ` · ${guestsText(rooms[0])}${multiRoom ? ' each' : ''}` : ''}</span></li>`,
        `<li class="chip">${ico('clock')}<span>Every ${w.intervalMinutes} min</span></li>`,
        w.excludeTents ? `<li class="chip chip-rule">${ico('ban')}<span>No tents</span></li>` : '',
        w.requirePrivateBath ? `<li class="chip chip-rule">${ico('shield-check')}<span>Private bath</span></li>` : '',
        w.maxPricePerNight ? `<li class="chip chip-rule">${ico('wallet')}<span>Up to $${w.maxPricePerNight}/night</span></li>` : '',
        `<li class="chip chip-rule">${ico('moon')}<span>${w.matchMode === 'both' ? 'Full stay + single nights' : 'Full stay only'}</span></li>`
      ].join('');

      const matchesHtml = matches.length > 0 ? `
        <div class="matches">
          <div class="matches-head">${ico('sparkles')}${stale
            ? `${plural(matches.length, 'opening')} from the last successful check · ${escapeHtml(formatTimeAgo(res.checkedAt))}`
            : `${plural(matches.length, 'opening')} available right now`}</div>
          <div class="match-grid">
            ${matches.map(m => {
              const matchNights = m.segmentKind === 'night' ? [m.checkIn] : nightsBetween(m.checkIn, m.checkOut);
              const serves = multiRoom ? roomsForMatch(w, m).map(r => r.label) : [];
              return `
              <div class="match">
                <span class="match-where">${escapeHtml(m.propertyName)} · ${escapeHtml(m.segmentLabel)}</span>
                <span class="match-room">${escapeHtml(m.roomName)}</span>
                ${serves.length ? `<span class="match-for">${ico('users')}For ${escapeHtml(serves.join(', '))}</span>` : ''}
                <div class="match-foot">
                  <span class="match-price">${escapeHtml(m.priceText || 'See rate')}<small> / night</small></span>
                  <span class="match-actions">
                    <button type="button" class="btn btn-ghost btn-sm" data-action="booked-match" data-id="${escapeHtml(w.id)}" data-nights="${matchNights.join(',')}" data-party-key="${escapeHtml(m.partyKey || '')}" data-room="${escapeHtml(m.roomName)}" data-for="${escapeHtml(serves[0] || '')}" title="Booked it? We’ll stop looking for ${matchNights.length === 1 ? 'this night' : 'these nights'}">${ico('calendar-check')} I booked it</button>
                    <a class="btn btn-primary btn-sm" href="${escapeHtml(m.bookingUrl)}" target="_blank" rel="noopener">Book now ${ico('external-link')}</a>
                  </span>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>` : '';

      // Results are kept per search (per group of guests); older saved results had a single set
      const partyResult = group => res?.parties
        ? res.parties.find(p => p.key === group.key)
        : (res ? { segmentStatus: res.segmentStatus, excludedCountByProperty: res.excludedCountByProperty } : null);

      const propsHtml = groups.map(group => {
        const pr = partyResult(group);
        const bookedAll = bookedInAll(group.slots);
        const boxes = w.properties.map(code => {
          const prop = appState.properties[code] || { name: code, bookingUrl: '#', description: '' };
          const segMap = pr?.segmentStatus?.[code] || {};
          const excluded = pr?.excludedCountByProperty?.[code] || 0;
          const ordered = [];
          const fullSeg = segMap[`${w.checkIn}:${w.checkOut}`];
          if (fullSeg) ordered.push(segPill(fullSeg, prop));
          if (w.matchMode === 'both') {
            for (const n of nights) {
              if (bookedAll.has(n)) {
                ordered.push(`<span class="seg booked" title="Booked" aria-label="${escapeHtml(shortDay(n))}: booked">${ico('calendar-check')}${escapeHtml(shortDay(n))}</span>`);
              } else if (segMap[`${n}:${addDay(n)}`]) {
                ordered.push(segPill(segMap[`${n}:${addDay(n)}`], prop));
              }
            }
          }
          const pills = ordered.length
            ? ordered.join('')
            : `<span class="seg wait">${failure ? 'No successful check yet' : 'Waiting for first check'}</span>`;
          return `
            <section class="prop">
              <div class="prop-head">
                <span class="prop-icon">${ico(PROPERTY_ICONS[code] || 'bed-double')}</span>
                <div class="prop-titles">
                  <span class="prop-name">${escapeHtml(prop.name)}</span>
                  <span class="prop-desc">${escapeHtml(prop.location || '')}</span>
                </div>
                <a class="prop-link" href="${escapeHtml(prop.bookingUrl)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(prop.name)} on the official reservation site" title="Open official page">${ico('external-link')}</a>
              </div>
              <div class="segs">${pills}</div>
              ${excluded > 0 ? `<p class="prop-foot">${ico('ban')}${plural(excluded, 'unit')} filtered out by your rules</p>` : ''}
            </section>`;
        }).join('');
        const heading = groups.length > 1
          ? `<h4 class="party-head">${ico('users')}<span>${escapeHtml(guestsText(group))}</span><small>${escapeHtml(group.slots.map(s => s.label).join(', '))}</small></h4>`
          : '';
        return `<div class="party">${heading}<div class="props">${boxes}</div></div>`;
      }).join('');

      const nextText = isRunning ? 'Checking now' : isQueued ? 'Queued next'
        : (w.enabled ? (appState.runtime.nextRunAt[w.id] ? formatCountdown(appState.runtime.nextRunAt[w.id]) : 'Scheduling next check') : 'Paused');

      return `
        <article class="watch${w.enabled ? '' : ' is-paused'}${allBooked ? ' is-complete' : ''}${matches.length > 0 ? ' has-matches' : ''}" data-watch-id="${escapeHtml(w.id)}">
          <header class="watch-head">
            <div class="watch-titles">
              <h3 class="watch-title">${escapeHtml(w.name)}</h3>
              ${allBooked
                ? `<span class="badge badge-booked" title="Every room is booked for every night" aria-label="All rooms booked">${ico('calendar-check')}</span>`
                : `<span class="badge ${w.enabled ? 'badge-active' : 'badge-paused'}">${w.enabled ? 'Active' : 'Paused'}</span>`}
            </div>
            <div class="watch-actions">
              <button class="btn btn-secondary btn-sm btn-keep-label" data-action="check" data-id="${escapeHtml(w.id)}" ${isRunning ? 'disabled' : ''}>${ico('refresh-cw')}<span class="btn-label">${isRunning ? 'Checking…' : 'Check now'}</span></button>
              <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${escapeHtml(w.id)}" aria-label="Edit" title="Edit">${ico('pencil')}<span class="btn-label">Edit</span></button>
              <button class="btn btn-ghost btn-sm" data-action="link" data-id="${escapeHtml(w.id)}" aria-label="Copy a link straight to this watch’s settings" title="Copy a link straight to this watch’s settings">${ico('link')}<span class="btn-label">Link</span></button>
              <button class="btn btn-ghost btn-sm" data-action="toggle" data-id="${escapeHtml(w.id)}" aria-label="${w.enabled ? 'Pause' : 'Resume'}" title="${w.enabled ? 'Pause' : 'Resume'}">${ico(w.enabled ? 'pause' : 'play')}<span class="btn-label">${w.enabled ? 'Pause' : 'Resume'}</span></button>
              <button class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(w.id)}" aria-label="Delete" title="Delete">${ico('trash-2')}<span class="btn-label">Delete</span></button>
            </div>
          </header>

          <ul class="chips">${chips}</ul>
          ${w.notes ? `<p class="watch-note">${escapeHtml(w.notes)}</p>` : ''}
          ${nightsHtml}
          ${failureHtml}
          ${matchesHtml}
          ${propsHtml}

          <footer class="watch-foot">
            <span>${ico('refresh-cw')}Last checked <strong>${escapeHtml(lastChecked)}</strong></span>
            <span>${ico('clock')}${escapeHtml(nextText)}</span>
          </footer>
        </article>`;
    }).join('');

    for (const id of freshIds) {
      const card = container.querySelector(`[data-watch-id="${CSS.escape(id)}"]`);
      if (!card) continue;
      card.classList.add('just-found');
      card.addEventListener('animationend', () => card.classList.remove('just-found'), { once: true });
    }
  }

  function renderHistory() {
    const container = $('historyContainer');
    const items = appState.state.alertHistory || [];
    if (!items.length) {
      container.innerHTML = `<div class="empty">${ico('bell-ring')}<h3>No alerts yet</h3><p>Use <strong>Send test alert</strong> in Alerts to make sure your phone and desktop light up.</p></div>`;
      return;
    }
    container.innerHTML = `<ol class="timeline">${items.slice(0, 25).map(item => `
      <li class="tl-item">
        <span class="tl-dot${item.matchCount > 0 ? ' is-open' : ''}">${ico(item.matchCount > 0 ? 'sparkles' : 'bell-ring')}</span>
        <div class="tl-body">
          <div class="tl-top">
            <strong>${escapeHtml(item.title)}</strong>
            <span class="tl-time">${new Date(item.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </div>
          <p class="tl-msg">${escapeHtml(item.message)}</p>
          ${item.bookingUrl ? `<a class="tl-link" href="${escapeHtml(item.bookingUrl)}" target="_blank" rel="noopener">Open the booking page ${ico('external-link')}</a>` : ''}
        </div>
      </li>`).join('')}</ol>`;
  }

  function renderAll() {
    renderProgress();
    renderSummary();
    renderWatches();
    renderHistory();
  }

  function setLive(connected) {
    const pill = $('connectionStatus');
    pill.classList.toggle('is-off', !connected);
    pill.innerHTML = `<span class="live-dot"></span>${connected ? 'Live' : 'Reconnecting'}`;
  }

  // ---------- Modals ----------
  function openModal(id) {
    $(id).classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeModal(id) {
    $(id).classList.add('hidden');
    if (!document.querySelector('.modal:not(.hidden)')) document.body.style.overflow = '';
    if (id === 'watchModal') clearWatchHash();
  }

  // ---------- Deep links: #/watch/<id> opens that watch's settings ----------
  const watchHash = id => `#/watch/${encodeURIComponent(id)}`;
  const watchUrl = id => `${location.origin}${location.pathname}${watchHash(id)}`;

  function clearWatchHash() {
    if (location.hash.startsWith('#/watch/')) history.replaceState(null, '', location.pathname + location.search);
  }

  function routeFromHash() {
    const match = location.hash.match(/^#\/watch\/(.+)$/);
    if (!match) return;
    const watch = appState.config.watches.find(w => w.id === decodeURIComponent(match[1]));
    if (!watch) {
      showToast('That watch request no longer exists', 'error');
      clearWatchHash();
      return;
    }
    openWatchEditor(watch, { fromHash: true });
  }

  function renderPropertyCheckboxes(selectedCodes) {
    const selected = new Set(selectedCodes || ['Y', 'M', 'D']);
    $('wfPropertiesGrid').innerHTML = Object.values(appState.properties).map(p => `
      <label class="pick">
        <input type="checkbox" name="wfProps" value="${escapeHtml(p.code)}" ${selected.has(p.code) ? 'checked' : ''} />
        <span class="pick-card">
          <span class="pick-icon">${ico(PROPERTY_ICONS[p.code] || 'bed-double')}</span>
          <span class="pick-name">${escapeHtml(p.name)}</span>
          <span class="pick-desc">${escapeHtml(p.description)}</span>
          ${ico('check', 'pick-check')}
        </span>
      </label>`).join('');
  }

  // ---------- Rooms needed (editor) ----------
  const MAX_ROOMS = 6;
  let editorRooms = [];

  function renderEditorRooms() {
    $('wfRoomCount').textContent = String(editorRooms.length);
    $('wfRoomMinus').disabled = editorRooms.length <= 1;
    $('wfRoomPlus').disabled = editorRooms.length >= MAX_ROOMS;
    $('wfRoomsList').innerHTML = editorRooms.map((room, i) => `
      <div class="room-row" data-index="${i}">
        <div class="field"><label class="lbl" for="wfRoomLabel${i}">${i === 0 ? 'Name' : '&nbsp;'}</label>
          <input id="wfRoomLabel${i}" class="control" data-field="label" type="text" maxlength="30" value="${escapeHtml(room.label)}" placeholder="Room ${i + 1}" aria-label="Room ${i + 1} name" /></div>
        <div class="field"><label class="lbl" for="wfRoomAdults${i}">${i === 0 ? 'Adults' : '&nbsp;'}</label>
          <input id="wfRoomAdults${i}" class="control" data-field="adults" type="number" min="1" max="9" value="${room.adults}" aria-label="Room ${i + 1} adults" /></div>
        <div class="field"><label class="lbl" for="wfRoomKids${i}">${i === 0 ? 'Kids' : '&nbsp;'}</label>
          <input id="wfRoomKids${i}" class="control" data-field="children" type="number" min="0" max="9" value="${room.children}" aria-label="Room ${i + 1} kids" /></div>
      </div>`).join('');
  }

  function setEditorRooms(rooms) {
    editorRooms = rooms.map(r => ({ id: r.id, label: r.label || '', adults: r.adults ?? 2, children: r.children ?? 0 }));
    renderEditorRooms();
  }

  function changeRoomCount(delta) {
    if (delta > 0 && editorRooms.length < MAX_ROOMS) {
      const last = editorRooms[editorRooms.length - 1] || { adults: 2, children: 2 };
      editorRooms.push({ label: '', adults: last.adults, children: last.children });
    } else if (delta < 0 && editorRooms.length > 1) {
      editorRooms.pop();
    }
    renderEditorRooms();
  }

  function openWatchEditor(watch = null, { fromHash = false } = {}) {
    $('wfError').classList.add('hidden');
    $('watchModalTitle').textContent = watch ? 'Edit watch request' : 'New watch request';
    if (watch && !fromHash) history.replaceState(null, '', watchHash(watch.id));
    if (!watch) clearWatchHash();
    $('wfId').value = watch?.id || '';
    $('wfName').value = watch?.name || '';
    $('wfCheckIn').value = watch?.checkIn || '2027-06-07';
    $('wfCheckOut').value = watch?.checkOut || '2027-06-11';
    setEditorRooms(watch?.roomSlots?.length ? watch.roomSlots : [{ label: '', adults: 2, children: 2 }]);
    $('wfExcludeTents').checked = watch ? Boolean(watch.excludeTents) : true;
    $('wfRequireBath').checked = watch ? Boolean(watch.requirePrivateBath) : true;
    $('wfMatchMode').value = watch?.matchMode || 'both';
    $('wfInterval').value = String(watch?.intervalMinutes || 10);
    $('wfMaxPrice').value = watch?.maxPricePerNight ?? '';
    $('wfNotes').value = watch?.notes || '';
    $('wfCheckNow').checked = true;
    renderPropertyCheckboxes(watch?.properties || ['Y', 'M', 'D']);
    openModal('watchModal');
    setTimeout(() => $('wfName').focus(), 50);
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

  // ---------- API ----------
  async function api(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 || data.code === 'PASSKEY_SETUP_REQUIRED') {
        window.location.reload();
      }
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
      if (res.delivery?.ntfy?.sent) parts.push('Phone alert sent');
      else if (res.delivery?.ntfy?.error) parts.push(`Phone alert failed: ${res.delivery.ntfy.error}`);
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
      showToast('Test alert failed: ' + err.message, 'error');
    }
  }

  // ---------- Events ----------
  function bindEvents() {
    $('btnNewWatch').addEventListener('click', () => openWatchEditor(null));
    $('wfRoomMinus').addEventListener('click', () => changeRoomCount(-1));
    $('wfRoomPlus').addEventListener('click', () => changeRoomCount(1));
    $('wfRoomsList').addEventListener('input', e => {
      const row = e.target.closest('.room-row');
      const field = e.target.getAttribute('data-field');
      if (!row || !field) return;
      editorRooms[Number(row.dataset.index)][field] = e.target.value;
    });
    $('btnAlertsSettings').addEventListener('click', openAlertsEditor);
    $('btnEnableBrowser').addEventListener('click', requestBrowserNotifications);
    $('btnTestAlertModal').addEventListener('click', () => sendTestAlert($('afFeedback')));

    $('btnCheckAll').addEventListener('click', async () => {
      try {
        await api('/api/check-all', { method: 'POST' });
        showToast('Checking every active watch now');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('btnClearHistory').addEventListener('click', async () => {
      await api('/api/alerts/history', { method: 'DELETE' });
      appState.state.alertHistory = [];
      renderHistory();
    });

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close-modal')));
    });
    ['alertsModal', 'accountsModal'].forEach(id => {
      $(id).addEventListener('mousedown', e => { if (e.target === $(id)) closeModal(id); });
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach(m => closeModal(m.id));
    });

    $('watchesContainer').addEventListener('click', async e => {
      if (e.target.closest('[data-empty-new]')) return openWatchEditor(null);
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      const watch = appState.config.watches.find(w => w.id === id);
      if (!watch) return;

      try {
        if (action === 'edit') {
          openWatchEditor(watch);
        } else if (action === 'link') {
          await navigator.clipboard?.writeText(watchUrl(watch.id)).catch(() => {});
          showToast(`Link copied. It opens “${watch.name}” directly.`);
        } else if (action === 'book' || action === 'booked-match') {
          const nights = action === 'book' ? [btn.getAttribute('data-night')] : btn.getAttribute('data-nights').split(',');
          const list = nights.map(shortDay).join(', ');
          const room = roomsOf(watch).find(r => r.id === btn.getAttribute('data-room-id'));
          const forRoom = action === 'book' ? room?.label : btn.getAttribute('data-for');
          const multiRoom = roomsOf(watch).length > 1;
          const ok = await UiDialog.confirm({
            title: nights.length === 1 ? `Mark ${list} as booked?` : `Mark ${nights.length} nights as booked?`,
            message: (action === 'booked-match' ? `You booked ${btn.getAttribute('data-room')}. ` : '')
              + (multiRoom && forRoom ? `We’ll record it for ${forRoom} and stop looking for ${list} for that room. ` : `We’ll stop looking for ${list}. `)
              + 'You can undo this anytime.',
            confirmLabel: 'Yes, it’s booked', icon: 'calendar-check'
          });
          if (ok) {
            await setBooked(id, {
              nights, booked: true,
              roomId: room?.id,
              partyKey: action === 'booked-match' ? btn.getAttribute('data-party-key') || undefined : undefined
            });
          }
        } else if (action === 'unbook') {
          await setBooked(id, { nights: [btn.getAttribute('data-night')], booked: false, roomId: btn.getAttribute('data-room-id') });
        } else if (action === 'check') {
          await api(`/api/watches/${id}/check`, { method: 'POST' });
          showToast(`Checking “${watch.name}”`);
        } else if (action === 'toggle') {
          await api(`/api/watches/${id}`, { method: 'PUT', body: JSON.stringify({ ...watch, enabled: !watch.enabled }) });
          showToast(watch.enabled ? `Paused “${watch.name}”` : `Resumed “${watch.name}”`);
          await refreshFullState();
        } else if (action === 'delete') {
          const ok = await UiDialog.confirm({
            title: 'Delete this watch?',
            message: `“${watch.name}” and its check history will be removed. This can’t be undone.`,
            confirmLabel: 'Delete watch', danger: true, icon: 'trash-2'
          });
          if (!ok) return;
          await api(`/api/watches/${id}`, { method: 'DELETE' });
          showToast(`Deleted “${watch.name}”`);
          await refreshFullState();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('watchForm').addEventListener('submit', async e => {
      e.preventDefault();
      $('wfError').classList.add('hidden');
      const id = $('wfId').value.trim();
      const props = [...document.querySelectorAll('input[name="wfProps"]:checked')].map(el => el.value);
      const payload = {
        name: $('wfName').value.trim(),
        checkIn: $('wfCheckIn').value,
        checkOut: $('wfCheckOut').value,
        roomSlots: editorRooms.map(r => ({ id: r.id, label: r.label.trim(), adults: Number(r.adults), children: Number(r.children) })),
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
          showToast('Watch request updated');
        } else {
          await api('/api/watches', { method: 'POST', body: JSON.stringify(payload) });
          showToast('Watch request added');
        }
        closeModal('watchModal');
        await refreshFullState();
      } catch (err) {
        $('wfError').textContent = err.message;
        $('wfError').classList.remove('hidden');
      }
    });

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
        $('afFeedback').textContent = 'Alert settings saved.';
        $('afFeedback').classList.remove('hidden');
        showToast('Alert settings saved');
        await refreshFullState();
      } catch (err) {
        showToast('Could not save alerts: ' + err.message, 'error');
      }
    });
  }

  let eventSource = null;
  let streamWasDown = false;

  function connectEvents() {
    if (eventSource) eventSource.close();
    const es = new EventSource('/api/events');
    eventSource = es;
    es.addEventListener('open', () => {
      setLive(true);
      // Catch up on anything that happened while the stream was down
      if (streamWasDown) refreshFullState().catch(() => {});
      streamWasDown = false;
    });
    es.addEventListener('error', () => {
      setLive(false);
      streamWasDown = true;
      // The browser gives up on some failures; start a fresh connection ourselves
      if (es.readyState === EventSource.CLOSED) setTimeout(connectEvents, 5000);
    });
    es.addEventListener('progress', e => {
      appState.runtime.running = JSON.parse(e.data);
      renderProgress();
      renderWatches();
    });
    es.addEventListener('watchError', e => {
      const data = JSON.parse(e.data);
      appState.state.watchErrors = { ...appState.state.watchErrors, [data.watchId]: { message: data.message, at: data.at } };
      renderWatches();
    });
    es.addEventListener('watchResult', e => {
      const data = JSON.parse(e.data);
      appState.state.watchResults[data.watchId] = data.result;
      if (appState.state.watchErrors) delete appState.state.watchErrors[data.watchId];
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
      showToast(payload.title || 'Yosemite opening found');
      refreshFullState();
    });
    es.addEventListener('historyCleared', () => {
      appState.state.alertHistory = [];
      renderHistory();
    });
  }

  // Keep countdowns fresh
  setInterval(() => { if (!$('appShell').classList.contains('hidden')) renderWatches(); }, 10000);

  // Safety net: re-sync when the tab wakes up and once a minute, in case the live stream stalls
  const resync = () => {
    if (!$('appShell').classList.contains('hidden')) refreshFullState().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
  setInterval(() => { if (!document.hidden) resync(); }, 60000);

  updateBrowserNotificationUI();
  bindEvents();

  // Load protected data only after sign-in, then honor a deep link if one was opened
  window.addEventListener('hashchange', () => {
    if ($('appShell').classList.contains('hidden')) return;
    if (location.hash.startsWith('#/watch/')) routeFromHash();
    else if (!$('watchModal').classList.contains('hidden')) closeModal('watchModal');
  });
  window.YosemiteAuth.boot(() => {
    refreshFullState().then(routeFromHash);
    connectEvents();
  });
})();
