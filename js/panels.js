/**
 * panels.js -- Detail panel open/close/load system
 *
 * Manages the slide-in service detail panels. Panel HTML lives in
 * dashboard.html; data loading is delegated to services.js loaders.
 *
 * Also manages the Docker container detail panel and group editor modal.
 */

import {
  loadLMStudioPanel, loadOllamaPanel,  loadProxmoxPanel,
  loadTrueNASPanel,  loadJellyfinPanel, loadLiteLLMPanel,
  loadModel, unloadModel, ollamaPull, fmtBytes, fmtUptime,
} from './services.js';

import {
  containerAction, getContainers, getCustomGroups,
  saveCustomGroups, resetGroups, dockerEventBus, fetchContainerStats,
} from './dockerApi.js';

const LOADERS = {
  lmstudio: loadLMStudioPanel,
  ollama:   loadOllamaPanel,
  proxmox:  loadProxmoxPanel,
  truenas:  loadTrueNASPanel,
  jellyfin: loadJellyfinPanel,
  litellm:  loadLiteLLMPanel,
};

let _current = null;
let _dockerStatsTimer = null;
const _dockerStatsHistory = new Map();
const DOCKER_STATS_INTERVAL = 3000;
const DOCKER_HISTORY_LIMIT = 30;

// ── Public API ────────────────────────────────────────────────────────────

export function openPanel(id) {
  if (id !== 'docker') _stopDockerStatsPolling();
  if (_current && _current !== id) {
    document.getElementById(`panel-${_current}`)?.classList.remove('is-open');
  }
  _current = id;
  document.getElementById('panelOverlay')?.classList.add('is-open');
  const panel = document.getElementById(`panel-${id}`);
  if (panel) panel.classList.add('is-open');
  document.body.style.overflow = 'hidden';

  const bodyEl = document.getElementById(`panel-${id}-body`);
  if (bodyEl) bodyEl.innerHTML = '<div class="panel-loading">Loading...</div>';

  _loadData(id);
}

export function closePanel() {
  if (!_current) return;
  if (_current === 'docker') _stopDockerStatsPolling();
  document.getElementById('panelOverlay')?.classList.remove('is-open');
  document.getElementById(`panel-${_current}`)?.classList.remove('is-open');
  document.body.style.overflow = '';
  _current = null;
}

export function refreshPanel(id) {
  if (_current !== id) return;
  _loadData(id);
}

// ── Internal ────────────────────────────────────────────────────────────────

async function _loadData(id) {
  const btn    = document.querySelector(`#panel-${id} .detail-panel__refresh`);
  const bodyEl = document.getElementById(`panel-${id}-body`);
  if (!bodyEl) return;
  if (btn) btn.classList.add('spinning');
  try {
    await (LOADERS[id]?.(bodyEl) ?? Promise.resolve());
  } catch (e) {
    bodyEl.innerHTML = `<div class="panel-error">Error: ${e.message}</div>`;
  }
  if (btn) btn.classList.remove('spinning');
}

// ── Docker container panel ──────────────────────────────────────────────────

let _dockerContainerId = null;

function openDockerPanel(containerId) {
  _stopDockerStatsPolling();
  _dockerContainerId = containerId;
  window._lastDockerContainerId = containerId;

  if (_current && _current !== 'docker') {
    document.getElementById(`panel-${_current}`)?.classList.remove('is-open');
  }
  _current = 'docker';
  document.getElementById('panelOverlay')?.classList.add('is-open');
  const panel = document.getElementById('panel-docker');
  if (panel) panel.classList.add('is-open');
  document.body.style.overflow = 'hidden';

  _loadDockerPanel();
}

