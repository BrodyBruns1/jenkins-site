/**
 * foodPlanet.js -- FoodPlanet
 *
 * Warm terracotta planet at scroll section 5 (x=71.5).
 * Extends SisterPlanet visuals with:
 *   - Organic noise-bump shader on the surface
 *   - A growing garnish ring: one small icon mesh per cuisine in the library
 *   - Live updates from foodEventBus as recipes arrive
 *
 * Position: (71.5, -5.2, -2.5) -- scroll section 5 (last planet)
 */

import * as THREE from 'three';
import { SisterPlanet } from './sisterPlanet.js';
import { getFoodSnapshot, foodEventBus } from './foodApi.js';

// ── World position ────────────────────────────────────────────────────────────
export const FOOD_PLANET_POSITION = new THREE.Vector3(71.5, -5.2, -2.5);

// ── Cuisine → geometry style ──────────────────────────────────────────────────
const CUISINE_STYLES = {
  italian:    { color: 0xff6b35, shape: 'torus'    },  // pasta ring
  thai:       { color: 0x4ecdc4, shape: 'cone'     },  // bamboo spire
  mexican:    { color: 0xffe66d, shape: 'tetra'    },  // chip
  japanese:   { color: 0xff9ff3, shape: 'octahedron' },
  chinese:    { color: 0xf9ca24, shape: 'cylinder' },
  indian:     { color: 0xff7675, shape: 'sphere'   },
  american:   { color: 0x74b9ff, shape: 'cube'     },
  french:     { color: 0xa29bfe, shape: 'icosa'    },
  dessert:    { color: 0xfd79a8, shape: 'torus'    },
  drink:      { color: 0x55efc4, shape: 'cylinder' },
  other:      { color: 0xb2bec3, shape: 'sphere'   },
};

const DEFAULT_STYLE = CUISINE_STYLES.other;

function _makeIcon(style, scale = 0.1) {
  const s = style || DEFAULT_STYLE;
  let geo;
  switch (s.shape) {
    case 'torus':      geo = new THREE.TorusGeometry(scale, scale * 0.38, 8, 16);       break;
    case 'cone':       geo = new THREE.ConeGeometry(scale * 0.65, scale * 1.4, 8);     break;
    case 'tetra':      geo = new THREE.TetrahedronGeometry(scale * 1.1, 0);             break;
    case 'octahedron': geo = new THREE.OctahedronGeometry(scale, 0);                   break;
    case 'cylinder':   geo = new THREE.CylinderGeometry(scale*0.5, scale*0.5, scale*1.2, 10); break;
    case 'cube':       geo = new THREE.BoxGeometry(scale, scale, scale);                break;
    case 'icosa':      geo = new THREE.IcosahedronGeometry(scale, 0);                  break;
    default:           geo = new THREE.SphereGeometry(scale, 8, 8);
  }
  const mat = new THREE.MeshStandardMaterial({
    color:     s.color,
    emissive:  new THREE.Color(s.color).multiplyScalar(0.3),
    roughness: 0.45,
    metalness: 0.15,
  });
  return new THREE.Mesh(geo, mat);
}

