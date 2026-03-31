/**
 * api.js — Jenkins poller + global event bus
 *
 * All Three.js components subscribe to `buildEventBus`.
 * This module owns all network I/O; components never fetch directly.
 *
 * Events dispatched on buildEventBus:
 *   jobs-update       { jobs: [{name,color,url,lastBuild}] }
 *   queue-update      { queueDepth: number }
 *   executors-update  { total, busy, utilization, computers }
 *   build-start       { jobName, buildNumber }   — NOT fired on initial load
 *   build-fail        { jobName, buildNumber }   — NOT fired on initial load
 *   all-green         {}
 *   connection-ok     {}
 *   connection-error  { error: string }
 *   queue-items-update { queueItems }
 *   hitl-update       { hitl }
 *   jenkins-update    { ...snapshot }
 */

import { JENKINS_URL, AUTH_HEADER } from '../config.js';

// ── Build Event Bus ────────────────────────────────────────────────────────
export const buildEventBus = new EventTarget();

// ── Internal state ─────────────────────────────────────────────────────────
// lastBuildNumbers: jobName → lastBuild.number seen on the *previous* poll.
// Populated silently on the first poll so comets never fire on page load.
const lastBuildNumbers = new Map();
let   isFirstPoll      = true;
let   statusIntervalId = null;
let   crumbCache       = null;
let   jenkinsSnapshot  = {
  status: 'idle',
  jobs: [],
  queueDepth: 0,
  queueItems: [],
  executors: { total: 0, busy: 0, utilization: 0, computers: [] },
  runningJobs: [],
  hitl: [],
  lastUpdated: null,
  error: null,
};

function encodeJobPath(jobName = '') {
  return String(jobName)
    .split('/')
    .filter(Boolean)
    .map((segment) => `job/${encodeURIComponent(segment)}`)
    .join('/');
}

// ── Fetch helper ───────────────────────────────────────────────────────────
async function jFetch(path, opts = {}) {
  const request = { headers: {}, ...opts };
  if (AUTH_HEADER) request.headers['Authorization'] = AUTH_HEADER;
  const res = await fetch(`${JENKINS_URL}${path}`, request);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${path})`);
  return res.json();
}

async function jMaybeFetch(path, opts = {}) {
  const request = { headers: {}, ...opts };
  if (AUTH_HEADER) request.headers['Authorization'] = AUTH_HEADER;
  const res = await fetch(`${JENKINS_URL}${path}`, request);
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${path})`);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function getCrumb() {
  if (crumbCache && Date.now() - crumbCache.fetchedAt < 60 * 1000) {
    return crumbCache;
  }

  try {
    const data = await jMaybeFetch('/crumbIssuer/api/json');
    if (!data?.crumbRequestField || !data?.crumb) return null;
    crumbCache = {
      crumbRequestField: data.crumbRequestField,
      crumb: data.crumb,
      fetchedAt: Date.now(),
    };
    return crumbCache;
  } catch (_error) {
    return null;
  }
}

