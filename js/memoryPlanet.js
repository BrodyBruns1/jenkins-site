/**
 * memoryPlanet.js -- Memory Constellation + Constellation Game
 *
 * Visualizes the seven-layer Claude memory stack as a star constellation,
 * and lets you morph it into real constellations (Orion, Big Dipper, etc.).
 * Stars can be toggled on/off, and blank stars can be added.
 */

import * as THREE from 'three';

// ── Tone colors ──────────────────────────────────────────────────────────
const TONE_COLORS = {
  stable:  0x8db7ff,
  active:  0x73f6d1,
  synced:  0xffc96b,
  storage: 0xff9a63,
  bridge:  0xb7d8ff,
  star:    0xc8dce8,   // default for real constellation stars
};

// ── Pool sizes ───────────────────────────────────────────────────────────
const POOL_SIZE      = 15;
const EDGE_POOL_SIZE = 22;
const MORPH_DURATION = 1.8;  // seconds

// ── Memory layout: star positions (local coords) ────────────────────────
const MEMORY_POSITIONS = {
  proxmox:     { x:  0.0,  y:  4.2,  z:  0.0  },
  vm105:       { x:  4.5,  y: -2.8,  z: -0.5  },
  truenas:     { x:  0.5,  y: -3.2,  z: -0.3  },
  vault:       { x: -4.2,  y: -2.2,  z: -0.4  },
  claude:      { x: -3.0,  y:  2.6,  z:  0.2  },
  primary:     { x:  0.0,  y:  2.0,  z:  0.3  },
  'memory-sh': { x:  3.0,  y:  2.6,  z:  0.2  },
  hindsight:   { x:  0.0,  y:  0.2,  z:  0.1  },
  logseq:      { x: -2.8,  y: -0.8,  z: -0.1  },
  valkey:      { x:  2.8,  y: -0.8,  z: -0.1  },
  qdrant:      { x:  2.5,  y: -4.2,  z: -0.3  },
};

// ── Memory layout: star metadata ─────────────────────────────────────────
const MEMORY_STARS = [
  { id: 'proxmox',    name: 'Proxmox Host',  status: 'hooks + orchestration', tone: 'stable',  bright: true  },
  { id: 'vm105',      name: 'VM 105',        status: 'Valkey + Qdrant',       tone: 'synced',  bright: true  },
  { id: 'truenas',    name: 'TrueNAS',       status: '/mnt/llm-memory',       tone: 'storage', bright: true  },
  { id: 'vault',      name: 'Logseq Vault',  status: '5 recent notes',        tone: 'active',  bright: true  },
  { id: 'claude',     name: 'CLAUDE.md',     status: 'stable rules',          tone: 'stable',  bright: false },
  { id: 'primary',    name: 'PRIMARY.md',    status: 'rolling state',         tone: 'bridge',  bright: false },
  { id: 'memory-sh',  name: 'memory.sh',     status: 'session start',         tone: 'bridge',  bright: false },
  { id: 'hindsight',  name: 'HINDSIGHT.md',  status: 'durable patterns',      tone: 'stable',  bright: false },
  { id: 'logseq',     name: 'LOGSEQ.md',     status: 'shared vault',          tone: 'active',  bright: false },
  { id: 'valkey',     name: 'VALKEY.md',     status: 'synced queue',          tone: 'synced',  bright: false },
  { id: 'qdrant',     name: 'QDRANT.md',     status: 'vector sync',           tone: 'synced',  bright: false },
];

// ── Memory layout: edge pairs (by ID) ────────────────────────────────────
const MEMORY_EDGE_IDS = [
  ['proxmox', 'claude'],     ['proxmox', 'primary'],   ['proxmox', 'memory-sh'],
  ['claude', 'hindsight'],   ['primary', 'hindsight'],  ['memory-sh', 'hindsight'],
  ['hindsight', 'logseq'],   ['hindsight', 'valkey'],
  ['logseq', 'vault'],       ['logseq', 'truenas'],
  ['valkey', 'vm105'],       ['valkey', 'truenas'],
  ['truenas', 'qdrant'],     ['vm105', 'qdrant'],
];

// Convert to index pairs
const _memIdxMap = new Map(MEMORY_STARS.map((s, i) => [s.id, i]));
const MEMORY_EDGES = MEMORY_EDGE_IDS
  .map(([a, b]) => [_memIdxMap.get(a), _memIdxMap.get(b)])
  .filter(([a, b]) => a != null && b != null);

