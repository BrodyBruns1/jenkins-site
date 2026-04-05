/**
 * main.js -- scene manager, renderer, animation loop, DOM wiring
 *
 * Owns:
 *   - ONE shared THREE.WebGLRenderer on #three-canvas
 *   - Scene + camera (passed to component constructors)
 *   - EffectComposer (bloom -> chromatic aberration -> vignette)
 *   - Scroll-driven camera track (5 sections, freeform scroll)
 *   - DOM label updates
 *   - startServicePolling() call (homelab services)
 *   - startDockerPolling() call (Docker containers)
 */

import * as THREE          from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';

import { buildEventBus, getJenkinsSnapshot, requestHitlDecision, startPolling } from './api.js';
import { ParticleReactor }             from './reactor.js';
import { HealthRings }                 from './rings.js';
import { HoloCore }                    from './holoCore.js';
import { HomelabPlanet }               from './planet.js';
import { ServiceNodes }                from './nodes.js';
import { startServicePolling }         from './services.js';
import { closePanel, initPanels }      from './panels.js';
import { DockerPlanet }                from './dockerPlanet.js';
import { startDockerPolling, dockerEventBus } from './dockerApi.js';
import { ProxmoxDrillDown }            from './proxmoxDrillDown.js';
import { N8nPlanet }                   from './n8nPlanet.js';
import { getN8nSnapshot, n8nEventBus, startN8nPolling } from './n8nApi.js';
import { getMemorySnapshot, memoryEventBus, startMemoryPolling } from './memoryApi.js';
import { MemoryPlanet, MEMORY_ORBIT_DATA } from './memoryPlanet.js';
import { connectMissionControlSpeechBridge } from './sttBridge.js';
import { STT_BRIDGE_CONFIG }           from '../config.js';
import { Starfield }                   from './starfield.js';
import { CommandRing }                 from './commandRing.js';

// ── Renderer ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping        = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// ── Scene / Camera ──────────────────────────────────────────────────────────
const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  65,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);
camera.position.set(0, 0, 20);

const clock = new THREE.Clock();

// ── Post-processing ─────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.2, 0.5, 0.0
);
composer.addPass(bloomPass);

// Chromatic aberration
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0.003 } },
  vertexShader:   `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; varying vec2 vUv;
    void main(){
      vec2 d=vUv-0.5; float l=length(d);
      float r=texture2D(tDiffuse,vUv-d*uAmount*l).r;
      float g=texture2D(tDiffuse,vUv).g;
      float b=texture2D(tDiffuse,vUv+d*uAmount*l).b;
      gl_FragColor=vec4(r,g,b,1.0);
    }`,
}));

// Vignette
composer.addPass(new ShaderPass({
  uniforms: {
    tDiffuse:  { value: null },
    uOffset:   { value: 0.90 },
    uDarkness: { value: 1.30 },
  },
  vertexShader:   `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uOffset; uniform float uDarkness; varying vec2 vUv;
    void main(){
      vec4 col=texture2D(tDiffuse,vUv);
      float d=length(vUv-0.5)*uOffset;
      col.rgb*=clamp(1.0-uDarkness*d*d,0.0,1.0);
      gl_FragColor=col;
    }`,
}));

// ── 3D Components ───────────────────────────────────────────────────────────
const starfield = new Starfield(scene);
const reactor = new ParticleReactor(scene);
const rings   = new HealthRings(scene);
const core    = new HoloCore(scene);
const planet  = new HomelabPlanet(scene);
const proxmoxDrillDown = new ProxmoxDrillDown(scene, camera);
const nodes   = new ServiceNodes(scene, planet.position, { onSelect: _handleServiceSelect });
nodes.setCamera(camera);

// Docker planet (section 2 — replaces the old empty sister planet)
const dockerPlanet = new DockerPlanet(scene, camera);
const n8nPlanet = new N8nPlanet(scene, camera);
const memoryPlanet = new MemoryPlanet(scene, camera);
const commandRing = new CommandRing(scene, camera);

// ── Scroll-driven camera track ──────────────────────────────────────────────
const _lookTarget = new THREE.Vector3();
const _manualLookTarget = new THREE.Vector3();
const _baseOffset = new THREE.Vector3();
const _rotatedOffset = new THREE.Vector3();
const _orbitQuaternion = new THREE.Quaternion();
const _yawQuaternion = new THREE.Quaternion();
const _pitchQuaternion = new THREE.Quaternion();
const _orbitRight = new THREE.Vector3();
let _scrollProgress = 0;
let _cameraMode = 'scroll';
let _cameraTransition = null;
let _drillDownBlend = 0;
let _commandRingBlend = 0;
let _serviceLabelProximity = 0;
let _dockerLabelProximity = 0;
let _n8nLabelProximity = 0;
let _memoryLabelProximity = 0;
let _orbitYaw = 0;
let _orbitPitch = 0;
let _commandRingYaw = 0;
let _commandRingPitch = 0;
let _dragState = null;
let _suppressCanvasClick = false;
let _activeHitlEntry = null;
let _hitlActionPending = false;

