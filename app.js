/* ── JENKINS — app.js ─────────────────────────────────────────────────────── */

// ── Default endpoint config ───────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  lmstudio: { url: 'http://100.71.100.103:1234' },
  ollama:   { url: 'http://10.201.52.200:11434' },
  litellm:  { url: 'http://10.201.52.200:4000' },
  proxmox:  { url: 'https://10.201.52.200:8006', user: 'root@pam', password: '', token: '' },
  truenas:  { url: 'http://10.201.52.170', apikey: '' },
  jellyfin: { url: 'http://10.201.52.207:8096', apikey: '' },
};

function loadConfig() {
  try {
    const stored = localStorage.getItem('jenkins_config');
    if (!stored) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    // Deep merge so new fields in DEFAULT_CONFIG get picked up
    const parsed = JSON.parse(stored);
    const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    for (const svc of Object.keys(merged)) {
      if (parsed[svc]) Object.assign(merged[svc], parsed[svc]);
    }
    return merged;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function persistConfig() {
  localStorage.setItem('jenkins_config', JSON.stringify(config));
}

let config = loadConfig();

// ── Preloader ─────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  setTimeout(() => {
    const preloader = document.getElementById('preloader');
    document.body.classList.remove('is-loading');
    preloader.classList.add('is-done');
    initAnimations();
    initStarField();
    startPolling();
    updateClock();
    setInterval(updateClock, 1000);
  }, 1100);
});

