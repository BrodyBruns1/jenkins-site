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
  { id: 'lmstudio', label: 'LM Studio', orbitR: 2.9,  speed: 0.30,  incl:  0.40, color: 0xff9940 },
  { id: 'ollama',   label: 'Ollama',    orbitR: 2.3,  speed: 0.55,  incl: -0.30, color: 0x00d060 },
  { id: 'litellm',  label: 'LiteLLM',  orbitR: 1.9,  speed: 0.80,  incl:  0.60, color: 0x10a0ff },
  { id: 'proxmox',  label: 'Proxmox',  orbitR: 3.5,  speed: 0.22,  incl:  0.20, color: 0xff6020 },
  { id: 'truenas',  label: 'TrueNAS',  orbitR: 4.0,  speed: 0.18,  incl: -0.50, color: 0x4060d0 },
  { id: 'jellyfin', label: 'Jellyfin', orbitR: 4.4,  speed: 0.15,  incl:  0.35, color: 0x9050ff },
];

export class ServiceNodes {
  /**
   * @param {THREE.Scene}  scene
   * @param {THREE.Vector3} planetPos -- world-space center of HomelabPlanet
   * @param {{ onSelect?: function }} options
   */
  constructor(scene, planetPos, options = {}) {
    this._scene      = scene;
    this._planetPos  = planetPos;
    this._camera     = null;  // set by main.js after construction
    this._onSelect   = options.onSelect || null;
    this._raycaster  = new THREE.Raycaster();
    this._pointer    = new THREE.Vector2();
    this._hiddenIds  = new Set();
    this._fade       = 1.0;
    this._labelFade  = 1.0;
    this._interactive = true;
    this._angleById  = new Map();

    this._nodes    = [];   // { mesh, wire, beamGeo, beamLine, labelEl, angle, status, metric, health }
    this._orbitTrails = [];

    this._build();
    this._subscribe();
  }

  setCamera(camera) { this._camera = camera; }
  setFade(fade) { this._fade = THREE.MathUtils.clamp(fade, 0, 1); }
  setLabelFade(fade) { this._labelFade = THREE.MathUtils.clamp(fade, 0, 1); }
  setInteractive(enabled) { this._interactive = !!enabled; }
  setHiddenIds(ids) { this._hiddenIds = new Set(ids); }

  // ── Build ────────────────────────────────────────────────────────────────