const htmlEl = document.documentElement;
const backBtn = document.getElementById('proxmox-back-btn');
const dragSurface = document.getElementById('main-content');
const scrollTrack = document.getElementById('scroll-track');
const sectionTitles = Array.from(document.querySelectorAll('.section-title'));
const sectionDots = Array.from(document.querySelectorAll('.section-dot'));
const commandRingSummary = document.getElementById('command-ring-summary');
const commandRingQueue = document.getElementById('command-ring-queue');
const commandRingHitlTitle = document.getElementById('command-ring-hitl-title');
const commandRingHitlQuestion = document.getElementById('command-ring-hitl-question');
const commandRingHitlMeta = document.getElementById('command-ring-hitl-meta');
const commandRingHitlStatus = document.getElementById('command-ring-hitl-status');
const commandRingHitlApprove = document.getElementById('command-ring-hitl-approve');
const commandRingHitlReject = document.getElementById('command-ring-hitl-reject');

const WAYPOINTS = [
  { cam: new THREE.Vector3(0,     0,    20),  look: new THREE.Vector3(0,      0,    0   ) },
  { cam: new THREE.Vector3(-8.5, -0.9,   4.4),  look: new THREE.Vector3(-8.5,  -5.0, -2.0) },
  { cam: new THREE.Vector3(11.5, -0.75,  5.8),  look: new THREE.Vector3(11.5,  -5.0, -2.0) },
  { cam: new THREE.Vector3(31.5, -0.65,  6.0),  look: new THREE.Vector3(31.5,  -5.1, -2.2) },
  { cam: new THREE.Vector3(51.5, -0.55,  6.2),  look: new THREE.Vector3(51.5,  -5.15, -2.35) },
];

htmlEl.style.setProperty('--section-count', String(WAYPOINTS.length));
if (scrollTrack) scrollTrack.setAttribute('aria-hidden', 'true');

function _updateCamera(p) {
  const pose = _getCameraPose(p);
  _lookTarget.copy(pose.look);
  _baseOffset.copy(pose.cam).sub(pose.look);
  _rotatedOffset.copy(_baseOffset);

  _yawQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), _orbitYaw);
  _rotatedOffset.applyQuaternion(_yawQuaternion);

  _orbitRight.crossVectors(_rotatedOffset, new THREE.Vector3(0, 1, 0)).normalize();
  if (_orbitRight.lengthSq() > 0.0001) {
    _pitchQuaternion.setFromAxisAngle(_orbitRight, _orbitPitch);
    _rotatedOffset.applyQuaternion(_pitchQuaternion);
  }

  camera.position.copy(_lookTarget).add(_rotatedOffset);
  camera.up.set(0, 1, 0);
  camera.updateProjectionMatrix();
  camera.lookAt(_lookTarget);
}

function _getCameraPose(p) {
  p = Math.max(0, Math.min(WAYPOINTS.length - 1, p));
  const i  = Math.min(Math.floor(p), WAYPOINTS.length - 2);
  const t  = p - i;
  const te = t * t * (3 - 2 * t);   // smoothstep easing
  const a  = WAYPOINTS[i];
  const b  = WAYPOINTS[i + 1];
  return {
    cam: new THREE.Vector3().lerpVectors(a.cam, b.cam, te),
    look: new THREE.Vector3().lerpVectors(a.look, b.look, te),
  };
}

function _updateSectionUI(p) {
  sectionTitles.forEach((el, i) => {
    el.style.opacity = String(Math.max(0, 1 - Math.abs(p - i) * 2.5));
  });
  sectionDots.forEach((el, i) => {
    el.classList.toggle('active', Math.round(p) === i);
  });

  // Show/hide Docker-specific UI when near section 2
  const dockerProximity = 1 - Math.min(Math.abs(p - 2), 1);
  _dockerLabelProximity = Math.max(0, dockerProximity);
  const editBtn   = document.getElementById('docker-edit-groups-btn');
  const summaryEl = document.getElementById('docker-summary');
  if (editBtn)   editBtn.classList.toggle('visible', dockerProximity > 0.5);
  if (summaryEl) summaryEl.classList.toggle('visible', dockerProximity > 0.5);

  const n8nSummary = document.getElementById('n8n-summary');
  const n8nProximity = 1 - Math.min(Math.abs(p - 3), 1);
  _n8nLabelProximity = Math.max(0, n8nProximity);
  if (n8nSummary) n8nSummary.classList.toggle('visible', n8nProximity > 0.5);

  const memorySummary = document.getElementById('memory-summary');
  const memoryProximity = 1 - Math.min(Math.abs(p - 4), 1);
  _memoryLabelProximity = Math.max(0, memoryProximity);
  if (memorySummary) memorySummary.classList.toggle('visible', memoryProximity > 0.5);

  // Show/hide service cards when near section 1
  const svcCards = document.getElementById('service-cards');
  if (svcCards) {
    const svcProximity = 1 - Math.min(Math.abs(p - 1), 1);
    _serviceLabelProximity = Math.max(0, svcProximity);
    svcCards.style.opacity = String(Math.max(0, svcProximity));
    svcCards.style.pointerEvents = svcProximity > 0.3 ? 'auto' : 'none';
  }
}

function _scrollToSection(index, behavior = 'smooth') {
  const target = THREE.MathUtils.clamp(index, 0, WAYPOINTS.length - 1);
  window.scrollTo({ top: target * window.innerHeight, behavior });
}

function _isEditableTarget(target) {
  if (!target) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return !!target.closest?.('input, textarea, select, [contenteditable="true"]');
}

