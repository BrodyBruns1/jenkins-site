/**
 * starfield.js — Background star field
 *
 * Renders thousands of distant stars across the scene background.
 * Stars vary in size and brightness, with a subtle twinkle effect
 * driven through a custom shader. The field is a single Points draw
 * call — no per-frame geometry updates.
 */

import * as THREE from 'three';

const STAR_COUNT = 4200;
const FIELD_RADIUS = 220;       // how far stars extend from origin
const MIN_DIST = 40;            // minimum distance so stars don't crowd the foreground

const VERT = /* glsl */`
  uniform float uTime;
  attribute float aSize;
  attribute float aPhase;
  attribute float aBrightness;
  varying float vAlpha;

  void main() {
    // Twinkle: slow sin oscillation unique per star
    float twinkle = 0.72 + 0.28 * sin(uTime * (0.3 + aPhase * 0.7) + aPhase * 6.2831);
    vAlpha = aBrightness * twinkle;

    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (180.0 / -mvPos.z);
    gl_PointSize = clamp(gl_PointSize, 0.4, 3.5);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const FRAG = /* glsl */`
  varying float vAlpha;

  void main() {
    // Soft circular point
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float soft = 1.0 - d * d;
    gl_FragColor = vec4(0.85, 0.88, 1.0, vAlpha * soft);
  }
`;

export class Starfield {
  constructor(scene) {
    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes     = new Float32Array(STAR_COUNT);
    const phases    = new Float32Array(STAR_COUNT);
    const brightness = new Float32Array(STAR_COUNT);

    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniformly distributed on a sphere shell, then randomised radially
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = MIN_DIST + Math.random() * (FIELD_RADIUS - MIN_DIST);

      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);

      // Most stars are small and dim, a few are bigger and brighter
      const mag = Math.random();
      sizes[i]      = mag < 0.92 ? 0.6 + Math.random() * 0.8
                     : mag < 0.98 ? 1.2 + Math.random() * 1.0
                     : 2.0 + Math.random() * 1.2;
      phases[i]     = Math.random();
      brightness[i] = 0.25 + Math.random() * 0.75;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',    new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize',       new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aPhase',      new THREE.BufferAttribute(phases, 1));
    geo.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));

    this._material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this._points = new THREE.Points(geo, this._material);
    this._points.renderOrder = -100;   // draw behind everything
    scene.add(this._points);
  }

  update(elapsed) {
    this._material.uniforms.uTime.value = elapsed;
  }

  dispose() {
    this._points.geometry.dispose();
    this._material.dispose();
  }
}
