/**
 * dockerApi.js -- Portainer Docker API client
 *
 * Polls container & network data from Portainer via nginx proxy.
 * Provides container actions (start/stop/restart).
 * Manages custom container groups (localStorage).
 *
 * Events on dockerEventBus:
 *   containers-update  { containers, groups }
 *   networks-update    { networks }
 *   docker-connection  { status:'connected'|'error', error? }
 */

const PORTAINER_BASE = '/proxy/portainer';
const ENDPOINT_ID    = 3;            // local Docker engine in Portainer
const POLL_INTERVAL  = 15000;

export const dockerEventBus = new EventTarget();

let _containers = [];
let _networks   = [];
let _intervalId = null;

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchJSON(path, opts = {}) {
  const res = await fetch(`${PORTAINER_BASE}${path}`, {
    signal: AbortSignal.timeout(opts.timeout || 8000),
    ...opts,
  });
  if (!res.ok && res.status !== 304) throw new Error(`HTTP ${res.status}`);
  if (res.status === 204 || res.status === 304) return null;
  return res.json();
}

// ── Container actions ───────────────────────────────────────────────────────

export async function containerAction(containerId, action) {
  await fetch(
    `${PORTAINER_BASE}/endpoints/${ENDPOINT_ID}/docker/containers/${containerId}/${action}`,
    { method: 'POST', signal: AbortSignal.timeout(30000) }
  );
  setTimeout(pollDocker, 1200);
}

export async function fetchContainerStats(containerId) {
  const stats = await fetchJSON(
    `/endpoints/${ENDPOINT_ID}/docker/containers/${containerId}/stats?stream=false`,
    { timeout: 10000 }
  );

  const cpuUsage = stats?.cpu_stats?.cpu_usage?.total_usage || 0;
  const prevCpuUsage = stats?.precpu_stats?.cpu_usage?.total_usage || 0;
  const systemUsage = stats?.cpu_stats?.system_cpu_usage || 0;
  const prevSystemUsage = stats?.precpu_stats?.system_cpu_usage || 0;
  const onlineCpus =
    stats?.cpu_stats?.online_cpus ||
    stats?.cpu_stats?.cpu_usage?.percpu_usage?.length ||
    1;

  const cpuDelta = cpuUsage - prevCpuUsage;
  const systemDelta = systemUsage - prevSystemUsage;
  const cpuPercent = cpuDelta > 0 && systemDelta > 0
    ? (cpuDelta / systemDelta) * onlineCpus * 100
    : 0;

  const memStats = stats?.memory_stats || {};
  const inactive = memStats.stats?.inactive_file || memStats.stats?.cache || 0;
  const memoryUsage = Math.max((memStats.usage || 0) - inactive, 0);
  const memoryLimit = memStats.limit || 0;
  const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

  const networkEntries = Object.values(stats?.networks || {});
  const networkRx = networkEntries.reduce((sum, net) => sum + (net.rx_bytes || 0), 0);
  const networkTx = networkEntries.reduce((sum, net) => sum + (net.tx_bytes || 0), 0);

  return {
    readAt: Date.now(),
    cpuPercent,
    memoryUsage,
    memoryLimit,
    memoryPercent,
    networkRx,
    networkTx,
  };
}

// ── Parse raw Portainer/Docker container JSON into clean objects ─────────────

function parseContainer(c) {
  const name   = (c.Names?.[0] || '').replace(/^\//, '');
  const state  = c.State || 'unknown';
  const status = c.Status || '';
  const health = status.includes('healthy') && !status.includes('unhealthy')
    ? 'healthy'
    : status.includes('unhealthy') ? 'unhealthy' : null;

  const image      = c.Image || '';
  const shortImage = image.replace(/^.*\//, '').split('@')[0];

  const ports = (c.Ports || []).map(p =>
    p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}` : String(p.PrivatePort));

  const labels         = c.Labels || {};
  const composeProject = labels['com.docker.compose.project'] || null;
  const composeService = labels['com.docker.compose.service'] || null;

  const networks = Object.keys(c.NetworkSettings?.Networks || {});
  const created  = c.Created ? new Date(c.Created * 1000) : null;

  return {
    id: c.Id, shortId: (c.Id || '').substring(0, 12),
    name, state, status, health,
    image, shortImage,
    ports, composeProject, composeService,
    networks, created, labels,
  };
}

// ── Group computation ───────────────────────────────────────────────────────

function computeGroups(containers) {
  const custom = JSON.parse(localStorage.getItem('docker-groups') || 'null');

  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    const groups   = {};
    const assigned = new Set();
    for (const [gName, members] of Object.entries(custom)) {
      const memberList = Array.isArray(members) ? members : [];
      groups[gName] = containers.filter(c => memberList.includes(c.name));
      memberList.forEach(n => assigned.add(n));
    }
    const rest = containers.filter(c => !assigned.has(c.name));
    if (rest.length) groups.ungrouped = rest;
    return groups;
  }

  // Default: by Docker Compose project
  const groups = {};
  for (const c of containers) {
    const g = c.composeProject || 'standalone';
    (groups[g] ??= []).push(c);
  }
  return groups;
}

// ── Main poll ───────────────────────────────────────────────────────────────

async function pollDocker() {
  try {
    const [cRes, nRes] = await Promise.allSettled([
      fetchJSON(`/endpoints/${ENDPOINT_ID}/docker/containers/json?all=true`),
      fetchJSON(`/endpoints/${ENDPOINT_ID}/docker/networks`),
    ]);

    if (cRes.status === 'fulfilled' && cRes.value) {
      _containers = cRes.value.map(parseContainer);
      dockerEventBus.dispatchEvent(new CustomEvent('containers-update', {
        detail: { containers: _containers, groups: computeGroups(_containers) },
      }));
    }

    if (nRes.status === 'fulfilled' && nRes.value) {
      _networks = nRes.value.filter(n => !['bridge', 'host', 'none'].includes(n.Name));
      dockerEventBus.dispatchEvent(new CustomEvent('networks-update', {
        detail: { networks: _networks },
      }));
    }

    dockerEventBus.dispatchEvent(new CustomEvent('docker-connection', {
      detail: { status: 'connected' },
    }));
  } catch (e) {
    dockerEventBus.dispatchEvent(new CustomEvent('docker-connection', {
      detail: { status: 'error', error: e.message },
    }));
  }
}

export function startDockerPolling() {
  pollDocker();
  _intervalId = setInterval(pollDocker, POLL_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(_intervalId); _intervalId = null; }
    else { pollDocker(); _intervalId = setInterval(pollDocker, POLL_INTERVAL); }
  });
}

export { pollDocker };
export function getContainers() { return _containers; }
export function getNetworks()   { return _networks; }

// ── Group management (localStorage) ─────────────────────────────────────────

export function getCustomGroups() {
  return JSON.parse(localStorage.getItem('docker-groups') || 'null');
}

export function saveCustomGroups(groups) {
  localStorage.setItem('docker-groups', JSON.stringify(groups));
  dockerEventBus.dispatchEvent(new CustomEvent('containers-update', {
    detail: { containers: _containers, groups: computeGroups(_containers) },
  }));
}

export function resetGroups() {
  localStorage.removeItem('docker-groups');
  dockerEventBus.dispatchEvent(new CustomEvent('containers-update', {
    detail: { containers: _containers, groups: computeGroups(_containers) },
  }));
}