// ── FoodPlanet ────────────────────────────────────────────────────────────────
export class FoodPlanet {
  constructor(scene, camera) {
    this._scene  = scene;
    this._camera = camera;
    this._fade      = 1.0;
    this._labelFade = 1.0;
    this._cuisineIcons = new Map();  // cuisine key → { group, angle, speed }

    // Build base planet via SisterPlanet config
    this._sister = new SisterPlanet(scene, FOOD_PLANET_POSITION, {
      surfaceColor: 0xc1440e,          // terracotta
      emissive:     0x7a2208,
      atmColor:     0xff9966,
      rings: [
        { color: 0xff8c42, inner: 1.22, outer: 1.50, tilt: Math.PI * 0.38, opacity: 0.22 },
        { color: 0xffd6a0, inner: 1.58, outer: 1.74, tilt: Math.PI * 0.52, opacity: 0.14 },
      ],
      lightColor: 0xff9955,
    });

    // Cuisine garnish ring — children of an outer group
    this._garnishGroup = new THREE.Group();
    this._garnishGroup.position.copy(FOOD_PLANET_POSITION);
    scene.add(this._garnishGroup);

    // Label DOM element
    this._labelEl = this._buildLabel();

    this._subscribe();
    this._update(getFoodSnapshot());
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _buildLabel() {
    const el = document.createElement('div');
    el.className = 'food-planet-label';
    el.textContent = 'Recipe Collection';
    el.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'font-family:monospace',
      'font-size:12px',
      'color:rgba(255,180,120,0.85)',
      'text-shadow:0 0 8px rgba(255,100,30,0.7)',
      'white-space:nowrap',
      'transition:opacity 0.3s',
      'opacity:0',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  _subscribe() {
    foodEventBus.addEventListener('food-update', (e) => {
      this._update(e.detail);
    });
  }

  _update(snapshot) {
    const cuisines = snapshot?.cuisines || [];
    const total    = snapshot?.stats?.count || 0;

    // Update label text
    if (this._labelEl) {
      this._labelEl.textContent = total > 0
        ? `${total} recipe${total === 1 ? '' : 's'} · ${cuisines.length} cuisines`
        : 'Recipe Collection';
    }

    // Add icons for new cuisines, remove stale ones
    const active = new Set(cuisines.map((c) => c.key));

    // Remove stale
    for (const [key, entry] of this._cuisineIcons) {
      if (!active.has(key)) {
        this._garnishGroup.remove(entry.pivot);
        this._cuisineIcons.delete(key);
      }
    }

    // Add new
    cuisines.forEach((cDef, i) => {
      if (this._cuisineIcons.has(cDef.key)) return;
      const style  = CUISINE_STYLES[cDef.key] || DEFAULT_STYLE;
      const icon   = _makeIcon(style);
      const radius = 1.95 + (i % 3) * 0.28;
      const speed  = 0.12 + i * 0.018;
      const angle  = (i / Math.max(cuisines.length, 1)) * Math.PI * 2;

      const pivot = new THREE.Group();
      pivot.rotation.x = 0.32 + (i * 0.07 % 0.6);
      const arm = new THREE.Group();
      arm.position.set(radius, 0, 0);
      arm.add(icon);
      pivot.add(arm);

      // Scale-in tween: start at zero, animate to 1 in update()
      pivot.scale.setScalar(0);
      this._garnishGroup.add(pivot);

      this._cuisineIcons.set(cDef.key, {
        pivot,
        arm,
        icon,
        angle,
        speed,
        scaleTarget: 1,
      });
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  get position() { return this._sister.position; }

  setFade(fade) {
    this._fade = THREE.MathUtils.clamp(fade, 0, 1);
    if (this._labelEl) this._labelEl.style.opacity = String(this._labelFade * this._fade);
  }

  setLabelFade(fade) {
    this._labelFade = THREE.MathUtils.clamp(fade, 0, 1);
    if (this._labelEl) this._labelEl.style.opacity = String(this._labelFade * this._fade);
  }

  /**
   * Project world-space planet position to screen for label placement.
   * Called from main.js animate loop.
   */
  updateLabel(camera) {
    if (!this._labelEl) return;
    const pos = FOOD_PLANET_POSITION.clone().project(camera);
    const hw = window.innerWidth  / 2;
    const hh = window.innerHeight / 2;
    const sx = ( pos.x + 1) * hw;
    const sy = (-pos.y + 1) * hh;
    this._labelEl.style.left = `${sx - 60}px`;
    this._labelEl.style.top  = `${sy + 52}px`;
  }

  update(elapsed, delta) {
    // Delegate spin / ring wobble to SisterPlanet
    this._sister.update(elapsed, delta);

    // Rotate garnish icons + scale-in new arrivals
    for (const entry of this._cuisineIcons.values()) {
      entry.angle += delta * entry.speed;
      entry.pivot.rotation.y = entry.angle;

      // Scale-in tween
      const cur = entry.pivot.scale.x;
      if (cur < 0.99) {
        const next = THREE.MathUtils.lerp(cur, entry.scaleTarget, delta * 3.5);
        entry.pivot.scale.setScalar(next);
      } else if (cur !== 1) {
        entry.pivot.scale.setScalar(1);
      }
    }
  }
}