function _renderChipList(container, items, className) {
  if (!container) return;
  container.textContent = '';
  items.filter(Boolean).forEach((text) => {
    const chip = document.createElement('span');
    chip.className = className;
    chip.textContent = text;
    container.appendChild(chip);
  });
}

function _pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function _formatRelativeTime(value) {
  if (!value) return '';

  const stamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(stamp)) return String(value);

  const deltaMs = Math.max(Date.now() - stamp, 0);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (deltaMs < minute) return 'just now';
  if (deltaMs < hour) return `${Math.round(deltaMs / minute)}m ago`;
  if (deltaMs < day) return `${Math.round(deltaMs / hour)}h ago`;
  return `${Math.round(deltaMs / day)}d ago`;
}

function _formatRemainingTime(value) {
  if (!value) return '';
  const stamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(stamp)) return String(value);
  const deltaMs = Math.max(stamp - Date.now(), 0);
  const totalSeconds = Math.round(deltaMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return `${hours}h ${String(rem).padStart(2, '0')}m`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function _compactOrbitName(name = '') {
  return String(name).replace(/^Automation Orbit -\s*/, '').trim() || String(name);
}

function _renderN8nSummary(snapshot = getN8nSnapshot()) {
  const titleEl = document.querySelector('#n8n-summary .n8n-summary__title');
  const bodyEl = document.querySelector('#n8n-summary .n8n-summary__body');
  const metaEl = document.getElementById('n8n-summary-meta');
  const sourcesEl = document.getElementById('n8n-summary-sources');
  const workflowsEl = document.getElementById('n8n-summary-workflows');
  const targetsEl = document.getElementById('n8n-summary-targets');
  const ideasEl = document.getElementById('n8n-summary-ideas');
  const summary = snapshot.summary || {
    workflowCount: 0,
    activeWorkflows: 0,
    executionCount: 0,
    runningExecutions: 0,
    failedExecutions: 0,
  };
  const stats = snapshot.stats || {};
  const workflowRuns = Array.isArray(snapshot.workflowRuns) ? snapshot.workflowRuns : [];
  const mode = snapshot.mode || 'fallback';
  const isSeedMode = mode === 'seed';
  const overview = snapshot.overview || {};
  const sourcePaths = snapshot.sourcePaths || {};
  const nextIdeas = Array.isArray(snapshot.nextIdeas) ? snapshot.nextIdeas : [];
  const knownTargets = Array.isArray(snapshot.targets) && snapshot.targets.length
    ? snapshot.targets
    : workflowRuns.flatMap((workflow) => Array.isArray(workflow.targets) ? workflow.targets : []);

  if (titleEl && bodyEl) {
    if (mode === 'live') {
      if (summary.workflowCount > 0) {
        titleEl.textContent = `${_pluralize(summary.workflowCount, 'workflow')} in orbit`;
        bodyEl.textContent = summary.runningExecutions > 0
          ? `${_pluralize(summary.runningExecutions, 'execution')} currently moving through ${_pluralize(summary.activeWorkflows, 'active workflow')}.`
          : `${_pluralize(summary.executionCount, 'recent execution')} grouped across ${_pluralize(summary.workflowCount, 'workflow')}.`;
      } else {
        titleEl.textContent = 'n8n orbit is live but empty';
        bodyEl.textContent = 'The proxy is reachable. As workflows and executions appear, they will populate this section automatically.';
      }
    } else if (isSeedMode) {
      titleEl.textContent = overview.title || `${_pluralize(summary.workflowCount, 'workflow')} seeded`;
      bodyEl.textContent = snapshot.error?.includes('X-N8N-API-KEY') || snapshot.error?.includes('API-KEY')
        ? `${overview.usableNow || 'Usable workflows are seeded.'} ${overview.blocker || 'Live proxy auth is still pending.'}`
        : (overview.summary || 'The automation orbit is using a generated snapshot of the real workflow seed pack.');
    } else {
      titleEl.textContent = 'n8n proxy auth still pending';
      bodyEl.textContent = snapshot.error?.includes('X-N8N-API-KEY') || snapshot.error?.includes('API-KEY')
        ? 'n8n is up, but the public API still requires X-N8N-API-KEY. Seeded workflows stay in orbit until the proxy injects that header.'
        : 'The automation orbit is holding on a local fallback until the generated seed snapshot loads.';
    }
  }

  _renderChipList(metaEl, [
    `${summary.workflowCount} workflows`,
    stats.scheduleCount ? `${stats.scheduleCount} schedules` : '',
    stats.manualCount ? `${stats.manualCount} manual` : '',
    stats.webhookCount ? `${stats.webhookCount} webhook` : '',
    mode === 'live' ? 'live proxy' : isSeedMode ? 'seed snapshot' : 'fallback',
    summary.failedExecutions ? `${summary.failedExecutions} blocked` : '',
  ], 'summary-chip');

  _renderChipList(sourcesEl, [
    sourcePaths.workflowRoot ? 'seed pack' : '',
    sourcePaths.n8nUrl ? 'vm105 n8n' : '',
    snapshot.generatedAt ? `snapshot ${_formatRelativeTime(snapshot.generatedAt)}` : '',
  ], 'n8n-source');

  _renderChipList(workflowsEl, workflowRuns.slice(0, 6).map((workflow) => {
    const trigger = workflow.triggerKind || workflow.status || 'orbit';
    return `${_compactOrbitName(workflow.name)} · ${trigger}`;
  }), 'n8n-workflow');

  _renderChipList(targetsEl, knownTargets.slice(0, 8), 'n8n-target');

  _renderChipList(ideasEl, nextIdeas.slice(0, 4), 'n8n-idea');
}

function _renderMemorySummary(snapshot = getMemorySnapshot()) {
  const titleEl = document.querySelector('#memory-summary .memory-summary__title');
  const bodyEl = document.querySelector('#memory-summary .memory-summary__body');
  const metaEl = document.getElementById('memory-summary-meta');
  const sourcesEl = document.getElementById('memory-summary-sources');
  const layersEl = document.getElementById('memory-summary-layers');
  const docsEl = document.getElementById('memory-summary-docs');
  const notesEl = document.getElementById('memory-summary-notes');

  const overview = snapshot?.overview || MEMORY_ORBIT_DATA.overview;
  const layers = Array.isArray(snapshot?.layers) && snapshot.layers.length
    ? snapshot.layers
    : MEMORY_ORBIT_DATA.layers;
  const supportingDocs = Array.isArray(snapshot?.supportingDocs)
    ? snapshot.supportingDocs
    : (MEMORY_ORBIT_DATA.supportingDocs || []);
  const recentNotes = Array.isArray(snapshot?.recentNotes) && snapshot.recentNotes.length
    ? snapshot.recentNotes
    : MEMORY_ORBIT_DATA.recentNotes;
  const stats = snapshot?.stats || {
    layerCount: layers.length,
    supportDocCount: supportingDocs.length,
    recentNoteCount: recentNotes.length,
    indexedDocCount: 0,
  };
  const mode = snapshot?.mode || 'fallback';
  const generatedAt = snapshot?.generatedAt || null;
  const latestLayerUpdate = overview.latestLayerUpdate || null;
  const sourcePaths = snapshot?.sourcePaths || {};

  if (titleEl) {
    titleEl.textContent = mode === 'generated'
      ? `${_pluralize(stats.layerCount || layers.length, 'layer')} + ${_pluralize(stats.supportDocCount || supportingDocs.length, 'support doc')}`
      : overview.layers;
  }

  if (bodyEl) {
    bodyEl.textContent = mode === 'generated'
      ? `Workspace ${overview.workspace} is now feeding the constellation from generated markdown data. ${_pluralize(stats.recentNoteCount || recentNotes.length, 'recent vault note')}, ${_pluralize(stats.indexedDocCount || 0, 'indexed doc')}, and ${overview.services} are all reflected here.`
      : `Workspace ${overview.workspace} is linked to shared storage at ${overview.storage}, with ${overview.services} sustaining the sync layers.`;
  }

  _renderChipList(metaEl, [
    mode === 'generated' ? 'generated memory feed' : 'fallback snapshot',
    `${stats.layerCount || layers.length} layers`,
    `${stats.recentNoteCount || recentNotes.length} recent notes`,
    stats.indexedDocCount ? `${stats.indexedDocCount} indexed docs` : '',
    generatedAt ? `generated ${_formatRelativeTime(generatedAt)}` : '',
    latestLayerUpdate ? `latest layer ${_formatRelativeTime(latestLayerUpdate)}` : '',
    snapshot?.error ? `feed issue: ${snapshot.error}` : '',
  ], 'summary-chip');

  _renderChipList(sourcesEl, [
    sourcePaths.claude || '',
    overview.workspace || '',
    sourcePaths.vault || '',
    overview.storage || '',
  ], 'memory-source');

  _renderChipList(
    layersEl,
    layers.map((layer) => `${layer.name} - ${layer.status}`),
    'memory-chip'
  );
  _renderChipList(
    docsEl,
    supportingDocs.map((doc) => `${doc.name} - ${doc.status}`),
    'memory-doc'
  );
  _renderChipList(
    notesEl,
    recentNotes.map((note) => {
      if (typeof note === 'string') return note;
      return note.path || note.title || note.label || '';
    }),
    'memory-note'
  );
}

function _renderCommandRingHud(snapshot = getJenkinsSnapshot()) {
  const queueItems = Array.isArray(snapshot.queueItems) ? snapshot.queueItems : [];
  const runningJobs = Array.isArray(snapshot.runningJobs) ? snapshot.runningJobs : [];
  const hitl = Array.isArray(snapshot.hitl) ? snapshot.hitl : [];
  const status = snapshot.status || 'idle';
  const error = snapshot.error || '';

  _renderChipList(commandRingSummary, [
    `${queueItems.length} queued`,
    `${runningJobs.length} running`,
    `${snapshot.executors?.busy || 0}/${snapshot.executors?.total || 0} executors`,
    hitl.length ? `${hitl.length} hitl` : 'no hitl',
    status,
    snapshot.lastUpdated ? `updated ${_formatRelativeTime(snapshot.lastUpdated)}` : '',
    error ? `issue ${error}` : '',
  ], 'command-ring-chip');

  _renderChipList(commandRingQueue, queueItems.length
    ? queueItems.slice(0, 6).map((item) => item.name || `Queue ${item.id}`)
    : ['No queued Jenkins jobs'], 'command-ring-queue-item');

  _activeHitlEntry = hitl[0] || null;
  const hasHitl = Boolean(_activeHitlEntry);

  if (commandRingHitlTitle) {
    commandRingHitlTitle.textContent = hasHitl
      ? `${_activeHitlEntry.jobName || 'Pipeline'} awaiting approval`
      : 'No approval waiting';
  }

  if (commandRingHitlQuestion) {
    commandRingHitlQuestion.textContent = hasHitl
      ? (_activeHitlEntry.message || 'Approval required for this Jenkins pipeline step.')
      : 'When Jenkins exposes a pending input step, it will appear here with dashboard-side approve and reject controls.';
  }

  _renderChipList(commandRingHitlMeta, hasHitl ? [
    _activeHitlEntry.buildNumber ? `build #${_activeHitlEntry.buildNumber}` : '',
    _activeHitlEntry.timeoutAt ? `auto-abort ${_formatRemainingTime(_activeHitlEntry.timeoutAt)}` : '',
    _activeHitlEntry.proceedUrl ? 'proceed ready' : 'proceed url missing',
    _activeHitlEntry.abortUrl ? 'reject ready' : 'reject url missing',
  ] : ['Dashboard approval is standing by'], 'command-ring-hitl-chip');

  if (commandRingHitlApprove) {
    commandRingHitlApprove.disabled = !hasHitl || _hitlActionPending || !_activeHitlEntry?.proceedUrl;
  }
  if (commandRingHitlReject) {
    commandRingHitlReject.disabled = !hasHitl || _hitlActionPending || !_activeHitlEntry?.abortUrl;
  }
}

async function _submitHitlDecision(action) {
  if (!_activeHitlEntry || _hitlActionPending) return;
  _hitlActionPending = true;
  if (commandRingHitlStatus) {
    commandRingHitlStatus.textContent = action === 'reject'
      ? 'Sending reject to Jenkins...'
      : 'Sending approval to Jenkins...';
  }
  _renderCommandRingHud();

  try {
    await requestHitlDecision(_activeHitlEntry, action);
    if (commandRingHitlStatus) {
      commandRingHitlStatus.textContent = action === 'reject'
        ? 'Reject sent. Waiting for Jenkins to clear the input step.'
        : 'Approval sent. Waiting for Jenkins to resume.';
    }
  } catch (error) {
    if (commandRingHitlStatus) {
      commandRingHitlStatus.textContent = error?.message || 'Could not reach Jenkins for this HITL action.';
    }
  } finally {
    _hitlActionPending = false;
    _renderCommandRingHud();
  }
}

commandRingHitlApprove?.addEventListener('click', () => {
  _submitHitlDecision('approve');
});

commandRingHitlReject?.addEventListener('click', () => {
  _submitHitlDecision('reject');
});

// Wire section-dot clicks
sectionDots.forEach((el, i) => {
  el.addEventListener('click', () => _scrollToSection(i));
});

function _isInteractiveTarget(target) {
  if (!target?.closest) return false;
  return !!target.closest(
    '.svc-label, .docker-label, .svc-card, .detail-panel, .panel-overlay, ' +
    '#docker-edit-groups-btn, #docker-group-modal, #section-nav, #proxmox-back-btn, ' +
    '#proxmox-drilldown-hud, #command-ring-hud, #command-ring-hitl'
  );
}

dragSurface?.addEventListener('click', (e) => {
  if (_suppressCanvasClick) {
    _suppressCanvasClick = false;
    return;
  }
  if (_cameraMode === 'commandring') return;
  if (_cameraMode !== 'scroll') return;
  if (_isInteractiveTarget(e.target)) return;
  if (Math.abs(_scrollProgress) < 0.45 && core.hitTest?.(e.clientX, e.clientY, camera)) {
    _enterCommandRing();
    return;
  }
  nodes.handlePointerClick(e.clientX, e.clientY);
});

dragSurface?.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (_isInteractiveTarget(e.target)) return;
  if (_cameraMode !== 'scroll' && _cameraMode !== 'commandring') return;
  _dragState = { x: e.clientX, y: e.clientY, moved: false, mode: _cameraMode };
  if (_cameraMode === 'commandring') {
    commandRing.setInteracting(true);
  }
  dragSurface.setPointerCapture?.(e.pointerId);
});

