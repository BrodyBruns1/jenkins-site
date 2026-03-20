/**
 * services.js -- Homelab service polling + panel data loaders
 *
 * Mirrors the architecture of api.js but for the 6 homelab services.
 * All network I/O for services lives here; components subscribe to
 * serviceEventBus for health updates.
 *
 * Events dispatched on serviceEventBus:
 *   service-update  { id, status:'online'|'offline'|'degraded', metric:string, data:object }
 *     id      -- one of: lmstudio, ollama, litellm, proxmox, truenas, jellyfin
 *     metric  -- short display string: "2 loaded", "82% CPU", etc.
 */

import { SERVICES_CONFIG } from '../config.js';

export const serviceEventBus = new EventTarget();

// ── Service index (matches nodes.js order) ────────────────────────────────
const SERVICE_IDS = ['lmstudio', 'ollama', 'litellm', 'proxmox', 'truenas', 'jellyfin'];

// ── Fast status polls (minimal fetches, no panel detail) ──────────────────

async function pollLMStudio() {
  const base = SERVICES_CONFIG.lmstudio.url;
  const res = await fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const models = Array.isArray(raw) ? raw : (raw.data || []);
  const loaded = models.filter(m => m.state === 'loaded' || m.loaded === true).length;
  return { status: 'online', metric: `${loaded} loaded`, data: { models, loaded } };
}

async function pollOllama() {
  const base = SERVICES_CONFIG.ollama.url;
  const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const running = (data.models || []).length;
  return { status: 'online', metric: `${running} running`, data: { running: data.models || [] } };
}

async function pollLiteLLM() {
  const base = SERVICES_CONFIG.litellm.proxyBase;
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: 'online', metric: 'healthy', data: {} };
}

async function pollProxmox() {
  const base = SERVICES_CONFIG.proxmox.proxyBase;
  const res = await fetch(`${base}/nodes/proxmox/status`, { signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const ns = data.data || data;
  const cpu = ((ns.cpu || 0) * 100).toFixed(1);
  const cpuNum = parseFloat(cpu);
  const status = cpuNum > 90 ? 'degraded' : 'online';
  return { status, metric: `${cpu}% CPU`, data: ns };
}

async function pollTrueNAS() {
  const base = SERVICES_CONFIG.truenas.proxyBase;
  const res = await fetch(`${base}/pool`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const pools = await res.json();
  const degraded = pools.some(p => p.status !== 'ONLINE');
  return {
    status: degraded ? 'degraded' : 'online',
    metric: `${pools.length} pool${pools.length !== 1 ? 's' : ''}`,
    data: { pools },
  };
}

async function pollJellyfin() {
  const { url, apikey } = SERVICES_CONFIG.jellyfin;
  const res = await fetch(`${url}/Sessions`, {
    headers: { 'X-Emby-Token': apikey },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const sessions = await res.json();
  const active = sessions.filter(s => s.NowPlayingItem).length;
  return {
    status: 'online',
    metric: active > 0 ? `${active} streaming` : 'idle',
    data: { sessions, active },
  };
}

const POLL_FNS = { lmstudio: pollLMStudio, ollama: pollOllama, litellm: pollLiteLLM,
                 proxmox: pollProxmox, truenas: pollTrueNAS, jellyfin: pollJellyfin };

// ── Polling loop ──────────────────────────────────────────────────────────
let _intervalId = null;

async function pollAll() {
  const results = await Promise.allSettled(
    SERVICE_IDS.map(id => POLL_FNS[id]().then(r => ({ id, ...r })))
  );
  for (const r of results) {
    if (r.status === 'fulfilled') {
      serviceEventBus.dispatchEvent(new CustomEvent('service-update', { detail: r.value }));
    } else {
      const idx = results.indexOf(r);
      serviceEventBus.dispatchEvent(new CustomEvent('service-update', {
        detail: { id: SERVICE_IDS[idx], status: 'offline', metric: 'offline', data: {} },
      }));
    }
  }
}

export function startServicePolling() {
  pollAll();
  _intervalId = setInterval(pollAll, 20000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(_intervalId); _intervalId = null; }
    else { pollAll(); _intervalId = setInterval(pollAll, 20000); }
  });
}

export function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1099511627776) return (b / 1099511627776).toFixed(1) + ' TB';
  if (b >= 1073741824)    return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576)       return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024)          return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