async function postJenkins(pathOrUrl, { method = 'POST', body = null } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${JENKINS_URL}${pathOrUrl}`;
  const headers = {};
  if (AUTH_HEADER) headers.Authorization = AUTH_HEADER;

  const crumb = await getCrumb();
  if (crumb?.crumbRequestField && crumb?.crumb) {
    headers[crumb.crumbRequestField] = crumb.crumb;
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 160);
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
}

function normalizeQueueItems(items = []) {
  return items.map((item) => ({
    id: item.id,
    name: item.task?.name || item.name || `Queue Item ${item.id}`,
    why: item.why || '',
    stuck: Boolean(item.stuck),
    inQueueSince: item.inQueueSince || null,
    params: item.params || '',
  }));
}

function normalizeHitlEntries(entries = [], fallback = {}) {
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: String(entry.id || entry.input?.id || entry.proceedUrl || entry.abortUrl || ''),
      jobName: fallback.jobName || entry.jobName || 'unknown-job',
      buildNumber: fallback.buildNumber ?? entry.buildNumber ?? null,
      message: entry.message || entry.input?.message || entry.caption || 'Approval required',
      proceedUrl: entry.proceedUrl || entry.input?.proceedUrl || null,
      abortUrl: entry.abortUrl || entry.input?.abortUrl || null,
      proceedText: entry.proceedText || entry.ok || 'Approve',
      abortText: entry.abortText || entry.cancel || 'Reject',
      timeoutAt: entry.proceedTimeout || entry.timeoutAt || null,
    }))
    .filter((entry) => entry.id || entry.proceedUrl || entry.abortUrl);
}

async function fetchHitlState(jobs = []) {
  const runningJobs = jobs.filter((job) =>
    String(job.color || '').endsWith('_anime') &&
    Number.isFinite(job.lastBuild?.number)
  );

  if (!runningJobs.length) return [];

  const responses = await Promise.allSettled(
    runningJobs.map(async (job) => {
      const jobPath = encodeJobPath(job.name);
      if (!jobPath) return [];
      const path = `/${jobPath}/${job.lastBuild.number}/wfapi/pendingInputActions`;
      const payload = await jMaybeFetch(path);
      if (!Array.isArray(payload) || !payload.length) return [];
      return normalizeHitlEntries(payload, {
        jobName: job.name,
        buildNumber: job.lastBuild.number,
      });
    })
  );

  return responses.flatMap((response) => response.status === 'fulfilled' ? response.value : []);
}

function updateSnapshot(partial = {}) {
  jenkinsSnapshot = {
    ...jenkinsSnapshot,
    ...partial,
  };
  buildEventBus.dispatchEvent(new CustomEvent('jenkins-update', { detail: jenkinsSnapshot }));
}

// ── Status poll (every 5 s) ────────────────────────────────────────────────
async function pollStatus() {
  try {
    const [jobsData, queueData, execData] = await Promise.all([
      jFetch('/api/json?tree=jobs[name,color,url,lastBuild[number,result,duration,timestamp,building,url]]'),
      jFetch('/queue/api/json?tree=items[id,task[name],why,inQueueSince,stuck,params]'),
      jFetch('/computer/api/json?tree=computer[displayName,offline,idle,executors[currentExecutable[url]]]'),
    ]);

    const jobs = jobsData.jobs ?? [];
    const queueItems = normalizeQueueItems(queueData.items ?? []);

    // ── jobs-update ────────────────────────────────────────────────────────
    buildEventBus.dispatchEvent(new CustomEvent('jobs-update', { detail: { jobs } }));

    // ── queue-update ───────────────────────────────────────────────────────
    buildEventBus.dispatchEvent(new CustomEvent('queue-update', {
      detail: { queueDepth: queueItems.length },
    }));
    buildEventBus.dispatchEvent(new CustomEvent('queue-items-update', {
      detail: { queueItems },
    }));

    // ── executors-update ───────────────────────────────────────────────────
    const computers = execData.computer ?? [];
    let total = 0, busy = 0;
    for (const c of computers) {
      if (c.offline) continue;
      for (const ex of (c.executors ?? [])) {
        total++;
        if (ex.currentExecutable) busy++;
      }
    }
    buildEventBus.dispatchEvent(new CustomEvent('executors-update', {
      detail: { total, busy, utilization: total > 0 ? busy / total : 0, computers },
    }));

    const hitl = await fetchHitlState(jobs);
    buildEventBus.dispatchEvent(new CustomEvent('hitl-update', {
      detail: { hitl },
    }));

    // ── comet diff — build-start / build-fail ──────────────────────────────
    // Decision: no events fire on the initial page load (isFirstPoll guard).
    // Subsequent polls diff against lastBuildNumbers; only strictly higher
    // build numbers trigger events.
    for (const job of jobs) {
      const curr = job.lastBuild?.number;
      if (curr == null) continue;

      if (isFirstPoll) {
        // Seed the map silently — no events
        lastBuildNumbers.set(job.name, curr);
      } else {
        const prev = lastBuildNumbers.get(job.name);
        if (prev != null && curr > prev) {
          buildEventBus.dispatchEvent(new CustomEvent('build-start', {
            detail: { jobName: job.name, buildNumber: curr },
          }));
          if (job.lastBuild.result === 'FAILURE') {
            buildEventBus.dispatchEvent(new CustomEvent('build-fail', {
              detail: { jobName: job.name, buildNumber: curr },
            }));
          }
        }
        lastBuildNumbers.set(job.name, curr);
      }
    }
    isFirstPoll = false;

    // ── all-green ──────────────────────────────────────────────────────────
    // All jobs are success, not-built, or disabled (ignores disabled/notbuilt
    // as neutral; only true failure or building breaks the green state).
    const hasProblems = jobs.some(j =>
      j.color === 'red'       || j.color === 'red_anime'    ||
      j.color === 'yellow'    || j.color === 'yellow_anime' ||
      j.color === 'aborted'   || j.color === 'aborted_anime'
    );
    if (!hasProblems && jobs.length > 0) {
      buildEventBus.dispatchEvent(new CustomEvent('all-green', { detail: {} }));
    }

    updateSnapshot({
      status: 'connected',
      jobs,
      queueDepth: queueItems.length,
      queueItems,
      executors: { total, busy, utilization: total > 0 ? busy / total : 0, computers },
      runningJobs: jobs.filter((job) => String(job.color || '').endsWith('_anime')),
      hitl,
      lastUpdated: Date.now(),
      error: null,
    });
    buildEventBus.dispatchEvent(new CustomEvent('connection-ok', { detail: {} }));

  } catch (err) {
    console.warn('[api] Poll failed:', err.message);
    updateSnapshot({
      status: 'error',
      error: err.message,
      lastUpdated: Date.now(),
      hitl: [],
    });
    buildEventBus.dispatchEvent(new CustomEvent('connection-error', {
      detail: { error: err.message },
    }));
  }
}

// ── Polling lifecycle ──────────────────────────────────────────────────────
function schedulePolling() {
  pollStatus();
  statusIntervalId = setInterval(pollStatus, 5000);
}

export function startPolling() {
  schedulePolling();

  // Pause when the tab is hidden; resume (with re-seed) when it returns.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(statusIntervalId);
      statusIntervalId = null;
    } else {
      // Reset isFirstPoll so we re-seed instead of firing stale comets
      isFirstPoll = true;
      schedulePolling();
    }
  });
}

export function stopPolling() {
  clearInterval(statusIntervalId);
  statusIntervalId = null;
}

export function getJenkinsSnapshot() {
  return jenkinsSnapshot;
}

export async function requestHitlDecision(entry, action = 'approve') {
  if (!entry || typeof entry !== 'object') {
    throw new Error('No HITL entry selected.');
  }

  if (action === 'reject') {
    if (!entry.abortUrl) throw new Error('Jenkins did not expose an abort URL for this approval.');
    await postJenkins(entry.abortUrl, { method: 'POST' });
  } else {
    const target = entry.proceedUrl || entry.url;
    if (!target) throw new Error('Jenkins did not expose a proceed URL for this approval.');
    await postJenkins(target, { method: 'POST' });
  }

  await pollStatus();
}
