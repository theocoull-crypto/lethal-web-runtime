import * as THREE from 'three';
import { AssetLib } from '../../loader.js';
import { Player } from '../../player.js';
import { SoundManager } from '../../audio.js';
import { createLowtideMoon, disposeLowtideMoon, updateLowtideMoon } from './lowtide-moon.mjs';
import { LOWTIDE_STATES } from './config.mjs';

const canvas = document.getElementById('lowtide-canvas');
const loading = document.getElementById('lowtide-loading');
const loadingText = document.getElementById('loading-text');
const loadingFill = document.getElementById('loading-fill');
const enterButton = document.getElementById('enter-preview');
const stateElement = document.getElementById('tide-state');
const waterElement = document.getElementById('water-level');
const tideCountElement = document.getElementById('tide-count');
const crateCountElement = document.getElementById('crate-count');
const clockElement = document.getElementById('clock-time');
const clockRateElement = document.getElementById('clock-rate');
const noticeElement = document.getElementById('lowtide-notice');
const contextElement = document.getElementById('lowtide-context');
const perfElement = document.getElementById('perf-stats');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, 1, 0.08, 1200);
scene.add(camera);
const clock = new THREE.Clock();
const sound = new SoundManager();
const assetLib = new AssetLib(renderer);

let moon = null;
let player = null;
let gameTime = 0;
let timeScale = 1;
let ready = false;
let noticeTimer = 0;
let hazardCooldown = 0;
let markerVisible = false;
let eyeDebugValue = false;
let surfHandle = null;
let reloadCount = 0;
let eventUnsubscribers = [];
const fpsSamples = [];

function showNotice(text, seconds = 3) {
  noticeElement.textContent = text;
  noticeElement.classList.add('visible');
  noticeTimer = seconds;
}

function updateLoading(text, percent) {
  loadingText.textContent = text;
  loadingFill.style.width = `${Math.max(6, Math.min(100, percent))}%`;
}