window.addEventListener('pointermove', (e) => {
  if (!_dragState) return;
  const dx = e.clientX - _dragState.x;
  const dy = e.clientY - _dragState.y;
  if (Math.abs(dx) + Math.abs(dy) < 2) return;

  _dragState.moved = true;
  if (_dragState.mode === 'commandring' && _cameraMode === 'commandring') {
    _commandRingYaw   -= dx * 0.0052;
    _commandRingPitch -= dy * 0.0032;
    _commandRingPitch = THREE.MathUtils.clamp(_commandRingPitch, -0.42, 0.42);
    commandRing.setOrbit(_commandRingYaw, _commandRingPitch);
  } else if (_dragState.mode === 'scroll' && _cameraMode === 'scroll') {
    _orbitYaw   -= dx * 0.0065;
    _orbitPitch += dy * 0.0048;
    _orbitPitch = THREE.MathUtils.clamp(_orbitPitch, -0.85, 0.85);
  }
  _dragState.x = e.clientX;
  _dragState.y = e.clientY;
});

function _endDrag() {
  if (!_dragState) return;
  if (_dragState.moved) _suppressCanvasClick = true;
  if (_dragState.mode === 'commandring') {
    commandRing.setInteracting(false);
  }
  _dragState = null;
}

window.addEventListener('pointerup', _endDrag);
window.addEventListener('pointercancel', _endDrag);