export function fmtUptime(secs) {
  secs = Number(secs) || 0;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function usageBar(used, total, label) {
  const pct = total ? Math.min((used / total) * 100, 100) : 0;
  const cls = pct > 90 ? 'usage-bar__fill--crit' : pct > 75 ? 'usage-bar__fill--warn' : '';
  return `<div class="usage-bar-wrap"><div class="usage-bar-label"><span>${label}</span><span>${fmtBytes(used)} / ${fmtBytes(total)}&nbsp;(${pct.toFixed(1)}%)</span></div><div class="usage-bar"><div class="usage-bar__fill ${cls}" style="width:${pct}%"></div></div></div>`;
}

export function monoCell(text, maxW) {
  return `<span style="font-family:'Courier New',monospace;font-size:0.7rem;display:block;max-width:${maxW || 200}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${text}">${text}</span>`;
}

export async function fetchProxmoxSnapshot() {
  const PROXY = SERVICES_CONFIG.proxmox.proxyBase;
  const [statusRes, qemuRes, lxcRes] = await Promise.allSettled([
    fetch(`${PROXY}/nodes/proxmox/status`, { signal: AbortSignal.timeout(7000) }),
    fetch(`${PROXY}/nodes/proxmox/qemu`,   { signal: AbortSignal.timeout(7000) }),
    fetch(`${PROXY}/nodes/proxmox/lxc`,    { signal: AbortSignal.timeout(7000) }),
  ]);

  const nodeStatus = statusRes.status === 'fulfilled' && statusRes.value.ok
    ? (await statusRes.value.json()).data
    : null;
  const qemus = qemuRes.status === 'fulfilled' && qemuRes.value.ok
    ? (await qemuRes.value.json()).data || []
    : [];
  const lxcs = lxcRes.status === 'fulfilled' && lxcRes.value.ok
    ? (await lxcRes.value.json()).data || []
    : [];
  const resources = [
    ...qemus.map(vm => ({ ...vm, _type: 'vm' })),
    ...lxcs.map(ct => ({ ...ct, _type: 'lxc' })),
  ].sort((a, b) => a.vmid - b.vmid);

  if (!nodeStatus && resources.length === 0) {
    throw new Error('Unable to load Proxmox data');
  }

  return { nodeStatus, qemus, lxcs, resources };
}

export async function proxmoxAction(resourceType, vmid, action) {
  const PROXY = SERVICES_CONFIG.proxmox.proxyBase;
  const kind = resourceType === 'lxc' ? 'lxc' : 'qemu';
  const proxmoxActionName = action === 'restart'
    ? 'reboot'
    : action === 'stop'
      ? 'shutdown'
      : action;

  const res = await fetch(
    `${PROXY}/nodes/proxmox/${kind}/${vmid}/status/${proxmoxActionName}`,
    { method: 'POST', signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 204) return null;
  try { return await res.json(); } catch { return null; }
}

export async function loadLMStudioPanel(bodyEl) {
  const base = SERVICES_CONFIG.lmstudio.url;
  try {
    const res = await fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const models = Array.isArray(raw) ? raw : (raw.data || []);
    const loaded = models.filter(m => m.state === 'loaded' || m.loaded === true);
    models.sort((a, b) => { const al = a.state === 'loaded' || a.loaded; const bl = b.state === 'loaded' || b.loaded; return bl - al; });
    bodyEl.innerHTML = `<div class="panel-section"><div class="panel-section__title">Overview</div><div class="stat-grid"><div class="stat-item"><div class="stat-item__label">Available</div><div class="stat-item__value">${models.length}</div></div><div class="stat-item"><div class="stat-item__label">Loaded</div><div class="stat-item__value">${loaded.length}</div></div></div></div><div class="panel-section"><div class="panel-section__title">Models (${models.length})</div><table class="panel-table"><thead><tr><th>Model</th><th>State</th><th></th></tr></thead><tbody>${models.map(m => { const isLoaded = m.state === 'loaded' || m.loaded === true; const id = m.id || (m.path || '').split(/[/\\]/).pop() || 'unknown'; const safeId = id.replace(/'/g, "\\'"); return `<tr><td>${monoCell(id,240)}</td><td><span class="chip chip--${isLoaded?'loaded':'idle'}">${isLoaded?'loaded':'idle'}</span></td><td>${isLoaded?`<button class="panel-btn" onclick="window._svcUnloadModel('${safeId}')">Unload</button>`:`<button class="panel-btn" onclick="window._svcLoadModel('${safeId}')">Load</button>`}</td></tr>`; }).join('')}</tbody></table></div>`;
  } catch (e) { bodyEl.innerHTML = `<div class="panel-error">${e instanceof TypeError?'Offline':`Error: ${e.message}`}</div>`; }
}

export async function loadOllamaPanel(bodyEl) {
  const url = SERVICES_CONFIG.ollama.url;
  try {
    const [tagsRes, psRes] = await Promise.allSettled([fetch(`${url}/api/tags`,{signal:AbortSignal.timeout(6000)}),fetch(`${url}/api/ps`,{signal:AbortSignal.timeout(6000)})]);
    const models = tagsRes.status==='fulfilled'&&tagsRes.value.ok?(await tagsRes.value.json()).models||[]:[];
    const running = psRes.status==='fulfilled'&&psRes.value.ok?(await psRes.value.json()).models||[]:[];
    const totalSize = models.reduce((a,m)=>a+(m.size||0),0);
    bodyEl.innerHTML = `<div class="panel-section"><div class="panel-section__title">Overview</div><div class="stat-grid"><div class="stat-item"><div class="stat-item__label">Models</div><div class="stat-item__value">${models.length}</div></div><div class="stat-item"><div class="stat-item__label">Running</div><div class="stat-item__value">${running.length}</div></div><div class="stat-item"><div class="stat-item__label">Disk</div><div class="stat-item__value" style="font-size:0.8rem">${fmtBytes(totalSize)}</div></div></div></div>${running.length?`<div class="panel-section"><div class="panel-section__title">Running</div><table class="panel-table"><thead><tr><th>Model</th><th>Size</th><th>VRAM</th></tr></thead><tbody>${running.map(m=>`<tr><td>${monoCell(m.name,220)}</td><td>${fmtBytes(m.size||0)}</td><td>${fmtBytes(m.size_vram||0)}</td></tr>`).join('')}</tbody></table></div>`:''}<div class="panel-section"><div class="panel-section__title">All Models (${models.length})</div><table class="panel-table"><thead><tr><th>Model</th><th>Params</th><th>Quant</th><th>Size</th></tr></thead><tbody>${models.map(m=>`<tr><td>${monoCell(m.name,190)}</td><td>${m.details?.parameter_size||'--'}</td><td>${m.details?.quantization_level||'--'}</td><td>${fmtBytes(m.size)}</td></tr>`).join('')}</tbody></table></div><div class="panel-section"><div class="panel-section__title">Pull a Model</div><div class="panel-input-row"><input class="panel-input" id="ollama-pull-input" placeholder="e.g. llama3.2:latest" /><button class="panel-btn" onclick="window._svcOllamaPull()">Pull</button></div><div class="panel-status-msg" id="ollama-pull-status"></div></div>`;
  } catch (e) { bodyEl.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`; }
}

export async function loadProxmoxPanel(bodyEl) {
  try {
    const { nodeStatus: ns, resources: all } = await fetchProxmoxSnapshot();
    bodyEl.innerHTML = `${ns?`<div class="panel-section"><div class="panel-section__title">Node</div><div class="stat-grid"><div class="stat-item"><div class="stat-item__label">CPU</div><div class="stat-item__value">${((ns.cpu||0)*100).toFixed(1)}%</div></div><div class="stat-item"><div class="stat-item__label">Cores</div><div class="stat-item__value">${ns.cpuinfo?.cpus||'--'}</div></div><div class="stat-item"><div class="stat-item__label">Uptime</div><div class="stat-item__value" style="font-size:0.8rem">${fmtUptime(ns.uptime||0)}</div></div><div class="stat-item"><div class="stat-item__label">Load</div><div class="stat-item__value" style="font-size:0.8rem">${ns.loadavg||[]}</div></div></div>${ns.memory?usageBar(ns.memory.used,ns.memory.total,'RAM'):''}${ns.rootfs?usageBar(ns.rootfs.used,ns.rootfs.total,'Root FS'):''}</div>`:''}<div class="panel-section"><div class="panel-section__title">VMs & Containers (${all.length})</div><table class="panel-table"><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Status</th><th>CPU</th><th>RAM</th><th>Uptime</th></tr></thead><tbody>${all.map(vm=>`<tr><td style="color:rgba(255,255,255,0.35)">${vm.vmid}</td><td style="font-weight:500">${vm.name}</td><td style="color:rgba(255,255,255,0.35);font-size:0.75em">${vm._type}</td><td><span class="chip chip--${vm.status}">${vm.status}</span></td><td>${vm.status==='running'?((vm.cpu||0)*100).toFixed(1)+'%':'--'}</td><td>${vm.status==='running'?fmtBytes(vm.mem||0)+' / '+fmtBytes(vm.maxmem||0):'--'}</td><td>${vm.status==='running'?fmtUptime(vm.uptime||0):'--'}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { bodyEl.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`; }
}

export async function loadTrueNASPanel(bodyEl) {
  const PROXY = SERVICES_CONFIG.truenas.proxyBase;
  try {
    const [poolRes,dsRes,alertRes,diskRes] = await Promise.allSettled([fetch(`${PROXY}/pool`,{signal:AbortSignal.timeout(8000)}),fetch(`${PROXY}/pool/dataset`,{signal:AbortSignal.timeout(8000)}),fetch(`${PROXY}/alert/list`,{signal:AbortSignal.timeout(8000)}),fetch(`${PROXY}/disk`,{signal:AbortSignal.timeout(8000)})]);
    const pools=poolRes.status==='fulfilled'&&poolRes.value.ok?await poolRes.value.json():[];
    const allDS=dsRes.status==='fulfilled'&&dsRes.value.ok?await dsRes.value.json():[];
    const alerts=alertRes.status==='fulfilled'&&alertRes.value.ok?await alertRes.value.json():[];
    const disks=diskRes.status==='fulfilled'&&diskRes.value.ok?await diskRes.value.json():[];
    const activeAlerts=alerts.filter(a=>!a.dismissed);
    const topDS=allDS.filter(d=>(d.name.match(/\//g)||[]).length===1);
    const realDisks=disks.filter(d=>d.pool||d.type==='HDD'||d.type==='SSD');
    bodyEl.innerHTML = `${activeAlerts.length?`<div class="panel-section"><div class="panel-section__title">Alerts (${activeAlerts.length})</div>${activeAlerts.map(a=>`<div class="alert-item alert-item--${a.level}"><div class="alert-item__source">${a.level} &middot; ${a.source}</div>${a.formatted||a.text}</div>`).join('')}</div>`:''}<div class="panel-section"><div class="panel-section__title">Pools</div>${pools.map(p=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span style="font-family:'Courier New',monospace;font-size:0.9rem">${p.name}</span><span class="chip chip--${p.status}">${p.status}</span></div>`).join('')}</div>${topDS.length?`<div class="panel-section"><div class="panel-section__title">Datasets</div>${topDS.map(d=>{const used=d.used?.parsed||0;const avail=d.available?.parsed||0;return usageBar(used,used+avail,d.name);}).join('')}</div>`:''}${realDisks.length?`<div class="panel-section"><div class="panel-section__title">Disks (${realDisks.length})</div><table class="panel-table"><thead><tr><th>Device</th><th>Type</th><th>Size</th><th>Pool</th></tr></thead><tbody>${realDisks.map(d=>`<tr><td>${monoCell(d.devname||d.name,80)}</td><td>${d.type||'--'}</td><td>${fmtBytes(d.size||0)}</td><td style="color:rgba(255,255,255,0.38)">${d.pool||'--'}</td></tr>`).join('')}</tbody></table></div>`:''}`;
  } catch (e) { bodyEl.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`; }
}

export async function loadJellyfinPanel(bodyEl) {
  const { url, apikey } = SERVICES_CONFIG.jellyfin;
  const headers = { 'X-Emby-Token': apikey };
  try {
    const [infoRes,sessRes,countsRes,recentRes] = await Promise.allSettled([fetch(`${url}/System/Info`,{headers,signal:AbortSignal.timeout(7000)}),fetch(`${url}/Sessions`,{headers,signal:AbortSignal.timeout(7000)}),fetch(`${url}/Items/Counts`,{headers,signal:AbortSignal.timeout(7000)}),fetch(`${url}/Items?SortBy=DateCreated&SortOrder=Descending&Limit=6&Recursive=true&IncludeItemTypes=Movie,Episode`,{headers,signal:AbortSignal.timeout(7000)})]);
    const info=infoRes.status==='fulfilled'&&infoRes.value.ok?await infoRes.value.json():null;
    const sessions=sessRes.status==='fulfilled'&&sessRes.value.ok?await sessRes.value.json():[];
    const counts=countsRes.status==='fulfilled'&&countsRes.value.ok?await countsRes.value.json():null;
    const recent=recentRes.status==='fulfilled'&&recentRes.value.ok?(await recentRes.value.json()).Items||[]:[];
    const active=sessions.filter(s=>s.NowPlayingItem);
    bodyEl.innerHTML = `${info?`<div class="panel-section"><div class="panel-section__title">Server</div><div class="stat-grid"><div class="stat-item"><div class="stat-item__label">Version</div><div class="stat-item__value" style="font-size:0.75rem">${info.Version||'--'}</div></div><div class="stat-item"><div class="stat-item__label">OS</div><div class="stat-item__value" style="font-size:0.75rem">${info.OperatingSystem||'--'}</div></div><div class="stat-item"><div class="stat-item__label">Name</div><div class="stat-item__value" style="font-size:0.75rem">${info.ServerName||'--'}</div></div></div></div>`:''}${counts?`<div class="panel-section"><div class="panel-section__title">Library</div><div class="stat-grid"><div class="stat-item"><div class="stat-item__label">Movies</div><div class="stat-item__value">${counts.MovieCount||0}</div></div><div class="stat-item"><div class="stat-item__label">Series</div><div class="stat-item__value">${counts.SeriesCount||0}</div></div><div class="stat-item"><div class="stat-item__label">Episodes</div><div class="stat-item__value">${counts.EpisodeCount||0}</div></div><div class="stat-item"><div class="stat-item__label">Songs</div><div class="stat-item__value">${counts.SongCount||0}</div></div></div></div>`:''}<div class="panel-section"><div class="panel-section__title">Active Streams (${active.length})</div>${active.length===0?`<div style="color:rgba(255,255,255,0.28);font-family:'Courier New',monospace;font-size:0.8rem">No active streams</div>`:active.map(s=>{ const item=s.NowPlayingItem; const pct=s.PlayState?.PositionTicks&&item?.RunTimeTicks?(s.PlayState.PositionTicks/item.RunTimeTicks*100):0; const pos=s.PlayState?.PositionTicks?new Date(s.PlayState.PositionTicks/10000).toISOString().substr(11,8).replace(/^00:/,''):''; const dur=item?.RunTimeTicks?new Date(item.RunTimeTicks/10000).toISOString().substr(11,8).replace(/^00:/,''):''; return `<div class="stream-item"><div class="stream-title">${item?.SeriesName?item.SeriesName+' -- ':''}${item?.Name||'Unknown'}</div><div class="stream-meta">${s.UserName||'Unknown'} &middot; ${s.Client||'--'} &middot; ${s.DeviceName||'--'}${pos?' &middot; '+pos+(dur?' / '+dur:''):''}</div>${pct>0?`<div class="stream-progress"><div class="stream-progress__fill" style="width:${pct}%"></div></div>`:''}</div>`;}).join('')}</div>${recent.length?`<div class="panel-section"><div class="panel-section__title">Recently Added</div>${recent.map(i=>`<div style="padding:0.45rem 0;border-bottom:1px solid rgba(255,255,255,0.05);font-family:'Courier New',monospace;font-size:0.8rem;color:rgba(255,255,255,0.7)">${i.SeriesName?`<span style="color:rgba(255,255,255,0.38)">${i.SeriesName} &middot; </span>`:''}${i.Name}<span style="float:right;color:rgba(255,255,255,0.28);font-size:0.7rem">${i.Type}</span></div>`).join('')}</div>`:''}`;
  } catch (e) { bodyEl.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`; }
}

export async function loadLiteLLMPanel(bodyEl) {
  const PROXY = SERVICES_CONFIG.litellm.proxyBase;
  try {
    const [healthRes,modelsRes] = await Promise.allSettled([fetch(`${PROXY}/health`,{signal:AbortSignal.timeout(6000)}),fetch(`${PROXY}/models`,{signal:AbortSignal.timeout(6000)})]);
    const healthy=healthRes.status==='fulfilled'&&healthRes.value.ok;
    const models=modelsRes.status==='fulfilled'&&modelsRes.value.ok?(await modelsRes.value.json()).data||[]:[];
    bodyEl.innerHTML = `<div class="panel-section"><div class="panel-section__title">Status</div><div class="stat-grid"><div class="stat-item"><div class="stat-item__label">Health</div><div class="stat-item__value"><span class="chip chip--${healthy?'online':'offline'}">${healthy?'Healthy':'Offline'}</span></div></div><div class="stat-item"><div class="stat-item__label">Models</div><div class="stat-item__value">${models.length}</div></div></div></div>${models.length?`<div class="panel-section"><div class="panel-section__title">Available Models</div><table class="panel-table"><thead><tr><th>Model ID</th><th>Provider</th></tr></thead><tbody>${models.map(m=>`<tr><td>${monoCell(m.id,260)}</td><td style="color:rgba(255,255,255,0.38)">${m.litellm_params?.model?.split('/')[0]||'--'}</td></tr>`).join('')}</tbody></table></div>`:`<div class="panel-section"><div style="color:rgba(255,255,255,0.28);font-family:'Courier New',monospace;font-size:0.82rem">No models registered or LiteLLM offline.</div></div>`}`;
  } catch (e) { bodyEl.innerHTML = `<div class="panel-error">Offline -- LiteLLM may not be running</div>`; }
}

export async function loadModel(identifier) {
  const base = SERVICES_CONFIG.lmstudio.url;
  try { await fetch(`${base}/api/v1/models/load`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier}),signal:AbortSignal.timeout(30000)}); } catch {}
}

export async function unloadModel(identifier) {
  const base = SERVICES_CONFIG.lmstudio.url;
  try { await fetch(`${base}/api/v1/models/unload`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier}),signal:AbortSignal.timeout(15000)}); } catch {}
}

export async function ollamaPull(name) {
  const url = SERVICES_CONFIG.ollama.url;
  const statusEl = document.getElementById('ollama-pull-status');
  if (statusEl) statusEl.textContent = `Pulling ${name}...`;
  try {
    const res = await fetch(`${url}/api/pull`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,stream:false}),signal:AbortSignal.timeout(300000)});
    if (statusEl) statusEl.textContent = res.ok?`Done: ${name}`:`Failed (HTTP ${res.status})`;
  } catch (e) { if (statusEl) statusEl.textContent = `Error: ${e.message}`; }
}
