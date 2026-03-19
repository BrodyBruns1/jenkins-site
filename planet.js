/* ── JENKINS · planet.js ─────────────────────────────────────────────────── */

(function () {
  'use strict';

  const canvas = document.getElementById('planetCanvas');
  if (!canvas || typeof THREE === 'undefined') return;

  // ── Renderer ───────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  // ── Scene / Camera ─────────────────────────────────────────────────────────
  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0.4, 3.8);
  camera.lookAt(0, 0, 0);

  // ── Lights ─────────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.18));

  const keyLight = new THREE.PointLight(0xd0c8ff, 2.2, 20);
  keyLight.position.set(4, 5, 4);
  scene.add(keyLight);

  const rimLight = new THREE.PointLight(0x6040c0, 0.9, 12);
  rimLight.position.set(-3, -2, -3);
  scene.add(rimLight);

  // ── Planet ─────────────────────────────────────────────────────────────────
  const planetGeo = new THREE.SphereGeometry(1, 64, 64);
  const planetMat = new THREE.MeshStandardMaterial({
    color:     0x1a0e2e,
    emissive:  0x2a1045,
    emissiveIntensity: 0.35,
    roughness: 0.82,
    metalness: 0.12,
  });
  const planet = new THREE.Mesh(planetGeo, planetMat);
  scene.add(planet);

  // Atmosphere glow (slightly larger, additive transparent shell)
  const atmGeo = new THREE.SphereGeometry(1.04, 48, 48);
  const atmMat = new THREE.MeshBasicMaterial({
    color:       0x4422aa,
    transparent: true,
    opacity:     0.09,
    side:        THREE.BackSide,
  });
  scene.add(new THREE.Mesh(atmGeo, atmMat));

  // ── Rings ─────────────────────────────────────────────────────────────────
  const ringsGroup = new THREE.Group();
  ringsGroup.rotation.x = Math.PI * 0.40; // Saturn-like tilt

  // Helper: build a ring mesh with UV-corrected geometry
  function makeRing(innerR, outerR, color, opacity) {
    const geo = new THREE.RingGeometry(innerR, outerR, 128, 4);
    // Fix UVs so inner edge = 0, outer = 1 (for gradient later if needed)
    const pos  = geo.attributes.position;
    const uv   = geo.attributes.uv;
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

  const ring1 = makeRing(1.30, 1.92, 0xc8a85a, 0.40); // main dusty ring
  const ring2 = makeRing(1.14, 1.32, 0x9980cc, 0.22); // inner blue haze
  const ring3 = makeRing(1.93, 2.15, 0xa07838, 0.18); // outer faint ring

  ringsGroup.add(ring1, ring2, ring3);
  scene.add(ringsGroup);

  // ── Sizing ─────────────────────────────────────────────────────────────────
  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement);

  // ── Scroll state ───────────────────────────────────────────────────────────
  let scrollTarget = { ry: 0, rz: 0 };
  let scrollCurrent = { ry: 0, rz: 0 };

  window.addEventListener('scroll', () => {
    const maxScroll = document.body.scrollHeight - window.innerHeight;
    const frac = maxScroll > 0 ? Math.min(window.scrollY / maxScroll, 1) : 0;
    scrollTarget.ry = frac * Math.PI * 4;   // 2 full spins Y
    scrollTarget.rz = frac * Math.PI * 0.55; // tilt shift Z
  }, { passive: true });

  // ── Render loop ────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);

    const t = clock.getElapsedTime();

    // Idle planet spin
    planet.rotation.y = t * 0.08;

    // Lerp scroll rotation toward target
    const lerpK = 0.065;
    scrollCurrent.ry += (scrollTarget.ry - scrollCurrent.ry) * lerpK;
    scrollCurrent.rz += (scrollTarget.rz - scrollCurrent.rz) * lerpK;

    ringsGroup.rotation.y = scrollCurrent.ry;
    ringsGroup.rotation.z = scrollCurrent.rz;

    // Subtle idle ring wobble
    ringsGroup.rotation.x = Math.PI * 0.40 + Math.sin(t * 0.25) * 0.018;

    renderer.render(scene, camera);
  }

  animate();
})();
