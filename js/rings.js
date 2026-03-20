/**
 * rings.js — Health Rings header element
 *
 * Four concentric TorusGeometry rings rendered in 3D space in the upper-right
 * of the scene. Each ring represents one system metric via a filled-arc shader:
 *
 *   Ring 0 (outer, ~r=2.2): Build queue depth     — orange → red as queue grows
 *   Ring 1 (      ~r=1.65): Executor utilization  — green → yellow → orange
 *   Ring 2 (      ~r=1.10): 24 h pass rate        — red → green
 *   Ring 3 (inner, ~r=0.65): Active builds count  — blue, pulses per build
 *
 * UV layout of THREE.TorusGeometry:
 *   uv.x → position around the large circumference (0–1) — used for arc fill
 *   uv.y → position around the tube cross-section (0–1)  — used for tube glow
 *
 * The group is positioned at (9, 8, 0) in world space which, with the default
 * camera at (0, 0, 20) fov=65, maps to roughly the upper-right quadrant.
 */

import * as THREE from 'three';
import { buildEventBus } from './api.js';

// ── Shaders ────────────────────────────────────────────────────────────────
const RING_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAG = /* glsl */`
  uniform float uFill;      // 0.0–1.0: filled arc fraction
  uniform vec3  uColor;     // RGB ring colour
  uniform float uTime;
  uniform float uPulse;     // 1.0 = enable pulse (innermost ring only)
  uniform float uDimAlpha;  // global fade-in alpha, driven by main.js

  varying vec2 vUv;

  void main() {
    // uv.x: position around torus circumference
    // uv.y: position around tube cross-section

    // Soft arc edge (+/-1.5 % of circumference)
    float filled = 1.0 - smoothstep(uFill - 0.015, uFill + 0.015, vUv.x);

    // Dark (unfilled) arc brightness
    float dark = 0.06;

    // Tube-cross glow: brightest at the centre of the tube
    float tubeDist = abs(vUv.y - 0.5) * 2.0;   // 0 = centre, 1 = edge
    float tubeGlow = pow(1.0 - tubeDist, 2.8);

    float brightness = mix(dark, 0.55 + 0.45 * tubeGlow, filled);

    // Inner-ring pulse
    if (uPulse > 0.5) {
      float pulse = 0.25 * sin(uTime * 3.8 + vUv.x * 6.283) + 0.25;
      brightness += filled * tubeGlow * pulse;
    }

    gl_FragColor = vec4(uColor * brightness, uDimAlpha * 0.88);
  }
`;

// ── Ring config ────────────────────────────────────────────────────────────
// [torusRadius, tubeRadius, baseColor[r,g,b], tiltX, tiltZ, rotSpeedY, isPulse]
const RING_DEFS = [
  { r: 2.20, t: 0.055, col: [1.0, 0.40, 0.10], tx:  0.28, tz:  0.18, ry: 0.28, pulse: false },
  { r: 1.65, t: 0.055, col: [1.0, 0.75, 0.00], tx: -0.18, tz:  0.35, ry: 0.45, pulse: false },
  { r: 1.10, t: 0.055, col: [0.00, 0.88, 0.45], tx:  0.35, tz: -0.28, ry:-0.38, pulse: false },
  { r: 0.65, t: 0.055, col: [0.15, 0.60, 1.00], tx: -0.10, tz:  0.08, ry: 0.62, pulse: true  },
];

export class HealthRings {
  constructor(scene) {
    this._rings = [];
    this._group = new THREE.Group();
    this._fade = 1.0;
    this._speechLevel = 0.0;
    this._speechEnergy = 0.0;
    this._speechFrequency = 0.0;
    this._speechFrequencyTarget = 0.0;
    this._responseEnergy = 0.0;
    // Upper-right quadrant; z slightly negative for natural depth cue
    this._group.position.set(9.0, 8.0, -1.0);
    scene.add(this._group);

    this._buildRings();
    this._subscribe();
  }

