/**
 * reactor.js — Particle Reactor background
 *
 * 30,000 particles in a slow Brownian drift that reacts to build events:
 *   build-start  → particle burst from center (radial burst, exponential decay)
 *   build-fail   → shockwave ripple outward through the field
 *   all-green    → field calms, hue shifts toward cool blue-green
 *   jobs-update  → field goes warm-orange when failures exist
 *
 * Uses a single Points draw call with a custom ShaderMaterial.
 * All reactive behaviour is driven purely through uniforms — no geometry
 * is rebuilt at runtime.
 */

import * as THREE from 'three';
import { buildEventBus } from './api.js';

const VERT = /* glsl */`
  uniform float uTime;
  uniform float uBurstTime;    // elapsed time when last burst fired (-999 = never)
  uniform float uShockTime;    // elapsed time when last shockwave fired (-999 = never)
  uniform float uMood;         // -1 = failures, 0 = normal, +1 = all-green
  uniform vec2  uMouse;        // cursor in NDC space (-1..1)
  uniform float uMouseRadius;  // rainbow influence radius in NDC

  attribute float aSize;
  attribute float aPhase;
  attribute float aSpeed;
  attribute vec3  aBasePos;    // original sphere-distributed position

  varying float vAlpha;
  varying vec3  vColor;

  void main() {
    vec3 pos = aBasePos;

    // ── Brownian drift ──────────────────────────────────────────────────────
    // Calmer when all-green (uMood=1), more agitated when failures (uMood=-1)
    float dAmp = mix(0.25, 0.55, (-uMood * 0.5 + 0.5)); // 0.25 (calm) to 0.55 (agitated)
    float t    = uTime;
    pos.x += sin(t * 0.31 * aSpeed + aPhase)        * dAmp
           + cos(t * 0.19 * aSpeed + aPhase * 1.27) * dAmp * 0.45;
    pos.y += cos(t * 0.27 * aSpeed + aPhase * 0.73) * dAmp
           + sin(t * 0.17 * aSpeed + aPhase * 0.91) * dAmp * 0.45;
    pos.z += sin(t * 0.23 * aSpeed + aPhase * 1.11) * dAmp;

    // ── Burst: particles radiate from origin, decay in ~2 s ────────────────
    float burstAge = t - uBurstTime;
    if (burstAge > 0.0 && burstAge < 2.5) {
      // Each particle gets a deterministic burst direction from aPhase
      float bp = aPhase;
      vec3 dir = normalize(vec3(
        sin(bp * 7.3 + 1.0),
        cos(bp * 3.1 + 0.5),
        sin(bp * 5.7 + 2.3)
      ));
      float decay = exp(-burstAge * 2.2) * aSpeed;
      pos += dir * decay * 9.0;
    }

    // ── Shockwave: spherical ripple through the field ───────────────────────
    float shockAge = t - uShockTime;
    if (shockAge > 0.0 && shockAge < 3.0) {
      float waveFront = shockAge * 7.0;
      float origDist  = length(aBasePos);
      // Particles near the wave front get displaced outward
      float envelope  = smoothstep(waveFront - 1.8, waveFront, origDist)
                      * (1.0 - smoothstep(waveFront, waveFront + 0.6, origDist));
      float shockDecay = exp(-shockAge * 1.2);
      pos += normalize(aBasePos + 0.001) * envelope * shockDecay * 6.0;
    }

    vec4 mvPos    = modelViewMatrix * vec4(pos, 1.0);
    float sz      = aSize * (280.0 / -mvPos.z);
    gl_PointSize  = clamp(sz, 0.3, 7.0);
    gl_Position   = projectionMatrix * mvPos;

    // ── Colour: cyan-blue (normal) → orange-red (failure) → blue-green (ok) ─
    float failBlend  = clamp(-uMood, 0.0, 1.0);
    float greenBlend = clamp( uMood, 0.0, 1.0);
    vec3  baseCol  = vec3(0.08, 0.45, 1.00);   // normal blue
    vec3  failCol  = vec3(1.00, 0.28, 0.08);   // failure orange-red
    vec3  greenCol = vec3(0.00, 0.82, 0.52);   // all-green teal

    vColor = mix(mix(baseCol, failCol, failBlend), greenCol, greenBlend);

    // Depth fade + pulse
    float depthFade = clamp((-mvPos.z - 1.0) / 28.0, 0.0, 1.0);
    vAlpha = depthFade * (0.35 + 0.65 * sin(t * 0.5 + aPhase));

    // ── Cursor rainbow ──────────────────────────────────────────────────────
    // Particles near the cursor in NDC space get a rainbow hue.
    // Each particle gets a unique hue from aPhase, slowly cycling with time.
    vec2 ndc = gl_Position.xy / gl_Position.w;
    float cursorDist = length(ndc - uMouse);
    float proximity = 1.0 - smoothstep(0.0, uMouseRadius, cursorDist);
    if (proximity > 0.01) {
      float hue = fract(aPhase * 0.15915 + uTime * 0.06); // aPhase/(2PI) + slow drift
      float r = clamp(abs(hue * 6.0 - 3.0) - 1.0, 0.0, 1.0);
      float g = clamp(2.0 - abs(hue * 6.0 - 2.0), 0.0, 1.0);
      float b = clamp(2.0 - abs(hue * 6.0 - 4.0), 0.0, 1.0);
      vColor = mix(vColor, vec3(r, g, b), proximity * 0.90);
      vAlpha = mix(vAlpha, min(vAlpha * 2.2 + proximity * 0.5, 1.0), proximity);
    }
  }
`;

