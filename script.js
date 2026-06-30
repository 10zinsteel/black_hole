// ============================================================
// === IMPORTS
// ============================================================
import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';

// ============================================================
// === TUNABLE CONSTANTS  (easy to modify)
// ============================================================
const PARTICLE_COUNT       = 7000;
const EVENT_HORIZON_RADIUS = 0.50;  // black sphere radius
const DISK_INNER_RADIUS    = 0.58;  // inner edge of accretion disk
const DISK_OUTER_RADIUS    = 3.20;  // outer edge of accretion disk
const KEPLERIAN_K          = 0.78;  // angular speed at r=1 (rad/s)
const SPIRAL_RATE_MIN      = 0.005; // slowest inward drift (units/s)
const SPIRAL_RATE_MAX      = 0.025; // fastest inward drift (units/s)
const BLOOM_STRENGTH       = 1.9;
const BLOOM_RADIUS         = 0.85;
const BLOOM_THRESHOLD      = 0.10;
const LENSING_STRENGTH     = 0.0035;

// ============================================================
// === RENDERER
// ============================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// ============================================================
// === SCENE / CAMERA / CLOCK
// ============================================================
const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.01, 200
);
camera.position.set(0, 1.5, 5);
camera.lookAt(0, 0, 0);

const clock = new THREE.Clock();

// ============================================================
// === POST-PROCESSING PIPELINE
// ============================================================
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// Bloom — makes bright objects glow outward
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  BLOOM_STRENGTH,
  BLOOM_RADIUS,
  BLOOM_THRESHOLD
);
composer.addPass(bloomPass);

// Gravitational lensing — distorts pixels near the black hole outward,
// simulating how mass bends light paths around the shadow.
const lensingPass = new ShaderPass({
  uniforms: {
    tDiffuse:  { value: null },
    uCenter:   { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: LENSING_STRENGTH },
    uAspect:   { value: window.innerWidth / window.innerHeight }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  uCenter;
    uniform float uStrength;
    uniform float uAspect;
    varying vec2 vUv;

    void main() {
      vec2 uv    = vUv;
      vec2 delta = uv - uCenter;

      // Compute distance in aspect-correct physical space
      vec2 physDelta = vec2(delta.x * uAspect, delta.y);
      float dist = length(physDelta);

      if (dist < 0.001) {
        gl_FragColor = texture2D(tDiffuse, uv);
        return;
      }

      // Warp magnitude: stronger closer to center (1/d^2 falloff)
      float warp = uStrength / (dist * dist + 0.005);
      warp = clamp(warp, 0.0, 0.12);

      // Direction in UV space (undo aspect correction for the offset)
      vec2 dir = physDelta / dist;
      dir.x /= uAspect;

      gl_FragColor = texture2D(tDiffuse, uv + dir * warp);
    }
  `
});
composer.addPass(lensingPass);

// Correct tone mapping + sRGB gamma conversion for the final canvas output
composer.addPass(new OutputPass());

// ============================================================
// === STAR FIELD  (static background)
// ============================================================
(function createStarField() {
  const count     = 2000;
  const positions = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    // Uniform random points on a spherical shell
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 15 + Math.random() * 65;

    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    const b = 0.15 + Math.random() * 0.85;
    colors[i * 3] = b; colors[i * 3 + 1] = b; colors[i * 3 + 2] = b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.08,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    depthWrite: false
  })));
}());

// ============================================================
// === EVENT HORIZON  (perfectly black occluding sphere)
// ============================================================
const eventHorizon = new THREE.Mesh(
  new THREE.SphereGeometry(EVENT_HORIZON_RADIUS, 64, 64),
  new THREE.MeshBasicMaterial({ color: 0x000000 })
);
// Opaque mesh — Three.js always draws opaque objects before transparent ones,
// so this naturally occludes particles and disk fragments behind it via depth test.
scene.add(eventHorizon);

// ============================================================
// === ACCRETION DISK  (animated shader ring, flat in XZ plane)
// ============================================================
const diskVertSrc = /* glsl */`
  varying float vNorm; // 0 = inner edge, 1 = outer edge
  varying float vAngle;
  uniform float uInnerR;
  uniform float uOuterR;

  void main() {
    float r = length(position.xy); // RingGeometry lives in XY plane
    vNorm  = (r - uInnerR) / (uOuterR - uInnerR);
    vAngle = atan(position.y, position.x);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const diskFragSrc = /* glsl */`
  varying float vNorm;
  varying float vAngle;
  uniform float uTime;

  void main() {
    float t = vNorm;

    // Bright inner core, fading to dark outer rim
    float core = (1.0 - smoothstep(0.0, 0.10, t)) * 2.2;
    float glow = (1.0 - smoothstep(0.0, 0.65, t)) * 0.75;

    // Animated hot bands that rotate around the disk
    float shimmer = sin(vAngle * 6.0 + uTime * 0.40) * 0.14
                  + sin(vAngle * 13.0 - uTime * 0.65) * 0.07
                  + sin(vAngle * 2.5  + uTime * 0.15) * 0.05;
    shimmer *= (1.0 - t); // shimmer only visible near inner edge

    float brightness = core + glow + shimmer;
    float alpha      = (1.0 - smoothstep(0.55, 1.0, t))
                     * clamp(brightness * 0.65, 0.0, 1.0);

    gl_FragColor = vec4(vec3(brightness), alpha);
  }
`;

function makeDiskMaterial(innerR, outerR) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uInnerR: { value: innerR },
      uOuterR: { value: outerR },
      uTime:   { value: 0 }
    },
    vertexShader:   diskVertSrc,
    fragmentShader: diskFragSrc,
    side:       THREE.DoubleSide,
    transparent: true,
    blending:   THREE.AdditiveBlending,
    depthWrite: false
  });
}

