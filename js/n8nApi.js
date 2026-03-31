/**
 * n8nApi.js -- authenticated polling plus generated automation-orbit fallback
 *
 * Uses the live n8n proxy when it works. If proxy auth is still blocked, the
 * dashboard falls back to a generated snapshot of the real workflow seed pack
 * instead of generic ghost data.
 */

import { N8N_CONFIG } from '../config.js';

const N8N_BASE = N8N_CONFIG?.proxyBase || '/proxy/n8n';
const SEED_DATA_URL = new URL('../data/n8n-orbit.json', import.meta.url);
const POLL_INTERVAL = 20000;
const EXECUTION_LIMIT = 24;

export const n8nEventBus = new EventTarget();

let _intervalId = null;
let _snapshot = null;
let _seedPayload = null;
let _seedLoadPromise = null;
let _seedMetaById = new Map();

const DEFAULT_FALLBACK_WORKFLOW_RUNS = [
  {
    id: 'seed-hourly-stack-pulse',
    name: 'Automation Orbit - Hourly Stack Pulse',
    description: 'Hourly schedule for public stack surfaces.',
    triggerKind: 'schedule',
    category: 'observability',
    cadence: 'Every 1h at :07',
    route: null,
    routeState: 'ready',
    usable: true,
    active: true,
    nodeCount: 4,
    tone: 'steady',
    targets: ['n8n Settings', 'TTS API Health', 'Memory Snapshot'],
    notes: ['Generated seed snapshot not loaded yet.'],
    status: 'active',
    executions: [
      { id: 'seed-hourly-1', status: 'success' },
      { id: 'seed-hourly-2', status: 'waiting' },
      { id: 'seed-hourly-3', status: 'success' },
    ],
  },
  {
    id: 'seed-daily-auth-audit',
    name: 'Automation Orbit - Daily Auth Audit',
    description: 'Daily watch on auth-gated services.',
    triggerKind: 'schedule',
    category: 'auth',
    cadence: 'Daily at 06:12',
    route: null,
    routeState: 'ready',
    usable: true,
    active: true,
    nodeCount: 3,
    tone: 'watchful',
    targets: ['n8n Public API Audit', 'Qdrant Collections Audit'],
    notes: ['Keeps blocked integrations visible while auth work catches up.'],
    status: 'waiting',
    executions: [
      { id: 'seed-auth-1', status: 'waiting' },
      { id: 'seed-auth-2', status: 'success' },
    ],
  },
  {
    id: 'seed-public-service-sweep',
    name: 'Automation Orbit - Public Service Sweep',
    description: 'Manual probe for public VM105 services.',
    triggerKind: 'manual',
    category: 'observability',
    cadence: null,
    route: null,
    routeState: 'manual',
    usable: true,
    active: false,
    nodeCount: 3,
    tone: 'hands-on',
    targets: ['n8n Settings', 'TTS API Health'],
    notes: ['One-click editor-side probe.'],
    status: 'idle',
    executions: [{ id: 'seed-public-1', status: 'idle' }],
  },
  {
    id: 'seed-ops-intake-webhook',
    name: 'Automation Orbit - Ops Intake Webhook',
    description: 'Webhook ingress point for future dashboard and alert traffic.',
    triggerKind: 'webhook',
    category: 'webhook',
    cadence: null,
    route: '/webhook/ops-intake',
    routeState: 'published-route-unresolved',
    usable: false,
    active: true,
    nodeCount: 2,
    tone: 'experimental',
    targets: ['Webhook ops-intake', 'Normalize Payload'],
    notes: ['Published in n8n, but production route is still unresolved.'],
    status: 'error',
    executions: [
      { id: 'seed-webhook-1', status: 'error' },
      { id: 'seed-webhook-2', status: 'waiting' },
    ],
  },
];

function _seedSupportData(payload = _seedPayload) {
  return {
    overview: payload?.overview || {},
    stats: payload?.stats || {},
    targets: Array.isArray(payload?.targets) ? payload.targets : [],
    supportingDocs: Array.isArray(payload?.supportingDocs) ? payload.supportingDocs : [],
    nextIdeas: Array.isArray(payload?.nextIdeas) ? payload.nextIdeas : [],
    sourcePaths: payload?.sourcePaths || {},
    generatedAt: payload?.generatedAt || null,
    claudeWorkflowClause: payload?.claudeWorkflowClause || '',
  };
}

function _dispatchSnapshot(snapshot) {
  n8nEventBus.dispatchEvent(new CustomEvent('n8n-update', { detail: snapshot }));
  n8nEventBus.dispatchEvent(new CustomEvent('n8n-connection', {
    detail: { status: snapshot.status, error: snapshot.error },
  }));
}

