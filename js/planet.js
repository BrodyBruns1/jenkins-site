/**
 * planet.js -- HomelabPlanet
 *
 * A Saturn-like planet in the lower-left quadrant of the 3D scene that
 * serves as a living health indicator for the 6 homelab services.
 *
 * Visual design:
 *   - Dark purple sphere with a custom ShaderMaterial surface: 6 hotspots
 *     glow at fixed UV positions, each driven by a service's health value.
 *   - Three UV-remapped rings (infrastructure, AI, media) whose opacity
 *     lerps toward targets driven by service health.
 *   - Fresnel atmosphere rim glow at the sphere edge.
 *
 * Service -> ring mapping:
 *   Ring 1 (gold,  infrastructure): Proxmox + TrueNAS
 *   Ring 2 (blue,  AI)            : LMStudio + Ollama + LiteLLM
 *   Ring 3 (amber, media)         : Jellyfin
 *
 * Service -> hotspot mapping (index matches nodes.js SERVICE_DEFS order):
 *   0=LMStudio  1=Ollama  2=LiteLLM  3=Proxmox  4=TrueNAS  5=Jellyfin
 */

import * as THREE from 'three';
import { serviceEventBus } from './services.js';

// ── Shaders ──────────────────────────────────────────────────────────────

const PLANET_VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec2 vUv;
  varying vec3 vViewDir;

  void main() {
    vUv     = uv;
    vNormal = normalize(normalMatrix * normal);

    vec4 mvPos  = modelViewMatrix * vec4(position, 1.0);
    vViewDir    = normalize(-mvPos.xyz);

    gl_Position = projectionMatrix * mvPos;
  }
`;

const PLANET_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uHealth0;
  uniform float uHealth1;
  uniform float uHealth2;
  uniform float uHealth3;
  uniform float uHealth4;
  uniform float uHealth5;
  uniform vec3  uColor0;
  uniform vec3  uColor1;
  uniform vec3  uColor2;
  uniform vec3  uColor3;
  uniform vec3  uColor4;
  uniform vec3  uColor5;

  varying vec3 vNormal;
  varying vec2 vUv;
  varying vec3 vViewDir;

  // 6 hotspot UV positions (latitude/longitude on sphere surface)
  vec2 hotspots[6];

  float hotspotGlow(vec2 uv, vec2 center, float health, float phase) {
    float d = distance(uv, center) * 3.5;
    float g = exp(-d * d * 12.0) * health;
    float pulse = 0.5 + 0.5 * sin(uTime * 2.0 + phase);
    return g * (0.55 + 0.45 * pulse);
  }

  void main() {
    // Base: deep navy-purple
    vec3 col = vec3(0.09, 0.055, 0.17);

    // Subtle surface variation
    float lat = vUv.y;
    col += vec3(0.03, 0.02, 0.06) * (0.5 + 0.5 * sin(lat * 18.0 + uTime * 0.05));

    // Hotspot positions in UV space
    hotspots[0] = vec2(0.20, 0.60);  // LMStudio
    hotspots[1] = vec2(0.45, 0.72);  // Ollama
    hotspots[2] = vec2(0.70, 0.55);  // LiteLLM
    hotspots[3] = vec2(0.30, 0.38);  // Proxmox
    hotspots[4] = vec2(0.60, 0.28);  // TrueNAS
    hotspots[5] = vec2(0.80, 0.65);  // Jellyfin

    float h[6];
    h[0] = uHealth0; h[1] = uHealth1; h[2] = uHealth2;
    h[3] = uHealth3; h[4] = uHealth4; h[5] = uHealth5;

    vec3 c[6];
    c[0] = uColor0; c[1] = uColor1; c[2] = uColor2;
    c[3] = uColor3; c[4] = uColor4; c[5] = uColor5;

    // Add each hotspot contribution
    for (int i = 0; i < 6; i++) {
      float glow = hotspotGlow(vUv, hotspots[i], h[i], float(i) * 1.047);
      col += c[i] * glow * 0.7;
    }

    // Offline pulse: when a service is down, its hotspot pulses red
    for (int i = 0; i < 6; i++) {
      float offline = 1.0 - h[i];
      float d = distance(vUv, hotspots[i]) * 3.5;
      float g = exp(-d * d * 8.0) * offline;
      float pulse = 0.5 + 0.5 * sin(uTime * 4.5 + float(i));
      col += vec3(0.8, 0.1, 0.05) * g * pulse * 0.5;
    }

    // Fresnel atmosphere rim
    float fresnel = pow(1.0 - max(dot(vViewDir, vNormal), 0.0), 3.5);
    col += vec3(0.15, 0.28, 0.80) * fresnel * 0.65;

    // Fade in global alpha
    gl_FragColor = vec4(col, 0.96);
  }
`;

