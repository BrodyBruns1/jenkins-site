/**
 * foodApi.js -- recipe snapshot loader for the food planet
 *
 * Polls /proxy/recipes/snapshot (recipe-api FastAPI service) and exposes
 * a live snapshot to the dashboard via foodEventBus.  Falls back to
 * www/data/food-orbit.json when the API is unreachable.
 */

import { RECIPES_CONFIG } from '../config.js';

const FALLBACK_URL  = new URL('../data/food-orbit.json', import.meta.url);
const POLL_INTERVAL = 30000;  // 30s — new recipes come in slowly

export const foodEventBus = new EventTarget();

let _intervalId = null;
let _snapshot   = _buildFallbackSnapshot('Waiting for recipe API.');

// ── Internal ──────────────────────────────────────────────────────────────────

function _buildFallbackSnapshot(error = null) {
  return {
    status:    'fallback',
    error,
    updatedAt: null,
    stats:     { count: 0, cuisines: 0, addedThisWeek: 0 },
    cuisines:  [],
    recipes:   [],
  };
}

function _buildLiveSnapshot(payload) {
  return {
    status:    'connected',
    error:     null,
    updatedAt: payload.updatedAt || Date.now(),
    stats:     payload.stats     || { count: 0, cuisines: 0, addedThisWeek: 0 },
    cuisines:  payload.cuisines  || [],
    recipes:   payload.recipes   || [],
  };
}

function _dispatch(snapshot) {
  foodEventBus.dispatchEvent(new CustomEvent('food-update', { detail: snapshot }));
}

async function _fetchSnapshot() {
  const base = RECIPES_CONFIG?.proxyBase;
  if (!base) {
    // Fall back to static JSON when config is absent
    const res = await fetch(FALLBACK_URL, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  const res = await fetch(`${base}/snapshot?limit=200`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function pollFoodSnapshot() {
  const payload = await _fetchSnapshot();
  _snapshot = _buildLiveSnapshot(payload);
  _dispatch(_snapshot);
  return _snapshot;
}

export function startFoodPolling() {
  const runPoll = () => {
    pollFoodSnapshot().catch((err) => {
      _snapshot = _buildFallbackSnapshot(err.message);
      _dispatch(_snapshot);
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

export function getFoodSnapshot() {
  return _snapshot;
}

/** Fetch full recipe detail (ingredients + steps) for the drill-down HUD. */
export async function fetchRecipeDetail(id) {
  const base = RECIPES_CONFIG?.proxyBase;
  if (!base) return null;
  const res = await fetch(`${base}/${id}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}