// ── Star Field ────────────────────────────────────────────────────────────────
function initStarField() {
  const canvas = document.getElementById('starField');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let W, H, stars = [], animId;

  function resize() {
    W = canvas.width  = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }

  function mkStars(n = 200) {
    stars = Array.from({ length: n }, () => ({
      x:  Math.random() * W,
      y:  Math.random() * H,
      r:  Math.random() * 1.3 + 0.2,
      a:  Math.random() * 0.65 + 0.1,
      dv: Math.random() * 0.018 + 0.004,
      ph: Math.random() * Math.PI * 2,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.ph += s.dv;
      const alpha = s.a * (0.45 + 0.55 * Math.sin(s.ph));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(240,237,232,${alpha})`;
      ctx.fill();
    }
    animId = requestAnimationFrame(draw);
  }

  resize();
  mkStars();
  draw();

  window.addEventListener('resize', () => {
    cancelAnimationFrame(animId);
    resize();
    mkStars();
    draw();
  });
}

// ── GSAP Animations ───────────────────────────────────────────────────────────
function initAnimations() {
  if (typeof gsap === 'undefined') {
    document.querySelectorAll(
      '.section-hero__eyebrow, .section-hero__title .word, .section-hero__desc, ' +
      '.section-hero__decoration, .section-hero__scroll, ' +
      '.stack-card, .status-card, .about-stat'
    ).forEach(el => { el.style.opacity = '1'; el.style.transform = 'none'; });
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  const tl = gsap.timeline({ delay: 0.15 });
  tl
    .to('.section-hero__eyebrow', { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' })
    .to('.section-hero__title .word', { opacity: 1, y: 0, duration: 0.9, stagger: 0.14, ease: 'power3.out' }, '-=0.45')
    .to('.section-hero__desc',        { opacity: 1, duration: 0.7, ease: 'power2.out' }, '-=0.3')
    .to('.section-hero__decoration',  { opacity: 1, duration: 1.2, ease: 'power2.out' }, '-=0.75')
    .to('.section-hero__scroll',      { opacity: 1, duration: 0.5, ease: 'power2.out' }, '-=0.2');

  gsap.utils.toArray('.stack-card').forEach((card, i) => {
    gsap.to(card, { opacity: 1, y: 0, duration: 0.75, ease: 'power3.out', delay: i * 0.08,
      scrollTrigger: { trigger: card, start: 'top 88%' } });
  });

  gsap.utils.toArray('.status-card').forEach((card, i) => {
    gsap.to(card, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', delay: i * 0.07,
      scrollTrigger: { trigger: card, start: 'top 92%' } });
  });

  gsap.utils.toArray('.about-stat').forEach((stat, i) => {
    gsap.to(stat, { opacity: 1, x: 0, duration: 0.7, ease: 'power3.out', delay: i * 0.1,
      scrollTrigger: { trigger: stat, start: 'top 88%' } });
  });

  window.addEventListener('scroll', () => {
    document.getElementById('siteHeader').classList.toggle('is-scrolled', window.scrollY > 40);
  }, { passive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripProto(url) {
  return url.replace(/^https?:\/\//, '');
}

function errMsg(e, url) {
  if (e instanceof TypeError) return 'CORS blocked — needs proxy';
  if (e.message?.includes('401') || e.message?.includes('403')) return 'Auth failed — check credentials';
  return `Unreachable (${stripProto(url)})`;
}

// ── Status card helpers ───────────────────────────────────────────────────────
function setStatus(id, state, detail, endpoint) {
  const ind  = document.getElementById(`ind-${id}`);
  const det  = document.getElementById(`detail-${id}`);
  const ep   = document.getElementById(`ep-${id}`);
  const card = document.getElementById(`card-${id}`);

  if (ind)  ind.className = `status-indicator ${state}`;
  if (det  && detail   !== undefined) det.textContent  = detail;
  if (ep   && endpoint !== undefined) ep.textContent   = endpoint;
  if (card) {
    card.classList.remove('is-online', 'is-offline', 'is-unknown');
    if (state === 'online')        card.classList.add('is-online');
    else if (state === 'offline')  card.classList.add('is-offline');
    else                           card.classList.add('is-unknown');
  }
}

// ── LM Studio model list ──────────────────────────────────────────────────────
function renderModelList(models) {
  const container = document.getElementById('models-lmstudio');
  if (!container) return;
  if (!models.length) { container.innerHTML = ''; return; }

  // Normalise: LM Studio native vs OpenAI-compat shapes
  const norm = models.map(m => ({
    id:     m.id || m.path?.split(/[\\/]/).pop() || 'unknown',
    loaded: m.state === 'loaded' || m.loaded === true || m.status === 'loaded',
  }));

  // Sort: loaded first
  norm.sort((a, b) => b.loaded - a.loaded);

  const MAX = 10;
  const shown = norm.slice(0, MAX);
  const extra = norm.length - MAX;

  container.innerHTML =
    shown.map(m => `
      <div class="model-item${m.loaded ? ' is-loaded' : ''}">
        <div class="model-dot${m.loaded ? ' active' : ''}"></div>
        <span class="model-name" title="${m.id}">${m.id}</span>
        ${m.loaded
          ? `<span class="model-badge">loaded</span>`
          : `<button class="model-load-btn" onclick="loadModel('${m.id.replace(/'/g, "\\'")}')">load</button>`
        }
      </div>`).join('') +
    (extra > 0 ? `<div class="model-more">+${extra} more</div>` : '');
}

async function loadModel(identifier) {
  const base = config.lmstudio.url || 'http://100.71.100.103:1234';

  const btn = [...document.querySelectorAll('.model-load-btn')]
    .find(b => b.onclick?.toString().includes(identifier));
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  try {
    await fetch(`${base}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
      signal: AbortSignal.timeout(15000),
    });
  } catch { /* ignore — model load can be slow */ }

  // Refresh status after a short delay (model loading is async on server side)
  setTimeout(() => refreshService('lmstudio'), 2000);
}
window.loadModel = loadModel;

// ── Service checks ────────────────────────────────────────────────────────────

async function checkLMStudio() {
  const { url } = config.lmstudio;
  const display = url ? stripProto(url) : '100.71.100.103:1234';
  const base = url || 'http://100.71.100.103:1234';

  setStatus('lmstudio', 'loading', 'Connecting…', display);
  const mlContainer = document.getElementById('models-lmstudio');
  if (mlContainer) mlContainer.innerHTML = '';

  try {
    // Use the native LM Studio API endpoint via proxy
    const res = await fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Accept both array and {data:[...]} shapes
    const models = Array.isArray(data) ? data : (data.data || []);
    const loaded  = models.filter(m =>
      m.state === 'loaded' || m.loaded === true || m.status === 'loaded'
    );

    const detail = loaded.length > 0
      ? `${loaded.length} loaded · ${models.length} available`
      : `${models.length} model${models.length !== 1 ? 's' : ''} available`;

    setStatus('lmstudio', 'online', detail, display);
    renderModelList(models);
  } catch (e) {
    setStatus('lmstudio', 'offline', errMsg(e, base), display);
  }
}

async function checkOllama() {
  const { url } = config.ollama;
  if (!url) { setStatus('ollama', 'unknown', 'Not configured', '—'); return; }

  setStatus('ollama', 'loading', 'Connecting…', stripProto(url));
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = data.models || [];
    setStatus('ollama', 'online',
      `${models.length} model${models.length !== 1 ? 's' : ''} available`,
      stripProto(url));
  } catch (e) {
    setStatus('ollama', 'offline', errMsg(e, url), stripProto(url));
  }
}

async function checkLiteLLM() {
  const PROXY = 'http://10.201.52.171:8040/proxy/litellm';
  const { url } = config.litellm;
  const display = url ? stripProto(url) : '10.201.52.200:4000';

  setStatus('litellm', 'loading', 'Connecting…', display);
  try {
    const res = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus('litellm', 'online', 'Proxy healthy', display);
  } catch (e) {
    setStatus('litellm', 'offline', errMsg(e, PROXY), display);
  }
}

