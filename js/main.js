/**
 * main.js -- scene manager, renderer, animation loop, DOM wiring
 *
 * Owns:
 *   - ONE shared THREE.WebGLRenderer on #three-canvas
 *   - Scene + camera (passed to component constructors)
 *   - EffectComposer (bloom -> chromatic aberration -> vignette)
 *   - Scroll-driven camera track (3 sections, freeform scroll)
 *   - DOM label updates
 *   - startServicePolling() call (homelab services)
 *   - startDockerPolling() call (Docker containers)
 */

import * as THREE          from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';

import { ParticleReactor }             from './reactor.js';
import { HealthRings }                 from './rings.js';
import { HoloCore }                    from './holoCore.js';
import { HomelabPlanet }               from './planet.js';
import { ServiceNodes }                from './nodes.js';
import { startServicePolling }         from './services.js';
import { initPanels }                  from './panels.js';
import { DockerPlanet }                from './dockerPlanet.js';
import { startDockerPolling, dockerEventBus } from './dockerApi.js';

// ── Renderer ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping        = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// ── Scene / Camera ──────────────────────────────────────────────────────────
const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  65,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);
camera.position.set(0, 0, 20);

const clock = new THREE.Clock();

// ── Post-processing ─────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.2, 0.5, 0.0
);
composer.addPass(bloomPass);

// Chromatic aberration
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0.003 } },
  vertexShader:   `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; varying vec2 vUv;
    void main(){
      vec2 d=vUv-0.5; float l=length(d);
      float r=texture2D(tDiffuse,vUv-d*uAmount*l).r;
      float g=texture2D(tDiffuse,vUv).g;
      float b=texture2D(tDiffuse,vUv+d*uAmount*l).b;
      gl_FragColor=vec4(r,g,b,1.0);
    }`,
}));

// Vignette
composer.addPass(new ShaderPass({
  uniforms: {
    tDiffuse:  { value: null },
    uOffset:   { value: 0.90 },
    uDarkness: { value: 1.30 },
  },
  vertexShader:   `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uOffset; uniform float uDarkness; varying vec2 vUv;
    void main(){
      vec4 col=texture2D(tDiffuse,vUv);
      float d=length(vUv-0.5)*uOffset;
      col.rgb*=clamp(1.0-uDarkness*d*d,0.0,1.0);
      gl_FragColor=col;
    }`,
}));

// ── 3D Components ───────────────────────────────────────────────────────────
const reactor = new ParticleReactor(scene);
const rings   = new HealthRings(scene);
const core    = new HoloCore(scene);
const planet  = new HomelabPlanet(scene);
const nodes   = new ServiceNodes(scene, planet.position);
nodes.setCamera(camera);

// Docker planet (section 2 — replaces the old empty sister planet)
const dockerPlanet = new DockerPlanet(scene, camera);

// ── Scroll-driven camera track ──────────────────────────────────────────────
const _lookTarget = new THREE.Vector3();
let _scrollProgress = 0;

const WAYPOINTS = [
  { cam: new THREE.Vector3(0,     0,    20),  look: new THREE.Vector3(0,      0,    0   ) },
  { cam: new THREE.Vector3(-8.5, -1.5,   3),  look: new THREE.Vector3(-8.5,  -5.0, -2.0) },
  { cam: new THREE.Vector3(11.5, -1.5,   3),  look: new THREE.Vector3(11.5,  -5.0, -2.0) },
];

function _updateCamera(p) {
  p = Math.max(0, Math.min(WAYPOINTS.length - 1, p));
  const i  = Math.min(Math.floor(p), WAYPOINTS.length - 2);
  const t  = p - i;
  const te = t * t * (3 - 2 * t);   // smoothstep easing
  const a  = WAYPOINTS[i];
  const b  = WAYPOINTS[i + 1];
  camera.position.lerpVectors(a.cam, b.cam, te);
  _lookTarget.lerpVectors(a.look, b.look, te);
  camera.lookAt(_lookTarget);
  camera.updateProjectionMatrix();
}

