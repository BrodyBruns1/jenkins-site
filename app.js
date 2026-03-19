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

// ── Panel helpers ──────────────────────────────────────────────────────────────
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1099511627776) return (b/1099511627776).toFixed(1) + ' TB';
  if (b >= 1073741824)    return (b/1073741824).toFixed(1) + ' GB';
  if (b >= 1048576)       return (b/1048576).toFixed(1) + ' MB';
  if (b >= 1024)          return (b/1024).toFixed(1) + ' KB';
  return b + ' B';
}

function fmtUptime(secs) {
  secs = Number(secs) || 0;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function usageBar(used, total, label) {
  const pct = total ? Math.min((used / total) * 100, 100) : 0;
  const cls = pct > 90 ? 'usage-bar__fill--crit' : pct > 75 ? 'usage-bar__fill--warn' : '';
  return `<div class="usage-bar-wrap">
    <div class="usage-bar-label"><span>${label}</span><span>${fmtBytes(used)} / ${fmtBytes(total)} &nbsp;(${pct.toFixed(1)}%)</span></div>
    <div class="usage-bar"><div class="usage-bar__fill ${cls}" style="width:${pct}%"></div></div>
  </div>`;
}

function monoCell(text, maxW) {
  return `<span style="font-family:'Space Mono',monospace;font-size:0.7rem;display:block;max-width:${maxW||200}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${text}">${text}</span>`;
}

// Override errMsg so LM Studio shows a friendlier message
function errMsg(e, url) {
  if (e instanceof TypeError) return 'Offline — may not be running';
  if (e.message?.includes('401') || e.message?.includes('403')) return 'Auth failed — check credentials';
  return `Unreachable (${stripProto(url)})`;
}

// ── Panel system ──────────────────────────────────────────────────────────────
let currentPanel = null;

function openPanel(id) {
  if (currentPanel && currentPanel !== id) {
    document.getElementById(`panel-${currentPanel}`)?.classList.remove('is-open');
  }
  currentPanel = id;
  document.getElementById('panelOverlay').classList.add('is-open');
  const panel = document.getElementById(`panel-${id}`);
  if (panel) panel.classList.add('is-open');
  document.body.style.overflow = 'hidden';
  const body = document.getElementById(`panel-${id}-body`);
  if (body) body.innerHTML = '<div class="panel-loading">Loading…</div>';
  loadPanelData(id);
}
window.openPanel = openPanel;

function closePanel() {
  if (!currentPanel) return;
  document.getElementById('panelOverlay')?.classList.remove('is-open');
  document.getElementById(`panel-${currentPanel}`)?.classList.remove('is-open');
  document.body.style.overflow = '';
  currentPanel = null;
}
window.closePanel = closePanel;

async function loadPanelData(id) {
  const btn = document.querySelector(`#panel-${id} .detail-panel__refresh`);
  if (btn) btn.classList.add('spinning');
  const loaders = {
    lmstudio: loadLMStudioPanel,
    ollama:   loadOllamaPanel,
    proxmox:  loadProxmoxPanel,
    truenas:  loadTrueNASPanel,
    jellyfin: loadJellyfinPanel,
    litellm:  loadLiteLLMPanel,
  };
  try { await (loaders[id] || (() => {}))(); } catch(e) {
    const body = document.getElementById(`panel-${id}-body`);
    if (body) body.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`;
  }
  if (btn) btn.classList.remove('spinning');
}
window.loadPanelData = loadPanelData;

// Wire up card clicks and ESC key after load
window.addEventListener('load', () => {
  ['lmstudio','ollama','proxmox','truenas','jellyfin','litellm'].forEach(id => {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;
    // Add expand hint
    const hint = document.createElement('span');
    hint.className = 'status-card__expand';
    hint.textContent = 'details →';
    card.appendChild(hint);
    card.addEventListener('click', e => {
      if (e.target.closest('.status-card__refresh')) return;
      openPanel(id);
    });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
});

// ── LM Studio Panel ────────────────────────────────────────────────────────────
async function loadLMStudioPanel() {
  const body = document.getElementById('panel-lmstudio-body');
  const base = config.lmstudio.url || 'http://100.71.100.103:1234';
  try {
    const res = await fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = Array.isArray(data) ? data : (data.data || []);
    const loaded = models.filter(m => m.state === 'loaded' || m.loaded === true);
    models.sort((a,b) => {
      const al = a.state==='loaded'||a.loaded; const bl = b.state==='loaded'||b.loaded;
      return bl - al;
    });
    body.innerHTML = `
      <div class="panel-section">
        <div class="panel-section__title">Overview</div>
        <div class="stat-grid">
          <div class="stat-item"><div class="stat-item__label">Available</div><div class="stat-item__value">${models.length}</div></div>
          <div class="stat-item"><div class="stat-item__label">Loaded</div><div class="stat-item__value">${loaded.length}</div></div>
          <div class="stat-item"><div class="stat-item__label">Host</div><div class="stat-item__value" style="font-size:0.6rem">${stripProto(base)}</div></div>
        </div>
      </div>
      <div class="panel-section">
        <div class="panel-section__title">Models (${models.length})</div>
        <table class="panel-table">
          <thead><tr><th>Model</th><th>State</th><th></th></tr></thead>
          <tbody>${models.map(m => {
            const isLoaded = m.state === 'loaded' || m.loaded === true;
            const id = m.id || (m.path||'').split(/[/\\]/).pop() || 'unknown';
            const safeId = id.replace(/'/g,"\\'");
            return `<tr>
              <td>${monoCell(id, 240)}</td>
              <td><span class="chip chip--${isLoaded?'loaded':'idle'}">${isLoaded?'loaded':'idle'}</span></td>
              <td>${isLoaded
                ? `<button class="panel-btn" onclick="unloadModel('${safeId}')">Unload</button>`
                : `<button class="panel-btn" onclick="loadModel('${safeId}')">Load</button>`}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  } catch(e) {
    const msg = e instanceof TypeError ? 'Offline — LM Studio may not be running on the gaming PC' : `Error: ${e.message}`;
    body.innerHTML = `<div class="panel-error">${msg}</div>`;
  }
}

async function unloadModel(identifier) {
  const base = config.lmstudio.url || 'http://100.71.100.103:1234';
  const btn = [...document.querySelectorAll('.panel-btn')].find(b => b.onclick?.toString().includes(identifier));
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    await fetch(`${base}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
      signal: AbortSignal.timeout(15000),
    });
  } catch { /* ignore — can be slow */ }
  setTimeout(() => { loadLMStudioPanel(); refreshService('lmstudio'); }, 1500);
}
window.unloadModel = unloadModel;

// ── Ollama Panel ───────────────────────────────────────────────────────────────
async function loadOllamaPanel() {
  const body = document.getElementById('panel-ollama-body');
  const url = config.ollama.url || 'http://10.201.52.200:11434';
  try {
    const [tagsRes, psRes] = await Promise.allSettled([
      fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(6000) }),
      fetch(`${url}/api/ps`,   { signal: AbortSignal.timeout(6000) }),
    ]);
    const models  = tagsRes.status==='fulfilled' && tagsRes.value.ok  ? (await tagsRes.value.json()).models||[]  : [];
    const running = psRes.status==='fulfilled'   && psRes.value.ok    ? (await psRes.value.json()).models||[]   : [];
    const totalSize = models.reduce((a,m) => a + (m.size||0), 0);

    body.innerHTML = `
      <div class="panel-section">
        <div class="panel-section__title">Overview</div>
        <div class="stat-grid">
          <div class="stat-item"><div class="stat-item__label">Models</div><div class="stat-item__value">${models.length}</div></div>
          <div class="stat-item"><div class="stat-item__label">Running</div><div class="stat-item__value">${running.length}</div></div>
          <div class="stat-item"><div class="stat-item__label">Disk Used</div><div class="stat-item__value" style="font-size:0.8rem">${fmtBytes(totalSize)}</div></div>
        </div>
      </div>
      ${running.length ? `
      <div class="panel-section">
        <div class="panel-section__title">Running</div>
        <table class="panel-table">
          <thead><tr><th>Model</th><th>Size</th><th>VRAM</th></tr></thead>
          <tbody>${running.map(m=>`<tr>
            <td>${monoCell(m.name,220)}</td>
            <td>${fmtBytes(m.size||0)}</td>
            <td>${fmtBytes(m.size_vram||0)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}
      <div class="panel-section">
        <div class="panel-section__title">All Models (${models.length})</div>
        <table class="panel-table">
          <thead><tr><th>Model</th><th>Params</th><th>Quant</th><th>Size</th></tr></thead>
          <tbody>${models.map(m=>`<tr>
            <td>${monoCell(m.name,190)}</td>
            <td>${m.details?.parameter_size||'—'}</td>
            <td>${m.details?.quantization_level||'—'}</td>
            <td>${fmtBytes(m.size)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="panel-section">
        <div class="panel-section__title">Pull a Model</div>
        <div class="panel-input-row">
          <input class="panel-input" id="ollama-pull-input" placeholder="e.g. llama3.2:latest" />
          <button class="panel-btn" onclick="ollamaPull()">Pull</button>
        </div>
        <div class="panel-status-msg" id="ollama-pull-status"></div>
      </div>`;
  } catch(e) {
    body.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`;
  }
}

async function ollamaPull() {
  const url = config.ollama.url || 'http://10.201.52.200:11434';
  const input = document.getElementById('ollama-pull-input');
  const statusEl = document.getElementById('ollama-pull-status');
  const name = input?.value?.trim();
  if (!name) return;
  if (statusEl) statusEl.textContent = `Pulling ${name}…`;
  try {
    const res = await fetch(`${url}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: false }),
      signal: AbortSignal.timeout(300000),
    });
    if (statusEl) statusEl.textContent = res.ok ? `✓ Pulled ${name}` : `Failed (HTTP ${res.status})`;
    setTimeout(() => { loadOllamaPanel(); refreshService('ollama'); }, 1000);
  } catch(e) {
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
  }
}
window.ollamaPull = ollamaPull;

// ── Proxmox Panel ──────────────────────────────────────────────────────────────
async function loadProxmoxPanel() {
  const body = document.getElementById('panel-proxmox-body');
  const PROXY = 'http://10.201.52.171:8040/proxy/proxmox';
  try {
    const [statusRes, qemuRes, lxcRes] = await Promise.allSettled([
      fetch(`${PROXY}/nodes/proxmox/status`, { signal: AbortSignal.timeout(7000) }),
      fetch(`${PROXY}/nodes/proxmox/qemu`,   { signal: AbortSignal.timeout(7000) }),
      fetch(`${PROXY}/nodes/proxmox/lxc`,    { signal: AbortSignal.timeout(7000) }),
    ]);
    const ns   = statusRes.status==='fulfilled' && statusRes.value.ok ? (await statusRes.value.json()).data : null;
    const vms  = qemuRes.status==='fulfilled'   && qemuRes.value.ok   ? (await qemuRes.value.json()).data||[] : [];
    const lxcs = lxcRes.status==='fulfilled'    && lxcRes.value.ok    ? (await lxcRes.value.json()).data||[] : [];
    const all  = [...vms.map(v=>({...v,_type:'vm'})), ...lxcs.map(v=>({...v,_type:'lxc'}))].sort((a,b)=>a.vmid-b.vmid);

    body.innerHTML = `
      ${ns ? `
      <div class="panel-section">
        <div class="panel-section__title">Node — proxmox</div>
        <div class="stat-grid">
          <div class="stat-item"><div class="stat-item__label">CPU</div><div class="stat-item__value">${((ns.cpu||0)*100).toFixed(1)}%</div></div>
          <div class="stat-item"><div class="stat-item__label">Cores</div><div class="stat-item__value">${ns.cpuinfo?.cpus||'—'}</div></div>
          <div class="stat-item"><div class="stat-item__label">Uptime</div><div class="stat-item__value" style="font-size:0.8rem">${fmtUptime(ns.uptime||0)}</div></div>
          <div class="stat-item"><div class="stat-item__label">Load</div><div class="stat-item__value" style="font-size:0.8rem">${(ns.loadavg||[]).join(' ')}</div></div>
        </div>
        ${ns.memory ? usageBar(ns.memory.used, ns.memory.total, 'RAM') : ''}
        ${ns.rootfs ? usageBar(ns.rootfs.used, ns.rootfs.total, 'Root FS') : ''}
        ${ns.swap && ns.swap.total ? usageBar(ns.swap.used, ns.swap.total, 'Swap') : ''}
      </div>` : ''}
      <div class="panel-section">
        <div class="panel-section__title">VMs & Containers (${all.length})</div>
        <table class="panel-table">
          <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Status</th><th>CPU</th><th>RAM</th><th>Uptime</th></tr></thead>
          <tbody>${all.map(vm=>`<tr>
            <td style="color:rgba(240,237,232,0.35);font-family:'Space Mono',monospace">${vm.vmid}</td>
            <td style="font-weight:500">${vm.name}</td>
            <td style="color:rgba(240,237,232,0.35);font-size:0.68rem">${vm._type}</td>
            <td><span class="chip chip--${vm.status}">${vm.status}</span></td>
            <td>${vm.status==='running' ? ((vm.cpu||0)*100).toFixed(1)+'%' : '—'}</td>
            <td>${vm.status==='running' ? fmtBytes(vm.mem||0)+' / '+fmtBytes(vm.maxmem||0) : '—'}</td>
            <td>${vm.status==='running' ? fmtUptime(vm.uptime||0) : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch(e) {
    body.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`;
  }
}

// ── TrueNAS Panel ─────────────────────────────────────────────────────────────
async function loadTrueNASPanel() {
  const body = document.getElementById('panel-truenas-body');
  const PROXY = 'http://10.201.52.171:8040/proxy/truenas';
  try {
    const [poolRes, dsRes, alertRes, diskRes] = await Promise.allSettled([
      fetch(`${PROXY}/pool`,         { signal: AbortSignal.timeout(8000) }),
      fetch(`${PROXY}/pool/dataset`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${PROXY}/alert/list`,   { signal: AbortSignal.timeout(8000) }),
      fetch(`${PROXY}/disk`,         { signal: AbortSignal.timeout(8000) }),
    ]);
    const pools  = poolRes.status==='fulfilled'  && poolRes.value.ok  ? await poolRes.value.json()  : [];
    const allDS  = dsRes.status==='fulfilled'    && dsRes.value.ok    ? await dsRes.value.json()    : [];
    const alerts = alertRes.status==='fulfilled' && alertRes.value.ok ? await alertRes.value.json() : [];
    const disks  = diskRes.status==='fulfilled'  && diskRes.value.ok  ? await diskRes.value.json()  : [];

    const activeAlerts = alerts.filter(a => !a.dismissed);
    // Top-level datasets only (one slash in name)
    const topDS = allDS.filter(d => (d.name.match(/\//g)||[]).length === 1);
    const realDisks = disks.filter(d => d.pool || d.type === 'HDD' || d.type === 'SSD');

    body.innerHTML = `
      ${activeAlerts.length ? `
      <div class="panel-section">
        <div class="panel-section__title">⚠ Alerts (${activeAlerts.length})</div>
        ${activeAlerts.map(a=>`
          <div class="alert-item alert-item--${a.level}">
            <div class="alert-item__source">${a.level} · ${a.source}</div>
            ${a.formatted || a.text}
          </div>`).join('')}
      </div>` : ''}
      <div class="panel-section">
        <div class="panel-section__title">Pools</div>
        ${pools.map(p=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid rgba(240,237,232,0.05)">
            <span style="font-weight:500">${p.name}</span>
            <span class="chip chip--${p.status}">${p.status}</span>
          </div>`).join('')}
      </div>
      ${topDS.length ? `
      <div class="panel-section">
        <div class="panel-section__title">Datasets</div>
        ${topDS.map(d => {
          const used  = d.used?.parsed || 0;
          const avail = d.available?.parsed || 0;
          return usageBar(used, used + avail, d.name);
        }).join('')}
      </div>` : ''}
      ${realDisks.length ? `
      <div class="panel-section">
        <div class="panel-section__title">Disks (${realDisks.length})</div>
        <table class="panel-table">
          <thead><tr><th>Device</th><th>Type</th><th>Size</th><th>Pool</th><th>Serial</th></tr></thead>
          <tbody>${realDisks.map(d=>`<tr>
            <td>${monoCell(d.devname||d.name, 80)}</td>
            <td>${d.type||'—'}</td>
            <td>${fmtBytes(d.size||0)}</td>
            <td style="color:rgba(240,237,232,0.38)">${d.pool||'—'}</td>
            <td>${monoCell(d.serial||'—', 110)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}`;
  } catch(e) {
    body.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`;
  }
}

// ── Jellyfin Panel ─────────────────────────────────────────────────────────────
async function loadJellyfinPanel() {
  const body = document.getElementById('panel-jellyfin-body');
  const base   = config.jellyfin?.url    || 'http://10.201.52.207:8096';
  const apikey = config.jellyfin?.apikey || '335afa8ef67d48ac85f6675556276451';
  const headers = { 'X-Emby-Token': apikey };
  try {
    const [infoRes, sessRes, countsRes, recentRes] = await Promise.allSettled([
      fetch(`${base}/System/Info`,                          { headers, signal: AbortSignal.timeout(7000) }),
      fetch(`${base}/Sessions`,                             { headers, signal: AbortSignal.timeout(7000) }),
      fetch(`${base}/Items/Counts`,                         { headers, signal: AbortSignal.timeout(7000) }),
      fetch(`${base}/Items?SortBy=DateCreated&SortOrder=Descending&Limit=6&Recursive=true&IncludeItemTypes=Movie,Episode&Fields=Overview`, { headers, signal: AbortSignal.timeout(7000) }),
    ]);
    const info    = infoRes.status==='fulfilled'    && infoRes.value.ok    ? await infoRes.value.json()    : null;
    const sessions= sessRes.status==='fulfilled'    && sessRes.value.ok    ? await sessRes.value.json()    : [];
    const counts  = countsRes.status==='fulfilled'  && countsRes.value.ok  ? await countsRes.value.json()  : null;
    const recent  = recentRes.status==='fulfilled'  && recentRes.value.ok  ? (await recentRes.value.json()).Items||[] : [];
    const active  = sessions.filter(s => s.NowPlayingItem);

    body.innerHTML = `
      ${info ? `
      <div class="panel-section">
        <div class="panel-section__title">Server</div>
        <div class="stat-grid">
          <div class="stat-item"><div class="stat-item__label">Version</div><div class="stat-item__value" style="font-size:0.75rem">${info.Version||'—'}</div></div>
          <div class="stat-item"><div class="stat-item__label">OS</div><div class="stat-item__value" style="font-size:0.75rem">${info.OperatingSystem||'—'}</div></div>
          <div class="stat-item"><div class="stat-item__label">Name</div><div class="stat-item__value" style="font-size:0.75rem">${info.ServerName||'—'}</div></div>
        </div>
      </div>` : ''}
      ${counts ? `
      <div class="panel-section">
        <div class="panel-section__title">Library</div>
        <div class="stat-grid">
          <div class="stat-item"><div class="stat-item__label">Movies</div><div class="stat-item__value">${counts.MovieCount||0}</div></div>
          <div class="stat-item"><div class="stat-item__label">Series</div><div class="stat-item__value">${counts.SeriesCount||0}</div></div>
          <div class="stat-item"><div class="stat-item__label">Episodes</div><div class="stat-item__value">${counts.EpisodeCount||0}</div></div>
          <div class="stat-item"><div class="stat-item__label">Songs</div><div class="stat-item__value">${counts.SongCount||0}</div></div>
        </div>
      </div>` : ''}
      <div class="panel-section">
        <div class="panel-section__title">Active Streams (${active.length})</div>
        ${active.length===0
          ? `<div style="color:rgba(240,237,232,0.28);font-size:0.82rem">No active streams</div>`
          : active.map(s => {
              const item = s.NowPlayingItem;
              const pct  = s.PlayState?.PositionTicks && item?.RunTimeTicks
                ? (s.PlayState.PositionTicks / item.RunTimeTicks * 100) : 0;
              const pos  = s.PlayState?.PositionTicks ? new Date(s.PlayState.PositionTicks/10000).toISOString().substr(11,8).replace(/^00:/,'') : '';
              const dur  = item?.RunTimeTicks ? new Date(item.RunTimeTicks/10000).toISOString().substr(11,8).replace(/^00:/,'') : '';
              return `<div class="stream-item">
                <div class="stream-title">${item?.SeriesName ? item.SeriesName+' — ' : ''}${item?.Name||'Unknown'}</div>
                <div class="stream-meta">${s.UserName||'Unknown'} &nbsp;·&nbsp; ${s.Client||'—'} &nbsp;·&nbsp; ${s.DeviceName||'—'}${pos ? ' &nbsp;·&nbsp; '+pos+(dur?' / '+dur:'') : ''}</div>
                ${pct>0 ? `<div class="stream-progress"><div class="stream-progress__fill" style="width:${pct}%"></div></div>` : ''}
              </div>`;
            }).join('')}
      </div>
      ${recent.length ? `
      <div class="panel-section">
        <div class="panel-section__title">Recently Added</div>
        ${recent.map(i=>`
          <div style="padding:0.45rem 0;border-bottom:1px solid rgba(240,237,232,0.05);font-size:0.8rem;color:rgba(240,237,232,0.7)">
            ${i.SeriesName ? `<span style="color:rgba(240,237,232,0.38)">${i.SeriesName} · </span>` : ''}${i.Name}
            <span style="float:right;color:rgba(240,237,232,0.28);font-size:0.7rem">${i.Type}</span>
          </div>`).join('')}
      </div>` : ''}`;
  } catch(e) {
    body.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`;
  }
}

// ── LiteLLM Panel ─────────────────────────────────────────────────────────────
async function loadLiteLLMPanel() {
  const body = document.getElementById('panel-litellm-body');
  const PROXY = 'http://10.201.52.171:8040/proxy/litellm';
  try {
    const [healthRes, modelsRes] = await Promise.allSettled([
      fetch(`${PROXY}/health`,  { signal: AbortSignal.timeout(6000) }),
      fetch(`${PROXY}/models`,  { signal: AbortSignal.timeout(6000) }),
    ]);
    const healthy = healthRes.status==='fulfilled' && healthRes.value.ok;
    const models  = modelsRes.status==='fulfilled' && modelsRes.value.ok
      ? (await modelsRes.value.json()).data||[] : [];

    body.innerHTML = `
      <div class="panel-section">
        <div class="panel-section__title">Status</div>
        <div class="stat-grid">
          <div class="stat-item"><div class="stat-item__label">Health</div><div class="stat-item__value"><span class="chip chip--${healthy?'online':'offline'}">${healthy?'Healthy':'Offline'}</span></div></div>
          <div class="stat-item"><div class="stat-item__label">Models</div><div class="stat-item__value">${models.length}</div></div>
          <div class="stat-item"><div class="stat-item__label">Host</div><div class="stat-item__value" style="font-size:0.6rem">REPLICA:4000</div></div>
        </div>
      </div>
      ${models.length ? `
      <div class="panel-section">
        <div class="panel-section__title">Available Models</div>
        <table class="panel-table">
          <thead><tr><th>Model ID</th><th>Provider</th></tr></thead>
          <tbody>${models.map(m=>`<tr>
            <td>${monoCell(m.id,260)}</td>
            <td style="color:rgba(240,237,232,0.38)">${m.litellm_params?.model?.split('/')[0]||'—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : `
      <div class="panel-section">
        <div style="color:rgba(240,237,232,0.28);font-size:0.82rem">LiteLLM is offline on REPLICA (100.111.121.128:4000)</div>
      </div>`}`;
  } catch(e) {
    body.innerHTML = `<div class="panel-error">Offline — LiteLLM may not be running on REPLICA</div>`;
  }
}
