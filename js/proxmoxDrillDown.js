import * as THREE from 'three';
import { fetchProxmoxSnapshot, fmtBytes, fmtUptime, proxmoxAction } from './services.js';

const STATUS_COLORS = {
  running: 0x38f2a1,
  stopped: 0xff6454,
  paused: 0xffbb44,
  unknown: 0x7f8da3,
};

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function resourceColor(resource) {
  if (resource.status === 'running') {
    return resource._type === 'lxc' ? 0x58d0ff : STATUS_COLORS.running;
  }
  return STATUS_COLORS[resource.status] || STATUS_COLORS.unknown;
}

function typeLabel(resource) {
  return resource._type === 'lxc' ? 'LXC' : 'VM';
}

export class ProxmoxDrillDown {
  constructor(scene, camera) {
    this._scene = scene;
    this._camera = camera;

    this._group = new THREE.Group();
    this._group.visible = false;
    this._scene.add(this._group);

    this._origin = new THREE.Vector3();
    this._expanded = new THREE.Vector3();
    this._blend = 0;
    this._active = false;
    this._requestId = 0;
    this._refreshTimer = null;
    this._labels = [];
    this._nodes = [];
    this._trails = [];
    this._hudEl = document.getElementById('proxmox-drilldown-hud');
    this._snapshot = null;
    this._statusText = '';
    this._busyKey = null;
    this._angleByKey = new Map();

    this._buildPlanet();
    this._buildLights();
  }

  get active() {
    return this._active;
  }

  activate(origin, expanded) {
    this._origin.copy(origin);
    this._expanded.copy(expanded || origin);
    this._group.position.copy(origin);
    this._group.visible = true;
    this._active = true;
    this.setBlend(0);
    this._setHudLoading();

    this.refresh();
    this._refreshTimer = window.setInterval(() => this.refresh(), 15000);
  }

  deactivate() {
    this._active = false;
    this._group.visible = false;
    this.setBlend(0);
    window.clearInterval(this._refreshTimer);
    this._refreshTimer = null;
    this._snapshot = null;
    this._statusText = '';
    this._busyKey = null;
    this._clearResources();
    if (this._hudEl) this._hudEl.innerHTML = '';
  }

  setBlend(blend) {
    this._blend = THREE.MathUtils.clamp(blend, 0, 1);
  }

  async refresh() {
    const requestId = ++this._requestId;

    try {
      const snapshot = await fetchProxmoxSnapshot();
      if (!this._active || requestId !== this._requestId) return;
      this._snapshot = snapshot;
      this._rebuildResources(snapshot.resources);
      this._renderHud(snapshot);
    } catch (error) {
      if (!this._active || requestId !== this._requestId || !this._hudEl) return;
      this._hudEl.innerHTML = `<div class="proxmox-hud__empty">Proxmox data unavailable: ${error.message}</div>`;
    }
  }

