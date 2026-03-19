/**
 * dockerPlanet.js -- DockerPlanet
 *
 * Teal/cyan planet representing the Docker host (VM 105).
 * Container boxes orbit in grouped elliptical rings.
 * Docker networks shown as Saturn-like rings perpendicular to orbits.
 * Click containers to open a detail panel with start/stop/restart.
 *
 * Position: (11.5, -5.0, -2.0) -- scroll section 2
 */

import * as THREE from 'three';
import { dockerEventBus } from './dockerApi.js';

// ── Status → color ──────────────────────────────────────────────────────────

const STATUS_COLORS = {
  'running-healthy':   0x00d0ff,
  'running':           0x00ff88,
  'running-unhealthy': 0xff8800,
  'exited':            0xff3333,
  'paused':            0xffff00,
  'created':           0x666666,
  'restarting':        0xff8800,
  'removing':          0xff3333,
  'dead':              0xff3333,
  'unknown':           0x666666,
};

const GROUP_ACCENT = [
  0x00d0ff, 0xff6090, 0x80ff40, 0xffa040,
  0xa060ff, 0xff4060, 0x40ffc0, 0xffd040,
];

const NET_COLORS = {
  shared:                   0x00c8e0,
  opt_default:              0xff9040,
  n8n_default:              0x70e040,
  'jenkins-proxy_default':  0xe0a050,
};

function statusKey(c) {
  if (c.state === 'running') {
    if (c.health === 'healthy')   return 'running-healthy';
    if (c.health === 'unhealthy') return 'running-unhealthy';
    return 'running';
  }
  return c.state || 'unknown';
}

// ── DockerPlanet class ──────────────────────────────────────────────────────

export class DockerPlanet {
  /**
   * @param {THREE.Scene}  scene
   * @param {THREE.Camera} camera
   */
  constructor(scene, camera) {
    this._scene  = scene;
    this._camera = camera;

    this._group = new THREE.Group();
    this._group.position.set(11.5, -5.0, -2.0);
    scene.add(this._group);

    this._nodes       = [];  // { mesh, wire, beamGeo, beamLine, label, container, angle, ... }
    this._netRings    = [];  // { mesh, tiltGroup, baseTilt }
    this._orbitTrails = [];  // faint ring per group

    this._buildPlanet();
    this._buildLight();
    this._subscribe();
  }

  // ── Planet ─────────────────────────────────────────────────────────────

  _buildPlanet() {
    // Core sphere -- dark teal industrial
    const geo = new THREE.SphereGeometry(1.0, 48, 32);
    const mat = new THREE.MeshStandardMaterial({
      color:     0x081822,
      emissive:  new THREE.Color(0x0a2838).multiplyScalar(0.30),
      roughness: 0.72,
      metalness: 0.12,
    });
    this._sphere = new THREE.Mesh(geo, mat);
    this._group.add(this._sphere);

    // Atmosphere
    const atmGeo = new THREE.SphereGeometry(1.06, 32, 32);
    const atmMat = new THREE.MeshBasicMaterial({
      color:       0x00a8c8,
      transparent: true,
      opacity:     0.09,
      side:        THREE.BackSide,
      depthWrite:  false,
    });
    this._group.add(new THREE.Mesh(atmGeo, atmMat));
  }

  _buildLight() {
    const p = this._group.position;
    const light = new THREE.PointLight(0x40d0e8, 1.5, 18);
    light.position.set(p.x + 3.5, p.y + 2.5, p.z + 4);
    this._scene.add(light);

    const rim = new THREE.PointLight(0x006080, 0.6, 12);
    rim.position.set(p.x - 4, p.y - 3, p.z - 4);
    this._scene.add(rim);
  }

  // ── Event subscription ────────────────────────────────────────────────

  _subscribe() {
    dockerEventBus.addEventListener('containers-update', (e) => {
      this._rebuildContainers(e.detail.containers, e.detail.groups);
    });
    dockerEventBus.addEventListener('networks-update', (e) => {
      this._rebuildNetworkRings(e.detail.networks);
    });
  }

  // ── Container boxes ───────────────────────────────────────────────────

