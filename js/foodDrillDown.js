/**
 * foodDrillDown.js -- FoodDrillDown
 *
 * "Walking" drill-down for the food planet.
 *
 * When activated the camera moves to a surface-level orbit:
 *   - Camera locked to a sphere of radius (PLANET_R + EYE_HEIGHT) centred on
 *     the planet.  The yaw/pitch from main.js drag events steer it.
 *   - WASD keyboard or drag orbits around the planet surface.
 *   - Recipe "stations" (one per cuisine) are placed at fibonacci-sphere
 *     surface coordinates.  Each station is a procedural 3D prop.
 *   - Clicking near a station (raycast) opens the #food-drilldown-hud with
 *     full recipe ingredients/steps fetched from /proxy/recipes/{id}.
 *   - Live-updating: subscribes to foodEventBus; new stations tween in.
 *
 * Camera modes added to main.js: 'foodsurface'
 * main.js must call:
 *   foodDrillDown.activate(origin)
 *   foodDrillDown.deactivate()
 *   foodDrillDown.setBlend(0..1)      -- fade in/out
 *   foodDrillDown.update(elapsed, delta, camera)  -- in animate loop
 */

import * as THREE from 'three';
import { foodEventBus, fetchRecipeDetail } from './foodApi.js';

const PLANET_R   = 1.0;   // radius of the food planet sphere
const EYE_HEIGHT = 1.85;  // camera height above surface
const ORBIT_R    = PLANET_R + EYE_HEIGHT;

// ── Cuisine station styles ────────────────────────────────────────────────────
const STATION_STYLES = {
  italian:    { baseColor: 0xff6b35, topColor: 0xffe5d0, shape: 'arch'    },
  thai:       { baseColor: 0x4ecdc4, topColor: 0xb2f7ef, shape: 'tower'   },
  mexican:    { baseColor: 0xffe66d, topColor: 0xfff3b0, shape: 'pyramid' },
  japanese:   { baseColor: 0xff9ff3, topColor: 0xffd6f5, shape: 'pagoda'  },
  chinese:    { baseColor: 0xf9ca24, topColor: 0xfff0a0, shape: 'lantern' },
  indian:     { baseColor: 0xff7675, topColor: 0xffdcdb, shape: 'dome'    },
  american:   { baseColor: 0x74b9ff, topColor: 0xd6ecff, shape: 'barn'    },
  french:     { baseColor: 0xa29bfe, topColor: 0xddd9ff, shape: 'spire'   },
  dessert:    { baseColor: 0xfd79a8, topColor: 0xffe4ef, shape: 'cake'    },
  drink:      { baseColor: 0x55efc4, topColor: 0xc8fff2, shape: 'bottle'  },
  other:      { baseColor: 0xb2bec3, topColor: 0xdfe6e9, shape: 'block'   },
};
const DEFAULT_STYLE = STATION_STYLES.other;

// ── Fibonacci sphere point distribution ──────────────────────────────────────
function _fibSphere(i, total) {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (i / Math.max(total - 1, 1)) * 1.4 - 0.3;  // range ~[-0.7, 0.7] (skip poles)
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = goldenAngle * i;
  return new THREE.Vector3(r * Math.cos(theta), y, r * Math.sin(theta)).normalize();
}