async function _loadDockerPanel() {
  const bodyEl = document.getElementById('panel-docker-body');
  const titleEl = document.querySelector('#panel-docker .detail-panel__title');
  const subEl   = document.querySelector('#panel-docker .detail-panel__subtitle');
  if (!bodyEl) return;

  const containers = getContainers();
  const c = containers.find(x => x.id === _dockerContainerId);
  if (!c) {
    bodyEl.innerHTML = '<div class="panel-error">Container not found</div>';
    return;
  }

  if (titleEl) titleEl.textContent = c.name;
  if (subEl)   subEl.textContent = c.shortImage;

  const sk = c.state === 'running'
    ? (c.health === 'healthy' ? 'running (healthy)' :
       c.health === 'unhealthy' ? 'running (unhealthy)' : 'running')
    : c.state;

  const chipClass = c.state === 'running'
    ? (c.health === 'unhealthy' ? 'chip--paused' : 'chip--running')
    : c.state === 'exited' ? 'chip--stopped'
    : c.state === 'paused' ? 'chip--paused'
    : 'chip--idle';

  const isRunning = c.state === 'running';
  const isPaused  = c.state === 'paused';
  const latestStats = _getLatestDockerStats(c.id);

  bodyEl.innerHTML = `
    <div class="panel-section">
      <div class="panel-section__title">Status</div>
      <div class="stat-grid">
        <div class="stat-item">
          <div class="stat-item__label">State</div>
          <div class="stat-item__value"><span class="chip ${chipClass}">${sk}</span></div>
        </div>
        <div class="stat-item">
          <div class="stat-item__label">Uptime</div>
          <div class="stat-item__value" style="font-size:0.8rem">${c.status || '--'}</div>
        </div>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section__title">Actions</div>
      <div class="docker-actions">
        <button class="panel-btn docker-actions panel-btn--start" id="docker-act-start"
                ${isRunning ? 'disabled' : ''}>Start</button>
        <button class="panel-btn docker-actions panel-btn--stop" id="docker-act-stop"
                ${!isRunning && !isPaused ? 'disabled' : ''}>Stop</button>
        <button class="panel-btn docker-actions panel-btn--restart" id="docker-act-restart"
                ${!isRunning ? 'disabled' : ''}>Restart</button>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section__title">Live Stats</div>
      <div class="docker-stats-grid">
        <div class="docker-stat-card">
          <div class="docker-stat-card__label">CPU</div>
          <div class="docker-stat-card__value" id="docker-stats-cpu-value">${_fmtPercent(latestStats?.cpuPercent)}</div>
          <canvas class="docker-sparkline" id="docker-cpu-sparkline" width="320" height="70"></canvas>
        </div>
        <div class="docker-stat-card">
          <div class="docker-stat-card__label">Memory</div>
          <div class="docker-stat-card__value" id="docker-stats-mem-value">${_fmtBytes(latestStats?.memoryUsage)}${latestStats?.memoryLimit ? ` / ${_fmtBytes(latestStats.memoryLimit)}` : ''}</div>
          <canvas class="docker-sparkline" id="docker-mem-sparkline" width="320" height="70"></canvas>
          <div class="docker-stat-card__meta" id="docker-stats-mem-percent">${_fmtPercent(latestStats?.memoryPercent)}</div>
        </div>
      </div>
      <div class="docker-network-row">
        <span class="docker-network-pill">RX <strong id="docker-stats-rx-value">${_fmtBytes(latestStats?.networkRx)}</strong></span>
        <span class="docker-network-pill">TX <strong id="docker-stats-tx-value">${_fmtBytes(latestStats?.networkTx)}</strong></span>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section__title">Details</div>
      <div class="docker-detail-row">
        <span class="docker-detail-key">ID</span>
        <span class="docker-detail-val">${c.shortId}</span>
      </div>
      <div class="docker-detail-row">
        <span class="docker-detail-key">Image</span>
        <span class="docker-detail-val">${c.image}</span>
      </div>
      <div class="docker-detail-row">
        <span class="docker-detail-key">Created</span>
        <span class="docker-detail-val">${c.created ? c.created.toLocaleString() : '--'}</span>
      </div>
      <div class="docker-detail-row">
        <span class="docker-detail-key">Ports</span>
        <span class="docker-detail-val">${c.ports.length ? c.ports.join(', ') : 'none'}</span>
      </div>
      <div class="docker-detail-row">
        <span class="docker-detail-key">Networks</span>
        <span class="docker-detail-val">${c.networks.join(', ') || 'none'}</span>
      </div>
      <div class="docker-detail-row">
        <span class="docker-detail-key">Compose</span>
        <span class="docker-detail-val">${c.composeProject || 'standalone'}${c.composeService ? ' / ' + c.composeService : ''}</span>
      </div>
    </div>
  `;

  // Wire action buttons
  const startBtn   = document.getElementById('docker-act-start');
  const stopBtn    = document.getElementById('docker-act-stop');
  const restartBtn = document.getElementById('docker-act-restart');

  const doAction = async (btn, action) => {
    btn.disabled = true;
    btn.textContent = '...';
    try {
      await containerAction(c.id, action);
      btn.textContent = 'Done';
      setTimeout(() => _loadDockerPanel(), 2000);
    } catch (e) {
      btn.textContent = 'Err';
      setTimeout(() => _loadDockerPanel(), 2000);
    }
  };

  startBtn?.addEventListener('click',   () => doAction(startBtn, 'start'));
  stopBtn?.addEventListener('click',    () => doAction(stopBtn, 'stop'));
  restartBtn?.addEventListener('click', () => doAction(restartBtn, 'restart'));

  _startDockerStatsPolling(c.id);
  _renderDockerStatsVisuals(c.id);
}