// ── Real constellation definitions ───────────────────────────────────────
const REAL_CONSTELLATIONS = {
  orion: {
    name: 'Orion',
    stars: [
      { name: 'Betelgeuse', x: -2.2, y: 3.5, z: 0.1, bright: true  },
      { name: 'Bellatrix',  x: 2.0,  y: 3.0, z: 0.0, bright: false },
      { name: 'Mintaka',    x: -0.8, y: 0.3, z: 0.0, bright: false },
      { name: 'Alnilam',    x: 0.0,  y: 0.0, z: 0.0, bright: false },
      { name: 'Alnitak',    x: 0.8,  y:-0.3, z: 0.0, bright: false },
      { name: 'Saiph',      x: -2.0, y:-3.5, z: 0.1, bright: false },
      { name: 'Rigel',      x: 2.2,  y:-3.8, z: 0.0, bright: true  },
    ],
    edges: [[0,1],[0,2],[1,4],[2,3],[3,4],[2,5],[4,6]],
  },
  'big-dipper': {
    name: 'Big Dipper',
    stars: [
      { name: 'Dubhe',  x: -4.0, y: 2.0,  z: 0.0, bright: true  },
      { name: 'Merak',  x: -4.0, y:-0.5,  z: 0.0, bright: false },
      { name: 'Phecda', x: -1.5, y:-0.8,  z: 0.0, bright: false },
      { name: 'Megrez', x: -1.0, y: 1.5,  z: 0.0, bright: false },
      { name: 'Alioth', x: 1.0,  y: 2.0,  z: 0.0, bright: false },
      { name: 'Mizar',  x: 2.8,  y: 2.8,  z: 0.0, bright: true  },
      { name: 'Alkaid', x: 4.5,  y: 3.5,  z: 0.0, bright: false },
    ],
    edges: [[0,1],[1,2],[2,3],[3,0],[3,4],[4,5],[5,6]],
  },
  cassiopeia: {
    name: 'Cassiopeia',
    stars: [
      { name: 'Segin',   x: -4.0, y:-0.5, z: 0.0, bright: false },
      { name: 'Ruchbah', x: -1.8, y: 2.5, z: 0.0, bright: false },
      { name: 'Gamma',   x: 0.0,  y:-1.0, z: 0.0, bright: true  },
      { name: 'Schedar', x: 1.8,  y: 2.5, z: 0.0, bright: true  },
      { name: 'Caph',    x: 4.0,  y: 0.0, z: 0.0, bright: false },
    ],
    edges: [[0,1],[1,2],[2,3],[3,4]],
  },
  cygnus: {
    name: 'Cygnus',
    stars: [
      { name: 'Deneb',   x: 0.0,  y: 4.0, z: 0.0, bright: true  },
      { name: 'Delta',   x: 0.0,  y: 2.0, z: 0.0, bright: false },
      { name: 'Sadr',    x: 0.0,  y: 0.5, z: 0.0, bright: false },
      { name: 'Gienah',  x: -3.5, y: 1.0, z: 0.0, bright: false },
      { name: 'Epsilon', x: 3.5,  y: 1.0, z: 0.0, bright: false },
      { name: 'Albireo', x: 0.0,  y:-3.5, z: 0.0, bright: true  },
    ],
    edges: [[0,1],[1,2],[2,5],[3,2],[2,4]],
  },
  scorpius: {
    name: 'Scorpius',
    stars: [
      { name: 'Acrab',    x: -2.0, y: 4.5, z: 0.0, bright: false },
      { name: 'Dschubba', x: -0.8, y: 3.8, z: 0.0, bright: false },
      { name: 'Antares',  x: 0.0,  y: 2.0, z: 0.0, bright: true  },
      { name: 'Tau',      x: 0.5,  y: 0.5, z: 0.0, bright: false },
      { name: 'Epsilon',  x: 1.0,  y:-0.8, z: 0.0, bright: false },
      { name: 'Mu',       x: 1.8,  y:-1.8, z: 0.0, bright: false },
      { name: 'Zeta',     x: 2.8,  y:-2.5, z: 0.0, bright: false },
      { name: 'Eta',      x: 3.2,  y:-3.2, z: 0.0, bright: false },
      { name: 'Theta',    x: 2.5,  y:-4.0, z: 0.0, bright: false },
      { name: 'Lambda',   x: 1.5,  y:-4.5, z: 0.0, bright: true  },
    ],
    edges: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9]],
  },
  lyra: {
    name: 'Lyra',
    stars: [
      { name: 'Vega',    x: 0.0,  y: 3.5, z: 0.0, bright: true  },
      { name: 'Zeta',    x: -1.2, y: 1.5, z: 0.0, bright: false },
      { name: 'Delta',   x: 1.2,  y: 1.5, z: 0.0, bright: false },
      { name: 'Gamma',   x: -1.5, y:-1.0, z: 0.0, bright: false },
      { name: 'Beta',    x: 1.5,  y:-1.0, z: 0.0, bright: false },
    ],
    edges: [[0,1],[0,2],[1,3],[2,4],[3,4],[1,2]],
  },
};