backBtn?.addEventListener('click', () => {
  if (_cameraMode === 'commandring') {
    _exitCommandRing();
    return;
  }
  _exitProxmoxDrillDown();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (_cameraMode === 'commandring') {
      _exitCommandRing();
      return;
    }
    if (_cameraMode === 'drilldown') {
      _exitProxmoxDrillDown();
      return;
    }
  }

  if ((e.key === 'r' || e.key === 'R') && _cameraMode === 'scroll' && !_isEditableTarget(e.target)) {
    e.preventDefault();
    _enterCommandRing();
    return;
  }

  if (_cameraMode !== 'scroll') return;
  if (_isEditableTarget(e.target)) return;

  let nextSection = null;
  if (e.key === 'PageDown') nextSection = Math.round(_scrollProgress) + 1;
  if (e.key === 'PageUp') nextSection = Math.round(_scrollProgress) - 1;
  if (e.key === 'Home') nextSection = 0;
  if (e.key === 'End') nextSection = WAYPOINTS.length - 1;
  if (nextSection == null) return;

  e.preventDefault();
  _scrollToSection(nextSection);
});

// ── DOM -- Docker summary labels ────────────────────────────────────────────
dockerEventBus.addEventListener('containers-update', (e) => {
  const { containers } = e.detail;
  const running  = containers.filter(c => c.state === 'running').length;
  const total    = containers.length;
  const healthy  = containers.filter(c => c.health === 'healthy').length;
  const unhealthy = containers.filter(c => c.health === 'unhealthy').length;

  dockerPlanet.setTelemetry({ running, total, healthy, unhealthy });

  const el = document.getElementById('docker-summary');
  if (el) {
    el.innerHTML = `
      <div class="docker-summary__stat"><strong>${running}</strong>/ ${total} running</div>
      ${healthy  ? `<div class="docker-summary__stat"><strong>${healthy}</strong> healthy</div>` : ''}
      ${unhealthy ? `<div class="docker-summary__stat" style="color:rgba(255,136,0,0.55)"><strong>${unhealthy}</strong> unhealthy</div>` : ''}`;
  }
});