function _startDockerStatsPolling(containerId) {
  _stopDockerStatsPolling();
  _pollDockerStats(containerId);
  _dockerStatsTimer = setInterval(() => _pollDockerStats(containerId), DOCKER_STATS_INTERVAL);
}

function _stopDockerStatsPolling() {
  if (_dockerStatsTimer) {
    clearInterval(_dockerStatsTimer);
    _dockerStatsTimer = null;
  }
}

async function _pollDockerStats(containerId) {
  try {
    const sample = await fetchContainerStats(containerId);
    const history = _dockerStatsHistory.get(containerId) || [];
    history.push(sample);
    if (history.length > DOCKER_HISTORY_LIMIT) history.splice(0, history.length - DOCKER_HISTORY_LIMIT);
    _dockerStatsHistory.set(containerId, history);
    _renderDockerStatsVisuals(containerId);
  } catch (_e) {
    // Keep the panel usable even when stats sampling fails intermittently.
  }
}

function _getLatestDockerStats(containerId) {
  const history = _dockerStatsHistory.get(containerId);
  return history?.[history.length - 1] || null;
}

function _renderDockerStatsVisuals(containerId) {
  if (_current !== 'docker' || _dockerContainerId !== containerId) return;

  const history = _dockerStatsHistory.get(containerId) || [];
  const latest = history[history.length - 1] || null;

  const cpuEl = document.getElementById('docker-stats-cpu-value');
  const memEl = document.getElementById('docker-stats-mem-value');
  const memPctEl = document.getElementById('docker-stats-mem-percent');
  const rxEl = document.getElementById('docker-stats-rx-value');
  const txEl = document.getElementById('docker-stats-tx-value');

  if (cpuEl) cpuEl.textContent = _fmtPercent(latest?.cpuPercent);
  if (memEl) {
    memEl.textContent = latest
      ? `${_fmtBytes(latest.memoryUsage)}${latest.memoryLimit ? ` / ${_fmtBytes(latest.memoryLimit)}` : ''}`
      : '--';
  }
  if (memPctEl) memPctEl.textContent = _fmtPercent(latest?.memoryPercent);
  if (rxEl) rxEl.textContent = _fmtBytes(latest?.networkRx);
  if (txEl) txEl.textContent = _fmtBytes(latest?.networkTx);

  const cpuCanvas = document.getElementById('docker-cpu-sparkline');
  const memCanvas = document.getElementById('docker-mem-sparkline');
  if (cpuCanvas) {
    _drawSparkline(
      cpuCanvas,
      history.map(sample => sample.cpuPercent),
      { stroke: 'rgba(0, 214, 255, 0.92)', fill: 'rgba(0, 214, 255, 0.14)' }
    );
  }
  if (memCanvas) {
    _drawSparkline(
      memCanvas,
      history.map(sample => sample.memoryPercent),
      { stroke: 'rgba(82, 255, 162, 0.92)', fill: 'rgba(82, 255, 162, 0.14)' }
    );
  }
}