// ── HomelabPlanet class ─────────────────────────────────────────────────────

// Service index order (must match nodes.js SERVICE_DEFS)
const SVC_INDEX = { lmstudio: 0, ollama: 1, litellm: 2, proxmox: 3, truenas: 4, jellyfin: 5 };

// Accent colors per service (RGB 0-1, matches nodes.js accentColor)
const SVC_COLORS = [
  new THREE.Vector3(1.00, 0.60, 0.25),  // LMStudio  amber
  new THREE.Vector3(0.00, 0.82, 0.38),  // Ollama    green
  new THREE.Vector3(0.06, 0.63, 1.00),  // LiteLLM   cyan
  new THREE.Vector3(1.00, 0.38, 0.13),  // Proxmox   orange
  new THREE.Vector3(0.25, 0.38, 0.82),  // TrueNAS   blue
  new THREE.Vector3(0.56, 0.31, 1.00),  // Jellyfin  purple
];

export class HomelabPlanet {
  constructor(scene) {
    this._group = new THREE.Group();
    this._group.position.set(-8.5, -5.0, -2.0);
    scene.add(this._group);

    // Health targets per service (lerped toward over time)
    this._healthTarget = new Float32Array(6).fill(1.0);
    this._healthCurrent = new Float32Array(6).fill(1.0);

    // Ring opacity targets
    this._ringOpacityTarget  = [0.38, 0.22, 0.18];
    this._ringOpacityCurrent = [0.38, 0.22, 0.18];

    this._buildPlanet(scene);
    this._buildRings();
    this._buildLights(scene);
    this._subscribe();
  }

  // ── Planet sphere ───────────────────────────────────────────────────────

