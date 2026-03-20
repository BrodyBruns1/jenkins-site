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
    this._speechLevel = 0.0;
    this._speechEnergy = 0.0;
    this._responseEnergy = 0.0;
    this._drift = new THREE.Vector3();
    this._liveRibbonEntries = [];
    this._liveRibbonTravel = 0.0;
    this._liveRibbonSpawnCooldown = 0.0;
    this._liveRibbonNeedsRedraw = true;
    this._liveRibbonBuffer = [];
    this._liveRibbonLastSpawnTravel = 0.0;
    this._liveRibbonWordHW = 0;
    this._liveRibbonLastFullText = '';
    this._liveRibbonUtteranceEnded = false;
    this._liveRibbonFullTurn = Math.PI * 2;
    this._liveRibbonRadius = 2.72;
    this._responseWordSprites = [];
    this._glyphSprites = [];
    this._responseTextAge = 999;
    this._glyphEmitCooldown = 0;
    this._nextGlyphIndex = 0;
    this._glyphStream = '';

    this._buildCore();
    this._buildWireframes();
    this._buildSpeechField();
    this._buildResponseText();
    this._buildLight();
  }

  setFade(fade) {
    this._fade = THREE.MathUtils.clamp(fade, 0, 1);
  }

  setSpeechActivity({ level = 0, speaking = false } = {}) {
    const target = THREE.MathUtils.clamp(level || 0, 0, 1);
    this._speechLevel = speaking ? Math.max(target, 0.08) : target * 0.35;
    if (!speaking) {
      // Flush any remaining words from the last partial before marking end
      this._flushRemainingWords();
      this._liveRibbonUtteranceEnded = true;
    }
  }

  triggerResponsePulse(strength = 1, text = '') {
    this._responseEnergy = Math.max(this._responseEnergy, THREE.MathUtils.clamp(strength, 0, 3));
    void text;
  }

  _bufferText(text) {
    for (const char of text) {
      const g = char === '\n' ? ' ' : char;
      if (!g) continue;
      const arcLength = g === ' ' ? 0.13 : (g === '.' || g === ',' ? 0.11 : 0.165);
      this._liveRibbonBuffer.push({ char: g, arcLength, isSpace: !g.trim() });
    }
  }

  _flushRemainingWords() {
    const full = this._liveRibbonLastFullText;
    if (!full) return;
    const words = full.split(/\s+/).filter(w => w);
    if (words.length <= this._liveRibbonWordHW) return;
    const prev = this._liveRibbonWordHW;
    this._liveRibbonWordHW = words.length;
    const text = (prev > 0 ? ' ' : '') + words.slice(prev).join(' ');
    console.log('[holoCore] FLUSH words=%o whw=%d', text, this._liveRibbonWordHW);
    this._bufferText(text);
  }

  streamLiveTranscript(fullText = '') {
    const full = String(fullText || '').replace(/\s+/g, ' ').trim();
    if (!full) return;

    // New utterance after a stop/silence — reset word high-water
    if (this._liveRibbonUtteranceEnded) {
      this._liveRibbonWordHW = 0;
      this._liveRibbonUtteranceEnded = false;
    }

    this._liveRibbonLastFullText = full;

    // Split into words; only emit words past the high-water mark.
    // STT corrections that rewrite existing words are ignored (already on ring).
    // Only genuinely new words (higher count) get buffered.
    const words = full.split(/\s+/).filter(w => w);
    if (words.length <= this._liveRibbonWordHW) return;

    const prev = this._liveRibbonWordHW;
    this._liveRibbonWordHW = words.length;
    const newWords = words.slice(prev);
    const text = (prev > 0 ? ' ' : '') + newWords.join(' ');

    console.log('[holoCore] ACCEPT words=%o whw=%d full=%o bufLen=%d',
      text, this._liveRibbonWordHW, full, this._liveRibbonBuffer.length);

    this._bufferText(text);
  }

  getGlyphCollisionBursts(limit = 6) {
    const collisions = [];
    for (let i = 0; i < this._glyphSprites.length; i++) {
      const glyph = this._glyphSprites[i];
      const distance = glyph.position.length();
      if (distance < 4.8 || distance > 18.5) continue;

      const lifeNorm = glyph.userData.maxLife > 0
        ? glyph.userData.life / glyph.userData.maxLife
        : 0;
      const shellBias = 1 - Math.min(Math.abs(distance - 9.5) / 7.5, 1);
      const strength = Math.max(0, lifeNorm * shellBias);
      if (strength < 0.16) continue;

      collisions.push({
        position: glyph.position.clone(),
        strength,
      });
      if (collisions.length >= limit) break;
    }
    return collisions;
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

  _buildSpeechField() {
    const haloGeo = new THREE.TorusGeometry(2.7, 0.028, 18, 180);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x4cbcff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._speechHalo = new THREE.Mesh(haloGeo, haloMat);
    this._speechHalo.rotation.x = Math.PI * 0.62;
    this._speechHalo.rotation.y = Math.PI * 0.12;
    this._group.add(this._speechHalo);

    const fieldGeo = new THREE.TorusGeometry(3.45, 0.02, 16, 220);
    const fieldMat = new THREE.MeshBasicMaterial({
      color: 0x7ce0ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._gravityField = new THREE.Mesh(fieldGeo, fieldMat);
    this._gravityField.rotation.x = Math.PI * 0.24;
    this._gravityField.rotation.z = Math.PI * 0.31;
    this._group.add(this._gravityField);
  }

  _buildResponseText() {
    const ribbonCanvas = document.createElement('canvas');
    ribbonCanvas.width = 4096;
    ribbonCanvas.height = 320;
    this._liveRibbonCanvas = ribbonCanvas;
    this._liveRibbonContext = ribbonCanvas.getContext('2d');
    this._liveRibbonTexture = new THREE.CanvasTexture(ribbonCanvas);
    this._liveRibbonTexture.needsUpdate = true;
    this._liveRibbonTexture.wrapS = THREE.RepeatWrapping;
    this._liveRibbonTexture.wrapT = THREE.ClampToEdgeWrapping;
    this._liveRibbonTexture.repeat.x = 1;
    this._liveRibbonTexture.offset.x = 0;

    const ribbonGeo = new THREE.TorusGeometry(this._liveRibbonRadius, 0.16, 26, 420);
    const ribbonMat = new THREE.MeshBasicMaterial({
      map: this._liveRibbonTexture,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._liveRibbonMesh = new THREE.Mesh(ribbonGeo, ribbonMat);
    this._liveRibbonMesh.rotation.copy(this._speechHalo.rotation);
    this._group.add(this._liveRibbonMesh);

    this._responseTextGroup = new THREE.Group();
    this._responseTextGroup.rotation.copy(this._speechHalo.rotation);
    this._group.add(this._responseTextGroup);

    this._glyphGroup = new THREE.Group();
    this._group.add(this._glyphGroup);
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

  _setResponseText(text) {
    this._clearCompletionText();

    const words = text.trim().split(/\s+/).slice(0, 12);
    if (!words.length) return;

    const radius = 3.0;
    words.forEach((word, idx) => {
      const sprite = this._makeTextSprite(word, idx === 0 ? 1.0 : 0.86);
      const angle = (idx / Math.max(words.length, 1)) * Math.PI * 2;
      sprite.userData.baseAngle = angle;
      sprite.userData.radius = radius;
      sprite.userData.revealAt = idx * 0.12;
      sprite.userData.offset = idx * 0.3;
      sprite.material.opacity = 0;
      this._responseTextGroup.add(sprite);
      this._responseWordSprites.push(sprite);
    });

    this._responseTextAge = 0;
    this._glyphEmitCooldown = 0;
    this._nextGlyphIndex = 0;
    this._glyphStream = words.join(' ');
  }

  _clearCompletionText() {
    for (const sprite of this._responseWordSprites) {
      sprite.material.map?.dispose?.();
      sprite.material.dispose();
      sprite.removeFromParent();
    }
    this._responseWordSprites = [];

    for (const glyph of this._glyphSprites) {
      glyph.material.map?.dispose?.();
      glyph.material.dispose();
      glyph.removeFromParent();
    }
    this._glyphSprites = [];
  }

  _drawLiveRibbon(opacity = 0) {
    const ctx = this._liveRibbonContext;
    const canvas = this._liveRibbonCanvas;
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this._liveRibbonEntries.length || opacity <= 0.01) {
      this._liveRibbonTexture.needsUpdate = true;
      return;
    }

    const bandHeight = 92;
    const centerY = canvas.height * 0.16;
    const bandTop = centerY - bandHeight * 0.5;
    const bandBottom = centerY + bandHeight * 0.5;
    const grad = ctx.createLinearGradient(0, bandTop, 0, bandBottom);
    grad.addColorStop(0, 'rgba(14, 42, 92, 0.00)');
    grad.addColorStop(0.12, `rgba(52, 138, 255, ${0.11 * opacity})`);
    grad.addColorStop(0.50, `rgba(128, 235, 255, ${0.18 * opacity})`);
    grad.addColorStop(0.88, `rgba(52, 138, 255, ${0.11 * opacity})`);
    grad.addColorStop(1, 'rgba(14, 42, 92, 0.00)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, bandTop, canvas.width, bandBottom - bandTop);

    ctx.strokeStyle = `rgba(176, 245, 255, ${0.18 * opacity})`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, bandTop + 6);
    ctx.lineTo(canvas.width, bandTop + 6);
    ctx.moveTo(0, bandBottom - 6);
    ctx.lineTo(canvas.width, bandBottom - 6);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 84px "Courier New", monospace';
    ctx.shadowColor = 'rgba(148, 235, 255, 0.55)';
    ctx.shadowBlur = 9;
    ctx.lineWidth = 2.6;

    for (const entry of this._liveRibbonEntries) {
      const travel = this._liveRibbonTravel - entry.travelAtBirth;
      const norm = travel / this._liveRibbonFullTurn;
      if (norm < 0 || norm > 1) continue;

      const x = norm * canvas.width;
      const life = 1 - norm;
      const charOpacity = opacity * (entry.isSpace ? 0.04 : 0.96) * (0.76 + 0.18 * Math.pow(life, 0.72));
      if (charOpacity <= 0.01) continue;

      ctx.strokeStyle = `rgba(8, 32, 72, ${charOpacity * 0.52})`;
      ctx.fillStyle = `rgba(240, 250, 255, ${charOpacity})`;
      ctx.save();
      ctx.translate(x, centerY);
      ctx.scale(-1, -1);
      if (!entry.isSpace) {
        ctx.strokeText(entry.char, 0, 0);
      }
      ctx.fillText(entry.char, 0, 0);
      ctx.restore();
    }

    this._liveRibbonTexture.needsUpdate = true;
    this._liveRibbonNeedsRedraw = false;
  }

  _spawnGlyphFromRibbon(entry) {
    if (!entry || entry.isSpace) return;

    const glyph = this._makeTextSprite(entry.char, 0.42);
    glyph.scale.set(0.38, 0.38, 1);

    const travel = this._liveRibbonTravel - entry.travelAtBirth;
    const angle = -travel;
    const local = new THREE.Vector3(
      Math.cos(angle) * this._liveRibbonRadius,
      Math.sin(angle) * this._liveRibbonRadius,
      0
    );
    const source = local.applyQuaternion(this._liveRibbonMesh.quaternion);
    glyph.position.copy(source);

    const tangent = new THREE.Vector3(-source.y, source.x, 0).normalize();
    const radial = source.clone().normalize();
    glyph.userData.velocity = tangent.multiplyScalar(0.95 + Math.random() * 0.65)
      .add(radial.multiplyScalar(0.46 + Math.random() * 0.34))
      .add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.16,
        (Math.random() - 0.5) * 0.16,
        (Math.random() - 0.5) * 0.12
      ));
    glyph.userData.life = 1.75 + Math.random() * 0.95;
    glyph.userData.maxLife = glyph.userData.life;
    this._glyphGroup.add(glyph);
    this._glyphSprites.push(glyph);
  }

  _makeTextSprite(text, scale = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `600 ${72 * scale}px "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(210, 238, 255, 0.96)';
    ctx.shadowColor = 'rgba(72, 196, 255, 0.8)';
    ctx.shadowBlur = 20;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2.25 * scale, 0.7 * scale, 1);
    sprite.userData.baseScaleX = 2.25 * scale;
    sprite.userData.baseScaleY = 0.7 * scale;
    return sprite;
  }

  _spawnGlyphFromWord(wordSprite) {
    if (!this._glyphStream) return;

    const glyphChar = this._glyphStream[this._nextGlyphIndex % this._glyphStream.length];
    this._nextGlyphIndex += 1;
    if (!glyphChar.trim()) return;

    const glyph = this._makeTextSprite(glyphChar, 0.44);
    glyph.scale.set(0.42, 0.42, 1);

    const source = wordSprite.position.clone().applyQuaternion(this._responseTextGroup.quaternion);
    glyph.position.copy(source);

    const tangent = new THREE.Vector3(-source.y, source.x, 0).normalize();
    const radial = source.clone().normalize();
    glyph.userData.velocity = radial.multiplyScalar(1.2 + Math.random() * 0.9)
      .add(tangent.multiplyScalar((Math.random() - 0.5) * 0.9))
      .add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.25
      ));
    glyph.userData.life = 1.35 + Math.random() * 0.7;
    glyph.userData.maxLife = glyph.userData.life;
    this._glyphGroup.add(glyph);
    this._glyphSprites.push(glyph);
  }

  // ── Per-frame ────────────────────────────────────────────────────────

  update(elapsed, _delta) {
    // Fade in over 3 s
    const fade = Math.min(elapsed / 3.0, 1.0) * this._fade;
    this._speechLevel *= 0.92;
    this._speechEnergy += (this._speechLevel - this._speechEnergy) * 0.10;
    this._responseEnergy += (0 - this._responseEnergy) * 0.03;
    this._liveRibbonTravel += _delta * (0.615 + this._speechEnergy * 0.39);

    // Drip buffered characters onto the ring — only place the next character
    // once the ring has scrolled far enough to fit the previous one's width.
    while (this._liveRibbonBuffer.length > 0) {
      const g = this._liveRibbonBuffer[0];
      const needed = g.arcLength * 0.55;
      if (this._liveRibbonTravel - this._liveRibbonLastSpawnTravel < needed) break;
      this._liveRibbonBuffer.shift();
      this._liveRibbonEntries.push({
        char: g.char,
        travelAtBirth: this._liveRibbonTravel,
        arcLength: g.arcLength,
        isSpace: g.isSpace,
      });
      this._liveRibbonLastSpawnTravel = this._liveRibbonTravel;
      this._liveRibbonNeedsRedraw = true;
    }

    this._liveRibbonSpawnCooldown -= _delta;
    this._responseTextAge += _delta;
    this._glyphEmitCooldown -= _delta;
    const speakingPulse = this._speechEnergy * (0.55 + 0.45 * Math.sin(elapsed * 8.0));
    const responsePulse = this._responseEnergy * (0.82 + 0.42 * Math.sin(elapsed * 6.2));
    const totalPulse = speakingPulse + responsePulse;

    // Core shader uniforms
    const u = this._coreMesh.material.uniforms;
    u.uTime.value  = elapsed;
    u.uAlpha.value = fade;
    const coreScale = 1 + totalPulse * 0.18 + responsePulse * 0.14;
    this._coreMesh.scale.setScalar(coreScale);

    // Wireframe rotations
    this._octWire.rotation.x = -elapsed * 0.18;
    this._octWire.rotation.z =  elapsed * 0.12;
    this._octWire.material.opacity = fade * (0.16 + 0.08 * Math.sin(elapsed * 0.9 + 1) + totalPulse * 0.22);

    this._icoWire.rotation.x = elapsed * 0.10;
    this._icoWire.rotation.y = elapsed * 0.07;
    this._icoWire.material.opacity = fade * (0.20 + 0.10 * Math.sin(elapsed * 0.7) + totalPulse * 0.26);

    this._dodWire.rotation.y =  elapsed * 0.035;
    this._dodWire.rotation.z = -elapsed * 0.025;
    this._dodWire.material.opacity = fade * (0.09 + 0.05 * Math.sin(elapsed * 0.5 + 2) + totalPulse * 0.18);

    this._speechHalo.rotation.z = elapsed * 0.18;
    this._speechHalo.scale.setScalar(1 + speakingPulse * 0.18 + responsePulse * 0.22);
    this._speechHalo.material.opacity = fade * (0.03 + speakingPulse * 0.55 + responsePulse * 0.34);

    this._gravityField.rotation.y = -elapsed * 0.12;
    this._gravityField.scale.setScalar(1 + speakingPulse * 0.26 + responsePulse * 0.28);
    this._gravityField.material.opacity = fade * (0.02 + speakingPulse * 0.38 + responsePulse * 0.22);
    this._liveRibbonMesh.rotation.z = -elapsed * 0.055;
    this._liveRibbonMesh.scale.setScalar(1 + speakingPulse * 0.045 + responsePulse * 0.035);
    this._liveRibbonMesh.material.opacity = fade * (0.26 + this._speechEnergy * 0.18 + responsePulse * 0.05);
    for (let i = this._liveRibbonEntries.length - 1; i >= 0; i--) {
      const entry = this._liveRibbonEntries[i];
      const traveled = this._liveRibbonTravel - entry.travelAtBirth;
      if (traveled > this._liveRibbonFullTurn) {
        this._liveRibbonEntries.splice(i, 1);
        this._liveRibbonNeedsRedraw = true;
        continue;
      }

      const lifeNorm = 1 - traveled / this._liveRibbonFullTurn;
      if (!entry.isSpace && this._speechEnergy > 0.10 && lifeNorm > 0.18 && lifeNorm < 0.92 && this._liveRibbonSpawnCooldown <= 0) {
        this._spawnGlyphFromRibbon(entry);
        const density = THREE.MathUtils.clamp((this._speechEnergy - 0.06) / 0.38, 0, 1);
        this._liveRibbonSpawnCooldown = THREE.MathUtils.lerp(0.05, 0.010, density);
      }
    }
    if (this._liveRibbonNeedsRedraw || this._liveRibbonEntries.length || this._speechEnergy > 0.02) {
      this._drawLiveRibbon(fade * (0.34 + this._speechEnergy * 0.12));
    }

    for (let i = this._glyphSprites.length - 1; i >= 0; i--) {
      const glyph = this._glyphSprites[i];
      glyph.userData.life -= _delta;
      if (glyph.userData.life <= 0) {
        glyph.material.map?.dispose?.();
        glyph.material.dispose();
        glyph.removeFromParent();
        this._glyphSprites.splice(i, 1);
        continue;
      }
      glyph.position.addScaledVector(glyph.userData.velocity, _delta);
      const lifeNorm = glyph.userData.life / glyph.userData.maxLife;
      glyph.material.opacity = fade * lifeNorm * 1.05;
      glyph.scale.setScalar(0.26 + lifeNorm * 0.36);
    }

    this._drift.set(
      Math.sin(elapsed * 2.1) * responsePulse * 0.34,
      Math.cos(elapsed * 2.6) * responsePulse * 0.28,
      Math.sin(elapsed * 1.7) * responsePulse * 0.18
    );
    this._group.position.copy(this._drift);

    // Pulsing light
    this._light.intensity = fade * (1.2 + 0.6 * Math.sin(elapsed * 1.5) + totalPulse * 1.5 + responsePulse * 1.2);
  }
}