function _drawSparkline(canvas, values, colors) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const padding = 6;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height - padding);
  ctx.lineTo(width, height - padding);
  ctx.stroke();

  if (!values.length) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.font = '11px Courier New';
    ctx.fillText('waiting for samples...', padding, height * 0.58);
    return;
  }

  const maxValue = Math.max(5, ...values);
  const minValue = Math.min(0, ...values);
  const span = Math.max(maxValue - minValue, 1);

  ctx.beginPath();
  values.forEach((value, idx) => {
    const x = padding + ((width - padding * 2) * idx) / Math.max(values.length - 1, 1);
    const norm = (value - minValue) / span;
    const y = height - padding - norm * (height - padding * 2);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.lineTo(width - padding, height - padding);
  ctx.lineTo(padding, height - padding);
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();

  ctx.beginPath();
  values.forEach((value, idx) => {
    const x = padding + ((width - padding * 2) * idx) / Math.max(values.length - 1, 1);
    const norm = (value - minValue) / span;
    const y = height - padding - norm * (height - padding * 2);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function _fmtPercent(value) {
  if (value == null || Number.isNaN(value)) return '--';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function _fmtBytes(value) {
  if (value == null || Number.isNaN(value)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx++;
  }
  const decimals = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)} ${units[unitIdx]}`;
}

// ── Docker group editor modal ───────────────────────────────────────────────

function openGroupEditor() {
  const overlay = document.getElementById('docker-group-modal');
  if (!overlay) return;
  overlay.classList.add('is-open');
  _renderGroupEditor();
}

function closeGroupEditor() {
  const overlay = document.getElementById('docker-group-modal');
  if (overlay) overlay.classList.remove('is-open');
}

function _renderGroupEditor() {
  const bodyEl = document.getElementById('group-editor-body');
  if (!bodyEl) return;

  const containers = getContainers();
  const custom     = getCustomGroups();

  // Build current assignment map: containerName → groupName
  const assignments = {};
  if (custom) {
    for (const [gName, members] of Object.entries(custom)) {
      for (const name of members) assignments[name] = gName;
    }
  } else {
    for (const c of containers) {
      assignments[c.name] = c.composeProject || 'standalone';
    }
  }

  // Collect all group names
  const allGroups = [...new Set(Object.values(assignments))].sort();

  bodyEl.innerHTML = `
    <div class="group-add-row">
      <input type="text" id="group-new-name" placeholder="New group name..." />
      <button class="panel-btn" id="group-add-btn">+ Add</button>
    </div>
    <table class="group-table">
      <thead><tr><th>Container</th><th>Group</th></tr></thead>
      <tbody>
        ${containers.map(c => `
          <tr>
            <td>${c.name}</td>
            <td>
              <select data-container="${c.name}">
                ${allGroups.map(g =>
                  `<option value="${g}" ${assignments[c.name] === g ? 'selected' : ''}>${g}</option>`
                ).join('')}
              </select>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // Add group button
  document.getElementById('group-add-btn')?.addEventListener('click', () => {
    const input = document.getElementById('group-new-name');
    const name  = input?.value?.trim();
    if (!name) return;
    // Re-render with new group available
    if (!allGroups.includes(name)) {
      allGroups.push(name);
      _renderGroupEditor();
    }
    input.value = '';
  });
}

function _saveGroupsFromEditor() {
  const selects = document.querySelectorAll('#group-editor-body select[data-container]');
  const groups  = {};
  for (const sel of selects) {
    const cName = sel.dataset.container;
    const gName = sel.value;
    (groups[gName] ??= []).push(cName);
  }
  saveCustomGroups(groups);
  closeGroupEditor();
}

// ── Init — wire up global event handlers ──────────────────────────────────

export function initPanels() {
  // ESC key closes the current panel or modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('docker-group-modal');
      if (modal?.classList.contains('is-open')) {
        closeGroupEditor();
      } else {
        closePanel();
      }
    }
  });

  // Expose model management to inline onclick handlers in panel HTML
  window._svcLoadModel = async (identifier) => {
    const btns = [...document.querySelectorAll('.panel-btn')];
    const btn  = btns.find(b => b.getAttribute('onclick')?.includes(identifier));
    if (btn) { btn.textContent = '...'; btn.disabled = true; }
    await loadModel(identifier);
    setTimeout(() => {
      if (_current === 'lmstudio') _loadData('lmstudio');
    }, 1500);
  };

  window._svcUnloadModel = async (identifier) => {
    const btns = [...document.querySelectorAll('.panel-btn')];
    const btn  = btns.find(b => b.getAttribute('onclick')?.includes(identifier));
    if (btn) { btn.textContent = '...'; btn.disabled = true; }
    await unloadModel(identifier);
    setTimeout(() => {
      if (_current === 'lmstudio') _loadData('lmstudio');
    }, 1500);
  };

  window._svcOllamaPull = async () => {
    const input = document.getElementById('ollama-pull-input');
    const name  = input?.value?.trim();
    if (!name) return;
    await ollamaPull(name);
    setTimeout(() => {
      if (_current === 'ollama') _loadData('ollama');
    }, 1000);
  };

  // Expose functions globally so dashboard.html onclick attributes work
  window.openPanel       = openPanel;
  window.closePanel      = closePanel;
  window.loadPanelData   = (id) => _loadData(id);
  window.openDockerPanel = openDockerPanel;

  // Docker group editor
  window.openGroupEditor  = openGroupEditor;
  window.closeGroupEditor = closeGroupEditor;

  // Wire edit groups button
  document.getElementById('docker-edit-groups-btn')
    ?.addEventListener('click', openGroupEditor);

  // Wire modal close
  document.getElementById('group-modal-close')
    ?.addEventListener('click', closeGroupEditor);

  // Wire modal save/reset
  document.getElementById('group-save-btn')
    ?.addEventListener('click', _saveGroupsFromEditor);

  document.getElementById('group-reset-btn')
    ?.addEventListener('click', () => { resetGroups(); closeGroupEditor(); });

  // Auto-refresh docker panel when container data updates
  dockerEventBus.addEventListener('containers-update', () => {
    if (_current === 'docker' && _dockerContainerId) {
      // Soft refresh -- only if panel is open
      _loadDockerPanel();
    }
  });
}