function resize() {
  const width = innerWidth; const height = innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

function formatClock(seconds) {
  const config = moon?.config;
  if (!config) return '8:00 AM';
  const fraction = Math.max(0, Math.min(1, seconds / config.daySeconds));
  let hour = config.startHour + (config.endHour - config.startHour) * fraction;
  const minutes = Math.floor((hour % 1) * 60 / 5) * 5;
  hour = Math.floor(hour);
  const suffix = hour >= 12 && hour < 24 ? 'PM' : 'AM';
  const displayHour = hour === 24 ? 12 : (hour % 12 || 12);
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function createProceduralSurf() {
  sound.ensure();
  const context = sound.ctx;
  const length = context.sampleRate * 5;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let brown = 0;
  for (let index = 0; index < length; index++) {
    brown = (brown + (Math.random() * 2 - 1) * 0.035) * 0.992;
    const swell = 0.32 + Math.pow(Math.max(0, Math.sin(index / context.sampleRate * Math.PI * 0.32)), 2) * 0.68;
    data[index] = Math.max(-1, Math.min(1, brown * swell));
  }
  const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
  const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 720; filter.Q.value = 0.7;
  const gain = context.createGain(); gain.gain.value = 0.17;
  source.connect(filter); filter.connect(gain); gain.connect(sound.master); source.start();
  return { stop: () => { try { source.stop(); } catch {} } };
}

function resetPlayer(reason = '') {
  if (!player || !moon) return;
  const spawn = moon.config.transforms.playerSpawn;
  player.attachTo(null); player.teleport(new THREE.Vector3(...spawn.position), spawn.yaw);
  player.health = 100; player.dead = false; hazardCooldown = 1;
  if (reason) showNotice(`SUIT RECOVERED TO SHIP // ${reason.toUpperCase()}`, 3.4);
}

function bindMoonEvents() {
  eventUnsubscribers.forEach(unsubscribe => unsubscribe()); eventUnsubscribers = [];
  eventUnsubscribers.push(
    moon.on('tide-warning', event => showNotice(`PLATFORM HORN // TIDE ${event.tideIndex + 1} RETURNING`, 4)),
    moon.on('creature-breath', event => { if (!event.manual) showNotice('SEISMIC DISPLACEMENT // ALL OUTSIDE SOUND EXPOSED', 4.5); }),
    moon.on('eye-watch', event => { if (event.watching) showNotice('OPTICAL MOVEMENT DETECTED', 4); }),
    moon.on('objects-removed', event => showNotice(`${event.ids.length} DROPPED OBJECT${event.ids.length === 1 ? '' : 'S'} LOST TO TIDE`, 4)),
    moon.on('tide-withdrawn', event => showNotice(`TIDE WITHDRAWN // POOL LAYOUT ${event.poolVariant + 1}`, 3)),
  );
}

async function createMoon() {
  updateLoading('GENERATING EXPOSED SEABED...', 34);
  moon = await createLowtideMoon({ scene, renderer, assetLib, sound });
  updateLoading('BUILDING COLLISION AND TIDE VOLUMES...', 76);
  bindMoonEvents();
  if (player) resetPlayer();
  moon.setDebugVisible(markerVisible);
  return moon;
}

const game = {
  renderer,
  camera,
  wantsLock: false,
  onKey(code, down) {
    if (!down || !ready) return;
    if (code === 'KeyR') resetPlayer();
    else if (code === 'KeyT') toggleSpeed();
    else if (code === 'KeyB') moon.triggerBreath();
    else if (code === 'KeyM') toggleMarkers();
    else if (code === 'KeyO') toggleEye();
    else if (code === 'KeyP') dropTestObject();
    else if (code === 'KeyL') reloadMoon();
    else if (/^Digit[1-6]$/.test(code)) forceState(LOWTIDE_STATES[Number(code.at(-1)) - 1]);
  },
  onMouse() {},
  onWheel() {},
  onLockChange(locked) {
    document.body.classList.toggle('mouse-free', !locked);
    if (!locked && ready) showNotice('MOUSE RELEASED // CLICK THE WORLD TO CONTINUE', 2.2);
  },
  onJump() {},
  onLand(speed) { if (speed < -7 && moon) moon.playFootstep(moon.surfaceAt(player.pos), player.pos.clone()); },
  onFootstep() { if (moon) moon.playFootstep(moon.surfaceAt(player.pos), player.pos.clone()); },
  onDamage() {},
  onDeath() { resetPlayer('fatal terrain'); },
  onLadder() {},
  onLadderStep() {},
};

function toggleSpeed() {
  timeScale = timeScale === 1 ? 25 : 1;
  clockRateElement.textContent = `${timeScale}×`;
  document.getElementById('toggle-speed').classList.toggle('active', timeScale > 1);
  showNotice(timeScale > 1 ? 'ACCELERATED TIDE CLOCK ENABLED' : 'NORMAL DAY CLOCK RESTORED', 2.4);
}

function forceState(state) {
  if (!moon) return;
  moon.forceTideState(state);
  document.querySelectorAll('[data-state]').forEach(button => button.classList.toggle('active', button.dataset.state === state));
  showNotice(`DEBUG TIDE STATE // ${state.toUpperCase()}`, 2.2);
}

function resumeTimeline() {
  moon.resumeTideTimeline();
  document.querySelectorAll('[data-state]').forEach(button => button.classList.remove('active'));
  showNotice('TIDE RETURNED TO DAY CLOCK', 2.2);
}

function toggleMarkers() {
  markerVisible = !markerVisible; moon.setDebugVisible(markerVisible);
  document.getElementById('toggle-markers').classList.toggle('active', markerVisible);
  showNotice(markerVisible ? 'ROUTES, SPAWNS, AND CLEANUP VOLUMES VISIBLE' : 'DEVELOPMENT MARKERS HIDDEN', 2.5);
}

function toggleEye() {
  eyeDebugValue = !eyeDebugValue; moon.setEyeWatching(eyeDebugValue);
  document.getElementById('toggle-eye').classList.toggle('active', eyeDebugValue);
  showNotice(eyeDebugValue ? 'EYE SET TO POST-SECOND-TIDE POSITION' : 'EYE RESET TO LIFELESS POSITION', 2.6);
}

function dropTestObject() {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
  const point = player.pos.clone().addScaledVector(forward, 2.5); point.y += 1.2;
  moon.spawnTestObject(point, `DROPPED ${moon.testObjects.length + 1}`);
  showNotice('FLOOD-CLEANUP TEST OBJECT DROPPED', 2);
}

async function reloadMoon() {
  if (!moon || !ready) return;
  ready = false; const audioWasEnabled = moon.audioEnabled;
  updateLoading('DISPOSING LOWTIDE RESOURCES...', 20); loading.classList.remove('hidden'); enterButton.disabled = true;
  eventUnsubscribers.forEach(unsubscribe => unsubscribe()); eventUnsubscribers = [];
  await disposeLowtideMoon(moon); moon = null;
  updateLoading('RELOADING ISOLATED EXTERIOR...', 46);
  await createMoon(); reloadCount++;
  if (audioWasEnabled) moon.enableAudio();
  updateLoading(`RELOAD ${reloadCount} VERIFIED`, 100);
  ready = true; loading.classList.add('hidden'); enterButton.disabled = false;
  showNotice(`LOWTIDE RELOADED // PASS ${reloadCount}`, 3);
}

function faceTarget(position, target) {
  const delta = target.clone().sub(position);
  player.yaw = Math.atan2(-delta.x, -delta.z);
  player.pitch = -Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
  player.pos.copy(position); player.vel.set(0, 0, 0); player.attachTo(null);
}

const cameraPresets = {
  ship: { position: [1, 3.1, 201], target: [0, 22, -165] },
  flats: { position: [3, 2.9, 74], target: [0, 30, -166] },
  chain: { position: [-114, 12.8, 165], target: [-79, 16, 56] },
  gullet: { position: [111, 5.1, -169], target: [61, 7.5, -170] },
  platform: { position: [15, 41.8, -145], target: [0, 46.2, -159] },
  highTide: { position: [1, 41.8, -151], target: [0, 5, 45] },
  eye: { position: [29, 15, -101], target: [31, 15.5, -128] },
};

function teleportPreset(name) {
  const preset = cameraPresets[name];
  if (!preset || !player) throw new Error(`Unknown LOWTIDE camera preset: ${name}`);
  faceTarget(new THREE.Vector3(...preset.position), new THREE.Vector3(...preset.target));
  return { name, position: [...preset.position], target: [...preset.target] };
}

function applyUrlPreviewMode() {
  const params = new URLSearchParams(location.search);
  const state = params.get('state');
  const view = params.get('view');
  if (state && LOWTIDE_STATES.includes(state)) forceState(state);
  if (params.get('eye') === '1') { eyeDebugValue = true; moon.setEyeWatching(true); }
  if (view && cameraPresets[view]) teleportPreset(view);
  if (params.get('hud') === '0') { document.body.classList.add('capture-clean'); moon.testObjectRoot.visible = false; }
  if (params.get('autostart') === '1') loading.classList.add('hidden');
}

function updateContext() {
  if (!moon || !player) return;
  const lift = moon.breathRoot.position.y;
  const main = new THREE.Vector3(...moon.config.transforms.mainEntrance.position); main.y += lift;
  const fire = new THREE.Vector3(...moon.config.transforms.fireExit.position); fire.y += lift;
  let text = '';
  if (player.pos.distanceTo(main) < 8) text = 'MAIN ENTRANCE SEALED // EXTERIOR PROTOTYPE';
  else if (player.pos.distanceTo(fire) < 8) text = 'FIRE EXIT SEALED // EXTERIOR PROTOTYPE';
  else if (moon.surfaceAt(player.pos) === 'chain') text = 'ANCHOR CHAIN // TWO-HANDED TURNING RESTRICTED';
  contextElement.textContent = text; contextElement.classList.toggle('visible', !!text);
}

function updateHud(snapshot, dt) {
  stateElement.textContent = snapshot.state.toUpperCase();
  waterElement.textContent = `${snapshot.waterLevel.toFixed(1)} M`;
  tideCountElement.textContent = `${snapshot.completedTides} / ${moon.config.tide.schedule.length}`;
  crateCountElement.textContent = String(moon.testObjects.length);
  clockElement.textContent = formatClock(gameTime);
  document.body.classList.toggle('tide-warning', snapshot.state === 'warning');
  if (noticeTimer > 0) {
    noticeTimer -= dt;
    if (noticeTimer <= 0) noticeElement.classList.remove('visible');
  }
  updateContext();
}

function updatePerformance(dt) {
  if (dt > 0) fpsSamples.push(1 / dt);
  if (fpsSamples.length > 45) fpsSamples.shift();
  if (!moon || performance.now() % 300 > 20) return;
  const fps = fpsSamples.length ? Math.round(fpsSamples.reduce((sum, value) => sum + value, 0) / fpsSamples.length) : 0;
  const info = renderer.info;
  perfElement.textContent = `FPS ${fps}  RELOADS ${reloadCount}\nDRAW ${info.render.calls}  TRI ${Math.round(info.render.triangles / 1000)}K\nGEO ${info.memory.geometries}  TEX ${info.memory.textures}\nPOS ${player.pos.x.toFixed(0)}, ${player.pos.y.toFixed(1)}, ${player.pos.z.toFixed(0)}`;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  if (ready && moon && player) {
    gameTime = Math.min(moon.config.daySeconds, gameTime + dt * timeScale);
    const snapshot = updateLowtideMoon(moon, dt, gameTime);
    player.update(dt, moon.colliders);
    const standingOnCreature = player.groundCollider === moon.dynamicCollider;
    player.attachTo(standingOnCreature ? moon.breathRoot : null);
    if (hazardCooldown > 0) hazardCooldown -= dt;
    const hazard = moon.checkPlayerHazard(player.pos);
    if (hazard && hazardCooldown <= 0) {
      document.body.classList.add('hazard'); moon.playSplash(player.pos.clone());
      resetPlayer(hazard.replaceAll('-', ' '));
      setTimeout(() => document.body.classList.remove('hazard'), 420);
    }
    updateHud(snapshot, dt);
  }
  renderer.render(scene, camera);
  updatePerformance(dt);
}

document.getElementById('toggle-speed').addEventListener('click', toggleSpeed);
document.getElementById('resume-timeline').addEventListener('click', resumeTimeline);
document.querySelectorAll('[data-state]').forEach(button => button.addEventListener('click', () => forceState(button.dataset.state)));
document.getElementById('trigger-breath').addEventListener('click', () => moon.triggerBreath());
document.getElementById('toggle-eye').addEventListener('click', toggleEye);
document.getElementById('toggle-markers').addEventListener('click', toggleMarkers);
document.getElementById('spawn-crate').addEventListener('click', dropTestObject);
document.getElementById('reset-player').addEventListener('click', () => resetPlayer());
document.getElementById('reload-moon').addEventListener('click', reloadMoon);
document.getElementById('debug-collapse').addEventListener('click', () => {
  const panel = document.getElementById('lowtide-debug'); panel.classList.toggle('collapsed');
  document.getElementById('debug-collapse').setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
});

enterButton.addEventListener('click', () => {
  if (!ready) return;
  loading.classList.add('hidden'); game.wantsLock = true; moon.enableAudio();
  if (!surfHandle) surfHandle = createProceduralSurf();
  player.lock(); showNotice('SURVEY STARTED // THREE ROUTES // WATCH THE HORN', 4);
});

async function boot() {
  try {
    updateLoading('READING BUNDLED LETHAL COMPANY ASSETS...', 12);
    assetLib.onProgress = (loaded, total) => updateLoading(`STREAMING ASSETS ${loaded} / ${Math.max(loaded, total)}`, 12 + loaded / Math.max(1, total) * 56);
    await assetLib.init();
    updateLoading('ASSEMBLING 14—LOWTIDE...', 27);
    await createMoon();
    player = new Player(game); player.radius = 0.4; player.standHeight = 2.5; player.crouchHeight = 1.5;
    resetPlayer();
    assetLib.onProgress = null;
    updateLoading('EXTERIOR READY // FACILITY REMAINS SEALED', 100);
    enterButton.disabled = false; ready = true;
    applyUrlPreviewMode();
    window.LOWTIDE_PREVIEW = {
      get ready() { return ready; },
      get moon() { return moon; },
      get player() { return player; },
      get state() { return moon?.simulation.getSnapshot(); },
      forceState,
      resumeTimeline,
      teleportPreset,
      cameraPresets,
      resetPlayer,
      reloadMoon,
      getMetrics: () => ({ ...renderer.info.render, ...renderer.info.memory, testObjects: moon.testObjects.length, reloadCount }),
    };
  } catch (error) {
    console.error(error);
    updateLoading(`FAILED: ${error.message}`, 100);
    enterButton.textContent = 'PREVIEW FAILED';
  }
}

addEventListener('beforeunload', () => {
  eventUnsubscribers.forEach(unsubscribe => unsubscribe());
  if (surfHandle) surfHandle.stop();
  if (moon) disposeLowtideMoon(moon);
});

animate();
boot();
