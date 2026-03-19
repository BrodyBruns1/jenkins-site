/**
 * sisterPlanet.js -- SisterPlanet
 *
 * A configurable decorative planet for additional dashboard sections.
 * Shares visual language with HomelabPlanet (rings, atmosphere shell)
 * but uses MeshStandardMaterial instead of a custom shader -- no health
 * tracking, just ambient visual presence.
 */

import * as THREE from 'three';

export class SisterPlanet {
  /**
   * @param {THREE.Scene}   scene
   * @param {THREE.Vector3} position   -- world-space center
   * @param {object}        config
   *   config.surfaceColor   hex color (number)
   *   config.emissive       hex color (number, default 0x000000)
   *   config.atmColor       hex color (number, for atmosphere shell)
   *   config.rings          [{color, inner, outer, tilt, opacity}]
   *   config.lightColor     hex color (number, default 0xffffff)
   */
  constructor(scene, position, config) {
    this._cfg   = config;
    this._group = new THREE.Group();
    this._group.position.copy(position);
    scene.add(this._group);

    this._buildPlanet();
    this._buildRings(config.rings || []);
    this._buildLight(scene, position, config.lightColor || 0xffd0a0);
  }

  // ─── Sphere ────────────────────────────────────────────────────────────

  _buildPlanet() {
    const geo = new THREE.SphereGeometry(1.0, 48, 32);
    const mat = new THREE.MeshStandardMaterial({
      color:       this._cfg.surfaceColor || 0x111111,
      emissive:    new THREE.Color(this._cfg.emissive || this._cfg.surfaceColor || 0x111111).multiplyScalar(0.25),
      roughness:   0.75,
      metalness:   0.10,
    });
    this._group.add(new THREE.Mesh(geo, mat));

    // Atmosphere shell -- BackSide, additive-ish look via transparency
    const atmGeo = new THREE.SphereGeometry(1.05, 32, 32);
    const atmMat = new THREE.MeshBasicMaterial({
      color:      this._cfg.atmColor || 0x442200,
      transparent: true,
      opacity:     0.10,
      side:        THREE.BackSide,
      depthWrite:  false,
    });
    this._group.add(new THREE.Mesh(atmGeo, atmMat));
  }

  // ─── Rings ─────────────────────────────────────────────────────────────

  _buildRings(ringDefs) {
    this._ringsGroup = new THREE.Group();
    this._group.add(this._ringsGroup);
    this._ringsBaseTilts = [];

    for (const def of ringDefs) {
      const mesh = this._makeRing(def.inner, def.outer, def.color, def.opacity ?? 0.30);
      const tilt = new THREE.Group();
      tilt.rotation.x = def.tilt;
      tilt.add(mesh);
      this._ringsGroup.add(tilt);
      this._ringsBaseTilts.push(def.tilt);
    }
  }

  _makeRing(innerR, outerR, color, opacity) {
    const geo = new THREE.RingGeometry(innerR, outerR, 128, 4);
    // Remap UV: inner=0, outer=1
    const pos = geo.attributes.position;
    const uv  = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      uv.setXY(i, (r - innerR) / (outerR - innerR), 0);
    }
    uv.needsUpdate = true;
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      side: THREE.DoubleSide, depthWrite: false,
    }));
  }

  // ─── Light ─────────────────────────────────────────────────────────────

  _buildLight(scene, position, color) {
    // Key light slightly above and in front of the planet (world space)
    const light = new THREE.PointLight(color, 1.6, 18);
    light.position.set(position.x + 3, position.y + 2.5, position.z + 4);
    scene.add(light);
  }

  // ─── Public ────────────────────────────────────────────────────────────

  get position() { return this._group.position; }

  update(elapsed, delta) {
    // Slow spin
    this._group.rotation.y += delta * 0.045;

    // Ring tilt wobble for each ring group
    const children = this._ringsGroup.children;
    for (let i = 0; i < children.length; i++) {
      children[i].rotation.x = this._ringsBaseTilts[i] + Math.sin(elapsed * 0.20 + i * 1.1) * 0.014;
    }
  }
}
