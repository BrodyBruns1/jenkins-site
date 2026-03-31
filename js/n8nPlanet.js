/**
 * n8nPlanet.js -- automation orbit
 *
 * Renders recent workflow activity when the n8n proxy is available, while
 * preserving a lively fallback state when API auth is still missing.
 */

import * as THREE from 'three';
import { getN8nSnapshot, n8nEventBus } from './n8nApi.js';

const STATUS_COLORS = {
  success: 0x7dffad,
  running: 0x5dc5ff,
  waiting: 0xffd66b,
  queued: 0xffc66b,
  error: 0xff7b91,
  active: 0x9fc6ff,
  idle: 0xb18cff,
};

const EMPTY_WORKFLOW = {
  id: 'no-workflows',
  name: 'No Workflows Yet',
  status: 'idle',
  active: false,
  triggerKind: 'utility',
  usable: true,
  executions: [{ id: 'empty-run', status: 'idle' }],
};

function _colorForStatus(status) {
  return new THREE.Color(STATUS_COLORS[status] || STATUS_COLORS.idle);
}

function _triggerSpeed(triggerKind) {
  if (triggerKind === 'schedule') return 1.0;
  if (triggerKind === 'manual') return 0.74;
  if (triggerKind === 'webhook') return 1.12;
  return 0.88;
}

function _labelForWorkflow(workflow) {
  if (workflow.triggerKind === 'schedule' && workflow.cadence) {
    return workflow.cadence.toLowerCase();
  }
  if (workflow.triggerKind === 'manual') {
    return workflow.usable === false ? 'manual hold' : 'manual probe';
  }
  if (workflow.triggerKind === 'webhook') {
    return workflow.routeState === 'published-route-unresolved' ? 'route blocked' : 'webhook live';
  }
  if (workflow.status === 'active') return 'listening';
  return workflow.status;
}

function _geometryForTrigger(triggerKind, nodeIndex) {
  const scale = 0.095 + nodeIndex * 0.008;
  if (triggerKind === 'manual') return new THREE.TetrahedronGeometry(scale + 0.008, 0);
  if (triggerKind === 'webhook') return new THREE.IcosahedronGeometry(scale, 0);
  if (triggerKind === 'schedule') return new THREE.OctahedronGeometry(scale + 0.01, 0);
  return new THREE.SphereGeometry(scale, 10, 10);
}

function _motionForWorkflow(workflow, index) {
  const triggerKind = workflow.triggerKind || 'utility';
  const radius = 1.7 + index * 0.54 + (triggerKind === 'webhook' ? 0.08 : 0);
  const speed = (0.18 - index * 0.016) * _triggerSpeed(triggerKind);
  const inclinationBase = 0.22 + index * 0.08;

  return {
    radius,
    speed,
    inclination:
      triggerKind === 'manual'
        ? inclinationBase * 0.82
        : triggerKind === 'webhook'
          ? inclinationBase * 1.18
          : inclinationBase,
    ellipseScale:
      triggerKind === 'manual'
        ? 0.38 + index * 0.024
        : triggerKind === 'webhook'
          ? 0.54 + index * 0.04
          : 0.46 + index * 0.03,
  };
}