async function checkProxmox() {
  const PROXY = 'http://10.201.52.171:8040/proxy/proxmox';
  setStatus('proxmox', 'loading', 'Connecting…', '10.201.52.200:8006');
  try {
    const res = await fetch(`${PROXY}/nodes`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const nodes  = data.data || [];
    const online = nodes.filter(n => n.status === 'online').length;
    setStatus('proxmox', 'online',
      `${online}/${nodes.length} node${nodes.length !== 1 ? 's' : ''} online`,
      '10.201.52.200:8006');
  } catch {
    setStatus('proxmox', 'offline', 'Unreachable', '10.201.52.200:8006');
  }
}

async function checkTrueNAS() {
  const PROXY = 'http://10.201.52.171:8040/proxy/truenas';
  setStatus('truenas', 'loading', 'Connecting…', '10.201.52.170');
  try {
    const res = await fetch(`${PROXY}/pool`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pools   = await res.json();
    const healthy = pools.filter(p => p.healthy).length;
    setStatus('truenas', 'online',
      `${pools.length} pool${pools.length !== 1 ? 's' : ''} — ${healthy} healthy`,
      '10.201.52.170');
  } catch {
    setStatus('truenas', 'offline', 'Unreachable', '10.201.52.170');
  }
}

async function checkJellyfin() {
  const { url, apikey } = config.jellyfin;
  if (!url)    { setStatus('jellyfin', 'unknown', 'Click ⚙ to configure', 'Not configured'); return; }
  if (!apikey) { setStatus('jellyfin', 'unknown', 'Needs API key', stripProto(url)); return; }

  setStatus('jellyfin', 'loading', 'Connecting…', stripProto(url));
  try {
    const headers = { 'X-Emby-Token': apikey };
    const [infoRes, sessRes] = await Promise.all([
      fetch(`${url}/System/Info`, { headers, signal: AbortSignal.timeout(6000) }),
      fetch(`${url}/Sessions`,    { headers, signal: AbortSignal.timeout(6000) }),
    ]);
    if (!infoRes.ok) throw new Error(`HTTP ${infoRes.status}`);
    const sessions = sessRes.ok ? await sessRes.json() : [];
    const playing  = sessions.filter(s => s.NowPlayingItem).length;
    setStatus('jellyfin', 'online',
      playing > 0 ? `${playing} stream${playing !== 1 ? 's' : ''} active` : 'Online — no active streams',
      stripProto(url));
  } catch (e) {
    setStatus('jellyfin', 'offline', errMsg(e, url), stripProto(url));
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
const SERVICE_CHECKS = {
  lmstudio: checkLMStudio,
  ollama:   checkOllama,
  litellm:  checkLiteLLM,
  proxmox:  checkProxmox,
  truenas:  checkTrueNAS,
  jellyfin: checkJellyfin,
};

async function refreshAll() {
  await Promise.allSettled(Object.values(SERVICE_CHECKS).map(fn => fn()));
}

async function refreshService(id) {
  const btn = document.querySelector(`#card-${id} .status-card__refresh`);
  if (btn) btn.classList.add('spinning');
  await (SERVICE_CHECKS[id] ?? (() => {}))();
  if (btn) btn.classList.remove('spinning');
}
window.refreshService = refreshService;

let countdown = 30;

function startPolling() {
  refreshAll();
  setInterval(() => {
    countdown--;
    const el = document.getElementById('refreshTimer');
    if (el) el.textContent = `Refreshing in ${countdown}s`;
    if (countdown <= 0) {
      countdown = 30;
      refreshAll();
      if (el) {
        el.textContent = 'Refreshed ✓';
        setTimeout(() => { if (el) el.textContent = 'Refreshing in 30s'; }, 1800);
      }
    }
  }, 1000);
}

// ── Config modal ──────────────────────────────────────────────────────────────
function openConfig() {
  document.getElementById('cfg-lmstudio-url').value    = config.lmstudio.url    || '';
  document.getElementById('cfg-ollama-url').value      = config.ollama.url      || '';
  document.getElementById('cfg-litellm-url').value     = config.litellm.url     || '';
  document.getElementById('cfg-jellyfin-url').value    = config.jellyfin.url    || '';
  document.getElementById('cfg-jellyfin-apikey').value = config.jellyfin.apikey || '';
  document.getElementById('modalOverlay').classList.add('is-open');
}

function closeConfig() {
  document.getElementById('modalOverlay').classList.remove('is-open');
}

function closeConfigIfOverlay(e) {
  if (e.target === document.getElementById('modalOverlay')) closeConfig();
}

function saveConfig() {
  config = {
    lmstudio: { url: v('cfg-lmstudio-url') },
    ollama:   { url: v('cfg-ollama-url')   },
    litellm:  { url: v('cfg-litellm-url')  },
    jellyfin: { url: v('cfg-jellyfin-url'), apikey: v('cfg-jellyfin-apikey') },
  };
  persistConfig();
  closeConfig();
  countdown = 30;
  refreshAll();
}

function v(id) {
  return (document.getElementById(id)?.value ?? '').trim();
}

window.openConfig           = openConfig;
window.closeConfig          = closeConfig;
window.closeConfigIfOverlay = closeConfigIfOverlay;
window.saveConfig           = saveConfig;

// ── Footer clock ──────────────────────────────────────────────────────────────
function updateClock() {
  const el = document.getElementById('footerTime');
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