// Main equatorial disk
const accretionDisk = new THREE.Mesh(
  new THREE.RingGeometry(DISK_INNER_RADIUS, DISK_OUTER_RADIUS, 160, 10),
  makeDiskMaterial(DISK_INNER_RADIUS, DISK_OUTER_RADIUS)
);
accretionDisk.rotation.x = -Math.PI / 2; // rotate XY ring into XZ plane
scene.add(accretionDisk);

// ============================================================
// === PHOTON RING  (several stacked bright tori)
// ============================================================
// Each torus is in the XY plane by default; rotate X by 90° to lay flat.
const photonRingConfigs = [
  { r: 0.520, tube: 0.009, opacity: 1.00 },  // innermost — brightest
  { r: 0.535, tube: 0.005, opacity: 0.80 },
  { r: 0.548, tube: 0.003, opacity: 0.55 },
  { r: 0.580, tube: 0.010, opacity: 0.22 },  // soft outer halo
];

for (const cfg of photonRingConfigs) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(cfg.r, cfg.tube, 16, 220),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: cfg.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  ring.rotation.x = Math.PI / 2; // lay flat in XZ plane
  scene.add(ring);
}

// ============================================================
// === BACK-DISK ARC  (lensed image of disk's far side, visible
//     above the shadow — a key Gargantua visual)
// ============================================================
// A thin bright ring floated above the equatorial plane mimics
// how light from the back of the disk bends up and over the shadow.
const backRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.545, 0.016, 16, 220),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
);
backRing.rotation.x = Math.PI / 2;
backRing.position.y = 0.18;
scene.add(backRing);

// ============================================================
// === PARTICLE SYSTEM  (orbiting accretion disk cloud)
// ============================================================
const pPositions    = new Float32Array(PARTICLE_COUNT * 3);
const pColors       = new Float32Array(PARTICLE_COUNT * 3);
const pRadii        = new Float32Array(PARTICLE_COUNT);
const pAngles       = new Float32Array(PARTICLE_COUNT);
const pHeights      = new Float32Array(PARTICLE_COUNT);
const pSpeeds       = new Float32Array(PARTICLE_COUNT);
const pSpiralRates  = new Float32Array(PARTICLE_COUNT);