n8nEventBus.addEventListener('n8n-update', (e) => {
  _renderN8nSummary(e.detail);
});

memoryEventBus.addEventListener('memory-update', (e) => {
  _renderMemorySummary(e.detail);
  memoryPlanet.applySnapshot(e.detail);
});

buildEventBus.addEventListener('jenkins-update', (e) => {
  _renderCommandRingHud(e.detail);
});

buildEventBus.addEventListener('connection-error', (e) => {
  if (commandRingHitlStatus && htmlEl.classList.contains('command-ring-active')) {
    commandRingHitlStatus.textContent = e.detail?.error || 'Jenkins connection failed.';
  }
});

// ── Ambient ring animation (no Jenkins data, so cycle aesthetically) ─────
function _animateRings(elapsed) {
  if (getJenkinsSnapshot().status === 'connected') return;
  // Slowly cycle ring fills to look like live data
  const r = rings;
  if (!r._rings) return;

  // Ring 0 (queue): slow sine wave
  const fill0 = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(elapsed * 0.18));
  r._setFill(0, fill0);

  // Ring 1 (executors): offset sine
  const fill1 = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 0.13 + 1.5));
  r._setFill(1, fill1);

  // Ring 2 (pass rate): stays high, gentle sway
  const fill2 = 0.80 + 0.18 * Math.sin(elapsed * 0.09 + 3.0);
  r._setFill(2, fill2);

  // Ring 3 (active): rhythmic pulse
  const fill3 = 0.25 + 0.25 * (0.5 + 0.5 * Math.sin(elapsed * 0.22 + 0.7));
  r._setFill(3, fill3);
}

// ── Mouse → reactor rainbow ─────────────────────────────────────────────────
window.addEventListener('mousemove', (e) => {
  const nx =  (e.clientX / window.innerWidth)  * 2 - 1;
  const ny = -((e.clientY / window.innerHeight) * 2 - 1);
  reactor.setMouse(nx, ny);
}, { passive: true });

function _setSpeechActivity(detail = {}) {
  rings.setSpeechActivity({
    level: detail.level ?? detail.intensity ?? 0,
    speaking: detail.speaking ?? true,
    frequency: detail.frequency ?? detail.frequencyHz ?? 0,
  });
  core.setSpeechActivity({
    level: detail.level ?? detail.intensity ?? 0,
    speaking: detail.speaking ?? true,
  });
}

function _streamLiveSpeech(detail = {}) {
  const full = detail.fullText ?? detail.text ?? detail.chunk ?? '';
  console.log('[STT→ring] full=%o', full);
  core.streamLiveTranscript(full);
  window.dispatchEvent(new CustomEvent('mission-control-transcript', {
    detail: {
      text: detail.text ?? detail.chunk ?? full,
      fullText: full,
    },
  }));
}

function _triggerSpeechResponse(detail = {}) {
  const strength = (detail.strength ?? detail.level ?? 1) * 0.72;
  core.triggerResponsePulse(strength, detail.text ?? '');
  rings.triggerResponsePulse(strength * 0.82);
  reactor.triggerSpeechResponse(strength);
  window.dispatchEvent(new CustomEvent('mc-ai-response', {
    detail: {
      text: detail.text ?? '',
      strength,
    },
  }));
}

