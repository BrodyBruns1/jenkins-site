/**
 * memoryApi.js -- generated memory snapshot loader
 *
 * Reads a generated JSON view of the real markdown memory stack and exposes
 * it to the dashboard with a safe static fallback when the export is missing.
 */

import { mergeMemoryOrbitData } from './memoryPlanet.js';

const MEMORY_DATA_URL = new URL('../data/memory-constellation.json', import.meta.url);
const POLL_INTERVAL = 45000;

export const memoryEventBus = new EventTarget();

let _intervalId = null;
let _snapshot = _buildFallbackSnapshot('Waiting for generated memory snapshot.');

async function fetchMemoryJSON() {
  const res = await fetch(MEMORY_DATA_URL, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).trim().slice(0, 160);
    throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
  }

  return res.json();
}

function _buildFallbackSnapshot(error = null) {
  return {
    status: 'fallback',
    mode: 'fallback',
    error,
    updatedAt: Date.now(),
    ...mergeMemoryOrbitData(),
  };
}

function _buildGeneratedSnapshot(payload) {
  const data = mergeMemoryOrbitData(payload);
  return {
    status: 'connected',
    mode: 'generated',
    error: null,
    updatedAt: Date.now(),
    schemaVersion: Number(payload?.schemaVersion || 1),
    ...data,
  };
}

function _dispatchSnapshot(snapshot) {
  memoryEventBus.dispatchEvent(new CustomEvent('memory-update', { detail: snapshot }));
  memoryEventBus.dispatchEvent(new CustomEvent('memory-connection', {
    detail: { status: snapshot.status, error: snapshot.error },
  }));
}

export async function pollMemorySnapshot() {
  const payload = await fetchMemoryJSON();
  _snapshot = _buildGeneratedSnapshot(payload);
  _dispatchSnapshot(_snapshot);
  return _snapshot;
}

export function startMemoryPolling() {
  const runPoll = () => {
    pollMemorySnapshot().catch((error) => {
      _snapshot = _buildFallbackSnapshot(error.message);
      _dispatchSnapshot(_snapshot);
    });
  };

  runPoll();
  _intervalId = setInterval(runPoll, POLL_INTERVAL);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(_intervalId);
      _intervalId = null;
      return;
    }

    if (!_intervalId) {
      runPoll();
      _intervalId = setInterval(runPoll, POLL_INTERVAL);
    }
  });
}

export function getMemorySnapshot() {
  return _snapshot;
}