// ── Build unified layouts map ────────────────────────────────────────────
const LAYOUTS = {
  memory: {
    name: 'Memory Stack',
    stars: MEMORY_STARS.map((s) => ({
      name: s.name, status: s.status || '', tone: s.tone,
      bright: s.bright, id: s.id,
      x: MEMORY_POSITIONS[s.id].x,
      y: MEMORY_POSITIONS[s.id].y,
      z: MEMORY_POSITIONS[s.id].z,
    })),
    edges: MEMORY_EDGES,
  },
};
Object.entries(REAL_CONSTELLATIONS).forEach(([key, c]) => {
  LAYOUTS[key] = {
    name: c.name,
    stars: c.stars.map((s) => ({
      name: s.name, status: '', tone: 'star',
      bright: s.bright, id: null,
      x: s.x, y: s.y, z: s.z,
    })),
    edges: c.edges,
  };
});

// ── MEMORY_ORBIT_DATA (unchanged — used by main.js summary renderer) ─────
export const MEMORY_ORBIT_DATA = {
  overview: {
    layers: '7 live layers',
    workspace: '/mnt/llm-memory/proxmox/memory',
    storage: '/mnt/llm-memory',
    services: 'VM105: Valkey + Qdrant',
  },
  supportingDocs: [
    { id: 'memory-index',  name: 'MEMORY.md',        status: 'structured index', tone: 'active' },
    { id: 'memory-system', name: 'MEMORY_SYSTEM.md',  status: 'seven-layer map',  tone: 'stable' },
  ],
  recentNotes: [
    'Codex Vault Test', 'journals/2026_03_20',
    'Claude Memory Behavior Cheat Sheet', 'pages/contents', 'Memory Graph',
  ],
  anchors: [
    { id: 'proxmox', name: 'Proxmox Host',  status: 'hooks + orchestration', tone: 'stable',  radius: 4.95, speed: 0.055, angle: 0.45, yScale: 0.34, zScale: 0.56 },
    { id: 'vm105',   name: 'VM 105',        status: 'Valkey + Qdrant',       tone: 'synced',  radius: 5.55, speed:-0.050, angle: 2.12, yScale: 0.28, zScale: 0.68 },
    { id: 'truenas', name: 'TrueNAS',       status: '/mnt/llm-memory',       tone: 'storage', radius: 5.95, speed: 0.043, angle: 3.86, yScale: 0.32, zScale: 0.72 },
    { id: 'vault',   name: 'Logseq Vault',  status: '5 recent notes',        tone: 'active',  radius: 5.2,  speed:-0.060, angle: 5.34, yScale: 0.24, zScale: 0.60 },
  ],
  layers: [
    { id: 'claude',    name: 'CLAUDE.md',    status: 'stable rules',    tone: 'stable', radius: 1.82, speed: 0.18, angle: 0.18, anchors: ['proxmox'] },
    { id: 'primary',   name: 'PRIMARY.md',   status: 'rolling state',   tone: 'bridge', radius: 2.18, speed: 0.16, angle: 1.04, anchors: ['proxmox'] },
    { id: 'memory-sh', name: 'memory.sh',    status: 'session start',   tone: 'bridge', radius: 2.52, speed: 0.14, angle: 1.95, anchors: ['proxmox'] },
    { id: 'hindsight', name: 'HINDSIGHT.md', status: 'durable patterns', tone: 'stable', radius: 2.86, speed: 0.12, angle: 2.84, anchors: ['proxmox'] },
    { id: 'logseq',    name: 'LOGSEQ.md',    status: 'shared vault',    tone: 'active', radius: 3.22, speed: 0.10, angle: 3.78, anchors: ['vault', 'truenas'] },
    { id: 'valkey',    name: 'VALKEY.md',    status: 'synced queue',    tone: 'synced', radius: 3.58, speed: 0.09, angle: 4.66, anchors: ['vm105', 'truenas'] },
    { id: 'qdrant',    name: 'QDRANT.md',    status: 'vector sync',     tone: 'synced', radius: 3.92, speed: 0.08, angle: 5.5,  anchors: ['vm105', 'truenas'] },
  ],
};

// ── Helpers (unchanged) ──────────────────────────────────────────────────
function _toneColor(tone) {
  return new THREE.Color(TONE_COLORS[tone] || TONE_COLORS.star);
}

