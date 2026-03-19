/**
 * nodes.js -- ServiceNodes
 *
 * Six icosahedron nodes (one per homelab service) orbit the HomelabPlanet
 * in world space. Each node has:
 *   - Solid MeshBasicMaterial core  (IcosahedronGeometry detail=1)
 *   - LineSegments wire shell       (EdgesGeometry)
 *   - LineSegments health beam      (2-point line to planet center, DynamicDrawUsage)
 *   - HTML label div                (positioned via camera.project() every frame)
 *
 * Clicking an HTML label opens the service's detail panel.
 * Labels live outside #overlay-root so pointer-events work without
 * conflicting with the canvas-passthrough setup.
 */

import * as THREE from 'three';
import { serviceEventBus } from './services.js';
import { openPanel } from './panels.js';

// ── Service definitions ─────────────────────────────────────────────────────
// Order is authoritative — matches SVC_INDEX in planet.js.
const SERVICE_DEFS = [
  { id: 'lmstudio', label: 'LM Studio', orbitR: 2.6,  speed: 0.30,  incl:  0.40, color: 0xff9940 },
  { id: 'ollama',   label: 'Ollama',    orbitR: 2.0,  speed: 0.55,  incl: -0.30, color: 0x00d060 },
  { id: 'litellm',  label: 'LiteLLM',  orbitR: 1.6,  speed: 0.80,  incl:  0.60, color: 0x10a0ff },
  { id: 'proxmox',  label: 'Proxmox',  orbitR: 3.2,  speed: 0.22,  incl:  0.20, color: 0xff6020 },
  { id: 'truenas',  label: 'TrueNAS',  orbitR: 3.7,  speed: 0.18,  incl: -0.50, color: 0x4060d0 },
  { id: 'jellyfin', label: 'Jellyfin', orbitR: 4.1,  speed: 0.15,  incl:  0.35, color: 0x9050ff },
];

export class ServiceNodes {
  /**
   * @param {THREE.Scene}  scene
   * @param {THREE.Vector3} planetPos -- world-space center of HomelabPlanet
   * @param {THREE.Camera}  camera   -- for label projection (set via setCamera)
   */
  constructor(scene, planetPos) {
    this._scene     = scene;
    this._planetPos = planetPos;
    this._camera    = null;  // set by main.js after construction

    this._nodes    = [];   // { mesh, wire, beamGeo, beamLine, labelEl, angle, status, metric, health }
    this._angles   = SERVICE_DEFS.map((_, i) => (i / SERVICE_DEFS.length) * Math.PI * 2);

    this._build();
    this._subscribe();
  }

  setCamera(camera) { this._camera = camera; }

  // ── Build ────────────────────────────────────────────────────────────────

  _build() {
    for (let i = 0; i < SERVICE_DEFS.length; i++) {
      const def   = SERVICE_DEFS[i];
      const col3  = new THREE.Color(def.color);

      // Solid core
      const coreGeo = new THREE.IcosahedronGeometry(0.20, 1);
      const coreMat = new THREE.MeshBasicMaterial({
        color:       col3,
        transparent: true,
        opacity:     0.70,
      });
      const mesh = new THREE.Mesh(coreGeo, coreMat);
      mesh.renderOrder = 3;
      this._scene.add(mesh);

      // Wire shell
      const wireGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.24, 1));
      const wireMat = new THREE.LineBasicMaterial({
        color:       col3,
        transparent: true,
        opacity:     0.45,
      });
      const wire = new THREE.LineSegments(wireGeo, wireMat);
      wire.renderOrder = 3;
      this._scene.add(wire);

      // Health beam (2-point line from node to planet)
      const beamPositions = new Float32Array(6);  // 2 points * 3 floats
      const beamGeo = new THREE.BufferGeometry();
      beamGeo.setAttribute('position',
        new THREE.BufferAttribute(beamPositions, 3).setUsage(THREE.DynamicDrawUsage));
      const beamMat = new THREE.LineBasicMaterial({
        color:       col3,
        transparent: true,
        opacity:     0.25,
      });
      const beamLine = new THREE.LineSegments(beamGeo, beamMat);
      beamLine.renderOrder = 2;
      this._scene.add(beamLine);

      // HTML label
      const labelEl = document.createElement('div');
      labelEl.className = `svc-label svc-label--${def.id}`;
      labelEl.dataset.status = 'pending';
      labelEl.innerHTML = `
        <span class="svc-label__name">${def.label}</span>
        <span class="svc-label__metric">--</span>`;
      labelEl.style.pointerEvents = 'auto';
      labelEl.style.cursor = 'pointer';
      labelEl.addEventListener('click', () => openPanel(def.id));
      document.body.appendChild(labelEl);