  _rebuildContainers(containers, groups) {
    // Dispose previous
    for (const n of this._nodes) {
      this._scene.remove(n.mesh, n.wire, n.beamLine);
      n.mesh.geometry.dispose(); n.mesh.material.dispose();
      n.wire.geometry.dispose(); n.wire.material.dispose();
      n.beamGeo.dispose();       n.beamLine.material.dispose();
      n.label.remove();
    }
    for (const t of this._orbitTrails) {
      this._group.remove(t.tiltGroup);
      t.mesh.geometry.dispose(); t.mesh.material.dispose();
    }
    this._nodes       = [];
    this._orbitTrails = [];

    const groupNames = Object.keys(groups);
    let gIdx = 0;

    for (const gName of groupNames) {
      const members    = groups[gName];
      const orbitR     = 1.70 + gIdx * 0.65;
      const speed      = 0.28 - gIdx * 0.025;
      const incl       = (gIdx % 2 === 0 ? 1 : -1) * (0.18 + gIdx * 0.07);
      const accentHex  = GROUP_ACCENT[gIdx % GROUP_ACCENT.length];

      // Faint orbit trail ring
      this._addOrbitTrail(orbitR, accentHex, incl);

      for (let ci = 0; ci < members.length; ci++) {
        const c     = members[ci];
        const sk    = statusKey(c);
        const color = new THREE.Color(STATUS_COLORS[sk] || 0x666666);
        const alive = c.state === 'running';
        const angle = (ci / members.length) * Math.PI * 2;

        // Box
        const boxGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
        const boxMat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: alive ? 0.78 : 0.30,
        });
        const mesh = new THREE.Mesh(boxGeo, boxMat);
        mesh.renderOrder = 3;
        this._scene.add(mesh);

        // Wire shell
        const wireGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.18, 0.18, 0.18));
        const wireMat = new THREE.LineBasicMaterial({
          color, transparent: true, opacity: alive ? 0.50 : 0.18,
        });
        const wire = new THREE.LineSegments(wireGeo, wireMat);
        wire.renderOrder = 3;
        this._scene.add(wire);

        // Health beam
        const bp = new Float32Array(6);
        const beamGeo = new THREE.BufferGeometry();
        beamGeo.setAttribute('position',
          new THREE.BufferAttribute(bp, 3).setUsage(THREE.DynamicDrawUsage));
        const beamMat = new THREE.LineBasicMaterial({
          color, transparent: true, opacity: 0.12,
        });
        const beamLine = new THREE.LineSegments(beamGeo, beamMat);
        beamLine.renderOrder = 2;
        this._scene.add(beamLine);

        // HTML label
        const label = document.createElement('div');
        label.className = 'docker-label';
        label.dataset.state  = c.state;
        label.dataset.health = c.health || '';
        label.innerHTML = `
          <span class="docker-label__name">${c.name}</span>
          <span class="docker-label__status">${sk.replace('-', ' ')}</span>`;
        label.style.pointerEvents = 'auto';
        label.style.cursor = 'pointer';
        label.addEventListener('click', () => window.openDockerPanel?.(c.id));
        document.body.appendChild(label);

        this._nodes.push({
          mesh, wire, beamGeo, beamLine, label,
          container: c, angle, orbitR, speed, incl,
          alive, statusKey: sk,
        });
      }
      gIdx++;
    }
  }

  _addOrbitTrail(orbitR, colorHex, inclination) {
    const geo = new THREE.RingGeometry(orbitR - 0.015, orbitR + 0.015, 128, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);

    const tiltGroup = new THREE.Group();
    // Lay flat in the orbital plane -- tilted slightly by inclination
    tiltGroup.rotation.x = Math.PI * 0.5 + inclination * 0.35;
    tiltGroup.add(mesh);
    this._group.add(tiltGroup);

    this._orbitTrails.push({ mesh, tiltGroup });
  }

  // ── Network rings (perpendicular Saturn bands) ────────────────────────

  _rebuildNetworkRings(networks) {
    for (const r of this._netRings) {
      this._group.remove(r.tiltGroup);
      r.mesh.geometry.dispose(); r.mesh.material.dispose();
    }
    this._netRings = [];

    for (let i = 0; i < networks.length; i++) {
      const net    = networks[i];
      const color  = NET_COLORS[net.Name] || GROUP_ACCENT[i % GROUP_ACCENT.length];
      const innerR = 1.30 + i * 0.35;
      const outerR = innerR + 0.10;

      const geo = new THREE.RingGeometry(innerR, outerR, 128, 2);
      // Remap UV
      const pos = geo.attributes.position;
      const uv  = geo.attributes.uv;
      for (let j = 0; j < pos.count; j++) {
        const x = pos.getX(j), y = pos.getY(j);
        const r = Math.sqrt(x * x + y * y);
        uv.setXY(j, (r - innerR) / (outerR - innerR), 0);
      }
      uv.needsUpdate = true;

      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.16,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);

      const tiltGroup = new THREE.Group();
      // Perpendicular to orbital planes (user requested)
      tiltGroup.rotation.z = Math.PI * 0.42 + i * 0.22;
      tiltGroup.add(mesh);
      this._group.add(tiltGroup);

      this._netRings.push({
        mesh, tiltGroup,
        baseTiltZ: Math.PI * 0.42 + i * 0.22,
      });
    }
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  update(elapsed, delta) {
    // Planet rotation
    this._sphere.rotation.y = elapsed * 0.035;

    // Network ring wobble
    for (let i = 0; i < this._netRings.length; i++) {
      const r = this._netRings[i];
      r.tiltGroup.rotation.z = r.baseTiltZ + Math.sin(elapsed * 0.16 + i * 0.9) * 0.015;
    }

    // Container orbits
    const P = this._group.position;

    for (const n of this._nodes) {
      n.angle += delta * n.speed;
      const theta = n.angle;

      const x = P.x + Math.cos(theta) * n.orbitR;
      const y = P.y + Math.sin(theta * 0.50) * n.orbitR * 0.26 * Math.sin(n.incl);
      const z = P.z + Math.sin(theta) * n.orbitR;

      const pulse = n.alive
        ? 1.0 + 0.10 * Math.sin(elapsed * 2.8 + n.angle * 3)
        : 0.82;

      n.mesh.position.set(x, y, z);
      n.mesh.scale.setScalar(pulse);
      n.mesh.rotation.x = elapsed * 0.55;
      n.mesh.rotation.y = elapsed * 0.38;

      n.wire.position.copy(n.mesh.position);
      n.wire.scale.copy(n.mesh.scale);
      n.wire.rotation.copy(n.mesh.rotation);

      // Beam
      const bp = n.beamGeo.attributes.position;
      bp.setXYZ(0, x, y, z);
      bp.setXYZ(1, P.x, P.y, P.z);
      bp.needsUpdate = true;
      n.beamLine.material.opacity = n.alive
        ? 0.08 + 0.14 * (0.5 + 0.5 * Math.sin(elapsed * 1.1 + n.angle))
        : 0.04;

      // Label
      if (this._camera) this._updateLabel(n, x, y, z);
    }
  }

  _updateLabel(node, wx, wy, wz) {
    const v = new THREE.Vector3(wx, wy, wz);
    v.project(this._camera);

    const hw = window.innerWidth  / 2;
    const hh = window.innerHeight / 2;
    const px = ( v.x * hw) + hw;
    const py = (-v.y * hh) + hh;

    if (v.z > 1 || px < -80 || px > window.innerWidth + 80 ||
        py < -80 || py > window.innerHeight + 80) {
      node.label.style.opacity = '0';
      node.label.style.pointerEvents = 'none';
      return;
    }

    node.label.style.opacity  = node.alive ? '0.88' : '0.35';
    node.label.style.left     = `${px}px`;
    node.label.style.top      = `${py}px`;
    node.label.style.pointerEvents = 'auto';
  }

  get position() { return this._group.position; }

  dispose() {
    for (const n of this._nodes) {
      this._scene.remove(n.mesh, n.wire, n.beamLine);
      n.mesh.geometry.dispose(); n.mesh.material.dispose();
      n.wire.geometry.dispose(); n.wire.material.dispose();
      n.beamGeo.dispose();       n.beamLine.material.dispose();
      n.label.remove();
    }
    for (const t of this._orbitTrails) {
      this._group.remove(t.tiltGroup);
      t.mesh.geometry.dispose(); t.mesh.material.dispose();
    }
    for (const r of this._netRings) {
      this._group.remove(r.tiltGroup);
      r.mesh.geometry.dispose(); r.mesh.material.dispose();
    }
  }
}