function _rememberSeedPayload(payload) {
  _seedPayload = payload && typeof payload === 'object' ? payload : null;
  _seedMetaById = new Map();

  const workflows = Array.isArray(_seedPayload?.workflowRuns) ? _seedPayload.workflowRuns : [];
  workflows.forEach((workflow) => {
    if (!workflow?.id) return;
    _seedMetaById.set(String(workflow.id), {
      name: workflow.name || '',
      description: workflow.description || '',
      triggerKind: workflow.triggerKind || null,
      category: workflow.category || null,
      cadence: workflow.cadence || null,
      route: workflow.route || null,
      routeState: workflow.routeState || null,
      usable: workflow.usable,
      active: workflow.active,
      nodeCount: workflow.nodeCount,
      targets: Array.isArray(workflow.targets) ? workflow.targets : [],
      notes: Array.isArray(workflow.notes) ? workflow.notes : [],
      tone: workflow.tone || 'steady',
      sourcePath: workflow.sourcePath || '',
      fileName: workflow.fileName || '',
    });
  });
}

async function fetchJSON(path, opts = {}) {
  const res = await fetch(`${N8N_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeout || 8000),
    ...opts,
  });

  if (!res.ok) {
    const message = await res.text().catch(() => '');
    const detail = message.trim().slice(0, 140);
    throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function fetchSeedJSON() {
  const res = await fetch(SEED_DATA_URL, {
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

async function loadSeedSnapshot(force = false) {
  if (!force && _seedPayload) return _seedPayload;
  if (!force && _seedLoadPromise) return _seedLoadPromise;

  _seedLoadPromise = fetchSeedJSON()
    .then((payload) => {
      _rememberSeedPayload(payload);
      return _seedPayload;
    })
    .finally(() => {
      _seedLoadPromise = null;
    });

  return _seedLoadPromise;
}

function _extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function _toId(value, fallback) {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function _normalizeExecutionStatus(raw = {}) {
  const status = String(raw.status ?? '').trim().toLowerCase();

  if (status === 'success' || status === 'succeeded' || status === 'completed') return 'success';
  if (status === 'error' || status === 'failed' || status === 'failure') return 'error';
  if (status === 'running' || status === 'executing' || status === 'in_progress') return 'running';
  if (status === 'waiting' || status === 'waiting_for_retry') return 'waiting';
  if (status === 'queued' || status === 'new' || status === 'pending') return 'queued';
  if (status === 'canceled' || status === 'cancelled' || status === 'crashed') return 'error';

  if (raw.waitTill) return 'waiting';
  if (raw.finished === false && raw.startedAt && !raw.stoppedAt) return 'running';
  if (raw.startedAt && !raw.stoppedAt) return 'running';
  if (raw.finished === true || raw.stoppedAt || raw.finishedAt) return 'success';
  return 'idle';
}

function _normalizeWorkflow(raw, index) {
  const id = _toId(raw.id ?? raw.workflowId, `workflow-${index + 1}`);
  const seedMeta = _seedMetaById.get(id) || {};

  return {
    id,
    name: String(raw.name ?? seedMeta.name ?? `Workflow ${index + 1}`).trim() || `Workflow ${index + 1}`,
    description: raw.description ?? seedMeta.description ?? '',
    active: Boolean(raw.active ?? raw.enabled ?? seedMeta.active ?? false),
    nodeCount:
      Array.isArray(raw.nodes) ? raw.nodes.length :
      Number(raw.nodeCount ?? raw.nodesCount ?? seedMeta.nodeCount ?? 0),
    updatedAt: raw.updatedAt ?? raw.updated ?? raw.createdAt ?? null,
    triggerKind: seedMeta.triggerKind ?? raw.triggerKind ?? null,
    category: seedMeta.category ?? raw.category ?? null,
    cadence: seedMeta.cadence ?? raw.cadence ?? null,
    route: seedMeta.route ?? raw.route ?? null,
    routeState: seedMeta.routeState ?? raw.routeState ?? null,
    usable: seedMeta.usable ?? raw.usable ?? true,
    targets: Array.isArray(seedMeta.targets) ? seedMeta.targets : [],
    notes: Array.isArray(seedMeta.notes) ? seedMeta.notes : [],
    tone: seedMeta.tone ?? raw.tone ?? 'steady',
    sourcePath: seedMeta.sourcePath ?? raw.sourcePath ?? '',
    fileName: seedMeta.fileName ?? raw.fileName ?? '',
  };
}

function _normalizeExecution(raw, index) {
  const workflowId = raw.workflowId ?? raw.workflow_id ?? raw.workflow?.id ?? raw.workflowData?.id;
  return {
    id: _toId(raw.id, `execution-${index + 1}`),
    workflowId: workflowId == null ? null : String(workflowId),
    status: _normalizeExecutionStatus(raw),
    startedAt: raw.startedAt ?? raw.createdAt ?? null,
    stoppedAt: raw.stoppedAt ?? raw.finishedAt ?? raw.updatedAt ?? null,
  };
}

function _normalizeSeedWorkflow(raw, index) {
  const workflow = {
    ..._normalizeWorkflow(raw, index),
    active: Boolean(raw.active ?? false),
    status: String(raw.status ?? '').trim().toLowerCase() || null,
    executions: Array.isArray(raw.executions)
      ? raw.executions.map((execution, execIndex) => ({
          id: _toId(execution.id, `${_toId(raw.id, `workflow-${index + 1}`)}-seed-${execIndex + 1}`),
          status: _normalizeExecutionStatus(execution),
        }))
      : [],
  };

  workflow.status = workflow.status || _deriveWorkflowStatus(workflow);
  return workflow;
}

function _deriveWorkflowStatus(workflow) {
  if (workflow.executions.some((execution) => execution.status === 'running')) return 'running';
  if (workflow.executions.some((execution) => execution.status === 'error')) return 'error';
  if (workflow.executions.some((execution) => execution.status === 'waiting')) return 'waiting';
  if (workflow.executions.some((execution) => execution.status === 'queued')) return 'queued';
  if (workflow.executions.some((execution) => execution.status === 'success')) return 'success';
  if (workflow.active) return 'active';
  return 'idle';
}

function _buildWorkflowRuns(workflows, executions) {
  const map = new Map();

  workflows.forEach((workflow, index) => {
    map.set(workflow.id, {
      ...workflow,
      status: workflow.active ? 'active' : 'idle',
      executions: [],
      order: index,
    });
  });

  executions.forEach((execution) => {
    const workflowId = execution.workflowId ?? 'unknown';
    if (!map.has(workflowId)) {
      const seedMeta = _seedMetaById.get(workflowId) || {};
      map.set(workflowId, {
        id: workflowId,
        name: seedMeta.name || `Workflow ${workflowId}`,
        description: seedMeta.description || '',
        active: false,
        nodeCount: 0,
        updatedAt: execution.startedAt ?? execution.stoppedAt ?? null,
        status: 'idle',
        executions: [],
        order: map.size,
        triggerKind: seedMeta.triggerKind ?? null,
        category: seedMeta.category ?? null,
        cadence: seedMeta.cadence ?? null,
        route: seedMeta.route ?? null,
        routeState: seedMeta.routeState ?? null,
        usable: seedMeta.usable ?? true,
        targets: Array.isArray(seedMeta.targets) ? seedMeta.targets : [],
        notes: Array.isArray(seedMeta.notes) ? seedMeta.notes : [],
        tone: seedMeta.tone ?? 'steady',
        sourcePath: seedMeta.sourcePath ?? '',
        fileName: seedMeta.fileName ?? '',
      });
    }
    map.get(workflowId).executions.push(execution);
  });

  return Array.from(map.values())
    .map((workflow) => {
      workflow.executions.sort((left, right) => {
        const leftTime = Date.parse(left.startedAt ?? left.stoppedAt ?? 0) || 0;
        const rightTime = Date.parse(right.startedAt ?? right.stoppedAt ?? 0) || 0;
        return rightTime - leftTime;
      });
      workflow.executions = workflow.executions.slice(0, 6);
      workflow.status = _deriveWorkflowStatus(workflow);
      return workflow;
    })
    .sort((left, right) => {
      const weight = { running: 5, error: 4, waiting: 3, queued: 2, success: 1, active: 1, idle: 0 };
      const statusDelta = (weight[right.status] || 0) - (weight[left.status] || 0);
      if (statusDelta !== 0) return statusDelta;
      if (right.executions.length !== left.executions.length) {
        return right.executions.length - left.executions.length;
      }
      return left.order - right.order;
    })
    .slice(0, 7);
}

function _buildSummary(workflowRuns) {
  const activeWorkflows = workflowRuns.filter((workflow) => workflow.active).length;
  let executionCount = 0;
  let runningExecutions = 0;
  let failedExecutions = 0;

  workflowRuns.forEach((workflow) => {
    executionCount += workflow.executions.length;
    workflow.executions.forEach((execution) => {
      if (execution.status === 'running') runningExecutions++;
      if (execution.status === 'error') failedExecutions++;
    });
  });

  return {
    workflowCount: workflowRuns.length,
    activeWorkflows,
    executionCount,
    runningExecutions,
    failedExecutions,
  };
}

function _statsFromRuns(workflowRuns) {
  return {
    workflowCount: workflowRuns.length,
    activeWorkflows: workflowRuns.filter((workflow) => workflow.active).length,
    scheduleCount: workflowRuns.filter((workflow) => workflow.triggerKind === 'schedule').length,
    manualCount: workflowRuns.filter((workflow) => workflow.triggerKind === 'manual').length,
    webhookCount: workflowRuns.filter((workflow) => workflow.triggerKind === 'webhook').length,
    usableCount: workflowRuns.filter((workflow) => workflow.usable !== false).length,
    routeIssueCount: workflowRuns.filter((workflow) => workflow.routeState === 'published-route-unresolved').length,
  };
}

function _buildSeedWorkflowRuns(payload = _seedPayload) {
  if (Array.isArray(payload?.workflowRuns) && payload.workflowRuns.length) {
    return payload.workflowRuns.map(_normalizeSeedWorkflow);
  }

  return DEFAULT_FALLBACK_WORKFLOW_RUNS.map((workflow, index) => _normalizeSeedWorkflow(workflow, index));
}

function _buildFallbackSnapshot(error = null) {
  const workflowRuns = _buildSeedWorkflowRuns();
  const seedSupport = _seedSupportData();

  return {
    status: 'fallback',
    mode: _seedPayload ? 'seed' : 'fallback',
    workflows: [],
    executions: [],
    workflowRuns,
    summary: _buildSummary(workflowRuns),
    stats: Object.keys(seedSupport.stats || {}).length ? seedSupport.stats : _statsFromRuns(workflowRuns),
    error,
    updatedAt: Date.now(),
    ...seedSupport,
  };
}

function _buildLiveSnapshot(workflows, executions, error = null) {
  const workflowRuns = _buildWorkflowRuns(workflows, executions);
  const seedSupport = _seedSupportData();
  const stats = {
    ..._statsFromRuns(workflowRuns),
    ...(seedSupport.stats || {}),
    workflowCount: workflowRuns.length,
    activeWorkflows: workflowRuns.filter((workflow) => workflow.active).length,
  };

  return {
    status: 'connected',
    mode: 'live',
    workflows,
    executions,
    workflowRuns,
    summary: _buildSummary(workflowRuns),
    stats,
    error,
    updatedAt: Date.now(),
    ...seedSupport,
  };
}

_snapshot = _buildFallbackSnapshot('Waiting for first n8n poll.');

export async function fetchWorkflows() {
  const payload = await fetchJSON('/api/v1/workflows?limit=100');
  return _extractArray(payload).map(_normalizeWorkflow);
}

export async function fetchExecutions() {
  const payload = await fetchJSON(`/api/v1/executions?includeData=false&limit=${EXECUTION_LIMIT}`);
  return _extractArray(payload).map(_normalizeExecution);
}

export async function pollN8n() {
  const [workflowsResult, executionsResult] = await Promise.allSettled([
    fetchWorkflows(),
    fetchExecutions(),
  ]);

  const workflows = workflowsResult.status === 'fulfilled' ? workflowsResult.value : [];
  const executions = executionsResult.status === 'fulfilled' ? executionsResult.value : [];
  const error =
    (workflowsResult.status === 'rejected' && workflowsResult.reason?.message) ||
    (executionsResult.status === 'rejected' && executionsResult.reason?.message) ||
    null;
  const hasLiveResponse =
    workflowsResult.status === 'fulfilled' ||
    executionsResult.status === 'fulfilled';

  _snapshot = hasLiveResponse
    ? _buildLiveSnapshot(workflows, executions, error)
    : _buildFallbackSnapshot(error);

  _dispatchSnapshot(_snapshot);
  return _snapshot;
}

export function startN8nPolling() {
  loadSeedSnapshot()
    .then(() => {
      if (_snapshot?.mode !== 'live') {
        _snapshot = _buildFallbackSnapshot(_snapshot?.error || null);
        _dispatchSnapshot(_snapshot);
      }
    })
    .catch(() => {});

  const runPoll = () => {
    pollN8n().catch((error) => {
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
      loadSeedSnapshot(true)
        .then(() => {
          if (_snapshot?.mode !== 'live') {
            _snapshot = _buildFallbackSnapshot(_snapshot?.error || null);
            _dispatchSnapshot(_snapshot);
          }
        })
        .catch(() => {});

      runPoll();
      _intervalId = setInterval(runPoll, POLL_INTERVAL);
    }
  });
}

export function getN8nSnapshot() {
  return _snapshot || _buildFallbackSnapshot('Waiting for first n8n poll.');
}