  update(elapsed, delta) {
    if (!this._active && this._blend <= 0.001) return;

    const eased = smoothstep(this._blend);
    this._group.position.lerpVectors(this._origin, this._expanded, eased);
    this._group.scale.setScalar(0.18 + eased * 0.82);
    this._group.visible = eased > 0.001;

    this._sphere.rotation.y = elapsed * 0.09;
    this._shell.material.opacity = 0.04 + eased * 0.13;
    this._grid.material.opacity = 0.08 + eased * 0.12;
    this._glow.material.opacity = 0.06 + eased * 0.10;
    this._keyLight.intensity = 0.25 + eased * 1.45;
    this._rimLight.intensity = 0.10 + eased * 0.85;

    this._keyLight.position.copy(this._group.position).add(new THREE.Vector3(2.8, 1.8, 3.6));
    this._rimLight.position.copy(this._group.position).add(new THREE.Vector3(-3.6, -2.2, -3.4));

    for (let i = 0; i < this._trails.length; i++) {
      const trail = this._trails[i];
      trail.mesh.material.opacity = 0.02 + eased * 0.09;
    }

    const center = this._group.position;
    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      node.angle += delta * node.speed;

      const orbitOffset = node.orbitBasisA.clone().multiplyScalar(Math.cos(node.angle) * node.orbitR)
        .add(node.orbitBasisB.clone().multiplyScalar(Math.sin(node.angle) * node.orbitR));
      const pos = center.clone().add(orbitOffset);
      const pulse = node.resource.status === 'running'
        ? 1.0 + 0.10 * Math.sin(elapsed * 2.8 + i * 0.7)
        : 0.86 + 0.04 * Math.sin(elapsed * 1.6 + i * 0.9);

      node.mesh.position.copy(pos);
      node.mesh.scale.setScalar(pulse);
      node.mesh.rotation.x = elapsed * 0.6 + i * 0.2;
      node.mesh.rotation.y = elapsed * 0.35 + i * 0.4;

      node.wire.position.copy(node.mesh.position);
      node.wire.scale.copy(node.mesh.scale);
      node.wire.rotation.copy(node.mesh.rotation);

      const beamPos = node.beamGeo.attributes.position;
      beamPos.setXYZ(0, pos.x, pos.y, pos.z);
      beamPos.setXYZ(1, center.x, center.y, center.z);
      beamPos.needsUpdate = true;
      node.beam.material.opacity = (0.04 + 0.12 * eased) * (node.resource.status === 'running' ? 1 : 0.55);

      this._updateLabel(node, eased);
    }
  }

  dispose() {
    this.deactivate();
    this._group.remove(this._sphere, this._shell, this._grid, this._glow);
    this._sphere.geometry.dispose();
    this._sphere.material.dispose();
    this._shell.geometry.dispose();
    this._shell.material.dispose();
    this._grid.geometry.dispose();
    this._grid.material.dispose();
    this._glow.geometry.dispose();
    this._glow.material.dispose();
    this._scene.remove(this._group, this._keyLight, this._rimLight);
  }

  _buildPlanet() {
    this._sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.12, 48, 32),
      new THREE.MeshStandardMaterial({
        color: 0x12151e,
        emissive: new THREE.Color(0xff7a3d).multiplyScalar(0.16),
        roughness: 0.78,
        metalness: 0.18,
      })
    );
    this._group.add(this._sphere);

    this._shell = new THREE.Mesh(
      new THREE.SphereGeometry(1.25, 32, 24),
      new THREE.MeshBasicMaterial({
        color: 0xff8c54,
        transparent: true,
        opacity: 0.0,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    this._group.add(this._shell);

    this._grid = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.42, 1)),
      new THREE.LineBasicMaterial({
        color: 0xffc27a,
        transparent: true,
        opacity: 0.0,
      })
    );
    this._group.add(this._grid);

    this._glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.7, 32, 24),
      new THREE.MeshBasicMaterial({
        color: 0xff8848,
        transparent: true,
        opacity: 0.0,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    this._group.add(this._glow);
  }

  _buildLights() {
    this._keyLight = new THREE.PointLight(0xff9550, 0.0, 18);
    this._rimLight = new THREE.PointLight(0x3b7fff, 0.0, 16);
    this._scene.add(this._keyLight, this._rimLight);
  }

  _clearResources() {
    for (const node of this._nodes) {
      this._angleByKey.set(this._resourceKey(node.resource), node.angle);
    }

    for (const trail of this._trails) {
      this._group.remove(trail.group);
      trail.mesh.geometry.dispose();
      trail.mesh.material.dispose();
    }
    this._trails = [];

    for (const node of this._nodes) {
      this._scene.remove(node.mesh, node.wire, node.beam);
      node.mesh.geometry.dispose();
      node.mesh.material.dispose();
      node.wire.geometry.dispose();
      node.wire.material.dispose();
      node.beamGeo.dispose();
      node.beam.material.dispose();
    }
    this._nodes = [];

    for (const label of this._labels) label.remove();
    this._labels = [];
  }

  _rebuildResources(resources) {
    this._clearResources();
    if (!resources.length) return;

    resources.forEach((resource, index) => {
      const color = new THREE.Color(resourceColor(resource));
      const orbitR = 2.0 + Math.floor(index / 2) * 0.62;
      const tilt = (index % 2 === 0 ? 1 : -1) * (0.32 + Math.floor(index / 2) * 0.08);
      const speed = 0.30 - Math.floor(index / 2) * 0.02 + (resource._type === 'lxc' ? 0.03 : 0.0);
      const orbitNormal = this._buildOrbitNormal(index, tilt);
      const orbitBasisA = new THREE.Vector3(0, 1, 0).cross(orbitNormal);
      if (orbitBasisA.lengthSq() < 0.0001) orbitBasisA.set(1, 0, 0);
      orbitBasisA.normalize();
      const orbitBasisB = new THREE.Vector3().crossVectors(orbitNormal, orbitBasisA).normalize();
      const orbitQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        orbitNormal
      );
      const geometry = resource._type === 'lxc'
        ? new THREE.OctahedronGeometry(0.16, 1)
        : new THREE.IcosahedronGeometry(0.18, 1);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: resource.status === 'running' ? 0.84 : 0.44,
      }));
      const wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(resource._type === 'lxc'
          ? new THREE.OctahedronGeometry(0.22, 1)
          : new THREE.IcosahedronGeometry(0.24, 1)),
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: resource.status === 'running' ? 0.56 : 0.28,
        })
      );

      const beamGeo = new THREE.BufferGeometry();
      beamGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage)
      );
      const beam = new THREE.LineSegments(beamGeo, new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.08,
      }));

      this._scene.add(mesh, wire, beam);

      const label = document.createElement('div');
      label.className = 'proxmox-label';
      label.innerHTML = `
        <span class="proxmox-label__name">${resource.name || `VM ${resource.vmid}`}</span>
        <span class="proxmox-label__meta">${typeLabel(resource)} ${resource.vmid} · ${resource.status || 'unknown'}</span>
      `;
      document.body.appendChild(label);
      this._labels.push(label);

      this._addTrail(orbitR, index, orbitQuat);

      const key = this._resourceKey(resource);
      const startAngle = this._angleByKey.has(key)
        ? this._angleByKey.get(key)
        : (index / resources.length) * Math.PI * 2;

      this._nodes.push({
        resource,
        mesh,
        wire,
        beamGeo,
        beam,
        label,
        orbitR,
        tilt,
        orbitNormal,
        orbitBasisA,
        orbitBasisB,
        speed,
        angle: startAngle,
        phase: index * 0.7,
      });
    });
  }

  _addTrail(orbitR, index, orbitQuat) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(orbitR - 0.015, orbitR + 0.015, 128, 1),
      new THREE.MeshBasicMaterial({
        color: index % 2 === 0 ? 0xff9a5b : 0x5eb4ff,
        transparent: true,
        opacity: 0.0,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    const group = new THREE.Group();
    group.quaternion.copy(orbitQuat);
    group.add(mesh);
    this._group.add(group);
    this._trails.push({ mesh, group });
  }

  _buildOrbitNormal(index, tilt) {
    return new THREE.Vector3(
      Math.sin(tilt) * 0.65,
      0.85 + Math.sin(index * 0.7) * 0.12,
      Math.cos(tilt + index * 0.35) * 0.42
    ).normalize();
  }

  _resourceKey(resource) {
    return `${resource._type}:${resource.vmid}`;
  }

  _updateLabel(node, eased) {
    const v = node.mesh.position.clone().project(this._camera);
    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    const px = v.x * halfW + halfW;
    const py = -v.y * halfH + halfH;

    if (v.z > 1.0 || px < -120 || px > window.innerWidth + 120 ||
        py < -80 || py > window.innerHeight + 80 || eased < 0.08) {
      node.label.style.opacity = '0';
      node.label.style.pointerEvents = 'none';
      return;
    }

    node.label.style.left = `${px}px`;
    node.label.style.top = `${py}px`;
    node.label.style.opacity = String((node.resource.status === 'running' ? 0.94 : 0.84) * eased);
    node.label.style.pointerEvents = 'none';
  }

  _setHudLoading() {
    if (!this._hudEl) return;
    this._hudEl.innerHTML = `
      <div class="proxmox-hud__title">Proxmox Drill-Down</div>
      <div class="proxmox-hud__empty">Loading node inventory...</div>
    `;
  }

  _renderHud(snapshot) {
    if (!this._hudEl) return;

    const node = snapshot.nodeStatus;
    const resources = snapshot.resources;
    const running = resources.filter(resource => resource.status === 'running');

    this._hudEl.innerHTML = `
      <div class="proxmox-hud__title">Proxmox Drill-Down</div>
      <div class="proxmox-hud__summary">
        <div class="proxmox-hud__stat"><span>Resources</span><strong>${resources.length}</strong></div>
        <div class="proxmox-hud__stat"><span>Running</span><strong>${running.length}</strong></div>
        <div class="proxmox-hud__stat"><span>Node CPU</span><strong>${node ? ((node.cpu || 0) * 100).toFixed(1) : '--'}%</strong></div>
      </div>
      ${node ? `
        <div class="proxmox-hud__meta">
          <span>${node.cpuinfo?.cpus || '--'} cores</span>
          <span>${fmtUptime(node.uptime || 0)} uptime</span>
          <span>${node.memory ? fmtBytes(node.memory.used || 0) : '--'} RAM used</span>
        </div>
      ` : ''}
      <div class="proxmox-hud__list">
        ${resources.map(resource => `
          <div class="proxmox-hud__row" data-state="${resource.status || 'unknown'}">
            <span class="proxmox-hud__name">${resource.name || `VM ${resource.vmid}`}</span>
            <span class="proxmox-hud__detail">${typeLabel(resource)} ${resource.vmid}</span>
            <span class="proxmox-hud__detail">${resource.status || 'unknown'}</span>
            <span class="proxmox-hud__actions">
              <button
                class="proxmox-action-btn"
                data-vmid="${resource.vmid}"
                data-type="${resource._type}"
                data-action="start"
                ${resource.status === 'running' ? 'disabled' : ''}>
                Start
              </button>
              <button
                class="proxmox-action-btn"
                data-vmid="${resource.vmid}"
                data-type="${resource._type}"
                data-action="stop"
                ${resource.status === 'running' ? '' : 'disabled'}>
                Stop
              </button>
              <button
                class="proxmox-action-btn"
                data-vmid="${resource.vmid}"
                data-type="${resource._type}"
                data-action="restart"
                ${resource.status === 'running' ? '' : 'disabled'}>
                Restart
              </button>
            </span>
          </div>
        `).join('')}
      </div>
      <div class="proxmox-hud__foot">${this._statusText || 'Node actions are available from the HUD rows. Use start, stop, or restart for each VM or LXC.'}</div>
    `;

    this._wireHudActions(resources);
  }

  _wireHudActions(resources) {
    this._hudEl.querySelectorAll('.proxmox-action-btn').forEach((button) => {
      const vmid = Number(button.dataset.vmid);
      const resourceType = button.dataset.type;
      const action = button.dataset.action;
      const busyKey = `${resourceType}:${vmid}:${action}`;

      if (this._busyKey) {
        button.disabled = true;
      }

      button.addEventListener('click', async () => {
        const resource = resources.find(entry =>
          entry.vmid === vmid && entry._type === resourceType
        );
        if (!resource) return;

        this._busyKey = busyKey;
        this._statusText = `${action.toUpperCase()} sent to ${resource.name || vmid}...`;
        this._renderHud(this._snapshot || { nodeStatus: null, resources });

        try {
          await proxmoxAction(resourceType, vmid, action);
          this._busyKey = null;
          this._statusText = `${action.toUpperCase()} accepted for ${resource.name || vmid}. Refreshing status...`;
          this._renderHud(this._snapshot || { nodeStatus: null, resources });
          window.setTimeout(() => this.refresh(), 1200);
          window.setTimeout(() => this.refresh(), 3200);
        } catch (error) {
          this._busyKey = null;
          this._statusText = `${action.toUpperCase()} failed for ${resource.name || vmid}: ${error.message}`;
          this._renderHud(this._snapshot || { nodeStatus: null, resources });
        }
      });
    });
  }
}
