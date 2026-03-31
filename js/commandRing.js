import * as THREE from 'three';

import { buildEventBus, getJenkinsSnapshot } from './api.js';
import { dockerEventBus, getContainers } from './dockerApi.js';
import { getN8nSnapshot, n8nEventBus } from './n8nApi.js';
import { getMemorySnapshot, memoryEventBus } from './memoryApi.js';

const PANEL_COUNT = 12;
const PANEL_CANVAS_WIDTH = 512;
const PANEL_CANVAS_HEIGHT = 320;
const PANEL_RADIUS = 1.52;
const TORUS_MAJOR_RADIUS = 3.08;
const TORUS_TUBE_RADIUS = 1.18;
const PANEL_WIDTH = 1.08;
const PANEL_HEIGHT = 0.70;
const CONDUIT_OFFSET = new THREE.Vector3(0.68, -0.16, -0.92);
const PANEL_TITLES = [
  'Jenkins Jobs',
  'Proxmox Nodes',
  'Docker Fleet',
  'n8n Workflows',
  'Memory System',
  'Active Voice',
  'AI Response',
  'LLM Services',
  'Recent Logseq',
  'Qdrant Status',
  'Valkey / Codex',
  'Clock / Uptime',
];

function formatRelativeTime(value) {
  if (!value) return 'No timestamp';

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

function formatClock(date = new Date()) {
  return new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function summarizeStatusList(items = [], limit = 5) {
  const list = items.filter(Boolean).slice(0, limit);
  return list.length ? list : ['No recent items'];
}

function wrapText(text = '', maxChars = 42, maxLines = 8) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [];

  const words = source.split(' ');
  const lines = [];
  let line = '';

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length >= maxLines) break;
  }

  if (line && lines.length < maxLines) {
    lines.push(line);
  }

  if (lines.length === maxLines && words.length > 0) {
    const joined = lines.join(' ');
    if (joined.length < source.length) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(maxChars - 3, 1)).trim()}...`;
    }
  }

  return lines;
}

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function pickJobAccent(name = '') {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('codex')) return new THREE.Color(0x9c7cff);
  if (lower.includes('research') || lower.includes('search')) return new THREE.Color(0x5fd8a8);
  if (lower.includes('deploy') || lower.includes('docker') || lower.includes('vm')) return new THREE.Color(0x66b5ff);
  return new THREE.Color(0x7fb7ff);
}

function normalizeChip(text = '') {
  return String(text || '').trim() || 'n/a';
}

export class CommandRing {
  constructor(scene, camera) {
    this._scene = scene;
    this._camera = camera;
    this._group = new THREE.Group();
    this._group.visible = false;
    this._group.renderOrder = 6;
    this._scene.add(this._group);

    this._fade = 0;
    this._active = false;
    this._isInteracting = false;
    this._userYaw = 0;
    this._userPitch = 0;
    this._autoYaw = 0;
    this._panelRefreshCooldown = 0;
    this._clockRefreshCooldown = 0;
    this._dirtyPanels = true;
    this._voiceText = '';
    this._voiceState = 'idle';
    this._responseText = '';
    this._responseAt = 0;
    this._lightsReady = false;
    this._queuePulse = 0;

    this._materials = [];
    this._panelCanvases = [];
    this._panelContexts = [];
    this._panelTextures = [];
    this._panelMeshes = [];
    this._queueOrbPool = [];
    this._tmpColor = new THREE.Color();
    this._cameraForward = new THREE.Vector3();
    this._panelWorldPos = new THREE.Vector3();
    this._panelViewDir = new THREE.Vector3();
    this._panelTargetPos = new THREE.Vector3();
    this._panelTargetScale = new THREE.Vector3(1, 1, 1);

    this._jenkins = getJenkinsSnapshot();
    this._dockerContainers = getContainers();
    this._n8n = getN8nSnapshot();
    this._memory = getMemorySnapshot();

    this._buildStructure();
    this._buildPanels();
    this._buildQueueOrbs();
    this._buildConduit();
    this._buildLights();
    this._subscribe();
  }

  get active() {
    return this._active;
  }

  activate() {
    this._active = true;
    this._group.visible = true;
    this._dirtyPanels = true;
  }

  deactivate() {
    this._active = false;
    this._group.visible = false;
  }

  setBlend(fade) {
    this._fade = clamp01(fade);

    for (const entry of this._materials) {
      entry.material.opacity = entry.baseOpacity * this._fade;
    }

    if (this._lightsReady) {
      this._ambientLight.intensity = 0.58 * this._fade;
      this._fillLightA.intensity = 1.15 * this._fade;
      this._fillLightB.intensity = 0.95 * this._fade;
    }

    if (this._conduitMaterial) {
      this._conduitMaterial.opacity = 0.12 * this._fade;
    }

    if (this._conduitPointsMaterial) {
      this._conduitPointsMaterial.opacity = 0.34 * this._fade;
    }

    if (this._group) {
      this._group.visible = this._active || this._fade > 0.001;
    }
  }

  setOrbit(yaw = 0, pitch = 0) {
    this._userYaw = yaw;
    this._userPitch = THREE.MathUtils.clamp(pitch, -0.55, 0.55);
  }

  setInteracting(isInteracting) {
    this._isInteracting = Boolean(isInteracting);
  }

  _registerMaterial(material, baseOpacity = 1) {
    this._materials.push({ material, baseOpacity });
    material.opacity = 0;
    return material;
  }

  _buildStructure() {
    const shellGeometry = new THREE.TorusGeometry(
      TORUS_MAJOR_RADIUS,
      TORUS_TUBE_RADIUS,
      30,
      120
    );
    const shellMaterial = this._registerMaterial(new THREE.MeshBasicMaterial({
      color: 0x091120,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
    }), 0.7);
    this._shell = new THREE.Mesh(shellGeometry, shellMaterial);
    this._group.add(this._shell);

    const gridMaterial = this._registerMaterial(new THREE.LineBasicMaterial({
      color: 0x17345d,
      transparent: true,
      opacity: 0,
    }), 0.48);
    const shellGrid = new THREE.LineSegments(new THREE.EdgesGeometry(shellGeometry, 28), gridMaterial);
    this._group.add(shellGrid);

    for (let i = 0; i < 8; i += 1) {
      const ribMaterial = this._registerMaterial(new THREE.MeshBasicMaterial({
        color: 0x193158,
        transparent: true,
        opacity: 0,
      }), 0.64);
      const rib = new THREE.Mesh(
        new THREE.TorusGeometry(TORUS_MAJOR_RADIUS, 0.035, 8, 52, Math.PI * 0.54),
        ribMaterial
      );
      rib.rotation.y = (i / 8) * Math.PI * 2;
      rib.rotation.z = Math.PI * 0.5;
      rib.position.y = Math.sin(i * 0.72) * 0.22;
      this._group.add(rib);
    }
  }

  _buildPanels() {
    const panelGeometry = new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT, 1, 1);

    for (let i = 0; i < PANEL_COUNT; i += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = PANEL_CANVAS_WIDTH;
      canvas.height = PANEL_CANVAS_HEIGHT;
      const context = canvas.getContext('2d');
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;

      const material = this._registerMaterial(new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
      }), 0.96);
      const mesh = new THREE.Mesh(panelGeometry, material);

      const angle = (i / PANEL_COUNT) * Math.PI * 2;
      const y = Math.sin(i * 0.6) * 0.18;
      mesh.position.set(Math.cos(angle) * PANEL_RADIUS, y, Math.sin(angle) * PANEL_RADIUS);
      mesh.lookAt(0, y * 0.35, 0);
      mesh.userData.basePosition = mesh.position.clone();
      mesh.userData.focusY = y;
      mesh.userData.focus = 0;

      this._panelCanvases.push(canvas);
      this._panelContexts.push(context);
      this._panelTextures.push(texture);
      this._panelMeshes.push(mesh);
      this._group.add(mesh);
    }
  }

  _buildQueueOrbs() {
    const geometry = new THREE.IcosahedronGeometry(0.07, 0);

    for (let i = 0; i < 8; i += 1) {
      const material = this._registerMaterial(new THREE.MeshBasicMaterial({
        color: 0x78b4ff,
        transparent: true,
        opacity: 0,
      }), 0.95);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.userData.offset = new THREE.Vector3(
        0.10 + (i % 4) * 0.11,
        -0.15 + Math.floor(i / 4) * 0.18,
        -0.16 + (i % 2) * 0.16
      );
      this._queueOrbPool.push(mesh);
      this._group.add(mesh);
    }
  }

  _buildConduit() {
    const curve = new THREE.LineCurve3(
      new THREE.Vector3(0, -2.6, 0),
      new THREE.Vector3(0, 2.6, 0)
    );
    this._conduitMaterial = new THREE.MeshBasicMaterial({
      color: 0x2758ff,
      transparent: true,
      opacity: 0,
    });
    this._conduit = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 48, 0.05, 12, false),
      this._conduitMaterial
    );
    this._conduit.position.copy(CONDUIT_OFFSET);
    this._group.add(this._conduit);

    const particleCount = 180;
    const positions = new Float32Array(particleCount * 3);
    const ys = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i += 1) {
      ys[i] = THREE.MathUtils.lerp(-2.45, 2.45, Math.random());
      positions[i * 3 + 0] = (Math.random() - 0.5) * 0.18;
      positions[i * 3 + 1] = ys[i];
      positions[i * 3 + 2] = (Math.random() - 0.5) * 0.18;
    }
    this._conduitParticleY = ys;
    this._conduitParticleGeometry = new THREE.BufferGeometry();
    this._conduitParticleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._conduitPointsMaterial = new THREE.PointsMaterial({
      color: 0x90d6ff,
      transparent: true,
      opacity: 0,
      size: 0.045,
      sizeAttenuation: true,
      depthWrite: false,
    });
    this._conduitPoints = new THREE.Points(this._conduitParticleGeometry, this._conduitPointsMaterial);
    this._conduitPoints.position.copy(CONDUIT_OFFSET);
    this._group.add(this._conduitPoints);
  }

  _buildLights() {
    this._ambientLight = new THREE.AmbientLight(0x173567, 0);
    this._fillLightA = new THREE.PointLight(0x5fa8ff, 0, 12, 2);
    this._fillLightB = new THREE.PointLight(0x3b68ff, 0, 12, 2);
    this._fillLightA.position.set(0, 2.6, 1.8);
    this._fillLightB.position.set(0, -2.8, -1.8);
    this._group.add(this._ambientLight);
    this._group.add(this._fillLightA);
    this._group.add(this._fillLightB);
    this._lightsReady = true;
  }

  _subscribe() {
    buildEventBus.addEventListener('jenkins-update', (event) => {
      this._jenkins = event.detail || getJenkinsSnapshot();
      this._dirtyPanels = true;
    });

    dockerEventBus.addEventListener('containers-update', (event) => {
      this._dockerContainers = event.detail?.containers || [];
      this._dirtyPanels = true;
    });

    n8nEventBus.addEventListener('n8n-update', (event) => {
      this._n8n = event.detail || getN8nSnapshot();
      this._dirtyPanels = true;
    });

    memoryEventBus.addEventListener('memory-update', (event) => {
      this._memory = event.detail || getMemorySnapshot();
      this._dirtyPanels = true;
    });

    window.addEventListener('mission-control-transcript', (event) => {
      const text = event.detail?.text ?? event.detail?.fullText ?? '';
      if (!text) return;
      this._voiceText = String(text).trim();
      this._voiceState = 'listening';
      this._dirtyPanels = true;
    });

    window.addEventListener('mission-control-speech', (event) => {
      if (event.detail?.speaking) {
        this._voiceState = 'listening';
      } else if (!this._responseText) {
        this._voiceState = 'idle';
      }
      this._dirtyPanels = true;
    });

    window.addEventListener('mc-ai-response', (event) => {
      const text = event.detail?.text ?? '';
      if (!text) return;
      this._responseText = String(text).trim();
      this._responseAt = Date.now();
      this._voiceState = 'responding';
      this._dirtyPanels = true;
    });
  }

  _getHealthMode() {
    const failedJobs = (this._jenkins.jobs || []).filter((job) =>
      String(job.color || '').startsWith('red') ||
      String(job.color || '').startsWith('aborted') ||
      String(job.color || '').startsWith('yellow')
    ).length;
    const unhealthyContainers = this._dockerContainers.filter((container) => container.health === 'unhealthy').length;
    const pendingInputs = (this._jenkins.hitl || []).length;

    if (pendingInputs > 0) return 'hitl';
    if (failedJobs > 0 || unhealthyContainers > 0 || this._jenkins.status === 'error') return 'error';
    if ((this._jenkins.queueItems || []).length > 0 || this._n8n?.summary?.failedExecutions > 0) return 'warning';
    return 'ok';
  }

  _getConduitState() {
    if ((this._jenkins.hitl || []).length > 0) return 'hitl';
    if (this._voiceState === 'responding' && Date.now() - this._responseAt < 7000) return 'voice';
    if ((this._jenkins.runningJobs || []).length > 0) return 'running';
    if (this._jenkins.status === 'error') return 'failed';
    return 'idle';
  }

  _updateLights(delta) {
    const healthMode = this._getHealthMode();
    const targetColor = this._tmpColor;
    if (healthMode === 'hitl') {
      targetColor.setRGB(0.58, 0.42, 0.14);
    } else if (healthMode === 'error') {
      targetColor.setRGB(0.46, 0.12, 0.14);
    } else if (healthMode === 'warning') {
      targetColor.setRGB(0.30, 0.24, 0.14);
    } else {
      targetColor.setRGB(0.10, 0.21, 0.42);
    }

    this._ambientLight.color.lerp(targetColor, 1 - Math.exp(-delta * 2.8));
    this._fillLightA.color.lerp(targetColor.clone().offsetHSL(0.02, 0.05, 0.1), 1 - Math.exp(-delta * 3.2));
    this._fillLightB.color.lerp(targetColor.clone().offsetHSL(-0.02, 0.02, -0.03), 1 - Math.exp(-delta * 3.2));
  }

  _updateConduit(elapsed, delta) {
    const conduitState = this._getConduitState();
    const positions = this._conduitParticleGeometry.attributes.position.array;
    let speed = 0.55;
    let hue = new THREE.Color(0x66b8ff);

    if (conduitState === 'running') {
      speed = 1.25;
      hue = new THREE.Color(0x9ce8ff);
    } else if (conduitState === 'failed') {
      speed = -0.82;
      hue = new THREE.Color(0xff6a7c);
    } else if (conduitState === 'hitl') {
      speed = 0.12;
      hue = new THREE.Color(0xffd36a);
    } else if (conduitState === 'voice') {
      speed = 1.45;
      hue = new THREE.Color(0xb591ff);
    }

    this._conduitMaterial.color.lerp(hue, 1 - Math.exp(-delta * 4.0));
    this._conduitPointsMaterial.color.lerp(hue, 1 - Math.exp(-delta * 5.0));
    this._conduit.rotation.y = elapsed * 0.08;
    this._conduit.position.copy(CONDUIT_OFFSET);
    this._conduitPoints.position.copy(CONDUIT_OFFSET);

    for (let i = 0; i < this._conduitParticleY.length; i += 1) {
      this._conduitParticleY[i] += speed * delta;
      if (this._conduitParticleY[i] > 2.5) this._conduitParticleY[i] = -2.5;
      if (this._conduitParticleY[i] < -2.5) this._conduitParticleY[i] = 2.5;

      const wobble = 0.05 + 0.03 * Math.sin(elapsed * 1.9 + i * 0.7);
      positions[i * 3 + 0] = Math.cos(elapsed * 0.9 + i * 0.31) * wobble;
      positions[i * 3 + 1] = this._conduitParticleY[i];
      positions[i * 3 + 2] = Math.sin(elapsed * 0.9 + i * 0.43) * wobble;
    }

    this._conduitParticleGeometry.attributes.position.needsUpdate = true;
  }

  _updateQueueOrbs(elapsed, delta) {
    const queueItems = Array.isArray(this._jenkins.queueItems) ? this._jenkins.queueItems.slice(0, this._queueOrbPool.length) : [];
    this._queuePulse += delta * (0.8 + queueItems.length * 0.08);

    const anchor = this._panelMeshes[0]?.position || new THREE.Vector3(PANEL_RADIUS, 0, 0);
    for (let i = 0; i < this._queueOrbPool.length; i += 1) {
      const mesh = this._queueOrbPool[i];
      const queueItem = queueItems[i];

      if (!queueItem) {
        mesh.visible = false;
        continue;
      }

      mesh.visible = true;
      mesh.material.color.copy(pickJobAccent(queueItem.name));
      mesh.position.copy(anchor).add(mesh.userData.offset);
      mesh.position.y += Math.sin(this._queuePulse * 1.7 + i) * 0.06;
      mesh.position.x += Math.cos(this._queuePulse * 1.2 + i * 0.8) * 0.04;
      mesh.position.z += Math.sin(this._queuePulse * 1.4 + i * 0.5) * 0.05;
      mesh.rotation.x = elapsed * (0.8 + i * 0.1);
      mesh.rotation.y = elapsed * (1.0 + i * 0.15);
      mesh.scale.setScalar(1 + Math.sin(this._queuePulse * 2.1 + i) * 0.12);
    }
  }

  _updatePanelFocus(delta) {
    const ease = 1 - Math.exp(-delta * 8);
    this._cameraForward.set(0, 0, -1).applyQuaternion(this._camera.quaternion).normalize();

    let bestIndex = -1;
    let bestAlignment = -1;
    for (let i = 0; i < this._panelMeshes.length; i += 1) {
      const mesh = this._panelMeshes[i];
      mesh.getWorldPosition(this._panelWorldPos);
      this._panelViewDir.copy(this._panelWorldPos).sub(this._camera.position).normalize();
      const alignment = this._cameraForward.dot(this._panelViewDir);
      if (alignment > bestAlignment) {
        bestAlignment = alignment;
        bestIndex = i;
      }
    }

    const focusStrength = THREE.MathUtils.smoothstep(bestAlignment, 0.84, 0.992);
    for (let i = 0; i < this._panelMeshes.length; i += 1) {
      const mesh = this._panelMeshes[i];
      const basePosition = mesh.userData.basePosition;
      const targetFocus = i === bestIndex ? focusStrength : 0;
      const nextFocus = THREE.MathUtils.lerp(mesh.userData.focus || 0, targetFocus, ease);
      mesh.userData.focus = nextFocus;

      this._panelTargetPos.copy(basePosition).multiplyScalar(1 - nextFocus * 0.24);
      mesh.position.lerp(this._panelTargetPos, ease);

      this._panelTargetScale.setScalar(1 + nextFocus * 0.16);
      mesh.scale.lerp(this._panelTargetScale, ease);
      mesh.lookAt(0, mesh.userData.focusY * 0.35, 0);
    }
  }

  _renderPanel(index, { title, accent, lines = [], footer = '', ghost = false }) {
    const ctx = this._panelContexts[index];
    const canvas = this._panelCanvases[index];
    const texture = this._panelTextures[index];
    if (!ctx || !canvas || !texture) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    bg.addColorStop(0, ghost ? 'rgba(20, 14, 30, 0.92)' : 'rgba(6, 10, 18, 0.94)');
    bg.addColorStop(1, ghost ? 'rgba(14, 10, 22, 0.88)' : 'rgba(4, 7, 14, 0.92)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = accent;
    ctx.lineWidth = ghost ? 1.0 : 1.6;
    ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);

    ctx.fillStyle = ghost ? 'rgba(168, 148, 214, 0.54)' : 'rgba(138, 164, 198, 0.64)';
    ctx.font = '700 16px "Courier New", monospace';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
    ctx.shadowBlur = 2;
    ctx.fillText(title.toUpperCase(), 22, 18);

    ctx.strokeStyle = 'rgba(150, 190, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(20, 46);
    ctx.lineTo(canvas.width - 20, 46);
    ctx.stroke();

    ctx.fillStyle = ghost ? 'rgba(168, 158, 202, 0.56)' : 'rgba(150, 164, 182, 0.68)';
    ctx.font = '13px "Courier New", monospace';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 1.5;
    lines.slice(0, 10).forEach((line, lineIndex) => {
      ctx.fillText(line, 22, 66 + lineIndex * 22);
    });

    ctx.fillStyle = ghost ? 'rgba(194, 172, 255, 0.40)' : 'rgba(146, 170, 214, 0.58)';
    ctx.font = '11px "Courier New", monospace';
    ctx.shadowBlur = 0;
    ctx.fillText(footer || 'Mission Control / Command Ring', 22, canvas.height - 28);

    texture.needsUpdate = true;
  }

  _renderPanels() {
    const jenkins = this._jenkins || getJenkinsSnapshot();
    const dockerContainers = this._dockerContainers || getContainers();
    const n8n = this._n8n || getN8nSnapshot();
    const memory = this._memory || getMemorySnapshot();
    const queueItems = Array.isArray(jenkins.queueItems) ? jenkins.queueItems : [];
    const runningJobs = Array.isArray(jenkins.runningJobs) ? jenkins.runningJobs : [];
    const hitl = Array.isArray(jenkins.hitl) ? jenkins.hitl : [];
    const unhealthy = dockerContainers.filter((container) => container.health === 'unhealthy');
    const runningContainers = dockerContainers.filter((container) => container.state === 'running');
    const memoryNotes = Array.isArray(memory.recentNotes) ? memory.recentNotes : [];
    const memoryLayers = Array.isArray(memory.layers) ? memory.layers : [];

    const now = formatClock(new Date());
    const panelData = [
      {
        accent: hitl.length ? 'rgba(255, 211, 106, 0.82)' : (jenkins.status === 'error' ? 'rgba(255, 116, 132, 0.84)' : 'rgba(114, 182, 255, 0.80)'),
        lines: [
          `${queueItems.length} queued`,
          `${runningJobs.length} running`,
          `${jenkins.executors?.busy || 0}/${jenkins.executors?.total || 0} executors busy`,
          hitl.length ? `${hitl.length} waiting for approval` : 'No HITL block',
          ...summarizeStatusList(queueItems.map((item) => `Q ${normalizeChip(item.name)}`), 4),
        ],
        footer: jenkins.lastUpdated ? `Jenkins ${formatRelativeTime(jenkins.lastUpdated)}` : 'Jenkins snapshot pending',
      },
      {
        accent: 'rgba(255, 166, 116, 0.82)',
        lines: [
          'Drill-down scene is live',
          'VM inventory path linked',
          'TrueNAS, Media, Docker1 visible',
          'Back-stack pattern already exists',
          'Panel click routing next',
        ],
        footer: 'Proxmox scene pass 1 shipped',
      },
      {
        accent: unhealthy.length ? 'rgba(255, 146, 110, 0.82)' : 'rgba(88, 232, 198, 0.82)',
        lines: [
          `${runningContainers.length}/${dockerContainers.length} containers running`,
          unhealthy.length ? `${unhealthy.length} unhealthy containers` : 'No unhealthy containers',
          ...summarizeStatusList(dockerContainers.slice(0, 4).map((container) =>
            `${normalizeChip(container.name)} ${container.state}`
          ), 4),
        ],
        footer: 'Portainer endpoint 3',
      },
      {
        accent: n8n.mode === 'live' ? 'rgba(138, 176, 255, 0.82)' : 'rgba(194, 160, 255, 0.82)',
        lines: [
          `${n8n.summary?.workflowCount || 0} workflows`,
          `${n8n.summary?.runningExecutions || 0} running executions`,
          `${n8n.summary?.failedExecutions || 0} blocked executions`,
          normalizeChip(n8n.mode === 'live' ? 'Live proxy' : n8n.mode === 'seed' ? 'Seed snapshot' : 'Fallback orbit'),
          ...summarizeStatusList((n8n.workflowRuns || []).slice(0, 4).map((workflow) =>
            `${normalizeChip(workflow.name).replace(/^Automation Orbit -\s*/, '')} ${workflow.status || 'idle'}`
          ), 4),
        ],
        footer: n8n.generatedAt ? `n8n ${formatRelativeTime(n8n.generatedAt)}` : 'n8n snapshot pending',
      },
      {
        accent: 'rgba(118, 232, 206, 0.82)',
        lines: [
          `${memoryLayers.length} memory layers`,
          `${memory.stats?.supportDocCount || 0} support docs`,
          `${memory.stats?.recentNoteCount || memoryNotes.length || 0} recent notes`,
          normalizeChip(memory.mode || 'fallback'),
          ...summarizeStatusList(memoryLayers.slice(0, 4).map((layer) =>
            `${normalizeChip(layer.name)} ${normalizeChip(layer.status)}`
          ), 4),
        ],
        footer: memory.generatedAt ? `Memory ${formatRelativeTime(memory.generatedAt)}` : 'Memory snapshot pending',
      },
      {
        accent: this._voiceState === 'listening' ? 'rgba(183, 145, 255, 0.84)' : 'rgba(124, 194, 255, 0.78)',
        lines: this._voiceText
          ? wrapText(this._voiceText, 38, 8)
          : ['Waiting for transcript', 'Speak into the STT bridge', 'Partial text will echo here'],
        footer: `Voice state: ${normalizeChip(this._voiceState)}`,
      },
      {
        accent: this._responseText ? 'rgba(114, 226, 255, 0.84)' : 'rgba(88, 146, 198, 0.72)',
        lines: this._responseText
          ? wrapText(this._responseText, 38, 8)
          : ['No AI response yet', 'Responses from /push and STT', 'will render here'],
        footer: this._responseAt ? `Response ${formatRelativeTime(this._responseAt)}` : 'Response channel idle',
      },
      {
        accent: 'rgba(255, 211, 142, 0.82)',
        lines: [
          'LM Studio 100.71.100.103:1234',
          'Ollama 10.201.52.200:11434',
          'LiteLLM /proxy/litellm',
          'Command Ring can reuse panel data',
          'Live health hookup still pending',
        ],
        footer: 'LLM routing surface',
      },
      {
        accent: 'rgba(126, 235, 188, 0.82)',
        lines: memoryNotes.length
          ? summarizeStatusList(memoryNotes.slice(0, 6).map((note) => {
              if (typeof note === 'string') return note;
              return note.path || note.title || note.label || 'Vault note';
            }), 6)
          : ['No recent Logseq notes in snapshot', 'Generated memory export will fill this'],
        footer: 'Recent vault path',
      },
      {
        accent: 'rgba(114, 234, 255, 0.82)',
        lines: [
          `${memory.stats?.indexedDocCount || 0} indexed docs`,
          normalizeChip(memory.overview?.services || 'Qdrant sync path pending'),
          normalizeChip(memory.overview?.storage || 'TrueNAS-backed storage'),
          'Vector clusters feed this panel later',
          'Current pass uses memory snapshot',
        ],
        footer: 'Qdrant-aware placeholder',
      },
      {
        accent: 'rgba(186, 144, 255, 0.82)',
        lines: [
          'Codex guidance bridge planned',
          'Valkey queue panel not wired yet',
          'Ring shell reserves this slot',
          queueItems.length ? `${queueItems.length} Jenkins queue items visible nearby` : 'No queued jobs right now',
          hitl.length ? 'HITL overlay is live in HUD' : 'Awaiting task feed',
        ],
        footer: 'Codex / Valkey placeholder',
        ghost: true,
      },
      {
        accent: 'rgba(224, 236, 255, 0.82)',
        lines: [
          now,
          `Queue ${queueItems.length} | Running ${runningJobs.length}`,
          `Bridge ${normalizeChip(this._voiceState)}`,
          `n8n ${normalizeChip(n8n.mode || 'fallback')}`,
          `Memory ${normalizeChip(memory.mode || 'fallback')}`,
        ],
        footer: 'Local browser clock',
      },
    ];

    for (let i = 0; i < PANEL_COUNT; i += 1) {
      const panel = panelData[i];
      this._renderPanel(i, {
        title: PANEL_TITLES[i],
        accent: panel.accent,
        lines: panel.lines,
        footer: panel.footer,
        ghost: panel.ghost,
      });
    }
  }

  update(elapsed, delta) {
    if (!this._active && this._fade <= 0.001) return;

    if (!this._isInteracting) {
      this._autoYaw += delta * 0.08;
    }

    this._group.rotation.y = this._userYaw + this._autoYaw;
    this._group.rotation.x = this._userPitch;

    this._updateLights(delta);
    this._updateConduit(elapsed, delta);
    this._updateQueueOrbs(elapsed, delta);
    this._updatePanelFocus(delta);

    this._panelRefreshCooldown -= delta;
    this._clockRefreshCooldown -= delta;
    if (this._clockRefreshCooldown <= 0) {
      this._dirtyPanels = true;
      this._clockRefreshCooldown = 1;
    }
    if (this._dirtyPanels || this._panelRefreshCooldown <= 0) {
      this._renderPanels();
      this._dirtyPanels = false;
      this._panelRefreshCooldown = 8;
    }
  }
}
