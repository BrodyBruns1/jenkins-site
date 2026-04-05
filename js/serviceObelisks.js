import * as THREE from 'three';

import { openPanel } from './panels.js';
import { serviceEventBus } from './services.js';

const SERVICE_DEFS = [
  { id: 'lmstudio', label: 'LM Studio', color: 0xff9940, baseHeight: 1.75 },
  { id: 'ollama', label: 'Ollama', color: 0x00d060, baseHeight: 1.42 },
  { id: 'litellm', label: 'LiteLLM', color: 0x10a0ff, baseHeight: 1.58 },
  { id: 'proxmox', label: 'Proxmox', color: 0xff6020, baseHeight: 2.42 },
  { id: 'truenas', label: 'TrueNAS', color: 0x4060d0, baseHeight: 2.16 },
  { id: 'jellyfin', label: 'Jellyfin', color: 0x9050ff, baseHeight: 1.92 },
];

const STATUS_HEALTH = {
  online: 1.0,
  degraded: 0.62,
  offline: 0.22,
  pending: 0.52,
};

const OFFLINE_COLOR = new THREE.Color(0xff6173);
const DEGRADED_COLOR = new THREE.Color(0xffcb70);
const PENDING_COLOR = new THREE.Color(0xa6b4d8);

function _createLabelTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return { canvas, ctx, texture };
}

export class ServiceObelisks {
  constructor(scene, camera, options = {}) {
    this._scene = scene;
    this._camera = camera;
    this._onSelect = options.onSelect || null;
    this._fade = 1;
    this._labelFade = 1;
    this._interactive = true;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._tmpColor = new THREE.Color();
    this._tmpColorB = new THREE.Color();
    this._worldPos = new THREE.Vector3();
    this._towers = [];

    this._group = new THREE.Group();
    this._group.position.set(-8.5, -6.3, -4.9);
    this._scene.add(this._group);

    this._buildDeck();
    this._buildTowers();
    this._buildLight();
    this._subscribe();
  }

  setFade(fade) {
    this._fade = THREE.MathUtils.clamp(fade, 0, 1);
  }

  setLabelFade(fade) {
    this._labelFade = THREE.MathUtils.clamp(fade, 0, 1);
  }

  setInteractive(enabled) {
    this._interactive = Boolean(enabled);
  }