function _cloneOrbitData() {
  return JSON.parse(JSON.stringify(MEMORY_ORBIT_DATA));
}

function _normalizeRecentNote(note, index) {
  if (typeof note === 'string') {
    return { id: `note-${index + 1}`, title: note, path: note, preview: note, label: note };
  }
  if (!note || typeof note !== 'object') {
    return { id: `note-${index + 1}`, title: `Note ${index + 1}`, path: '', preview: '', label: `Note ${index + 1}` };
  }
  const title   = String(note.title || note.path || note.preview || `Note ${index + 1}`).trim();
  const path    = String(note.path || title).trim();
  const preview = String(note.preview || title).trim();
  return { ...note, id: String(note.id || `note-${index + 1}`), title, path, preview,
    label: String(note.label || `${path} - ${title}`).trim() };
}

export function mergeMemoryOrbitData(snapshot = null) {
  const merged = _cloneOrbitData();
  if (!snapshot || typeof snapshot !== 'object') return merged;
  if (snapshot.overview && typeof snapshot.overview === 'object')
    merged.overview = { ...merged.overview, ...snapshot.overview };
  if (Array.isArray(snapshot.supportingDocs) && snapshot.supportingDocs.length) {
    const m = new Map(snapshot.supportingDocs.filter(d => d?.id).map(d => [String(d.id), d]));
    merged.supportingDocs = merged.supportingDocs.map(d => { const n = m.get(d.id); return n ? { ...d, ...n } : d; });
  }
  if (Array.isArray(snapshot.recentNotes) && snapshot.recentNotes.length)
    merged.recentNotes = snapshot.recentNotes.map(_normalizeRecentNote);
  else
    merged.recentNotes = merged.recentNotes.map(_normalizeRecentNote);
  if (Array.isArray(snapshot.anchors) && snapshot.anchors.length) {
    const m = new Map(snapshot.anchors.filter(a => a?.id).map(a => [String(a.id), a]));
    merged.anchors = merged.anchors.map(a => { const n = m.get(a.id); return n ? { ...a, ...n, id: a.id } : a; });
  }
  if (Array.isArray(snapshot.layers) && snapshot.layers.length) {
    const m = new Map(snapshot.layers.filter(l => l?.id).map(l => [String(l.id), l]));
    merged.layers = merged.layers.map(l => { const n = m.get(l.id); return n ? { ...l, ...n, id: l.id } : l; });
  }
  if (snapshot.sourcePaths && typeof snapshot.sourcePaths === 'object')
    merged.sourcePaths = { ...(merged.sourcePaths || {}), ...snapshot.sourcePaths };
  if (snapshot.stats && typeof snapshot.stats === 'object')
    merged.stats = { ...(merged.stats || {}), ...snapshot.stats };
  if (snapshot.generatedAt) merged.generatedAt = snapshot.generatedAt;
  return merged;
}

function _setLabelText(label, name, status) {
  const nameEl   = label.querySelector('.memory-label__name');
  const statusEl = label.querySelector('.memory-label__status');
  if (nameEl)   nameEl.textContent = name;
  if (statusEl) statusEl.textContent = status;
}

// ── Injected CSS for the constellation picker ────────────────────────────
const _styleInjected = { done: false };
function _injectStyles() {
  if (_styleInjected.done) return;
  _styleInjected.done = true;
  const style = document.createElement('style');
  style.textContent = `
    .constellation-picker {
      position: fixed;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 6px;
      padding: 10px 16px;
      background: rgba(8, 18, 22, 0.88);
      border: 1px solid rgba(130, 255, 208, 0.12);
      border-radius: 14px;
      backdrop-filter: blur(10px);
      z-index: 200;
      transition: opacity 0.4s;
      pointer-events: auto;
      flex-wrap: wrap;
      justify-content: center;
      max-width: 640px;
      opacity: 0;
    }
    .constellation-picker__title {
      width: 100%;
      text-align: center;
      font-size: 10px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: rgba(130, 255, 208, 0.4);
      margin-bottom: 4px;
    }
    .constellation-picker button {
      background: rgba(130, 255, 208, 0.06);
      border: 1px solid rgba(130, 255, 208, 0.14);
      color: rgba(200, 220, 230, 0.75);
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .constellation-picker button:hover {
      background: rgba(130, 255, 208, 0.16);
      border-color: rgba(130, 255, 208, 0.35);
      color: #fff;
    }
    .constellation-picker button.active {
      background: rgba(130, 255, 208, 0.2);
      border-color: rgba(130, 255, 208, 0.5);
      color: #82ffd0;
    }
    .constellation-picker .cpick-add {
      background: rgba(255, 201, 107, 0.08);
      border-color: rgba(255, 201, 107, 0.18);
      color: rgba(255, 220, 160, 0.75);
    }
    .constellation-picker .cpick-add:hover {
      background: rgba(255, 201, 107, 0.18);
      color: #ffc96b;
    }
    .memory-label.clickable { cursor: pointer; }
    .memory-label.star-hidden .memory-label__name,
    .memory-label.star-hidden .memory-label__status {
      opacity: 0.2;
      text-decoration: line-through;
    }
  `;
  document.head.appendChild(style);
}