      this._nodes.push({
        def, mesh, wire, beamGeo, beamLine, labelEl,
        health: 1.0, healthTarget: 1.0, status: 'pending', metric: '--',
      });
    }
  }

  // ── Subscription ──────────────────────────────────────────────────────

  _subscribe() {
    serviceEventBus.addEventListener('service-update', (e) => {
      const { id, status, metric } = e.detail;
      const node = this._nodes.find(n => n.def.id === id);
      if (!node) return;
      node.status = status;
      node.metric = metric;
      node.healthTarget = status === 'online' ? 1.0 : status === 'degraded' ? 0.5 : 0.0;

      // Update label status attribute and metric text
      node.labelEl.dataset.status = status;
      node.labelEl.querySelector('.svc-label__metric').textContent = metric;

      // Update service card in #service-cards
      const card = document.getElementById(`svc-card-${id}`);
      if (card) {
        card.dataset.status = status;
        const metricEl = card.querySelector('.svc-card__metric');
        if (metricEl) metricEl.textContent = metric;
      }
    });
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  update(elapsed, delta) {
    const P = this._planetPos;
    const lk = Math.min(delta * 1.5, 1.0);

    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      const def  = node.def;

      // Lerp health
      node.health += (node.healthTarget - node.health) * lk;

      // Advance orbit angle
      this._angles[i] += delta * def.speed;
      const theta = this._angles[i];

      // Elliptical orbit
      const x = P.x + Math.cos(theta) * def.orbitR;
      const y = P.y + Math.sin(theta * 0.47) * def.orbitR * 0.28 * Math.sin(def.incl);
      const z = P.z + Math.sin(theta) * def.orbitR;

      // Position and pulse scale
      const pulse = node.health > 0.3
        ? 1.0 + 0.08 * Math.sin(elapsed * 3.0 + i * 1.05)
        : 1.0;

      node.mesh.position.set(x, y, z);
      node.mesh.scale.setScalar(pulse);
      node.wire.position.copy(node.mesh.position);
      node.wire.scale.copy(node.mesh.scale);

      // Slow rotation of the icosahedra
      node.mesh.rotation.y = elapsed * 0.4 + i;
      node.mesh.rotation.z = elapsed * 0.25 + i * 0.7;
      node.wire.rotation.copy(node.mesh.rotation);

      // Opacity driven by health
      const targetAlpha = 0.12 + 0.58 * node.health;
      node.mesh.material.opacity = THREE.MathUtils.lerp(node.mesh.material.opacity, targetAlpha, lk);
      node.wire.material.opacity = THREE.MathUtils.lerp(node.wire.material.opacity, targetAlpha * 0.6, lk);

      // Update health beam endpoints
      const bp = node.beamGeo.attributes.position;
      bp.setXYZ(0, x, y, z);
      bp.setXYZ(1, P.x, P.y, P.z);
      bp.needsUpdate = true;
      node.beamLine.material.opacity = 0.12 + 0.18 * node.health *
        (0.5 + 0.5 * Math.sin(elapsed * 1.2 + i));

      // Update HTML label position
      if (this._camera) {
        this._updateLabel(node, x, y, z);
      }
    }
  }

  _updateLabel(node, wx, wy, wz) {
    const v = new THREE.Vector3(wx, wy, wz);
    v.project(this._camera);

    const halfW = window.innerWidth  / 2;
    const halfH = window.innerHeight / 2;
    const px = (v.x  *  halfW) + halfW;
    const py = (-v.y * halfH) + halfH;

    // Hide if behind camera or off screen
    if (v.z > 1.0 || px < -80 || px > window.innerWidth + 80 ||
        py < -80 || py > window.innerHeight + 80) {
      node.labelEl.style.opacity = '0';
      node.labelEl.style.pointerEvents = 'none';
      return;
    }

    node.labelEl.style.opacity  = String(0.3 + 0.7 * node.health);
    node.labelEl.style.left     = `${px}px`;
    node.labelEl.style.top      = `${py}px`;
    node.labelEl.style.pointerEvents = 'auto';
  }

  dispose() {
    for (const node of this._nodes) {
      this._scene.remove(node.mesh, node.wire, node.beamLine);
      node.mesh.geometry.dispose();
      node.mesh.material.dispose();
      node.wire.geometry.dispose();
      node.wire.material.dispose();
      node.beamGeo.dispose();
      node.beamLine.material.dispose();
      node.labelEl.remove();
    }
  }
}