window.addEventListener('mission-control-speech', (e) => {
  _setSpeechActivity(e.detail || {});
});

window.addEventListener('mission-control-response', (e) => {
  _triggerSpeechResponse(e.detail || {});
});

window.missionControlSpeech = {
  setActivity(detail = {}) {
    _setSpeechActivity(detail);
  },
  stream(detail = {}) {
    _streamLiveSpeech(detail);
  },
  stop() {
    _setSpeechActivity({ level: 0, speaking: false });
  },
  respond(strength = 1, text = '') {
    _triggerSpeechResponse({ strength, text });
  },
};

connectMissionControlSpeechBridge(STT_BRIDGE_CONFIG);

// ── Resize ──────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(w, h);
  bloomPass.resolution.set(w, h);
});

function _handleServiceSelect(selection) {
  if (selection.id !== 'proxmox' || _cameraMode !== 'scroll') return false;
  _enterProxmoxDrillDown(selection);
  return true;
}

function _getProxmoxDrillDownShot(selection) {
  const homelabPlanetPos = planet.position.clone();
  const axis = selection.position.clone().sub(homelabPlanetPos);
  if (axis.lengthSq() < 0.0001) axis.set(0, 0, 1);
  axis.normalize();

  const pushedPlanet = selection.position.clone().add(axis.clone().multiplyScalar(9.6));
  let planeNormal = new THREE.Vector3(0, 1, 0).cross(axis);
  if (planeNormal.lengthSq() < 0.0001) planeNormal = new THREE.Vector3(1, 0, 0);
  planeNormal.normalize();
  const elevatedNormal = planeNormal.clone().add(new THREE.Vector3(0, 0.95, 0)).normalize();
  const screenRight = axis.clone().cross(elevatedNormal).normalize();

  const toCam = homelabPlanetPos
    .clone()
    .lerp(pushedPlanet, 0.56)
    .add(elevatedNormal.clone().multiplyScalar(4.25))
    .add(screenRight.clone().multiplyScalar(1.15))
    .add(new THREE.Vector3(0, -0.95, 0));
  const toLook = pushedPlanet
    .clone()
    .add(axis.clone().multiplyScalar(2.25))
    .add(elevatedNormal.clone().multiplyScalar(0.25))
    .add(screenRight.clone().multiplyScalar(0.35))
    .add(new THREE.Vector3(0, -0.45, 0));

  return { toCam, toLook, pushedPlanet };
}

function _enterProxmoxDrillDown(selection) {
  if (_cameraMode !== 'scroll') return;

  closePanel();
  htmlEl.classList.add('drilldown-active');
  backBtn.textContent = 'Back to Orbit';
  backBtn.setAttribute('aria-label', 'Exit Proxmox drill-down');
  nodes.setHiddenIds(['proxmox']);
  nodes.setFade(0.14);
  nodes.setLabelFade(0);
  nodes.setInteractive(false);

  const fromCam = camera.position.clone();
  const fromLook = _lookTarget.clone();
  const { toCam, toLook, pushedPlanet } = _getProxmoxDrillDownShot(selection);

  proxmoxDrillDown.activate(selection.position, pushedPlanet);

  _cameraMode = 'transition';
  _cameraTransition = {
    startedAt: clock.getElapsedTime(),
    duration: 1.35,
    fromCam,
    fromLook,
    toCam,
    toLook,
    fromBlend: _drillDownBlend,
    toBlend: 1,
    onComplete: () => {
      _cameraMode = 'drilldown';
      _cameraTransition = null;
    },
  };
}

function _exitProxmoxDrillDown() {
  if (_cameraMode !== 'drilldown') return;

  const targetPose = _getCameraPose(_scrollProgress);

  _cameraMode = 'transition';
  _cameraTransition = {
    startedAt: clock.getElapsedTime(),
    duration: 1.1,
    fromCam: camera.position.clone(),
    fromLook: _manualLookTarget.clone(),
    toCam: targetPose.cam,
    toLook: targetPose.look,
    fromBlend: _drillDownBlend,
    toBlend: 0,
    onComplete: () => {
      htmlEl.classList.remove('drilldown-active');
      nodes.setHiddenIds([]);
      nodes.setFade(1);
      nodes.setLabelFade(1);
      nodes.setInteractive(true);
      proxmoxDrillDown.deactivate();
      _cameraMode = 'scroll';
      _cameraTransition = null;
      backBtn.textContent = 'Back to Orbit';
      backBtn.setAttribute('aria-label', 'Exit Proxmox drill-down');
    },
  };
}

function _enterCommandRing() {
  if (_cameraMode !== 'scroll') return;

  closePanel();
  htmlEl.classList.add('command-ring-active');
  backBtn.textContent = 'Exit Ring';
  backBtn.setAttribute('aria-label', 'Exit Command Ring');
  _commandRingYaw = 0;
  _commandRingPitch = 0;
  commandRing.setOrbit(_commandRingYaw, _commandRingPitch);
  commandRing.activate();
  _renderCommandRingHud(getJenkinsSnapshot());
  if (commandRingHitlStatus) {
    commandRingHitlStatus.textContent = '';
  }

  _cameraMode = 'transition';
  _cameraTransition = {
    startedAt: clock.getElapsedTime(),
    duration: 1.45,
    fromCam: camera.position.clone(),
    fromLook: _lookTarget.clone(),
    toCam: new THREE.Vector3(0, 0, 0.12),
    toLook: new THREE.Vector3(0, 0, -1),
    fromBlend: _drillDownBlend,
    toBlend: 0,
    fromCRBlend: _commandRingBlend,
    toCRBlend: 1,
    isCommandRing: true,
    onComplete: () => {
      _cameraMode = 'commandring';
      _cameraTransition = null;
      _manualLookTarget.set(0, 0, -1);
    },
  };
}