  _build() {
    for (let i = 0; i < SERVICE_DEFS.length; i++) {
      const def   = SERVICE_DEFS[i];
      const col3  = new THREE.Color(def.color);
      const orbitNormal = this._buildOrbitNormal(i, def.incl);
      const orbitBasisA = new THREE.Vector3(0, 1, 0).cross(orbitNormal);
      if (orbitBasisA.lengthSq() < 0.0001) orbitBasisA.set(1, 0, 0);
      orbitBasisA.normalize();
      const orbitBasisB = new THREE.Vector3().crossVectors(orbitNormal, orbitBasisA).normalize();
      const orbitQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        orbitNormal
      );

      this._addOrbitTrail(def.orbitR, def.color, orbitQuat);

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
      document.body.appendChild(labelEl);

      const node = {
        def, mesh, wire, beamGeo, beamLine, labelEl,
        health: 1.0, healthTarget: 1.0, status: 'pending', metric: '--',
        orbitBasisA, orbitBasisB,
        angle: (i / SERVICE_DEFS.length) * Math.PI * 2,
      };

      labelEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._emitSelection(node);
      });

      this._nodes.push(node);
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

    for (const trail of this._orbitTrails) {
      trail.mesh.material.opacity = 0.16 * this._fade;
    }

    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      const def  = node.def;
      const hidden = this._hiddenIds.has(def.id);

      // Lerp health
      node.health += (node.healthTarget - node.health) * lk;

      // Advance orbit angle
      node.angle += delta * def.speed;
      const orbitOffset = node.orbitBasisA.clone().multiplyScalar(Math.cos(node.angle) * def.orbitR)
        .add(node.orbitBasisB.clone().multiplyScalar(Math.sin(node.angle) * def.orbitR));
      const pos = P.clone().add(orbitOffset);

      // Position and pulse scale
      const pulse = node.health > 0.3
        ? 1.0 + 0.08 * Math.sin(elapsed * 3.0 + i * 1.05)
        : 1.0;

      node.mesh.position.copy(pos);
      node.mesh.scale.setScalar(pulse);
      node.wire.position.copy(node.mesh.position);
      node.wire.scale.copy(node.mesh.scale);

      // Slow rotation of the icosahedra
      node.mesh.rotation.y = elapsed * 0.4 + i;
      node.mesh.rotation.z = elapsed * 0.25 + i * 0.7;
      node.wire.rotation.copy(node.mesh.rotation);

      if (hidden) {
        node.mesh.visible = false;
        node.wire.visible = false;
        node.beamLine.visible = false;
        node.labelEl.style.opacity = '0';
        node.labelEl.style.pointerEvents = 'none';
        continue;
      }

      node.mesh.visible = true;
      node.wire.visible = true;
      node.beamLine.visible = true;

      // Opacity driven by health
      const targetAlpha = (0.12 + 0.58 * node.health) * this._fade;
      node.mesh.material.opacity = THREE.MathUtils.lerp(node.mesh.material.opacity, targetAlpha, lk);
      node.wire.material.opacity = THREE.MathUtils.lerp(node.wire.material.opacity, targetAlpha * 0.6, lk);

      // Update health beam endpoints
      const bp = node.beamGeo.attributes.position;
      bp.setXYZ(0, pos.x, pos.y, pos.z);
      bp.setXYZ(1, P.x, P.y, P.z);
      bp.needsUpdate = true;
      node.beamLine.material.opacity = (
        0.12 + 0.18 * node.health * (0.5 + 0.5 * Math.sin(elapsed * 1.2 + i))
      ) * this._fade;

      // Update HTML label position
      if (this._camera) {
        this._updateLabel(node, pos.x, pos.y, pos.z);
      }
    }
  }

  _addOrbitTrail(orbitR, colorHex, orbitQuat) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(orbitR - 0.012, orbitR + 0.012, 96, 1),
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    const tiltGroup = new THREE.Group();
    tiltGroup.position.copy(this._planetPos);
    tiltGroup.quaternion.copy(orbitQuat);
    tiltGroup.add(mesh);
    this._scene.add(tiltGroup);
    this._orbitTrails.push({ mesh, tiltGroup });
  }

  _buildOrbitNormal(index, inclination) {
    return new THREE.Vector3(
      Math.sin(inclination) * 0.68,
      0.86 + Math.sin(index * 0.8) * 0.12,
      Math.cos(inclination + index * 0.45) * 0.40
    ).normalize();
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

    node.labelEl.style.opacity  = String((0.3 + 0.7 * node.health) * this._labelFade);
    node.labelEl.style.left     = `${px}px`;
    node.labelEl.style.top      = `${py}px`;
    node.labelEl.style.pointerEvents = this._interactive && this._labelFade > 0.05 ? 'auto' : 'none';
  }

  handlePointerClick(clientX, clientY) {
    if (!this._interactive || !this._camera) return false;

    this._pointer.x = (clientX / window.innerWidth) * 2 - 1;
    this._pointer.y = -((clientY / window.innerHeight) * 2 - 1);
    this._raycaster.setFromCamera(this._pointer, this._camera);

    const candidates = this._nodes
      .filter(node => !this._hiddenIds.has(node.def.id) && node.mesh.visible)
      .map(node => node.mesh);
    const hit = this._raycaster.intersectObjects(candidates, false)[0];
    if (!hit) return false;

    const node = this._nodes.find(entry => entry.mesh === hit.object);
    if (!node) return false;

    this._emitSelection(node);
    return true;
  }

  _emitSelection(node) {
    if (!this._interactive || this._hiddenIds.has(node.def.id)) return;

    const position = new THREE.Vector3();
    node.mesh.getWorldPosition(position);

    const selection = {
      id: node.def.id,
      label: node.def.label,
      position,
      status: node.status,
      metric: node.metric,
    };

    const handled = this._onSelect?.(selection);
    if (handled === true) return;

    openPanel(node.def.id);
  }

  dispose() {
    for (const node of this._nodes) {
      this._angleById.set(node.def.id, node.angle);
    }
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
    for (const trail of this._orbitTrails) {
      this._scene.remove(trail.tiltGroup);
      trail.mesh.geometry.dispose();
      trail.mesh.material.dispose();
    }
  }
}