const FRAG = /* glsl */`
  varying float vAlpha;
  varying vec3  vColor;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp(-d * 4.5) * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export class ParticleReactor {
  constructor(scene) {
    this._elapsed = 0;
    this._visible = true;

    // Uniforms shared with the shader
    this._u = {
      uTime:        { value: 0.0 },
      uBurstTime:   { value: -999.0 },
      uShockTime:   { value: -999.0 },
      uMood:        { value: 0.0 },
      uMouse:       { value: new THREE.Vector2(9999, 9999) },
      uMouseRadius: { value: 0.28 },
    };

    this._build(scene);
    this._subscribe();
  }

  _build(scene) {
    const COUNT = 30000;
    const basePos = new Float32Array(COUNT * 3);
    const sizes   = new Float32Array(COUNT);
    const phases  = new Float32Array(COUNT);
    const speeds  = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      // Distribute in a thick shell (inner 4, outer 26) so particles surround
      // the viewer and fill the background at all camera angles
      const r  = 4 + Math.random() * 22;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      basePos[i*3]   = r * Math.sin(ph) * Math.cos(th);
      basePos[i*3+1] = r * Math.cos(ph);
      basePos[i*3+2] = r * Math.sin(ph) * Math.sin(th);

      sizes[i]  = 0.3 + Math.random() * 1.6;
      phases[i] = Math.random() * Math.PI * 2;
      speeds[i] = 0.25 + Math.random() * 0.75;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(basePos.slice(), 3)); // positions = base; drift in shader via aBasePos
    geo.setAttribute('aBasePos', new THREE.BufferAttribute(basePos, 3));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes,   1));
    geo.setAttribute('aPhase',   new THREE.BufferAttribute(phases,  1));
    geo.setAttribute('aSpeed',   new THREE.BufferAttribute(speeds,  1));

    this._mat = new THREE.ShaderMaterial({
      uniforms:    this._u,
      vertexShader:   VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
    });

    this._points = new THREE.Points(geo, this._mat);
    this._points.renderOrder = 0;
    scene.add(this._points);
  }

  _subscribe() {
    buildEventBus.addEventListener('build-start', () => {
      this._u.uBurstTime.value = this._elapsed;
    });

    buildEventBus.addEventListener('build-fail', () => {
      this._u.uShockTime.value = this._elapsed;
      // Immediately signal failure mood; cleared on all-green or jobs-update
      this._u.uMood.value = Math.min(this._u.uMood.value - 0.5, -1.0);
    });

    buildEventBus.addEventListener('all-green', () => {
      this._u.uMood.value = 1.0;
    });

    buildEventBus.addEventListener('jobs-update', (e) => {
      const { jobs } = e.detail;
      const hasFailures = jobs.some(j =>
        j.color === 'red' || j.color === 'red_anime'
      );
      if (hasFailures) {
        this._u.uMood.value = -1.0;
      } else if (this._u.uMood.value < 0) {
        // Recovery: drift back to neutral
        this._u.uMood.value = 0.0;
      }
    });
  }

  /** Called from main.js mousemove handler */
  setMouse(ndcX, ndcY) {
    this._u.uMouse.value.set(ndcX, ndcY);
  }

  setVisible(visible) {
    this._visible = !!visible;
    if (this._points) this._points.visible = this._visible;
  }

  /** Called every frame by main.js */
  update(elapsed) {
    this._elapsed        = elapsed;
    this._u.uTime.value  = elapsed;
    if (this._points) this._points.visible = this._visible;
  }
}