  _buildRings() {
    for (const [i, def] of RING_DEFS.entries()) {
      const geo = new THREE.TorusGeometry(def.r, def.t, 14, 240);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uFill:     { value: i === 2 ? 1.0 : 0.0 }, // pass-rate starts at 100 %
          uColor:    { value: new THREE.Vector3(...def.col) },
          uTime:     { value: 0.0 },
          uPulse:    { value: def.pulse ? 1.0 : 0.0 },
          uDimAlpha: { value: 0.0 },  // fades in via update()
        },
        vertexShader:   RING_VERT,
        fragmentShader: RING_FRAG,
        transparent:    true,
        depthWrite:     false,
        side:           THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = def.tx;
      mesh.rotation.z = def.tz;
      mesh.renderOrder = 2;
      mesh.userData.ry = def.ry;
      mesh.userData.baseTx = def.tx;
      mesh.userData.baseTz = def.tz;
      mesh.userData.baseRadius = def.r;
      mesh.userData.baseTube = def.t;
      mesh.userData.index = i;
      mesh.userData.waveStrength = 0;

      this._group.add(mesh);
      this._rings.push(mesh);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  _setFill(i, v) {
    this._rings[i].material.uniforms.uFill.value = THREE.MathUtils.clamp(v, 0, 1);
  }
  _setColor(i, r, g, b) {
    this._rings[i].material.uniforms.uColor.value.set(r, g, b);
  }

  setFade(fade) {
    this._fade = THREE.MathUtils.clamp(fade, 0, 1);
  }

  setSpeechActivity({ level = 0, speaking = false, frequency = 0 } = {}) {
    const targetLevel = THREE.MathUtils.clamp(level || 0, 0, 1);
    this._speechLevel = speaking ? Math.max(targetLevel, 0.06) : 0.0;

    const targetFrequency = Number(frequency) || 0;
    if (speaking && targetFrequency > 0) {
      this._speechFrequencyTarget = THREE.MathUtils.clamp(targetFrequency, 70, 340);
    } else if (!speaking) {
      this._speechFrequencyTarget = 0.0;
    }
  }

  triggerResponsePulse(strength = 1) {
    this._responseEnergy = Math.max(
      this._responseEnergy,
      THREE.MathUtils.clamp(strength || 0, 0, 3)
    );
  }

  getSpeechContours() {
    const contours = [];

    for (const ring of this._rings) {
      const center = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const normal = new THREE.Vector3(0, 0, 1);

      ring.getWorldPosition(center);
      ring.getWorldQuaternion(quaternion);
      ring.getWorldScale(scale);
      normal.applyQuaternion(quaternion).normalize();

      contours.push({
        center,
        normal,
        radius: ring.userData.baseRadius * scale.x,
        thickness: Math.max(ring.userData.baseTube * scale.x * 10.0, 0.4),
        strength: ring.userData.waveStrength || 0,
      });
    }

    return contours;
  }

  // ── Event subscriptions ───────────────────────────────────────────────────
  _subscribe() {
    // Ring 0: queue depth (0 → full at ≥8 jobs)
    buildEventBus.addEventListener('queue-update', (e) => {
      const fill = Math.min(e.detail.queueDepth / 8, 1.0);
      this._setFill(0, fill);
      // Colour: dim orange → hot red
      this._setColor(0, 0.3 + 0.7 * fill, 0.40 - 0.35 * fill, 0.10);
    });

    // Ring 1: executor utilisation
    buildEventBus.addEventListener('executors-update', (e) => {
      const u = e.detail.utilization;
      this._setFill(1, u);
      // Colour: green → yellow → orange
      this._setColor(1, Math.min(u * 2, 1.0), 1.0 - u * 0.4, 0.0);
    });

    // Ring 2: pass rate; Ring 3: active build count
    buildEventBus.addEventListener('jobs-update', (e) => {
      const { jobs } = e.detail;

      // Pass rate: jobs that have finished and have a known result
      const finished = jobs.filter(j => j.lastBuild?.result);
      const passed   = finished.filter(j => j.lastBuild.result === 'SUCCESS').length;
      const passRate = finished.length > 0 ? passed / finished.length : 1.0;
      this._setFill(2, passRate);
      // Colour: red → green
      this._setColor(2, 1.0 - passRate * 0.9, passRate * 0.88, passRate * 0.35);

      // Active builds (colour ends with _anime in Jenkins API)
      const active     = jobs.filter(j => j.color?.endsWith('_anime')).length;
      const activeFill = Math.min(active / 6, 1.0);
      this._setFill(3, activeFill);
    });
  }

  /** Called every frame by main.js. delta in seconds. */
  update(elapsed, delta) {
    this._speechEnergy += (this._speechLevel - this._speechEnergy) * 0.14;
    this._speechFrequency += (this._speechFrequencyTarget - this._speechFrequency) * 0.18;
    this._responseEnergy += (0 - this._responseEnergy) * 0.05;

    const visibleVoiceRate = THREE.MathUtils.mapLinear(
      THREE.MathUtils.clamp(this._speechFrequency || 140, 70, 340),
      70, 340,
      4.2, 10.8
    );
    const pitchNorm = THREE.MathUtils.clamp(
      THREE.MathUtils.mapLinear(this._speechFrequency || 140, 70, 340, 0, 1),
      0, 1
    );
    const responsePulse = this._responseEnergy * (0.65 + 0.35 * Math.sin(elapsed * 8.4));

    for (const ring of this._rings) {
      ring.rotation.y += delta * ring.userData.ry;
      const idx = ring.userData.index;
      const voicePhase = elapsed * visibleVoiceRate + idx * 0.95;
      const voiceTremor = this._speechEnergy * (0.02 + idx * 0.006);
      const responseTremor = responsePulse * (0.03 + idx * 0.008);
      const pitchExpansion = this._speechEnergy * (0.05 + pitchNorm * 0.20) * (1 + idx * 0.10);
      const responseExpansion = responsePulse * (0.04 + idx * 0.01);
      ring.rotation.x = ring.userData.baseTx
        + Math.sin(voicePhase) * voiceTremor
        + Math.cos(elapsed * 6.2 + idx) * responseTremor;
      ring.rotation.z = ring.userData.baseTz
        + Math.cos(voicePhase * 1.12) * voiceTremor * 0.92
        + Math.sin(elapsed * 7.4 + idx * 0.8) * responseTremor;
      ring.scale.setScalar(1 + pitchExpansion + responseExpansion);
      ring.userData.waveStrength = this._speechEnergy * (0.48 + pitchNorm * 0.95)
        + responsePulse * (0.16 + idx * 0.02);

      const u = ring.material.uniforms;
      u.uTime.value = elapsed;
      // Fade rings in over first 2 s
      u.uDimAlpha.value = Math.min(elapsed / 2.0, 1.0)
        * this._fade
        * (1 + this._speechEnergy * 0.22 + responsePulse * 0.34);
    }
  }

  /** Expose ring group for potential future repositioning from main.js */
  get group() { return this._group; }
}
