/**
 * n8nPlanet.js -- quick-pass automation planet
 *
 * Lightweight fourth-section placeholder while real n8n API auth is still
 * being finished.
 */

import * as THREE from 'three';

const GHOST_WORKFLOWS = [
  { name: 'Webhook Intake', status: 'idle', radius: 1.9, speed: 0.24, angle: 0.2 },
  { name: 'Media Sync', status: 'success', radius: 2.45, speed: 0.17, angle: 1.7 },
  { name: 'Ops Digest', status: 'queued', radius: 2.95, speed: 0.14, angle: 3.1 },
  { name: 'Alert Router', status: 'ghost', radius: 3.35, speed: 0.11, angle: 4.6 },
];

const STATUS_COLORS = {
  success: 0x7dffad,
  idle: 0x5dc5ff,
  queued: 0xffd66b,
  ghost: 0xff7ac6,
};

export class N8nPlanet {
  constructor(scene, camera) {
    this._scene = scene;
    this._camera = camera;
    this._fade = 1.0;
    this._labelFade = 1.0;
    this._ghosts = [];

    this._group = new THREE.Group();
    this._group.position.set(31.5, -5.1, -2.2);
    scene.add(this._group);

    this._buildPlanet();
    this._buildRings();
    this._buildGhosts();
    this._buildLight(scene);
  }

  setFade(fade) {
    this._fade = THREE.MathUtils.clamp(fade, 0, 1);
  }

  setLabelFade(fade) {
    this._labelFade = THREE.MathUtils.clamp(fade, 0, 1);
  }

  get position() {
    return this._group.position;
  }

  _buildPlanet() {
    this._shell = new THREE.Mesh(
      new THREE.SphereGeometry(1.14, 40, 32),
      new THREE.MeshStandardMaterial({
        color: 0x13161d,
        emissive: new THREE.Color(0x182235).multiplyScalar(0.42),
        roughness: 0.78,
        metalness: 0.18,
        transparent: true,
        opacity: 1,
      })
    );
    this._group.add(this._shell);

    this._core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.74, 1),
      new THREE.MeshBasicMaterial({
        color: 0x73d7ff,
        transparent: true,
        opacity: 0.24,
        wireframe: true,
      })
    );
    this._group.add(this._core);

    this._atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.24, 32, 24),
      new THREE.MeshBasicMaterial({
        color: 0x8aa8ff,
        transparent: true,
        opacity: 0.08,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    this._group.add(this._atmosphere);
  }

  _buildRings() {
    this._rings = [];
    const defs = [
      { inner: 1.55, outer: 1.64, tiltX: Math.PI * 0.34, color: 0x6ca8ff, opacity: 0.18 },
      { inner: 2.18, outer: 2.24, tiltX: Math.PI * 0.56, color: 0xffd16b, opacity: 0.14 },
      { inner: 2.82, outer: 2.87, tiltX: Math.PI * 0.18, color: 0xff85cb, opacity: 0.11 },
    ];

    for (const def of defs) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(def.inner, def.outer, 128, 2),
        new THREE.MeshBasicMaterial({
          color: def.color,
          transparent: true,
          opacity: def.opacity,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      const tiltGroup = new THREE.Group();
      tiltGroup.rotation.x = def.tiltX;
      tiltGroup.add(ring);
      this._group.add(tiltGroup);
      this._rings.push({ ring, tiltGroup, baseTilt: def.tiltX, baseOpacity: def.opacity });
    }
  }

  _buildGhosts() {
    for (const workflow of GHOST_WORKFLOWS) {
      const color = STATUS_COLORS[workflow.status] || 0x6ca8ff;

      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.11, 0),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.65,
        })
      );
      this._scene.add(mesh);

      const beamGeo = new THREE.BufferGeometry();
      beamGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage)
      );
      const beamLine = new THREE.LineSegments(
        beamGeo,
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.14,
        })
      );
      this._scene.add(beamLine);

      const label = document.createElement('div');
      label.className = 'n8n-label';
      label.innerHTML = `
        <span class="n8n-label__name">${workflow.name}</span>
        <span class="n8n-label__status">${workflow.status}</span>`;
      document.body.appendChild(label);

      this._ghosts.push({ workflow, mesh, beamGeo, beamLine, label });
    }
  }

  _buildLight(scene) {
    this._light = new THREE.PointLight(0x8fa8ff, 1.45, 18);
    this._light.position.set(
      this._group.position.x + 3.8,
      this._group.position.y + 3.0,
      this._group.position.z + 4.8
    );
    scene.add(this._light);
  }

  update(elapsed, delta) {
    this._group.rotation.y += delta * 0.04;
    this._shell.material.opacity = this._fade;
    this._core.material.opacity = 0.24 * this._fade;
    this._atmosphere.material.opacity = 0.08 * this._fade;
    this._core.rotation.x = elapsed * 0.18;
    this._core.rotation.y = -elapsed * 0.14;

    for (let i = 0; i < this._rings.length; i++) {
      const ring = this._rings[i];
      ring.tiltGroup.rotation.x = ring.baseTilt + Math.sin(elapsed * 0.22 + i * 1.4) * 0.018;
      ring.ring.material.opacity = ring.baseOpacity * this._fade;
    }

    const center = this._group.position;
    for (let i = 0; i < this._ghosts.length; i++) {
      const ghost = this._ghosts[i];
      const angle = ghost.workflow.angle + elapsed * ghost.workflow.speed;
      const x = center.x + Math.cos(angle) * ghost.workflow.radius;
      const y = center.y + Math.sin(angle * 1.7) * 0.24;
      const z = center.z + Math.sin(angle) * ghost.workflow.radius * 0.42;

      ghost.mesh.position.set(x, y, z);
      ghost.mesh.rotation.x = elapsed * 0.8 + i;
      ghost.mesh.rotation.y = elapsed * 0.55 + i * 0.3;
      ghost.mesh.scale.setScalar(0.92 + Math.sin(elapsed * 1.8 + i) * 0.08);
      ghost.mesh.material.opacity = 0.65 * this._fade;

      const positions = ghost.beamGeo.attributes.position;
      positions.setXYZ(0, x, y, z);
      positions.setXYZ(1, center.x, center.y, center.z);
      positions.needsUpdate = true;
      ghost.beamLine.material.opacity = 0.14 * this._fade;

      this._updateLabel(ghost, x, y, z);
    }

    this._light.intensity = 1.2 + Math.sin(elapsed * 0.8) * 0.18;
  }

  _updateLabel(ghost, wx, wy, wz) {
    const projected = new THREE.Vector3(wx, wy, wz).project(this._camera);
    const px = projected.x * window.innerWidth / 2 + window.innerWidth / 2;
    const py = -projected.y * window.innerHeight / 2 + window.innerHeight / 2;

    if (
      projected.z > 1 ||
      px < -80 || px > window.innerWidth + 80 ||
      py < -80 || py > window.innerHeight + 80
    ) {
      ghost.label.style.opacity = '0';
      ghost.label.style.pointerEvents = 'none';
      return;
    }

    ghost.label.style.left = `${px}px`;
    ghost.label.style.top = `${py}px`;
    ghost.label.style.opacity = String(0.86 * this._fade * this._labelFade);
    ghost.label.style.pointerEvents = 'none';
  }
}