// ── Station builder ──────────────────────────────────────────────────────────
function _buildStation(style) {
  const s = style || DEFAULT_STYLE;
  const group = new THREE.Group();

  const baseMat = new THREE.MeshStandardMaterial({
    color:     s.baseColor,
    emissive:  new THREE.Color(s.baseColor).multiplyScalar(0.18),
    roughness: 0.6,
    metalness: 0.1,
  });
  const topMat = new THREE.MeshStandardMaterial({
    color:     s.topColor,
    emissive:  new THREE.Color(s.topColor).multiplyScalar(0.12),
    roughness: 0.5,
    metalness: 0.05,
  });

  switch (s.shape) {
    case 'arch':
    case 'barn': {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.18), baseMat);
      base.position.y = 0.09;
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(0, 0.14, 0.16, 6), topMat);
      roof.position.y = 0.22;
      group.add(base, roof);
      break;
    }
    case 'tower':
    case 'spire': {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.30, 8), baseMat);
      col.position.y = 0.15;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 8), topMat);
      tip.position.y = 0.38;
      group.add(col, tip);
      break;
    }
    case 'pyramid': {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.2), baseMat);
      base.position.y = 0.04;
      const py = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.28, 4), topMat);
      py.position.y = 0.22;
      group.add(base, py);
      break;
    }
    case 'pagoda': {
      [0, 1, 2].forEach((tier) => {
        const r = 0.12 - tier * 0.03;
        const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.18, 0.08, 8), baseMat);
        body.position.y = 0.06 + tier * 0.12;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(r * 1.4, 0.06, 8), topMat);
        roof.position.y = 0.11 + tier * 0.12;
        group.add(body, roof);
      });
      break;
    }
    case 'lantern': {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), baseMat);
      body.position.y = 0.12;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.06, 8), topMat);
      cap.position.y = 0.24;
      group.add(body, cap);
      break;
    }
    case 'dome':
    case 'cake': {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12), baseMat);
      base.position.y = 0.05;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), topMat);
      dome.position.y = 0.10;
      group.add(base, dome);
      break;
    }
    case 'bottle': {
      const bot = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.18, 10), baseMat);
      bot.position.y = 0.09;
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.07, 0.12, 10), topMat);
      neck.position.y = 0.24;
      group.add(bot, neck);
      break;
    }
    default: {
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), baseMat);
      block.position.y = 0.1;
      group.add(block);
    }
  }

  // Glow point
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 6, 6),
    new THREE.MeshBasicMaterial({ color: s.baseColor }),
  );
  glow.position.y = 0.46;
  group.add(glow);

  // Floating label canvas texture
  const canvas = document.createElement('canvas');
  canvas.width  = 256;
  canvas.height = 40;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(20,10,5,0.0)';
  ctx.fillRect(0, 0, 256, 40);
  ctx.font = 'bold 18px monospace';
  ctx.fillStyle = '#' + s.baseColor.toString(16).padStart(6, '0');
  ctx.textAlign = 'center';
  ctx.fillText('', 128, 28);  // filled later when station data arrives

  const tex = new THREE.CanvasTexture(canvas);
  const labelMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.55, 0.085),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  labelMesh.position.y = 0.56;
  labelMesh.userData.canvas = canvas;
  labelMesh.userData.ctx    = ctx;
  labelMesh.userData.tex    = tex;
  labelMesh.userData.color  = '#' + s.baseColor.toString(16).padStart(6, '0');
  group.add(labelMesh);

  group.userData.labelMesh = labelMesh;
  group.userData.glow      = glow;

  return group;
}