  _buildDeck() {
    this._platform = new THREE.Mesh(
      new THREE.BoxGeometry(7.25, 0.18, 2.1),
      new THREE.MeshBasicMaterial({
        color: 0x0a101d,
        transparent: true,
        opacity: 0.68,
      })
    );
    this._platform.position.y = -0.12;
    this._group.add(this._platform);

    this._runway = new THREE.Mesh(
      new THREE.PlaneGeometry(6.9, 1.2),
      new THREE.MeshBasicMaterial({
        color: 0x111d32,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this._runway.rotation.x = -Math.PI * 0.5;
    this._runway.position.y = -0.02;
    this._group.add(this._runway);

    const laneGeometry = new THREE.BufferGeometry();
    laneGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -3.35, 0, -0.42,
       3.35, 0, -0.42,
      -3.35, 0,  0.42,
       3.35, 0,  0.42,
      -2.95, 0,  0,
       2.95, 0,  0,
    ]), 3));
    this._laneLines = new THREE.LineSegments(
      laneGeometry,
      new THREE.LineBasicMaterial({
        color: 0x5f7fcf,
        transparent: true,
        opacity: 0.24,
      })
    );
    this._laneLines.position.y = 0.01;
    this._group.add(this._laneLines);
  }

  _buildLight() {
    this._light = new THREE.PointLight(0x90afff, 0.95, 18, 2);
    this._light.position.copy(this._group.position).add(new THREE.Vector3(0, 4.8, 3.8));
    this._scene.add(this._light);
  }

  _buildTowers() {
    const mid = (SERVICE_DEFS.length - 1) * 0.5;

    SERVICE_DEFS.forEach((def, index) => {
      const root = new THREE.Group();
      root.position.set(
        (index - mid) * 1.08 + Math.sin(index * 0.74) * 0.08,
        0,
        Math.abs(index - mid) * 0.13 - 0.15
      );
      this._group.add(root);

      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.18, 1, 6, 1, false),
        new THREE.MeshStandardMaterial({
          color: def.color,
          emissive: new THREE.Color(def.color).multiplyScalar(0.28),
          roughness: 0.34,
          metalness: 0.48,
          transparent: true,
          opacity: 0.84,
        })
      );
      shaft.position.y = 0.5;
      root.add(shaft);

      const wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.142, 0.205, 1.04, 6, 1, false)),
        new THREE.LineBasicMaterial({
          color: def.color,
          transparent: true,
          opacity: 0.42,
        })
      );
      wire.position.y = 0.52;
      root.add(wire);

      const cap = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.18, 0),
        new THREE.MeshBasicMaterial({
          color: def.color,
          transparent: true,
          opacity: 0.92,
        })
      );
      cap.position.y = 1.16;
      root.add(cap);

      const halo = new THREE.Mesh(
        new THREE.PlaneGeometry(0.64, 0.64),
        new THREE.MeshBasicMaterial({
          color: def.color,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      halo.position.y = 1.16;
      root.add(halo);

      const particleCount = 14;
      const positions = new Float32Array(particleCount * 3);
      const offsets = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount; i += 1) {
        const radius = 0.035 + Math.random() * 0.04;
        const angle = Math.random() * Math.PI * 2;
        offsets[i * 3 + 0] = Math.cos(angle) * radius;
        offsets[i * 3 + 1] = Math.random();
        offsets[i * 3 + 2] = Math.sin(angle) * radius;
        positions[i * 3 + 0] = offsets[i * 3 + 0];
        positions[i * 3 + 1] = offsets[i * 3 + 1];
        positions[i * 3 + 2] = offsets[i * 3 + 2];
      }
      const particleGeometry = new THREE.BufferGeometry();
      particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const particles = new THREE.Points(
        particleGeometry,
        new THREE.PointsMaterial({
          color: def.color,
          transparent: true,
          opacity: 0.62,
          size: 0.045,
          sizeAttenuation: true,
          depthWrite: false,
        })
      );
      root.add(particles);

      const labelParts = _createLabelTexture();
      const label = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: labelParts.texture,
          transparent: true,
          opacity: 0.88,
          depthWrite: false,
        })
      );
      label.scale.set(1.34, 0.40, 1);
      label.position.set(0, 1.68, 0.12);
      root.add(label);

      const tower = {
        def,
        root,
        shaft,
        wire,
        cap,
        halo,
        particles,
        particleGeometry,
        particleOffsets: offsets,
        particlePositions: positions,
        label,
        labelCanvas: labelParts.canvas,
        labelContext: labelParts.ctx,
        labelTexture: labelParts.texture,
        status: 'pending',
        metric: 'probing',
        health: STATUS_HEALTH.pending,
        targetHealth: STATUS_HEALTH.pending,
        currentHeight: def.baseHeight * 0.86,
        targetHeight: def.baseHeight,
        drift: Math.random() * Math.PI * 2,
        dirtyLabel: true,
      };

      this._drawLabel(tower);
      this._towers.push(tower);
    });
  }

  _subscribe() {
    serviceEventBus.addEventListener('service-update', (event) => {
      const { id, status, metric } = event.detail;
      const tower = this._towers.find((entry) => entry.def.id === id);
      if (!tower) return;

      tower.status = status || 'pending';
      tower.metric = metric || status || 'pending';
      tower.targetHealth = STATUS_HEALTH[tower.status] ?? STATUS_HEALTH.pending;
      tower.dirtyLabel = true;
    });
  }

  _towerColor(tower) {
    this._tmpColor.set(tower.def.color);
    if (tower.status === 'offline') {
      this._tmpColor.lerp(OFFLINE_COLOR, 0.78);
    } else if (tower.status === 'degraded') {
      this._tmpColor.lerp(DEGRADED_COLOR, 0.66);
    } else if (tower.status === 'pending') {
      this._tmpColor.lerp(PENDING_COLOR, 0.44);
    }
    return this._tmpColor;
  }

  _drawLabel(tower) {
    const canvas = tower.labelCanvas;
    const ctx = tower.labelContext;
    const accent = this._towerColor(tower);
    const accentHex = `#${accent.getHexString()}`;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    bg.addColorStop(0, 'rgba(10, 14, 24, 0.84)');
    bg.addColorStop(1, 'rgba(7, 9, 18, 0.12)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(126, 154, 214, 0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

    ctx.fillStyle = accentHex;
    ctx.font = '700 18px "Courier New", monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(tower.def.label.toUpperCase(), 18, 14);

    ctx.fillStyle = 'rgba(186, 198, 224, 0.86)';
    ctx.font = '13px "Courier New", monospace';
    ctx.fillText(String(tower.metric || tower.status || 'pending'), 18, 44);

    ctx.fillStyle = 'rgba(150, 168, 205, 0.56)';
    ctx.font = '11px "Courier New", monospace';
    ctx.fillText(String(tower.status || 'pending').toUpperCase(), 18, 66);

    tower.labelTexture.needsUpdate = true;
    tower.dirtyLabel = false;
  }

  handlePointerClick(clientX, clientY) {
    if (!this._interactive || !this._camera) return false;

    this._pointer.x = (clientX / window.innerWidth) * 2 - 1;
    this._pointer.y = -((clientY / window.innerHeight) * 2 - 1);
    this._raycaster.setFromCamera(this._pointer, this._camera);

    const candidates = this._towers.flatMap((tower) => [tower.shaft, tower.cap]);
    const hit = this._raycaster.intersectObjects(candidates, false)[0];
    if (!hit) return false;

    const tower = this._towers.find((entry) => entry.shaft === hit.object || entry.cap === hit.object);
    if (!tower) return false;

    this._emitSelection(tower);
    return true;
  }

  _emitSelection(tower) {
    const selection = {
      id: tower.def.id,
      label: tower.def.label,
      status: tower.status,
      metric: tower.metric,
      position: tower.cap.getWorldPosition(this._worldPos.clone()),
    };

    const handled = this._onSelect?.(selection);
    if (handled === true) return;

    openPanel(tower.def.id);
  }

  update(elapsed, delta) {
    const ease = Math.min(1, delta * 3.6);
    const labelOpacity = this._fade * this._labelFade;

    this._platform.material.opacity = 0.68 * this._fade;
    this._runway.material.opacity = 0.28 * this._fade;
    this._laneLines.material.opacity = 0.24 * this._fade;
    this._light.intensity = 0.95 * this._fade;

    this._towers.forEach((tower, index) => {
      tower.health += (tower.targetHealth - tower.health) * ease;
      tower.targetHeight = THREE.MathUtils.clamp(
        tower.def.baseHeight * (0.54 + tower.targetHealth * 0.78),
        0.76,
        3.36
      );
      tower.currentHeight += (tower.targetHeight - tower.currentHeight) * ease;

      const pulse = 1 + Math.sin(elapsed * 1.6 + index * 0.8) * 0.03 * tower.health;
      const lift = Math.sin(elapsed * 0.9 + tower.drift) * 0.045 * tower.health;
      const color = this._towerColor(tower);

      tower.root.position.y = lift;
      tower.shaft.position.y = tower.currentHeight * 0.5;
      tower.shaft.scale.set(1, tower.currentHeight * pulse, 1);
      tower.wire.position.y = tower.currentHeight * 0.51;
      tower.wire.scale.set(1, tower.currentHeight * pulse * 1.02, 1);
      tower.cap.position.y = tower.currentHeight + 0.18;
      tower.cap.rotation.y = elapsed * 0.55 + index * 0.35;
      tower.cap.rotation.x = Math.sin(elapsed * 0.42 + index) * 0.12;
      tower.halo.position.copy(tower.cap.position);
      tower.halo.quaternion.copy(this._camera.quaternion);
      tower.halo.scale.setScalar(1 + Math.sin(elapsed * 1.4 + index * 0.6) * 0.08);
      tower.label.position.set(0, tower.currentHeight + 0.74, 0.16);

      tower.shaft.material.color.lerp(color, Math.min(1, delta * 6));
      tower.shaft.material.emissive.copy(this._tmpColorB.copy(color).multiplyScalar(0.22 + tower.health * 0.22));
      tower.shaft.material.opacity = (0.32 + tower.health * 0.56) * this._fade;
      tower.wire.material.color.lerp(color, Math.min(1, delta * 7));
      tower.wire.material.opacity = (0.18 + tower.health * 0.28) * this._fade;
      tower.cap.material.color.lerp(this._tmpColorB.copy(color).offsetHSL(0, 0.06, 0.09), Math.min(1, delta * 8));
      tower.cap.material.opacity = (0.42 + tower.health * 0.54) * this._fade;
      tower.halo.material.color.copy(color);
      tower.halo.material.opacity = (0.08 + tower.health * 0.16) * this._fade;
      tower.label.material.opacity = labelOpacity * (0.34 + tower.health * 0.58);

      const positions = tower.particlePositions;
      const offsets = tower.particleOffsets;
      for (let i = 0; i < positions.length / 3; i += 1) {
        const phase = (offsets[i * 3 + 1] + elapsed * (0.22 + tower.health * 0.7) + i * 0.05) % 1;
        positions[i * 3 + 0] = offsets[i * 3 + 0];
        positions[i * 3 + 1] = phase * tower.currentHeight;
        positions[i * 3 + 2] = offsets[i * 3 + 2];
      }
      tower.particleGeometry.attributes.position.needsUpdate = true;
      tower.particles.material.color.copy(color);
      tower.particles.material.opacity = (0.12 + tower.health * 0.42) * this._fade;

      if (tower.dirtyLabel) {
        this._drawLabel(tower);
      }
    });
  }

  dispose() {
    this._scene.remove(this._group);
    this._scene.remove(this._light);
    this._platform.geometry.dispose();
    this._platform.material.dispose();
    this._runway.geometry.dispose();
    this._runway.material.dispose();
    this._laneLines.geometry.dispose();
    this._laneLines.material.dispose();

    this._towers.forEach((tower) => {
      tower.shaft.geometry.dispose();
      tower.shaft.material.dispose();
      tower.wire.geometry.dispose();
      tower.wire.material.dispose();
      tower.cap.geometry.dispose();
      tower.cap.material.dispose();
      tower.halo.geometry.dispose();
      tower.halo.material.dispose();
      tower.particleGeometry.dispose();
      tower.particles.material.dispose();
      tower.labelTexture.dispose();
      tower.label.material.dispose();
    });
  }
}
