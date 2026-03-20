/**
 * holoCore.js -- Central holographic core
 *
 * A glowing wireframe polyhedron cluster with pulsing energy at the scene
 * origin. Gives section 0 ("Mission Control") a dramatic focal point
 * beyond just the particle reactor.
 *
 * Visual layers (inside-out):
 *   1. Inner glowing sphere — custom fresnel/scan-line shader
 *   2. Wireframe octahedron — counter-rotating
 *   3. Wireframe icosahedron (detail 1) — primary frame
 *   4. Wireframe dodecahedron — outermost, slow drift
 *   5. Point light at center — pulses with breathing rhythm
 */

import * as THREE from 'three';

// ── Shaders ────────────────────────────────────────────────────────────────

const CORE_VERT = /* glsl */`
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vNormal   = normalize(normalMatrix * normal);
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;

    // Subtle breathing displacement
    vec3 pos = position;
    float pulse = sin(uTime * 0.8) * 0.03 + sin(uTime * 1.3) * 0.02;
    pos += normal * pulse;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const CORE_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uAlpha;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    // Fresnel — bright at grazing angles
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = 1.0 - abs(dot(viewDir, vNormal));
    fresnel = pow(fresnel, 2.5);

    // Colour palette
    vec3 baseColor = vec3(0.05, 0.22, 0.58);
    vec3 edgeColor = vec3(0.22, 0.62, 1.00);
    vec3 color     = mix(baseColor, edgeColor, fresnel);

    // Horizontal scanning lines
    float scan = sin(vWorldPos.y * 14.0 - uTime * 2.2) * 0.5 + 0.5;
    scan = pow(scan, 10.0);
    color += vec3(0.10, 0.38, 0.80) * scan * 0.35;

    // Hexagonal-ish surface pattern
    float hex = sin(vWorldPos.x * 18.0 + uTime * 0.6)
              * sin(vWorldPos.y * 18.0 - uTime * 0.4)
              * sin(vWorldPos.z * 18.0 + uTime * 0.3);
    hex = smoothstep(0.55, 0.80, abs(hex));
    color += vec3(0.08, 0.30, 0.60) * hex * 0.20;

    // Global pulse
    float pulse = sin(uTime * 1.2) * 0.15 + 0.85;

    float alpha = (fresnel * 0.58 + 0.12) * pulse * uAlpha;
    gl_FragColor = vec4(color, alpha);
  }
`;

// ── Class ──────────────────────────────────────────────────────────────────

export class HoloCore {
  constructor(scene) {
    this._group = new THREE.Group();
    scene.add(this._group);
    this._fade = 1.0;

    this._buildCore();
    this._buildWireframes();
    this._buildLight();
  }

  setFade(fade) {
    this._fade = THREE.MathUtils.clamp(fade, 0, 1);
  }

  // ── Inner glowing sphere ─────────────────────────────────────────────

  _buildCore() {
    const geo = new THREE.SphereGeometry(0.8, 48, 48);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:  { value: 0 },
        uAlpha: { value: 0 },
      },
      vertexShader:   CORE_VERT,
      fragmentShader: CORE_FRAG,
      transparent: true,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
      side:        THREE.FrontSide,
    });
    this._coreMesh = new THREE.Mesh(geo, mat);
    this._coreMesh.renderOrder = 1;
    this._group.add(this._coreMesh);
  }

  // ── Nested wireframe shells ──────────────────────────────────────────

  _buildWireframes() {
    // Layer 1: octahedron (innermost frame)
    this._octWire = this._makeWire(
      new THREE.OctahedronGeometry(1.05, 0),
      0x60c0ff,
    );

    // Layer 2: icosahedron (mid frame, detail 1)
    this._icoWire = this._makeWire(
      new THREE.IcosahedronGeometry(1.50, 1),
      0x3090ff,
    );

    // Layer 3: dodecahedron (outermost, slow)
    this._dodWire = this._makeWire(
      new THREE.DodecahedronGeometry(2.10, 0),
      0x2060bb,
    );
  }

  _makeWire(geo, color) {
    const edges = new THREE.EdgesGeometry(geo);
    const mat   = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
    });
    const mesh = new THREE.LineSegments(edges, mat);
    mesh.renderOrder = 1;
    this._group.add(mesh);
    return mesh;
  }

  // ── Central light ────────────────────────────────────────────────────

  _buildLight() {
    this._light = new THREE.PointLight(0x4488ff, 0, 18);
    this._group.add(this._light);
  }

  // ── Per-frame ────────────────────────────────────────────────────────

  update(elapsed, _delta) {
    // Fade in over 3 s
    const fade = Math.min(elapsed / 3.0, 1.0) * this._fade;

    // Core shader uniforms
    const u = this._coreMesh.material.uniforms;
    u.uTime.value  = elapsed;
    u.uAlpha.value = fade;

    // Wireframe rotations
    this._octWire.rotation.x = -elapsed * 0.18;
    this._octWire.rotation.z =  elapsed * 0.12;
    this._octWire.material.opacity = fade * (0.16 + 0.08 * Math.sin(elapsed * 0.9 + 1));

    this._icoWire.rotation.x = elapsed * 0.10;
    this._icoWire.rotation.y = elapsed * 0.07;
    this._icoWire.material.opacity = fade * (0.20 + 0.10 * Math.sin(elapsed * 0.7));

    this._dodWire.rotation.y =  elapsed * 0.035;
    this._dodWire.rotation.z = -elapsed * 0.025;
    this._dodWire.material.opacity = fade * (0.09 + 0.05 * Math.sin(elapsed * 0.5 + 2));

    // Pulsing light
    this._light.intensity = fade * (1.2 + 0.6 * Math.sin(elapsed * 1.5));
  }
}