// ── FoodDrillDown ─────────────────────────────────────────────────────────────
export class FoodDrillDown {
  constructor(scene, camera) {
    this._scene  = scene;
    this._camera = camera;

    this._group = new THREE.Group();
    this._group.visible = false;
    this._scene.add(this._group);

    this._origin   = new THREE.Vector3();
    this._blend    = 0;
    this._active   = false;

    // Stations keyed by cuisine key
    this._stations = new Map();  // key → { group, normal, recipes, selected }

    // Camera surface-orbit angles
    this._yaw   = 0;
    this._pitch = 0.35;  // slight downward tilt to see the surface

    // Raycaster for station clicks
    this._raycaster = new THREE.Raycaster();
    this._clickables = [];

    // HUD
    this._hudEl        = document.getElementById('food-drilldown-hud');
    this._selectedKey  = null;
    this._selectedIdx  = 0;

    this._buildPlanet();
    this._buildLights();
    this._bindKeys();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  get active() { return this._active; }

  activate(origin) {
    this._origin.copy(origin);
    this._group.position.copy(origin);
    this._group.visible = true;
    this._active = true;
    this.setBlend(0);
    this._yaw   = 0;
    this._pitch = 0.35;

    this._clearStations();
    this._setHudIdle();
    this._refresh();

    this._unsubscribe = (e) => this._refresh(e.detail);
    foodEventBus.addEventListener('food-update', this._unsubscribe);
  }

  deactivate() {
    this._active = false;
    this._group.visible = false;
    this.setBlend(0);
    if (this._unsubscribe) {
      foodEventBus.removeEventListener('food-update', this._unsubscribe);
      this._unsubscribe = null;
    }
    this._clearStations();
    this._selectedKey = null;
    if (this._hudEl) this._hudEl.innerHTML = '';
  }

  setBlend(b) {
    this._blend = THREE.MathUtils.clamp(b, 0, 1);
    // Fade planet surface + lights proportionally
    if (this._planetMesh) {
      this._planetMesh.material.opacity = b;
    }
  }

  /** Called every frame from main.js animate loop. */
  update(elapsed, delta, camera) {
    if (!this._active) return;

    // Apply WASD velocity to yaw/pitch
    if (this._keys) {
      const speed = delta * 0.9;
      if (this._keys.left)  this._yaw   += speed;
      if (this._keys.right) this._yaw   -= speed;
      if (this._keys.up)    this._pitch  = THREE.MathUtils.clamp(this._pitch - speed, -1.1, 1.1);
      if (this._keys.down)  this._pitch  = THREE.MathUtils.clamp(this._pitch + speed, -1.1, 1.1);
    }

    // Pulse glow on active stations
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.4);
    for (const entry of this._stations.values()) {
      const g = entry.group.userData.glow;
      if (g) g.material.opacity = 0.5 + 0.5 * pulse;
    }

    // Billboard label meshes toward camera
    for (const entry of this._stations.values()) {
      const lm = entry.group.userData.labelMesh;
      if (lm) lm.lookAt(camera.position);
    }
  }

  /** Apply current yaw/pitch to camera position on the planet surface. */
  computeCameraPosition(out) {
    const phi   = Math.PI / 2 - this._pitch;  // polar angle
    const theta = this._yaw;                   // azimuthal
    out.set(
      ORBIT_R * Math.sin(phi) * Math.cos(theta),
      ORBIT_R * Math.cos(phi),
      ORBIT_R * Math.sin(phi) * Math.sin(theta),
    ).add(this._origin);
  }

  computeLookAt(out) {
    // Look slightly above the planet centre for a natural horizon feel
    out.copy(this._origin).add(new THREE.Vector3(0, PLANET_R * 0.25, 0));
  }

  /** Adjust orbit angles — called from main.js drag handler when in foodsurface mode. */
  applyDrag(dx, dy) {
    this._yaw   -= dx * 0.005;
    this._pitch  = THREE.MathUtils.clamp(this._pitch + dy * 0.003, -1.0, 1.0);
  }

  /** Hit-test stations on a canvas click. */
  handleClick(clientX, clientY, camera) {
    const x =  (clientX / window.innerWidth)  * 2 - 1;
    const y = -(clientY / window.innerHeight) * 2 + 1;
    this._raycaster.setFromCamera({ x, y }, camera);
    const hits = this._raycaster.intersectObjects(this._clickables, true);
    if (!hits.length) {
      this._clearSelection();
      return;
    }
    // Walk up to find station group
    let obj = hits[0].object;
    while (obj && !obj.userData.cuisineKey) obj = obj.parent;
    if (obj?.userData.cuisineKey) {
      this._selectStation(obj.userData.cuisineKey);
    }
  }

  // ── Station management ────────────────────────────────────────────────────