// ── MemoryPlanet class ───────────────────────────────────────────────────
export class MemoryPlanet {
  constructor(scene, camera) {
    this._scene  = scene;
    this._camera = camera;
    this._fade      = 1.0;
    this._labelFade = 1.0;
    this._data = mergeMemoryOrbitData();

    this._activeLayout  = 'memory';
    this._morphT        = 1.0;   // 1 = settled, <1 = morphing
    this._addedCount    = 0;

    this._group = new THREE.Group();
    this._group.position.set(51.5, -5.15, -2.35);
    scene.add(this._group);

    _injectStyles();
    this._buildPool();
    this._buildEdgePool();
    this._applyLayout('memory', false);
    this._buildUI();
    this._buildLight(scene);
  }

  // ── Public API (unchanged contract) ────────────────────────────────────
  setFade(fade)      { this._fade      = THREE.MathUtils.clamp(fade, 0, 1); }
  setLabelFade(fade) { this._labelFade = THREE.MathUtils.clamp(fade, 0, 1); }
  get position()     { return this._group.position; }

  applySnapshot(snapshot) {
    this._data = mergeMemoryOrbitData(snapshot);
    if (this._activeLayout === 'memory') this._refreshMemoryLabels();
  }

  // ── Pool: stars ────────────────────────────────────────────────────────
  _buildPool() {
    this._pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xc8dce8, transparent: true, opacity: 0 })
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xc8dce8, transparent: true, opacity: 0, depthWrite: false })
      );
      const bloom = new THREE.Mesh(
        new THREE.SphereGeometry(0.7, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xc8dce8, transparent: true, opacity: 0, depthWrite: false, side: THREE.BackSide })
      );
      this._group.add(core, halo, bloom);

      const label = this._createLabel('', '', 'layer', new THREE.Color(0xc8dce8));
      label.classList.add('clickable');
      label.addEventListener('click', () => this._toggleStar(i));

      this._pool.push({
        core, halo, bloom, label,
        active: false,
        hidden: false,
        current: { x: 0, y: 0, z: 0 },
        target:  { x: 0, y: 0, z: 0 },
        source:  { x: 0, y: 0, z: 0 },
        bright: false,
        tone: 'star',
        phaseOffset: i * 0.73 + Math.random() * 0.5,
      });
    }
  }

  // ── Pool: edges ────────────────────────────────────────────────────────
  _buildEdgePool() {
    this._edgePool = [];
    for (let i = 0; i < EDGE_POOL_SIZE; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
      const line = new THREE.Line(geo,
        new THREE.LineBasicMaterial({ color: 0x4a7a8a, transparent: true, opacity: 0, depthWrite: false }));

      const pulseDot = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 6, 4),
        new THREE.MeshBasicMaterial({ color: 0x4a7a8a, transparent: true, opacity: 0, depthWrite: false }));

      this._group.add(line, pulseDot);
      this._edgePool.push({
        line, pulseDot, geo,
        active: false,
        fromIdx: 0, toIdx: 0,
        phaseOffset: Math.random() * Math.PI * 2,
      });
    }
  }

  // ── Apply a layout (memory or real constellation) ──────────────────────
  _applyLayout(key, animate = true) {
    const layout = LAYOUTS[key];
    if (!layout) return;

    const prevLayout = this._activeLayout;
    this._activeLayout = key;
    this._addedCount = 0;

    // Assign stars
    const starCount = layout.stars.length;
    for (let i = 0; i < POOL_SIZE; i++) {
      const ps = this._pool[i];
      if (i < starCount) {
        const ls = layout.stars[i];
        ps.source.x = ps.current.x;
        ps.source.y = ps.current.y;
        ps.source.z = ps.current.z;
        ps.target.x = ls.x;
        ps.target.y = ls.y;
        ps.target.z = ls.z;
        ps.active = true;
        ps.hidden = false;
        ps.bright = ls.bright;
        ps.tone   = ls.tone || 'star';

        const color = _toneColor(ps.tone);
        ps.core.material.color.copy(color);
        ps.halo.material.color.copy(color);
        ps.bloom.material.color.copy(color);
        ps.label.style.setProperty('--memory-accent', color.getStyle());
        ps.label.classList.remove('star-hidden');
        _setLabelText(ps.label, ls.name, ls.status || '');

        // Size by brightness
        const coreR = ls.bright ? 0.18 : 0.12;
        ps.core.geometry.dispose();
        ps.core.geometry = new THREE.SphereGeometry(coreR, 12, 8);
      } else {
        // Deactivate
        ps.active = false;
        ps.hidden = false;
        ps.source.x = ps.current.x;
        ps.source.y = ps.current.y;
        ps.source.z = ps.current.z;
        ps.target.x = ps.current.x;
        ps.target.y = ps.current.y;
        ps.target.z = ps.current.z;
      }
    }

    // Assign edges
    const edgeCount = layout.edges.length;
    for (let i = 0; i < EDGE_POOL_SIZE; i++) {
      const pe = this._edgePool[i];
      if (i < edgeCount) {
        pe.active  = true;
        pe.fromIdx = layout.edges[i][0];
        pe.toIdx   = layout.edges[i][1];
      } else {
        pe.active = false;
      }
    }

    if (animate && prevLayout !== key) {
      this._morphT = 0;
    } else {
      this._morphT = 1;
      // Snap positions immediately
      for (let i = 0; i < POOL_SIZE; i++) {
        const ps = this._pool[i];
        ps.current.x = ps.target.x;
        ps.current.y = ps.target.y;
        ps.current.z = ps.target.z;
      }
    }

    // Update picker button states
    this._updatePickerButtons();
  }

  // ── Refresh memory labels from live snapshot data ──────────────────────
  _refreshMemoryLabels() {
    const anchorMap = new Map(this._data.anchors.map(a => [a.id, a]));
    const layerMap  = new Map(this._data.layers.map(l => [l.id, l]));

    LAYOUTS.memory.stars.forEach((ls, i) => {
      const next = anchorMap.get(ls.id) || layerMap.get(ls.id);
      if (!next) return;
      ls.name   = next.name;
      ls.status = next.status;
      ls.tone   = next.tone;

      const ps = this._pool[i];
      if (!ps || !ps.active) return;
      ps.tone = ls.tone;
      const color = _toneColor(ps.tone);
      ps.core.material.color.copy(color);
      ps.halo.material.color.copy(color);
      ps.bloom.material.color.copy(color);
      ps.label.style.setProperty('--memory-accent', color.getStyle());
      _setLabelText(ps.label, ls.name, ls.status);
    });
  }

  // ── Toggle a star on/off ───────────────────────────────────────────────
  _toggleStar(index) {
    const ps = this._pool[index];
    if (!ps || !ps.active) return;
    ps.hidden = !ps.hidden;
    ps.label.classList.toggle('star-hidden', ps.hidden);
  }

  // ── Add a blank star ───────────────────────────────────────────────────
  _addStar() {
    // Find next inactive pool star
    const idx = this._pool.findIndex(ps => !ps.active);
    if (idx < 0) return; // pool full

    const ps = this._pool[idx];
    // Random position within the constellation area
    const x = (Math.random() - 0.5) * 7;
    const y = (Math.random() - 0.5) * 7;
    const z = (Math.random() - 0.5) * 0.6;

    ps.active = true;
    ps.hidden = false;
    ps.bright = false;
    ps.tone   = 'star';
    ps.current.x = 0; ps.current.y = 0; ps.current.z = 0;
    ps.source.x  = 0; ps.source.y  = 0; ps.source.z  = 0;
    ps.target.x  = x; ps.target.y  = y; ps.target.z  = z;

    const color = _toneColor('star');
    ps.core.material.color.copy(color);
    ps.halo.material.color.copy(color);
    ps.bloom.material.color.copy(color);
    ps.core.geometry.dispose();
    ps.core.geometry = new THREE.SphereGeometry(0.10, 12, 8);
    ps.label.style.setProperty('--memory-accent', color.getStyle());
    ps.label.classList.remove('star-hidden');

    this._addedCount++;
    _setLabelText(ps.label, `Star ${this._addedCount}`, '');

    // Animate this star from center to its position
    this._morphT = Math.min(this._morphT, 0.6);
  }

  // ── UI: constellation picker ───────────────────────────────────────────
  _buildUI() {
    this._picker = document.createElement('div');
    this._picker.className = 'constellation-picker';

    const title = document.createElement('div');
    title.className = 'constellation-picker__title';
    title.textContent = 'Constellations';
    this._picker.appendChild(title);

    this._pickerButtons = {};

    // Memory button
    this._pickerButtons.memory = this._makePickerBtn('Memory Stack', 'memory');

    // Divider
    const sep = document.createElement('span');
    sep.style.cssText = 'width:1px;height:20px;background:rgba(130,255,208,0.12);align-self:center;margin:0 2px;';
    this._picker.appendChild(sep);

    // Real constellation buttons
    Object.entries(REAL_CONSTELLATIONS).forEach(([key, c]) => {
      this._pickerButtons[key] = this._makePickerBtn(c.name, key);
    });

    document.body.appendChild(this._picker);
    this._updatePickerButtons();
  }

  _makePickerBtn(label, key) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.addEventListener('click', () => this._applyLayout(key, true));
    this._picker.appendChild(btn);
    return btn;
  }

  _updatePickerButtons() {
    if (!this._pickerButtons) return;
    Object.entries(this._pickerButtons).forEach(([key, btn]) => {
      btn.classList.toggle('active', key === this._activeLayout);
    });
  }

  // ── Label helper ───────────────────────────────────────────────────────
  _createLabel(name, status, kind, color) {
    const label = document.createElement('div');
    label.className = 'memory-label';
    label.dataset.kind = kind;
    label.style.setProperty('--memory-accent', color.getStyle());

    const nameEl = document.createElement('span');
    nameEl.className = 'memory-label__name';
    nameEl.textContent = name;

    const statusEl = document.createElement('span');
    statusEl.className = 'memory-label__status';
    statusEl.textContent = status;

    label.append(nameEl, statusEl);
    document.body.appendChild(label);
    return label;
  }

  // ── Light ──────────────────────────────────────────────────────────────
  _buildLight(scene) {
    const p = this._group.position;
    this._light = new THREE.PointLight(0x7ff3d8, 1.2, 22);
    this._light.position.set(p.x + 2.0, p.y + 3.0, p.z + 5.0);
    scene.add(this._light);
  }

  // ── Animation loop ─────────────────────────────────────────────────────
  update(elapsed, delta) {
    // Advance morph
    if (this._morphT < 1) {
      this._morphT = Math.min(this._morphT + delta / MORPH_DURATION, 1);
    }
    const mt = this._morphT;
    const eased = mt * mt * (3 - 2 * mt);  // smoothstep

    // Very slow group rotation
    this._group.rotation.y += delta * 0.012;

    // Edge fade: edges appear after stars start moving
    const edgeFade = mt < 0.25 ? mt * 4 : 1.0;

    // ── Update stars ──
    for (let i = 0; i < POOL_SIZE; i++) {
      const ps = this._pool[i];

      // Lerp position
      if (mt < 1) {
        ps.current.x = ps.source.x + (ps.target.x - ps.source.x) * eased;
        ps.current.y = ps.source.y + (ps.target.y - ps.source.y) * eased;
        ps.current.z = ps.source.z + (ps.target.z - ps.source.z) * eased;
      }

      const phase = ps.phaseOffset;

      if (!ps.active || ps.hidden) {
        // Fade out
        const fadeTarget = 0;
        ps.core.material.opacity  = THREE.MathUtils.lerp(ps.core.material.opacity, fadeTarget, delta * 4);
        ps.halo.material.opacity  = THREE.MathUtils.lerp(ps.halo.material.opacity, fadeTarget, delta * 4);
        ps.bloom.material.opacity = THREE.MathUtils.lerp(ps.bloom.material.opacity, fadeTarget, delta * 4);
        ps.core.position.set(ps.current.x, ps.current.y, ps.current.z);
        ps.halo.position.copy(ps.core.position);
        ps.bloom.position.copy(ps.core.position);
        // Hide label
        ps.label.style.opacity = '0';
        continue;
      }

      // Twinkle
      const pulse = Math.sin(elapsed * 1.2 + phase) * 0.5 + 0.5;
      const bright = ps.bright;
      const coreOp = (bright ? 0.95 : 0.85) * this._fade;
      const haloOp = (bright ? 0.08 + pulse * 0.10 : 0.06 + pulse * 0.08) * this._fade;
      const bloomOp = (0.03 + pulse * 0.02) * this._fade;

      ps.core.material.opacity  = THREE.MathUtils.lerp(ps.core.material.opacity, coreOp, delta * 5);
      ps.halo.material.opacity  = THREE.MathUtils.lerp(ps.halo.material.opacity, haloOp, delta * 5);
      ps.bloom.material.opacity = THREE.MathUtils.lerp(ps.bloom.material.opacity, bloomOp, delta * 5);

      ps.halo.scale.setScalar(1.0 + pulse * 0.12);
      ps.bloom.scale.setScalar(1.0 + pulse * 0.08);

      // Gentle float
      const floatY = Math.sin(elapsed * 0.4 + phase * 2.1) * 0.02;
      const floatX = Math.cos(elapsed * 0.35 + phase * 1.7) * 0.012;
      ps.core.position.set(ps.current.x + floatX, ps.current.y + floatY, ps.current.z);
      ps.halo.position.copy(ps.core.position);
      ps.bloom.position.copy(ps.core.position);

      // Label
      const wp = ps.core.getWorldPosition(new THREE.Vector3());
      const labelOp = (bright ? 0.92 : 0.82) * this._fade * this._labelFade;
      this._updateLabel(ps.label, wp.x, wp.y, wp.z, labelOp);
    }

    // ── Update edges ──
    for (let i = 0; i < EDGE_POOL_SIZE; i++) {
      const pe = this._edgePool[i];
      if (!pe.active) {
        pe.line.material.opacity     = THREE.MathUtils.lerp(pe.line.material.opacity, 0, delta * 5);
        pe.pulseDot.material.opacity = THREE.MathUtils.lerp(pe.pulseDot.material.opacity, 0, delta * 5);
        continue;
      }

      const from = this._pool[pe.fromIdx];
      const to   = this._pool[pe.toIdx];
      if (!from || !to) continue;

      // Check if both endpoint stars are visible
      const bothVisible = from.active && !from.hidden && to.active && !to.hidden;
      const targetOp = bothVisible ? 0.20 * this._fade * edgeFade : 0;

      pe.line.material.opacity = THREE.MathUtils.lerp(pe.line.material.opacity, targetOp, delta * 4);

      // Blend endpoint colors
      const fromColor = _toneColor(from.tone);
      const toColor   = _toneColor(to.tone);
      pe.line.material.color.copy(fromColor).lerp(toColor, 0.5);

      // Update line positions
      const pos = pe.geo.attributes.position;
      pos.setXYZ(0, from.core.position.x, from.core.position.y, from.core.position.z);
      pos.setXYZ(1, to.core.position.x, to.core.position.y, to.core.position.z);
      pos.needsUpdate = true;

      // Pulse dot
      const speed = 0.18;
      const t = ((elapsed * speed + pe.phaseOffset) % (Math.PI * 2)) / (Math.PI * 2);
      const fx = from.core.position.x, fy = from.core.position.y, fz = from.core.position.z;
      const tx = to.core.position.x,   ty = to.core.position.y,   tz = to.core.position.z;
      pe.pulseDot.position.set(
        fx + (tx - fx) * t,
        fy + (ty - fy) * t,
        fz + (tz - fz) * t
      );
      pe.pulseDot.material.color.copy(pe.line.material.color);
      const dotOp = bothVisible
        ? (0.3 + Math.sin(elapsed * 2 + pe.phaseOffset) * 0.12) * this._fade * edgeFade
        : 0;
      pe.pulseDot.material.opacity = THREE.MathUtils.lerp(pe.pulseDot.material.opacity, dotOp, delta * 4);
    }

    // Light
    this._light.intensity = (1.0 + Math.sin(elapsed * 0.5) * 0.12) * this._fade;

    // Picker visibility
    if (this._picker) {
      this._picker.style.opacity = String(this._labelFade * this._fade);
      this._picker.style.pointerEvents = this._labelFade > 0.3 ? 'auto' : 'none';
    }
  }

  _updateLabel(label, wx, wy, wz, opacity) {
    const projected = new THREE.Vector3(wx, wy, wz).project(this._camera);
    const px =  projected.x * window.innerWidth  / 2 + window.innerWidth  / 2;
    const py = -projected.y * window.innerHeight / 2 + window.innerHeight / 2;
    if (projected.z > 1 || px < -120 || px > window.innerWidth + 120 ||
        py < -120 || py > window.innerHeight + 120) {
      label.style.opacity = '0';
      return;
    }
    label.style.left    = `${px}px`;
    label.style.top     = `${py}px`;
    label.style.opacity = String(opacity);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  dispose() {
    this._pool.forEach((ps) => {
      this._group.remove(ps.core, ps.halo, ps.bloom);
      ps.core.geometry.dispose();  ps.core.material.dispose();
      ps.halo.geometry.dispose();  ps.halo.material.dispose();
      ps.bloom.geometry.dispose(); ps.bloom.material.dispose();
      ps.label.remove();
    });
    this._edgePool.forEach((pe) => {
      this._group.remove(pe.line, pe.pulseDot);
      pe.geo.dispose(); pe.line.material.dispose();
      pe.pulseDot.geometry.dispose(); pe.pulseDot.material.dispose();
    });
    if (this._picker) this._picker.remove();
  }
}