  _buildPlanet(scene) {
    const geo = new THREE.SphereGeometry(1.2, 64, 64);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:    { value: 0.0 },
        uHealth0: { value: 1.0 }, uHealth1: { value: 1.0 },
        uHealth2: { value: 1.0 }, uHealth3: { value: 1.0 },
        uHealth4: { value: 1.0 }, uHealth5: { value: 1.0 },
        uColor0:  { value: SVC_COLORS[0] }, uColor1:  { value: SVC_COLORS[1] },
        uColor2:  { value: SVC_COLORS[2] }, uColor3:  { value: SVC_COLORS[3] },
        uColor4:  { value: SVC_COLORS[4] }, uColor5:  { value: SVC_COLORS[5] },
      },
      vertexShader:   PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      transparent:    true,
    });
    this._planetMesh = new THREE.Mesh(geo, mat);
    this._planetMat  = mat;
    this._group.add(this._planetMesh);

    // Atmosphere shell (additive transparent backside)
    const atmGeo = new THREE.SphereGeometry(1.26, 48, 48);
    const atmMat = new THREE.MeshBasicMaterial({
      color:       0x4422aa,
      transparent: true,
      opacity:     0.08,
      side:        THREE.BackSide,
      depthWrite:  false,
    });
    this._group.add(new THREE.Mesh(atmGeo, atmMat));
  }

  // ── Rings ──────────────────────────────────────────────────────────────

  _buildRings() {
    this._ringsGroup = new THREE.Group();
    this._ringsGroup.rotation.x = Math.PI * 0.40;
    this._group.add(this._ringsGroup);

    this._ringMeshes = [
      this._makeRing(1.55, 2.28, 0xc8a85a, 0.38),  // gold  -- infra
      this._makeRing(1.36, 1.57, 0x9980cc, 0.22),  // blue  -- AI
      this._makeRing(2.30, 2.55, 0xa07838, 0.18),  // amber -- media
    ];
    for (const r of this._ringMeshes) this._ringsGroup.add(r);
  }

  _makeRing(innerR, outerR, color, opacity) {
    const geo = new THREE.RingGeometry(innerR, outerR, 128, 4);
    // Remap UV so inner=0, outer=1 (radial gradient ready)
    const pos = geo.attributes.position;
    const uv  = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      uv.setXY(i, (r - innerR) / (outerR - innerR), 0);
    }
    uv.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side:       THREE.DoubleSide,
      depthWrite: false,
    });
    return new THREE.Mesh(geo, mat);
  }

  // ── Lights ─────────────────────────────────────────────────────────────

  _buildLights(scene) {
    // Key light — cool blue-white from upper-right of planet
    const key = new THREE.PointLight(0xd0c8ff, 1.8, 22);
    key.position.set(-4.5, 0.5, 3.0);
    scene.add(key);

    // Rim light -- deep purple from behind
    const rim = new THREE.PointLight(0x6040c0, 0.7, 14);
    rim.position.set(-12.5, -8.5, -5.0);
    scene.add(rim);
  }

  // ── Event subscription ───────────────────────────────────────────────────

  _subscribe() {
    serviceEventBus.addEventListener('service-update', (e) => {
      const { id, status } = e.detail;
      const i = SVC_INDEX[id];
      if (i === undefined) return;

      // Map status to health float
      const health = status === 'online' ? 1.0 : status === 'degraded' ? 0.5 : 0.0;
      this._healthTarget[i] = health;

      // Recompute ring opacity targets
      const h = this._healthTarget;
      const infra = (h[3] + h[4]) / 2;                // proxmox + truenas
      const ai    = (h[0] + h[1] + h[2]) / 3;         // lmstudio + ollama + litellm
      const media = h[5];                              // jellyfin

      this._ringOpacityTarget[0] = 0.08 + 0.35 * infra;
      this._ringOpacityTarget[1] = 0.06 + 0.22 * ai;
      this._ringOpacityTarget[2] = 0.05 + 0.16 * media;
    });
  }

  // ── Per-frame update ───────────────────────────────────────────────────

  update(elapsed, delta) {
    // Idle planet rotation
    this._planetMesh.rotation.y = elapsed * 0.06;

    // Ring wobble
    this._ringsGroup.rotation.x = Math.PI * 0.40 + Math.sin(elapsed * 0.25) * 0.018;

    // Lerp health values toward targets (smooth transitions)
    const lk = Math.min(delta * 1.5, 1.0);  // ~0.67s half-life
    for (let i = 0; i < 6; i++) {
      this._healthCurrent[i] += (this._healthTarget[i] - this._healthCurrent[i]) * lk;
    }

    // Push to shader uniforms
    const u = this._planetMat.uniforms;
    u.uTime.value    = elapsed;
    u.uHealth0.value = this._healthCurrent[0];
    u.uHealth1.value = this._healthCurrent[1];
    u.uHealth2.value = this._healthCurrent[2];
    u.uHealth3.value = this._healthCurrent[3];
    u.uHealth4.value = this._healthCurrent[4];
    u.uHealth5.value = this._healthCurrent[5];

    // Lerp ring opacities
    const ok = Math.min(delta * 0.8, 1.0);
    for (let i = 0; i < 3; i++) {
      this._ringOpacityCurrent[i] +=
        (this._ringOpacityTarget[i] - this._ringOpacityCurrent[i]) * ok;
      this._ringMeshes[i].material.opacity = this._ringOpacityCurrent[i];
    }
  }

  /** World-space center of the planet (used by nodes.js for orbits) */
  get position() { return this._group.position; }
}