  _refresh(snapshot) {
    const snap  = snapshot || (typeof getFoodSnapshot === 'function' ? null : null);
    // Import at runtime to avoid circular reference
    import('./foodApi.js').then(({ getFoodSnapshot: gfs }) => {
      const data     = snap || gfs();
      const cuisines = data?.cuisines || [];
      const recipes  = data?.recipes  || [];

      // Map recipes by cuisine
      const byKey = new Map();
      for (const r of recipes) {
        const k = r.cuisine || 'other';
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(r);
      }

      // Remove stale stations
      const active = new Set(cuisines.map((c) => c.key));
      for (const [key, entry] of this._stations) {
        if (!active.has(key)) {
          this._group.remove(entry.group);
          const idx = this._clickables.indexOf(entry.group);
          if (idx !== -1) this._clickables.splice(idx, 1);
          this._stations.delete(key);
        }
      }

      // Add / update stations
      cuisines.forEach((cDef, i) => {
        const normal = _fibSphere(i, Math.max(cuisines.length, 1));
        const rlist  = byKey.get(cDef.key) || [];

        if (!this._stations.has(cDef.key)) {
          // New station
          const style  = STATION_STYLES[cDef.key] || DEFAULT_STYLE;
          const group  = _buildStation(style);

          // Place on surface
          const pos = normal.clone().multiplyScalar(PLANET_R + 0.02);
          group.position.copy(pos);
          // Orient "up" = outward normal
          group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
          // Scale in from zero
          group.scale.setScalar(0.01);
          group.userData.cuisineKey = cDef.key;
          group.userData.scaleTarget = 1;

          this._group.add(group);
          this._clickables.push(group);
          this._stations.set(cDef.key, { group, normal, recipes: rlist });

          // Animate scale-in
          this._tweenScale(group);
        }

        // Update label & recipe list
        const entry = this._stations.get(cDef.key);
        entry.recipes = rlist;
        this._updateLabel(entry.group, cDef.label, rlist.length);
      });
    });
  }

  _tweenScale(group) {
    const target = group.userData.scaleTarget || 1;
    const step = () => {
      if (!this._active) return;
      const cur  = group.scale.x;
      const next = THREE.MathUtils.lerp(cur, target, 0.12);
      group.scale.setScalar(next);
      if (Math.abs(next - target) > 0.005) requestAnimationFrame(step);
      else group.scale.setScalar(target);
    };
    requestAnimationFrame(step);
  }

  _updateLabel(group, cuisineLabel, count) {
    const lm = group.userData.labelMesh;
    if (!lm) return;
    const { canvas, ctx, tex, color } = lm.userData;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(`${cuisineLabel} (${count})`, 128, 26);
    tex.needsUpdate = true;
  }

  _clearStations() {
    for (const entry of this._stations.values()) {
      this._group.remove(entry.group);
    }
    this._stations.clear();
    this._clickables.length = 0;
  }

  // ── Selection & HUD ──────────────────────────────────────────────────────

  _selectStation(key) {
    this._selectedKey = key;
    this._selectedIdx = 0;
    const entry = this._stations.get(key);
    if (!entry) return;
    this._renderHud(key, entry.recipes, 0);
  }

  _clearSelection() {
    this._selectedKey = null;
    this._setHudIdle();
  }

  _setHudIdle() {
    if (!this._hudEl) return;
    this._hudEl.innerHTML = `
      <div class="food-hud__eyebrow">Recipe Surface</div>
      <div class="food-hud__title">Click a station to browse</div>
      <div class="food-hud__body">Each station represents a cuisine. Drag to walk around the planet.</div>
    `;
  }

