/**
 * Scenes: photography, credits and light/dark theme for the whole app.
 * Photos are from Wikimedia Commons (licenses shown in the page footer); all are resized and compressed.
 */
(() => {
  const CC3 = 'https://creativecommons.org/licenses/by-sa/3.0/';
  const CC4 = 'https://creativecommons.org/licenses/by-sa/4.0/';
  const commons = file => 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file.replace(/ /g, '_'));

  const SCENES = [
    { id: 'tunnel-view', tone: 'day', title: 'Tunnel View', author: 'Diliff', license: 'CC BY-SA 3.0', licenseUrl: CC3,
      page: commons('Tunnel View, Yosemite Valley, Yosemite NP - Diliff.jpg'), color: '#808983', heroPos: '50% 62%', gatePos: '50% 55%' },
    { id: 'glacier-sunset', tone: 'day', title: 'Glacier Point at sunset', author: 'Diliff', license: 'CC BY-SA 3.0', licenseUrl: CC3,
      page: commons('Glacier Point at Sunset, Yosemite NP, CA, US - Diliff.jpg'), color: '#707476', heroPos: '52% 40%', gatePos: '50% 40%' },
    { id: 'half-dome-glow', tone: 'day', title: 'Half Dome at alpenglow', author: 'Diliff', license: 'CC BY-SA 3.0', licenseUrl: CC3,
      page: commons('Half Dome from Glacier Point, Yosemite NP - Diliff.jpg'), color: '#7b7d81', heroPos: '50% 34%', gatePos: '55% 40%' },
    { id: 'valley-view', tone: 'day', title: 'Valley View along the Merced', author: 'King of Hearts', license: 'CC BY-SA 3.0', licenseUrl: CC3,
      page: commons('Valley View Yosemite August 2013 002.jpg'), color: '#5d6e57', heroPos: '50% 36%', gatePos: '50% 45%' },
    { id: 'night-el-capitan', tone: 'night', title: 'El Capitan after dusk', author: 'C-M', license: 'CC BY-SA 4.0', licenseUrl: CC4,
      page: commons('Yosemite night elcapitan climbers.jpg'), color: '#3e3874', heroPos: '50% 28%', gatePos: '45% 40%' },
    { id: 'yosemite-falls', tone: 'footer', title: 'Upper Yosemite Fall', author: 'Diliff', license: 'CC BY-SA 3.0', licenseUrl: CC3,
      page: commons('Yosemite Falls from trail, Yosemite NP, CA, US - Diliff.jpg'), color: '#687772', heroPos: '50% 45%', gatePos: '50% 45%' }
  ];

  const byId = Object.fromEntries(SCENES.map(s => [s.id, s]));
  const THEME_KEY = 'yosemite-theme';
  const SCENE_KEY = 'yosemite-scene';

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  // One day scene per browser session so the sign-in photo and the hero feel like one visit.
  function pickScene(theme) {
    if (theme === 'dark') return byId['night-el-capitan'];
    const days = SCENES.filter(s => s.tone === 'day');
    let id = null;
    try { id = sessionStorage.getItem(SCENE_KEY); } catch { /* storage unavailable */ }
    if (!id || !byId[id] || byId[id].tone !== 'day') {
      id = days[Math.floor(Math.random() * days.length)].id;
      try { sessionStorage.setItem(SCENE_KEY, id); } catch { /* storage unavailable */ }
    }
    return byId[id];
  }

  function paint(img, scene, position) {
    if (!img) return;
    img.classList.remove('is-ready');
    img.closest('.scene')?.style.setProperty('--scene-color', scene.color);
    img.style.objectPosition = position;
    img.srcset = `/img/${scene.id}-1200.webp 1200w, /img/${scene.id}-2000.webp 2000w`;
    img.sizes = '100vw';
    img.src = `/img/${scene.id}-1200.webp`;
    const ready = () => img.classList.add('is-ready');
    if (img.complete && img.naturalWidth) requestAnimationFrame(ready);
    else img.addEventListener('load', ready, { once: true });
  }

  function credit(el, scene) {
    if (!el) return;
    el.href = scene.page;
    el.title = `${scene.title} by ${scene.author} (${scene.license}) via Wikimedia Commons`;
    el.querySelector('.photo-credit-text').textContent = `${scene.title} · ${scene.author}`;
  }

  function applyScenes() {
    const scene = pickScene(currentTheme());
    paint(document.getElementById('gateScene'), scene, scene.gatePos);
    paint(document.getElementById('heroScene'), scene, scene.heroPos);
    credit(document.getElementById('gateCredit'), scene);
    credit(document.getElementById('heroCredit'), scene);
    const falls = byId['yosemite-falls'];
    const footImg = document.getElementById('footScene');
    if (footImg && !footImg.dataset.ready) {
      footImg.dataset.ready = '1';
      paint(footImg, falls, falls.heroPos);
    }
  }

  function setTheme(theme, persist = true) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ } }
    document.querySelectorAll('.js-theme-toggle').forEach(btn => {
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', `/icons.svg#i-${theme === 'dark' ? 'sun' : 'moon'}`);
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    });
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1310' : '#2e5c45');
    applyScenes();
  }

  function renderCredits() {
    const list = document.getElementById('creditsList');
    if (!list) return;
    list.innerHTML = SCENES.map(s => `<li><a href="${s.page}" target="_blank" rel="noopener">${s.title}</a> by ${s.author} · <a href="${s.licenseUrl}" target="_blank" rel="noopener">${s.license}</a></li>`).join('');
  }

  function init() {
    document.querySelectorAll('.js-theme-toggle').forEach(btn => {
      btn.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
    });
    renderCredits();
    setTheme(currentTheme(), false);
  }

  window.YosemiteScenes = { init, setTheme };
  document.addEventListener('DOMContentLoaded', init);
})();