function _updateSectionUI(p) {
  document.querySelectorAll('.section-title').forEach((el, i) => {
    el.style.opacity = String(Math.max(0, 1 - Math.abs(p - i) * 2.5));
  });
  document.querySelectorAll('.section-dot').forEach((el, i) => {
    el.classList.toggle('active', Math.round(p) === i);
  });

  // Show/hide Docker-specific UI when near section 2
  const dockerProximity = 1 - Math.min(Math.abs(p - 2), 1);
  const editBtn   = document.getElementById('docker-edit-groups-btn');
  const summaryEl = document.getElementById('docker-summary');
  if (editBtn)   editBtn.classList.toggle('visible', dockerProximity > 0.5);
  if (summaryEl) summaryEl.classList.toggle('visible', dockerProximity > 0.5);

  // Show/hide service cards when near section 1
  const svcCards = document.getElementById('service-cards');
  if (svcCards) {
    const svcProximity = 1 - Math.min(Math.abs(p - 1), 1);
    svcCards.style.opacity = String(Math.max(0, svcProximity));
    svcCards.style.pointerEvents = svcProximity > 0.3 ? 'auto' : 'none';
  }
}

// Wire section-dot clicks
document.querySelectorAll('.section-dot').forEach((el, i) => {
  el.addEventListener('click', () =>
    window.scrollTo({ top: i * window.innerHeight, behavior: 'smooth' }));
});

// ── DOM -- Docker summary labels ────────────────────────────────────────────
dockerEventBus.addEventListener('containers-update', (e) => {
  const { containers } = e.detail;
  const running  = containers.filter(c => c.state === 'running').length;
  const total    = containers.length;
  const healthy  = containers.filter(c => c.health === 'healthy').length;
  const unhealthy = containers.filter(c => c.health === 'unhealthy').length;

  const el = document.getElementById('docker-summary');
  if (el) {
    el.innerHTML = `
      <div class="docker-summary__stat"><strong>${running}</strong>/ ${total} running</div>
      ${healthy  ? `<div class="docker-summary__stat"><strong>${healthy}</strong> healthy</div>` : ''}
      ${unhealthy ? `<div class="docker-summary__stat" style="color:rgba(255,136,0,0.55)"><strong>${unhealthy}</strong> unhealthy</div>` : ''}`;
  }
});

// ── Ambient ring animation (no Jenkins data, so cycle aesthetically) ─────
function _animateRings(elapsed) {
  // Slowly cycle ring fills to look like live data
  const r = rings;
  if (!r._rings) return;

  // Ring 0 (queue): slow sine wave
  const fill0 = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(elapsed * 0.18));
  r._setFill(0, fill0);

  // Ring 1 (executors): offset sine
  const fill1 = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 0.13 + 1.5));
  r._setFill(1, fill1);

  // Ring 2 (pass rate): stays high, gentle sway
  const fill2 = 0.80 + 0.18 * Math.sin(elapsed * 0.09 + 3.0);
  r._setFill(2, fill2);

  // Ring 3 (active): rhythmic pulse
  const fill3 = 0.25 + 0.25 * (0.5 + 0.5 * Math.sin(elapsed * 0.22 + 0.7));
  r._setFill(3, fill3);
}

// ── Mouse → reactor rainbow ─────────────────────────────────────────────────
window.addEventListener('mousemove', (e) => {
  const nx =  (e.clientX / window.innerWidth)  * 2 - 1;
  const ny = -((e.clientY / window.innerHeight) * 2 - 1);
  reactor.setMouse(nx, ny);
}, { passive: true });

// ── Resize ──────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(w, h);
  bloomPass.resolution.set(w, h);
});

// ── Animation loop ──────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const delta   = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  // Direct scroll camera — no snap, no lag
  _scrollProgress = window.scrollY / window.innerHeight;
  _updateCamera(_scrollProgress);
  _updateSectionUI(_scrollProgress);

  reactor.update(elapsed);
  rings.update(elapsed, delta);
  core.update(elapsed, delta);
  planet.update(elapsed, delta);
  nodes.update(elapsed, delta);
  dockerPlanet.update(elapsed, delta);

  _animateRings(elapsed);

  composer.render();
}

// ── Boot ─────────────────────────────────────────────────────────────────────
initPanels();
startServicePolling();
startDockerPolling();
animate();