  _renderHud(key, recipes, idx) {
    if (!this._hudEl) return;
    const recipe = recipes[idx];
    if (!recipe) {
      this._hudEl.innerHTML = `
        <div class="food-hud__eyebrow">${key.toUpperCase()}</div>
        <div class="food-hud__title">No recipes yet</div>
        <div class="food-hud__body">Drop links in #recipes to add some.</div>
      `;
      return;
    }

    const total = recipes.length;
    const time  = recipe.total_minutes ? `${recipe.total_minutes} min` : '';
    const tags  = (recipe.tags || []).map((t) => `<span class="food-hud__tag">${t}</span>`).join('');

    this._hudEl.innerHTML = `
      <div class="food-hud__eyebrow">${key.toUpperCase()} · ${idx + 1} / ${total}</div>
      <div class="food-hud__title">${recipe.title}</div>
      <div class="food-hud__meta">${[recipe.dish_type, time, recipe.servings ? `serves ${recipe.servings}` : ''].filter(Boolean).join(' · ')}</div>
      ${tags ? `<div class="food-hud__tags">${tags}</div>` : ''}
      ${recipe.description ? `<div class="food-hud__body">${recipe.description}</div>` : ''}
      <div class="food-hud__detail" id="food-hud-detail"><em>Loading details…</em></div>
      <div class="food-hud__nav">
        ${idx > 0 ? `<button class="food-hud__nav-btn" id="food-hud-prev">&#8592; Prev</button>` : ''}
        ${idx < total - 1 ? `<button class="food-hud__nav-btn" id="food-hud-next">Next &#8594;</button>` : ''}
      </div>
    `;

    // Wire navigation
    this._hudEl.querySelector('#food-hud-prev')?.addEventListener('click', () => {
      this._renderHud(key, recipes, idx - 1);
    });
    this._hudEl.querySelector('#food-hud-next')?.addEventListener('click', () => {
      this._renderHud(key, recipes, idx + 1);
    });

    // Lazy-load full detail
    fetchRecipeDetail(recipe.id).then((detail) => {
      const el = document.getElementById('food-hud-detail');
      if (!el || !detail) return;
      const ings = (detail.ingredients || [])
        .map((i) => `<li>${i.qty ? `${i.qty} ${i.unit || ''} `.trim() + ' ' : ''}${i.name}${i.note ? ` <em>(${i.note})</em>` : ''}</li>`)
        .join('');
      const steps = (detail.steps || [])
        .map((s, n) => `<li>${s}</li>`)
        .join('');
      el.innerHTML = `
        ${ings ? `<div class="food-hud__section">Ingredients</div><ul class="food-hud__list">${ings}</ul>` : ''}
        ${steps ? `<div class="food-hud__section">Steps</div><ol class="food-hud__list">${steps}</ol>` : ''}
        ${detail.source_url ? `<div class="food-hud__source"><a href="${detail.source_url}" target="_blank" rel="noopener">Source</a></div>` : ''}
      `;
    });
  }

  // ── Scene building ────────────────────────────────────────────────────────

  _buildPlanet() {
    const geo = new THREE.SphereGeometry(PLANET_R, 48, 32);
    const mat = new THREE.MeshStandardMaterial({
      color:       0xc1440e,
      emissive:    new THREE.Color(0x7a2208),
      roughness:   0.80,
      metalness:   0.05,
      transparent: true,
      opacity:     0,
    });
    this._planetMesh = new THREE.Mesh(geo, mat);
    this._group.add(this._planetMesh);

    // Atmosphere
    const atmGeo = new THREE.SphereGeometry(PLANET_R * 1.06, 32, 32);
    const atmMat = new THREE.MeshBasicMaterial({
      color:       0xff9966,
      transparent: true,
      opacity:     0.08,
      side:        THREE.BackSide,
      depthWrite:  false,
    });
    this._group.add(new THREE.Mesh(atmGeo, atmMat));
  }

  _buildLights() {
    const key = new THREE.PointLight(0xff9955, 1.8, 22);
    key.position.set(3, 2.5, 4);
    this._group.add(key);

    const fill = new THREE.PointLight(0x4ecdc4, 0.5, 18);
    fill.position.set(-4, 1, -2);
    this._group.add(fill);
  }

  _bindKeys() {
    this._keys = { left: false, right: false, up: false, down: false };
    const MAP = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
                  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down' };

    window.addEventListener('keydown', (e) => {
      if (!this._active) return;
      const k = MAP[e.code];
      if (k) { this._keys[k] = true; e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => {
      const k = MAP[e.code];
      if (k) this._keys[k] = false;
    });
  }
}