// Set up a single particle at index i
function initParticle(i, r) {
  if (r === undefined) {
    // Slight √ bias so more particles exist toward the inner disk
    r = DISK_INNER_RADIUS + 0.1
      + Math.pow(Math.random(), 0.75) * (DISK_OUTER_RADIUS - DISK_INNER_RADIUS - 0.1);
  }
  pRadii[i]       = r;
  pAngles[i]      = Math.random() * Math.PI * 2;
  pHeights[i]     = (Math.random() - 0.5) * 0.06 * Math.sqrt(r); // thin disk scatter
  // Keplerian angular velocity: ω ∝ r^(-3/2)
  pSpeeds[i]      = KEPLERIAN_K / Math.pow(r, 1.5);
  pSpiralRates[i] = SPIRAL_RATE_MIN + Math.random() * (SPIRAL_RATE_MAX - SPIRAL_RATE_MIN);

  // Brightness: white near center, dim gray further out
  const normR = (r - DISK_INNER_RADIUS) / (DISK_OUTER_RADIUS - DISK_INNER_RADIUS);
  const b = 0.20 + (1.0 - normR) * 0.80;
  pColors[i * 3] = b; pColors[i * 3 + 1] = b; pColors[i * 3 + 2] = b;
}

// Initialize all particles with staggered radii for an immediate full disk
for (let i = 0; i < PARTICLE_COUNT; i++) {
  initParticle(i);
  // Write initial position
  pPositions[i * 3]     = pRadii[i] * Math.cos(pAngles[i]);
  pPositions[i * 3 + 1] = pHeights[i];
  pPositions[i * 3 + 2] = pRadii[i] * Math.sin(pAngles[i]);
}

const particleGeo = new THREE.BufferGeometry();
particleGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3).setUsage(THREE.DynamicDrawUsage));
particleGeo.setAttribute('color',    new THREE.BufferAttribute(pColors,    3).setUsage(THREE.DynamicDrawUsage));

const particleMat = new THREE.PointsMaterial({
  size: 0.016,
  sizeAttenuation: true,
  vertexColors: true,
  transparent: true,
  opacity: 0.88,
  blending: THREE.AdditiveBlending,
  depthWrite: false
});

scene.add(new THREE.Points(particleGeo, particleMat));

// Per-frame particle update — runs on CPU, writes to dynamic buffers
function updateParticles(dt) {
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Advance angle (Keplerian orbit)
    pAngles[i] += pSpeeds[i] * dt;

    // Slow inward spiral
    pRadii[i] -= pSpiralRates[i] * dt;

    // Respawn beyond the outer disk when swallowed by the horizon
    if (pRadii[i] < EVENT_HORIZON_RADIUS + 0.05) {
      const spawnR = DISK_OUTER_RADIUS * 0.65 + Math.random() * DISK_OUTER_RADIUS * 0.35;
      initParticle(i, spawnR);
    }

    // Write updated position into the buffer
    const x = pRadii[i] * Math.cos(pAngles[i]);
    const z = pRadii[i] * Math.sin(pAngles[i]);
    pPositions[i * 3]     = x;
    pPositions[i * 3 + 1] = pHeights[i];
    pPositions[i * 3 + 2] = z;
  }

  particleGeo.attributes.position.needsUpdate = true;
  particleGeo.attributes.color.needsUpdate    = true;
}

// ============================================================
// === ANIMATION LOOP
// ============================================================
function animate() {
  requestAnimationFrame(animate);

  const dt      = Math.min(clock.getDelta(), 0.05); // cap to avoid spiral on tab focus
  const elapsed = clock.elapsedTime;

  // --- Particle orbits
  updateParticles(dt);

  // --- Disk shimmer (drive the time uniform)
  accretionDisk.material.uniforms.uTime.value = elapsed;

  // --- Subtle slow camera drift — adds cinematic depth
  camera.position.x = Math.sin(elapsed * 0.05) * 0.28;
  camera.position.y = 1.5 + Math.cos(elapsed * 0.032) * 0.14;
  camera.lookAt(0, 0, 0);

  composer.render();
}

animate();

// ============================================================
// === RESIZE HANDLER
// ============================================================
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;

  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.resolution.set(w, h);
  lensingPass.uniforms.uAspect.value = w / h;
});