export class N8nPlanet {
  constructor(scene, camera) {
    this._scene = scene;
    this._camera = camera;
    this._fade = 1.0;
    this._labelFade = 1.0;
    this._orbits = [];
    this._snapshot = getN8nSnapshot();

    this._group = new THREE.Group();
    this._group.position.set(31.5, -5.1, -2.2);
    scene.add(this._group);

    this._buildPlanet();
    this._buildLight(scene);
    this._subscribe();
    this._rebuildFromSnapshot(this._snapshot);
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

  _buildLight(scene) {
    this._light = new THREE.PointLight(0x8fa8ff, 1.45, 18);
    this._light.position.set(
      this._group.position.x + 3.8,
      this._group.position.y + 3.0,
      this._group.position.z + 4.8
    );
    scene.add(this._light);
  }

  _subscribe() {
    n8nEventBus.addEventListener('n8n-update', (event) => {
      this._snapshot = event.detail;
      this._rebuildFromSnapshot(event.detail);
    });
  }

  _rebuildFromSnapshot(snapshot) {
    this._disposeOrbits();

    const workflowRuns = snapshot.workflowRuns?.length
      ? snapshot.workflowRuns
      : [EMPTY_WORKFLOW];
    const modeMultiplier = snapshot.mode === 'live' ? 1 : snapshot.mode === 'seed' ? 0.93 : 0.86;

    workflowRuns.forEach((workflow, index) => {
      const color = _colorForStatus(workflow.status);
      const motion = _motionForWorkflow(workflow, index);
      const radius = motion.radius;
      const speed = motion.speed;
      const inclination = (index % 2 === 0 ? 1 : -1) * motion.inclination;
      const normal = this._buildOrbitNormal(index, inclination);
      const basisA = new THREE.Vector3(0, 1, 0).cross(normal);
      if (basisA.lengthSq() < 0.0001) basisA.set(1, 0, 0);
      basisA.normalize();
      const basisB = new THREE.Vector3().crossVectors(normal, basisA).normalize();
      const orbitQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        normal
      );

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius - 0.018, radius + 0.018, 144, 1),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: (workflow.executions.length > 0 ? 0.12 : 0.07) * modeMultiplier * (workflow.usable === false ? 0.9 : 1),
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      const tiltGroup = new THREE.Group();
      tiltGroup.quaternion.copy(orbitQuat);
      tiltGroup.add(ring);
      this._group.add(tiltGroup);

      const label = this._createLabel(
        workflow.name,
        _labelForWorkflow(workflow),
        workflow.triggerKind || 'utility',
        color
      );

      const nodes = (workflow.executions.length ? workflow.executions : EMPTY_WORKFLOW.executions).map((execution, nodeIndex) => {
        const nodeColor = _colorForStatus(execution.status);
        const mesh = new THREE.Mesh(
          _geometryForTrigger(workflow.triggerKind || 'utility', nodeIndex),
          new THREE.MeshBasicMaterial({
            color: nodeColor,
            transparent: true,
            opacity: 0.78,
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
            color: nodeColor,
            transparent: true,
            opacity: 0.14,
          })
        );
        this._scene.add(beamLine);

        return {
          execution,
          mesh,
          beamGeo,
          beamLine,
          angleOffset: (nodeIndex / Math.max(workflow.executions.length || 1, 1)) * Math.PI * 2,
          index: nodeIndex,
        };
      });

      this._orbits.push({
        workflow,
        ring,
        tiltGroup,
        label,
        radius,
        speed,
        basisA,
        basisB,
        ellipseScale: motion.ellipseScale,
        labelAngle: workflow.executions.length ? Math.PI * 1.6 : Math.PI * 0.5,
        nodes,
        baseOpacity: ring.material.opacity,
        baseQuaternion: orbitQuat.clone(),
      });
    });
  }

  _buildOrbitNormal(index, inclination) {
    return new THREE.Vector3(
      Math.sin(inclination) * 0.52,
      0.92 + Math.sin(index * 0.75) * 0.08,
      Math.cos(inclination + index * 0.35) * 0.30
    ).normalize();
  }

  _createLabel(name, status, triggerKind, color) {
    const label = document.createElement('div');
    label.className = 'n8n-label';
    label.dataset.trigger = triggerKind;
    label.style.setProperty('--n8n-accent', `#${color.getHexString()}`);

    const nameEl = document.createElement('span');
    nameEl.className = 'n8n-label__name';
    nameEl.textContent = name;

    const statusEl = document.createElement('span');
    statusEl.className = 'n8n-label__status';
    statusEl.textContent = status;

    label.append(nameEl, statusEl);
    document.body.appendChild(label);
    return label;
  }

  update(elapsed, delta) {
    this._group.rotation.y += delta * 0.04;
    this._shell.material.opacity = this._fade;
    this._core.material.opacity = 0.24 * this._fade;
    this._atmosphere.material.opacity = 0.08 * this._fade;
    this._core.rotation.x = elapsed * 0.18;
    this._core.rotation.y = -elapsed * 0.14;

    const center = this._group.position;
    const fallbackDim = this._snapshot.mode === 'live' ? 1 : this._snapshot.mode === 'seed' ? 0.94 : 0.88;
    const scheduleCount = this._orbits.filter((orbit) => orbit.workflow.triggerKind === 'schedule' && orbit.workflow.active).length;

    this._orbits.forEach((orbit, orbitIndex) => {
      orbit.tiltGroup.quaternion.copy(orbit.baseQuaternion);
      orbit.tiltGroup.rotateZ(Math.sin(elapsed * 0.12 + orbitIndex * 0.8) * 0.03);
      orbit.ring.material.opacity = orbit.baseOpacity * this._fade;

      orbit.nodes.forEach((node) => {
        const angle = node.angleOffset + elapsed * orbit.speed;
        const offset = orbit.basisA.clone().multiplyScalar(Math.cos(angle) * orbit.radius)
          .add(orbit.basisB.clone().multiplyScalar(Math.sin(angle) * orbit.radius * orbit.ellipseScale));
        const pos = center.clone().add(offset);
        const status = node.execution.status;
        const pulse = status === 'running'
          ? 1.08 + 0.12 * Math.sin(elapsed * 3 + node.index)
          : status === 'waiting' || status === 'queued'
            ? 0.96 + 0.08 * Math.sin(elapsed * 1.7 + node.index)
            : status === 'error'
              ? 0.88 + 0.06 * Math.sin(elapsed * 5 + node.index)
              : 0.92 + 0.04 * Math.sin(elapsed * 1.9 + node.index);

        node.mesh.position.copy(pos);
        node.mesh.rotation.x = elapsed * 0.7 + node.index;
        node.mesh.rotation.y = elapsed * 0.45 + node.index * 0.35;
        node.mesh.scale.setScalar(pulse * fallbackDim * (orbit.workflow.usable === false ? 0.96 : 1));
        node.mesh.material.opacity = 0.78 * this._fade * fallbackDim;

        const positions = node.beamGeo.attributes.position;
        positions.setXYZ(0, pos.x, pos.y, pos.z);
        positions.setXYZ(1, center.x, center.y, center.z);
        positions.needsUpdate = true;
        node.beamLine.material.opacity = (orbit.workflow.triggerKind === 'webhook' ? 0.18 : 0.14) * this._fade * fallbackDim;
      });

      const labelAngle = orbit.labelAngle + elapsed * orbit.speed * 0.6;
      const labelPos = center.clone()
        .add(orbit.basisA.clone().multiplyScalar(Math.cos(labelAngle) * (orbit.radius + 0.34)))
        .add(orbit.basisB.clone().multiplyScalar(Math.sin(labelAngle) * (orbit.radius + 0.34) * orbit.ellipseScale));
      this._updateLabel(
        orbit.label,
        labelPos.x,
        labelPos.y,
        labelPos.z,
        0.86 * this._fade * this._labelFade
      );
    });

    this._light.intensity = 1.12 + scheduleCount * 0.08 + Math.sin(elapsed * 0.8) * 0.18;
  }

  _updateLabel(label, wx, wy, wz, opacity) {
    const projected = new THREE.Vector3(wx, wy, wz).project(this._camera);
    const px = projected.x * window.innerWidth / 2 + window.innerWidth / 2;
    const py = -projected.y * window.innerHeight / 2 + window.innerHeight / 2;

    if (
      projected.z > 1 ||
      px < -80 || px > window.innerWidth + 80 ||
      py < -80 || py > window.innerHeight + 80
    ) {
      label.style.opacity = '0';
      label.style.pointerEvents = 'none';
      return;
    }

    label.style.left = `${px}px`;
    label.style.top = `${py}px`;
    label.style.opacity = String(opacity);
    label.style.pointerEvents = 'none';
  }

  _disposeOrbits() {
    this._orbits.forEach((orbit) => {
      orbit.label.remove();
      this._group.remove(orbit.tiltGroup);
      orbit.ring.geometry.dispose();
      orbit.ring.material.dispose();
      orbit.nodes.forEach((node) => {
        this._scene.remove(node.mesh, node.beamLine);
        node.mesh.geometry.dispose();
        node.mesh.material.dispose();
        node.beamGeo.dispose();
        node.beamLine.material.dispose();
      });
    });
    this._orbits = [];
  }
}