function _exitCommandRing() {
  if (_cameraMode !== 'commandring') return;

  closePanel();
  const targetPose = _getCameraPose(0);
  _cameraMode = 'transition';
  _cameraTransition = {
    startedAt: clock.getElapsedTime(),
    duration: 1.1,
    fromCam: camera.position.clone(),
    fromLook: _manualLookTarget.clone(),
    toCam: targetPose.cam,
    toLook: targetPose.look,
    fromBlend: _drillDownBlend,
    toBlend: 0,
    fromCRBlend: _commandRingBlend,
    toCRBlend: 0,
    isCommandRing: true,
    onComplete: () => {
      htmlEl.classList.remove('command-ring-active');
      commandRing.deactivate();
      _cameraMode = 'scroll';
      _cameraTransition = null;
      backBtn.textContent = 'Back to Orbit';
      backBtn.setAttribute('aria-label', 'Exit Proxmox drill-down');
    },
  };
}

function _updateCameraTransition(elapsed) {
  const transition = _cameraTransition;
  if (!transition) return;

  const t = Math.min((elapsed - transition.startedAt) / transition.duration, 1);
  const eased = t * t * (3 - 2 * t);

  camera.position.lerpVectors(transition.fromCam, transition.toCam, eased);
  _manualLookTarget.lerpVectors(transition.fromLook, transition.toLook, eased);
  camera.lookAt(_manualLookTarget);
  camera.updateProjectionMatrix();

  _drillDownBlend = THREE.MathUtils.lerp(transition.fromBlend, transition.toBlend, eased);
  proxmoxDrillDown.setBlend(_drillDownBlend);
  if (transition.isCommandRing) {
    _commandRingBlend = THREE.MathUtils.lerp(
      transition.fromCRBlend ?? _commandRingBlend,
      transition.toCRBlend ?? _commandRingBlend,
      eased
    );
  }

  if (t >= 1) {
    transition.onComplete?.();
  }
}

function _updateSceneFocus() {
  const sceneFade = (1 - 0.95 * _drillDownBlend) * (1 - 0.92 * _commandRingBlend);

  core.setFade(sceneFade);
  rings.setFade(sceneFade);
  planet.setFade(sceneFade);
  dockerPlanet.setFade(sceneFade);
  n8nPlanet.setFade(sceneFade);
  memoryPlanet.setFade(sceneFade);
  commandRing.setBlend(_commandRingBlend);

  nodes.setFade(Math.max(sceneFade, 0.12));
  nodes.setLabelFade(Math.max(sceneFade * _serviceLabelProximity, 0.0));
  dockerPlanet.setLabelFade(Math.max(sceneFade * _dockerLabelProximity, 0.0));
  n8nPlanet.setLabelFade(Math.max(sceneFade * _n8nLabelProximity, 0.0));
  memoryPlanet.setLabelFade(Math.max(sceneFade * _memoryLabelProximity, 0.0));
  reactor.setVisible(sceneFade > 0.18);
}

// ── Animation loop ──────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const delta   = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  _scrollProgress = window.scrollY / window.innerHeight;
  if (_cameraMode === 'scroll') {
    _updateCamera(_scrollProgress);
    _manualLookTarget.copy(_lookTarget);
    proxmoxDrillDown.setBlend(0);
  } else if (_cameraMode === 'transition') {
    _updateCameraTransition(elapsed);
  } else if (_cameraMode === 'commandring') {
    camera.position.set(0, 0, 0.12);
    _manualLookTarget.set(0, 0, -1);
    camera.lookAt(_manualLookTarget);
    camera.updateProjectionMatrix();
    proxmoxDrillDown.setBlend(0);
  }

  _updateSceneFocus();

  if (_cameraMode === 'scroll') {
    _updateSectionUI(_scrollProgress);
  }

  starfield.update(elapsed);
  reactor.update(elapsed);
  rings.update(elapsed, delta);
  reactor.setSpeechEllipses(rings.getSpeechContours());
  core.update(elapsed, delta);
  reactor.setImpactBursts(core.getGlyphCollisionBursts());
  planet.update(elapsed, delta);
  nodes.update(elapsed, delta);
  dockerPlanet.update(elapsed, delta);
  n8nPlanet.update(elapsed, delta);
  memoryPlanet.update(elapsed, delta);
  proxmoxDrillDown.update(elapsed, delta);
  commandRing.update(elapsed, delta);

  _animateRings(elapsed);

  composer.render();
}

// ── Boot ─────────────────────────────────────────────────────────────────────
initPanels();
memoryPlanet.applySnapshot(getMemorySnapshot());
_renderMemorySummary(getMemorySnapshot());
_renderN8nSummary(getN8nSnapshot());
_renderCommandRingHud(getJenkinsSnapshot());
startPolling();
startServicePolling();
startDockerPolling();
startN8nPolling();
startMemoryPolling();
animate();
