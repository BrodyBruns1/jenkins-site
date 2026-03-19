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

// ── Fetch helper ───────────────────────────────────────────────────────────
async function jFetch(path) {
  const opts = { headers: {} };
  if (AUTH_HEADER) opts.headers['Authorization'] = AUTH_HEADER;
  const res = await fetch(`${JENKINS_URL}${path}`, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${path})`);
  return res.json();
}

// ── Status poll (every 5 s) ────────────────────────────────────────────────
async function pollStatus() {
  try {
    const [jobsData, queueData, execData] = await Promise.all([
      jFetch('/api/json?tree=jobs[name,color,url,lastBuild[number,result,duration,timestamp]]'),
      jFetch('/queue/api/json?tree=items[id,task[name]]'),
      jFetch('/computer/api/json?tree=computer[displayName,offline,idle,executors[currentExecutable[url]]]'),
    ]);

    const jobs = jobsData.jobs ?? [];

    // ── jobs-update ────────────────────────────────────────────────────────
    buildEventBus.dispatchEvent(new CustomEvent('jobs-update', { detail: { jobs } }));

    // ── queue-update ───────────────────────────────────────────────────────
    buildEventBus.dispatchEvent(new CustomEvent('queue-update', {
      detail: { queueDepth: (queueData.items ?? []).length },
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

    buildEventBus.dispatchEvent(new CustomEvent('connection-ok', { detail: {} }));

  } catch (err) {
    console.warn('[api] Poll failed:', err.message);
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
