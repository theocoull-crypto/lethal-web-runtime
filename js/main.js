// LETHAL WEB - game orchestration.
import * as THREE from 'three';
import { AssetLib } from './loader.js';
import { World } from './world.js';
import { Player } from './player.js?v=20260911-2';
import { HUD } from './hud.js';
import { SoundManager, pickClip } from './audio.js';
import { Dungeon } from './dungeon.js';
import { Items } from './items.js';
import { Enemies } from './enemies.js';
import { LightPool } from './lights.js';
import { Terminal } from './terminal.js?v=20260911-2';
import { Settings } from './settings.js?v=20260911-2';
import { DebugMenu } from './debug.js?v=20260911-2';
import { Decor } from './decor.js';
import { WiderShip } from './widership.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// colour grade: the game's cold, slightly crushed look (applied in display space, after tone mapping)
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, contrast: { value: 1.07 }, saturation: { value: 0.9 }, lift: { value: new THREE.Vector3(0.0, 0.004, 0.012) }, tint: { value: new THREE.Vector3(0.985, 1.0, 1.03) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float contrast; uniform float saturation; uniform vec3 lift; uniform vec3 tint; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 col = mix(vec3(l), c.rgb, saturation) * tint;
      col = (col - 0.5) * contrast + 0.5 + lift;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};

const $ = id => document.getElementById(id);
const PIXEL_HEIGHT = 520;
const LIGHT_GAIN = 0.08, RANGE_GAIN = 1.6;   // brightness / range multipliers for the game's point lights   // the game renders its world at a low internal resolution and upscales it

class Game {
  constructor() {
    this.canvas = $('c');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    // post-processing: bloom for the lamps and screens + a colour grade; the OutputPass does tone mapping and sRGB
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, null);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.38, 0.5, 0.9);
    this.gradePass = new ShaderPass(GradeShader);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass); this.composer.addPass(this.bloomPass); this.composer.addPass(this.outputPass); this.composer.addPass(this.gradePass);
    this.postFx = true;
    // a neutral environment so metals and glossy surfaces have something to reflect
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;   // switched off inside the facility: it is a base fill that would light rooms with no lamps
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.08, 1500);
    this.scene.add(this.camera);
    this.renderPass.camera = this.camera;
    this.lib = new AssetLib(this.renderer);
    this.sound = new SoundManager();
    this.menuMusic = null; this._menuMusicKick = null; this._menuMusicToken = 0;
    this.hud = new HUD(this);
    this.clock = new THREE.Clock();
    this.state = 'loading';
    this.wantsLock = false;
    this.quota = 130; this.credits = 60; this.daysLeft = 3; this.scrapOnShip = 0; this.quotaRound = 1; this.quotaFulfilled = 0;
    this.dayCount = 0;
    this.inside = false;
    this.flashlightOn = false;
    this.scanT = 0; this.scanTargets = [];
    this.pixelFilter = true;
    this.lightGain = 1; this.shadowLamps = 0; this.shadowsOn = true; this.paused = false;
    this._resize();
    addEventListener('resize', () => this._resize());
    // surface errors on screen instead of a silent dead button
    const showErr = msg => { const el = $('menu-status'); if (el) el.textContent = 'Error: ' + msg + ' (press F5 to reload; if it persists, send this text)'; };
    addEventListener('error', e => showErr(e.message || String(e)));
    addEventListener('unhandledrejection', e => showErr((e.reason && (e.reason.message || e.reason)) || 'promise rejection'));
    // the start button is wired immediately; it waits for boot to finish
    this.ready = false;
    $('btn-play').onclick = () => { if (this.ready) this.startGame(); else $('menu-status').textContent = 'Still loading, one moment...'; };
    addEventListener('keydown', e => { if ((e.code === 'Enter' || e.code === 'Space') && this.state === 'menu' && this.ready) this.startGame(); });
    window.G = this;
  }

  _resize() {
    const aspect = innerWidth / innerHeight;
    this.camera.aspect = aspect; this.camera.updateProjectionMatrix();
    if (this.pixelFilter) {
      const h = Math.min(this.pixelLines || PIXEL_HEIGHT, innerHeight), w = Math.round(h * aspect);
      this.renderer.setPixelRatio(1); this.renderer.setSize(w, h, false);
      this.canvas.style.imageRendering = 'pixelated';
    } else {
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25)); this.renderer.setSize(innerWidth, innerHeight, false);
      this.canvas.style.imageRendering = 'auto';
    }
    this.canvas.style.width = '100%'; this.canvas.style.height = '100%';
    const size = this.renderer.getSize(new THREE.Vector2());
    if (this.composer) { this.composer.setSize(size.x, size.y); this.bloomPass.resolution.set(size.x, size.y); }
  }
  render() { if (this.postFx) this.composer.render(); else this.renderer.render(this.scene, this.camera); }

  togglePixelFilter() { this.pixelFilter = !this.pixelFilter; this._resize(); document.body.classList.toggle('nofilter', !this.pixelFilter); }

  async boot() {
    const fill = $('load-fill'), text = $('load-text');
    const t0 = performance.now(); let phase = 'Loading...';
    const setText = t => { phase = t; text.textContent = t; };
    // keep the loading screen visibly alive: elapsed time, and a hint if it takes unusually long (normal is 20-40 s)
    const tick = setInterval(() => {
      if (this.ready || this.state !== 'loading') { clearInterval(tick); return; }
      const s = Math.round((performance.now() - t0) / 1000);
      text.textContent = phase + '  (' + s + 's' + (s > 60 ? ' - this is taking too long, press F5 to reload' : '') + ')';
    }, 1000);
    try { await this.lib.init(); }
    catch (e) {
      $('loading').classList.add('hidden'); $('menu').classList.remove('hidden');
      $('menu-status').textContent = 'No extracted assets found in assets/. Run tools\\extract.bat with your own Lethal Company install first.';
      $('btn-play').disabled = true; return;
    }
    this.lib.onProgress = (l, t) => { fill.style.width = Math.min(100, 100 * l / Math.max(1, t)) + '%'; };
    try {
    this.world = new World(this);
    await this.world.load(setText);
    setText('Loading facility blueprints...');
    this.dungeon = new Dungeon(this);
    await this.dungeon.load();
    setText('Loading company property...');
    this.items = new Items(this);
    await this.items.load();
    this.decor = new Decor(this);
    await this.decor.load();
    this.enemies = new Enemies(this);
    await this.enemies.load();
    this.player = new Player(this);
    this.player.radius = 0.4; this.player.standHeight = 2.5; this.player.crouchHeight = 1.5;
    this.lightPool = new LightPool(this.scene, 14);
    this._refreshLightSources();
    this._setupFlashlight();
    this.terminal = new Terminal(this);
    this.settings = new Settings(this);
    this.debug = new DebugMenu(this);
    this._bindUISounds();
    fill.style.width = '100%';
    $('loading').classList.add('hidden'); $('menu').classList.remove('hidden');
    $('btn-continue').onclick = () => this.continueAfterResults();
    $('btn-menu-settings').onclick = () => { this.settings.show(); };
    $('btn-menu-controls').onclick = () => { $('menu-controls').classList.toggle('hidden'); };
    this.state = 'menu'; this.ready = true;
    // a restart from the Esc menu reloads the page and jumps straight back into a new run
    try { if (sessionStorage.getItem('lethalweb.autostart')) { sessionStorage.removeItem('lethalweb.autostart'); this.startGame(); } } catch (e) { }
    this.startMenuMusic();
    this.shipmods = new WiderShip(this); this.shipmods.load(); await this.shipmods.apply();
    this.spawnPlayerInShip();
    this.decor.restore();
    this.loop();
    } catch (e) {
      console.error(e);
      $('loading').classList.add('hidden'); $('menu').classList.remove('hidden');
      $('menu-status').textContent = 'Failed to load: ' + (e && e.message ? e.message : e) + '. Press F5 to reload. If it keeps failing, run tools/extract.bat again.';
    }
  }

  _refreshLightSources() {
    const src = [];
    const add = (l, area) => { if (!l.isPointLight && !l.isSpotLight) return; src.push({ obj: l, area, pos: new THREE.Vector3(), color: l.color.clone(), intensity: l.userData.baseIntensity != null ? Math.min(l.userData.baseIntensity, 60) * LIGHT_GAIN : l.intensity, distance: Math.max((l.distance || 8) * RANGE_GAIN, 14) }); l.visible = false; };
    for (const l of this.world.shipLights) add(l, 'ship');
    for (const moon of Object.values(this.world.moons)) for (const l of moon.lights) add(l, moon.key);
    for (const l of this.world.companyLights) add(l, 'company');
    for (const l of this.dungeon.lights) src.push({ obj: null, area: 'inside', pos: l.pos.clone(), color: l.color, intensity: l.intensity, distance: l.distance });
    this.lightSources = src;
    this.lightPool.setSources(src);
  }

  _updateLights() {
    const inside = this.inside, lit = this.world.lightsOn;
    if (this.world.hemi) { this.world.hemi.intensity = inside ? 0.09 : 0.6; this.world.ambient.intensity = inside ? 0.045 : 0.35; }   // inside: only the lamps and your flashlight really light things
    for (const s of this.lightSources) {
      if (s.area === 'inside') { s.enabled = inside; continue; }
      s.enabled = !inside && (s.area === 'ship' || (!this.world.inOrbit && s.area === this.world.destination));
      if (s.obj) { s.obj.getWorldPosition(s.pos); if (s.area === 'ship') s.intensity = (lit ? 1 : 0) * (s.obj.userData.baseIntensity != null ? Math.min(s.obj.userData.baseIntensity, 60) * LIGHT_GAIN : 0.5); }
    }
    this.lightPool.update(this.player.pos);
  }

  _setupFlashlight() {
    this.flash = new THREE.SpotLight(0xffe9c4, 0, 45, THREE.MathUtils.degToRad(31), 0.7, 1.4);
    this.flash.layers.set(0);   // the beam lights the world, not the torch held in front of the lens (which otherwise glows neon)
    this.flash.layers.set(0);
    this.flash.castShadow = true; this.flash.shadow.mapSize.set(1024, 1024); this.flash.shadow.bias = -0.002; this.flash.shadow.camera.near = 0.2;
    this.flashTarget = new THREE.Object3D();
    this.camera.add(this.flash); this.camera.add(this.flashTarget);
    // the beam starts just past the torch head (the held model sits at z -0.55), so the torch itself is never inside its own light
    this.flash.position.set(0.3, -0.28, -0.85); this.flashTarget.position.set(0.05, -0.1, -8); this.flash.target = this.flashTarget;
    this.nearLight = new THREE.PointLight(0xffffff, 0.0, 6, 2); this.camera.add(this.nearLight);
    this.nearLight.layers.enable(1);
    this.heldLight = new THREE.DirectionalLight(0xffffff, 0.35); this.heldLight.position.set(0.5, 1, 1); this.camera.add(this.heldLight); this.heldLight.target = this.camera; this.heldLight.layers.set(1);
    this.camera.layers.enable(1);
  }

  /** how hard the current moon is, from its risk letter: scales scrap counts up and enemy spawn timers down */
  difficulty() {
    const r = String((this.items && this.items.catalog && this.items.catalog.level && this.items.catalog.level.riskLevel) || 'D').toUpperCase();
    return { 'D': 1.0, 'C': 1.15, 'B': 1.3, 'A': 1.5, 'S': 1.75, 'S+': 2.0, 'S++': 2.2 }[r] || (r.startsWith('S') ? 1.9 : 1.0);
  }

  spawnPlayerInShip() {
    const ship = this.world.shipObj; ship.updateMatrixWorld(true);
    const p = ship.localToWorld(new THREE.Vector3(4.0, 1.4, -9.0));
    this.player.attachTo(ship);
    this.player.teleport(p, -Math.PI * 0.5);   // teleport re-snapshots the ship pose so the follow delta starts from here
  }

  startMenuMusic() {
    if (this.menuMusic || this._menuMusicKick) return;
    const token = ++this._menuMusicToken;
    const kick = async () => {
      removeEventListener('pointerdown', kick); removeEventListener('keydown', kick);
      if (this._menuMusicKick === kick) this._menuMusicKick = null;
      this.sound.resume();
      const h = await this.sound.play('b9_16', { loop: true, vol: 0.55 });
      // The activating click can also be the Start-job click. Never let that late load revive menu music in-game.
      if (token !== this._menuMusicToken || this.state !== 'menu') { if (h) h.stop(0.1); return; }
      this.menuMusic = h;
    };
    // browsers only allow audio after a gesture; the first click/key on the menu starts it
    addEventListener('pointerdown', kick); addEventListener('keydown', kick);
    this._menuMusicKick = kick;
  }
  stopMenuMusic(fade = 0.35) {
    ++this._menuMusicToken;
    if (this._menuMusicKick) {
      removeEventListener('pointerdown', this._menuMusicKick); removeEventListener('keydown', this._menuMusicKick);
      this._menuMusicKick = null;
    }
    const h = this.menuMusic; this.menuMusic = null;
    if (h && h.stop) h.stop(fade);
  }

  _bindUISounds() {
    const play = (name, vol = 0.28) => { const c = this.items.sfx(name); if (c) this.sound.play(c, { vol }); };
    for (const b of document.querySelectorAll('.menu-btn')) b.addEventListener('click', () => play('uiSelect', 0.3));
    for (const input of document.querySelectorAll('#settings input, #settings select')) input.addEventListener('change', () => play('key', 0.2));
  }

  startGame() {
    if (this.state === 'play') return;
    this.stopMenuMusic();
    this.sound.play('b9_18', { vol: 0.5 });
    $('menu-status').textContent = '';
    $('menu').classList.add('hidden');
    this.hud.show(true);
    this.sound.resume();
    this.state = 'play';
    this._suppressSettings = true; this.player.lock();
    this.world.startLoop('shipAmb', this.world.clips.shipAmb, { vol: 0.35 });
    this.world.startLoop('thruster', this.world.clips.thruster, { vol: 0.25 });
    this.hud.showTip(`Pull the lever by the door to land on ${this.world.levelName}.\nUse the terminal to buy gear or change your route.`, 8);
    this.hud.setQuota(this.quotaFulfilled, this.quota, this.daysLeft, this.credits);
  }

  // ---------- events from player ----------
  onKey(code, down) {
    if (!down) return;
    if (this.terminal && this.terminal.open) return;
    if (this.state !== 'play') return;
    if (code === 'KeyB') { this.decor.toggle(); return; }
    if (code === 'KeyR' && this.decor.carry) { this.decor.rotate(1); return; }
    if (code === 'KeyE') { this.interact(); this.enemies.onMash(); }
    if (code === 'KeyG') this.items.dropHeld();
    if (code === 'KeyF') this.toggleFlashlight();
    if (code === 'KeyP') { this.settings.v.pixel = !this.settings.v.pixel; this.settings.apply(); this.settings.save(); }
    if (code === 'Digit1') this.items.select(0); if (code === 'Digit2') this.items.select(1); if (code === 'Digit3') this.items.select(2); if (code === 'Digit4') this.items.select(3);
  }
  onMouse(button, down) {
    if (this.state !== 'play' || !down || (this.terminal && this.terminal.open)) return;
    if (button === 0) { if (this.decor.carry) return this.decor.place(); this.items.useHeld(); }
    if (button === 2) this.scan();
  }
  onWheel(dir) { if (this.state !== 'play' || (this.terminal && this.terminal.open)) return; if (this.decor.carry) return this.decor.rotate(dir > 0 ? 1 : -1); this.items.select((this.items.active + (dir > 0 ? 1 : 3)) % 4); }
  onLockChange(locked) {
    if (!locked && this.decor && this.decor.carry) this.decor.cancel();
    if (!locked && this.state === 'play' && !(this.terminal && this.terminal.open) && this.settings && !this.settings.open && !(this.debug && this.debug.open) && !this._suppressSettings) this.settings.show();
    this._suppressSettings = false;
  }
  /** start over: wipe the saved furniture layout and ship upgrade, reload, and begin a new run */
  restartRun() {
    try { localStorage.removeItem('lethalweb.decor'); localStorage.removeItem('lethalweb.ship'); sessionStorage.setItem('lethalweb.autostart', '1'); } catch (e) { }
    location.reload();
  }

  backToMenu() {
    this.state = 'menu'; this.hud.show(false); this.player.unlock();
    $('menu').classList.remove('hidden');
    this.stopMenuMusic(0);
    this.sound.stopAll(); this.world.loops = {};
    this.startMenuMusic();
  }
  onJump() { const c = this.items.sfx('jump'); if (c) this.sound.play(c, { vol: 0.42, pitch: 0.98 + Math.random() * 0.04 }); }
  onLand(v) {
    const impact = this.items.sfx(v < -14 ? 'landHard' : 'landSoft');
    if (impact) this.sound.play(impact, { vol: Math.min(0.9, 0.35 + -v * 0.025), pitch: 0.98 });
    const clip = this.footClip(); if (clip) this.sound.play(clip, { vol: Math.min(0.7, 0.28 + -v * 0.02), pitch: 0.9 });
  }
  onFootstep() {
    const clip = this.footClip();
    if (clip) this.sound.play(clip, { vol: this.player.sprinting ? 0.55 : this.player.crouching ? 0.15 : 0.35, pitch: 0.95 + Math.random() * 0.1 });
    this.enemies.onNoise(this.player.pos, this.player.sprinting ? 1 : this.player.crouching ? 0.2 : 0.5);
  }
  onLadder(on) { }
  onLadderStep() { const c = this.items.footstep('metal'); if (c) this.sound.play(c, { vol: 0.35, pitch: 1.1 }); }
  footClip() {
    const surf = this.player.attached ? 'metal' : this.inside ? 'concrete' : this.world.atCompany ? 'concrete' : 'dirt';
    return this.items.footstep(surf);
  }
  onDamage(amount, source) {
    this.hud.flashDamage(Math.min(1, amount / 40));
    const c = this.items.sfx(source === 'fall' ? 'fallDamage' : 'damage'); if (c) this.sound.play(c, { vol: 0.8 });
  }
  onDeath(source) {
    this.hud.showNotice('YOU DIED', 4);
    this.hud.setSpectate(`Cause of death: ${source || 'unknown'}
The ship will leave without you.`);
    this.player.inputEnabled = false;
    const c = this.items.sfx(source === 'space' || source === 'void' ? 'space' : 'death'); if (c) this.sound.play(c, { vol: 0.9 });
    this.items.dropAll();
    this.flashlightOn = false;
    // a moment on the body, then cut to a camera outside watching the ship take off without you; the results follow
    const w = this.world;
    setTimeout(() => {
      if (this.state !== 'play') return;
      if (w.shipState === 'landed' || w.shipState === 'leaving') {
        this.startSpectate();
        if (w.shipState === 'landed') { w.setShipState('leaving'); this.onShipDeparting(true); }
      } else this.endDay(true);
    }, 2500);
  }

  /** dead: watch the ship from a spot beside the landing pad */
  startSpectate() {
    const w = this.world;
    this.inside = false; this.player.attachTo(null);
    if (this.player.ladder) this.player.ladder = null;
    w.shipObj.updateMatrixWorld(true);
    // beside the ship, off the door side, a little above the pad; lookAt keeps the hull framed as it climbs
    this.spectatePos = w.shipObj.localToWorld(new THREE.Vector3(26, 9, -2));
    this.spectating = true;
    this.hud.setSpectate('The ship is leaving without you.');
    this.stopMoonMusic(); w.stopLoop('inside', 1.0); w.stopLoop('company', 1.0);
    if (!w.loops.outside && !w.atCompany) w.startLoop('outside', this.items.ambienceClip('outside'), { vol: 0.5 });
  }
  _updateSpectate() {
    if (!this.spectating) return;
    const hull = this.world.shipObj.getWorldPosition(new THREE.Vector3());
    this.camera.position.copy(this.spectatePos);
    this.camera.lookAt(hull.x, hull.y + 3, hull.z);
  }

  toggleFlashlight() {
    if (!this.items.hasFlashlight()) { this.hud.showTip('No flashlight.', 2); return; }
    if (!this.flashlightOn && this.items.flashlightBattery() <= 0) { this.hud.showTip('Flashlight battery is dead. Charge it on the ship.', 3); return; }
    this.flashlightOn = !this.flashlightOn;
    const c = this.items.sfx(this.flashlightOn ? 'flashOn' : 'flashOff'); if (c) this.sound.play(c, { vol: 0.6 });
  }

  // ---------- interaction ----------
  interact() { const t = this.lookTarget(); if (t && t.action) t.action(); }

  lookTarget() {
    const eye = this.camera.position, dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best = null, bestD = 1e9;
    const consider = (pos, radius, entry) => {
      const reach = entry.reach != null ? entry.reach : 4.0;
      let p = pos;
      if (entry.segment) {
        // ladders: measure to the closest point of the ladder line, not its middle
        const [a, b] = entry.segment(); const ab = b.clone().sub(a); const t = THREE.MathUtils.clamp(eye.clone().sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
        p = a.clone().addScaledVector(ab, t);
      }
      const to = p.clone().sub(eye); const d = to.length();
      if (d > reach + radius * 0.5) return;
      const along = to.dot(dir); if (along < 0) return;
      const perp = Math.sqrt(Math.max(0, d * d - along * along));
      if (perp < radius && d < bestD) { bestD = d; best = entry; }
    };
    if (!this.inside) { for (const it of this.world.interactables) { if (it.area && (this.world.inOrbit || it.area !== this.world.destination)) continue; if (it.obj) consider(this.world.worldPosOf(it.obj), it.radius, it); else if (it.pos) consider(it.pos, it.radius, it); } }
    else for (const it of this.dungeon.interactables) consider(it.pos, it.radius, it);
    for (const it of this.items.interactables()) consider(it.pos, it.radius, it);
    return best;
  }

  scan() {
    if (this.scanCooldown > 0) return;
    this.scanCooldown = 1.1;
    this.scanT = 3.0;
    this.hud.scanPulse();
    const c = this.items.sfx('scan'); if (c) this.sound.play(c, { vol: 0.5 });
    const all = this.items.scannables(this.camera.position, 22).concat(this.enemies.scannables(this.camera.position, 30), this.dungeon.scannables(this.camera.position, 30));
    this.scanTargets = all.filter(s => this.canSee(s.pos()));
  }

  /** the scanner only tags what the camera can actually see: inside the view and with nothing solid in between */
  canSee(p) {
    const cam = this.camera;
    const v = p.clone().project(cam);
    if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return false;   // off screen or behind the camera
    const dir = p.clone().sub(cam.position); const dist = dir.length(); if (dist < 0.05) return true; dir.divideScalar(dist);
    const far = dist - 0.35;   // stop just short of the target so its own bulk never counts as a wall
    for (const c of this.activeColliders()) if (c && c.raycast(cam.position, dir, far)) return false;
    return true;
  }

  openTerminal() { this._suppressSettings = true; this.terminal.show(); }
  showManual() { this.hud.showTip('WELCOME TO THE COMPANY\n1. Land on the moon (lever).\n2. Find the facility entrance.\n3. Collect scrap, bring it to the ship.\n4. Be back before midnight.\n5. Do not die. Cost of replacement is high.', 10); }

  // ---------- day flow ----------
  onShipDeparting(leaving) {
    const depart = this.items.sfx('depart'); if (depart) this.sound.play(depart, { vol: 0.55 });
    if (leaving) { this.hud.showNotice('SHIP DEPARTING', 3, '#e8c85a'); this.stopMoonMusic(); this.world.stopLoop('company', 2.0); this.world.stopLoop('outside', 2.0); }
  }
  async onShipLanded() {
    this.dayCount++;
    this.stopMenuMusic(0);
    this.world.stopLoop('thruster');
    const arrive = this.items.sfx('arrive'); if (arrive) this.sound.play(arrive, { vol: 0.6 });
    this.items.onLanded();
    if (this.world.atCompany) {
      this.hud.showNotice('WELCOME TO THE COMPANY', 4, '#e8c85a');
      this.hud.showTip(`Put scrap on the counter and ring the bell.\nThe Company is buying at ${Math.round(this.world.buyingRate() * 100)}% today.`, 8);
      const d = this.world.desk; if (d && d.clips.music) this.world.startLoop('company', d.clips.music, { vol: 0.35 });
      this._refreshLightSources();
      return;
    }
    const catalog = this.dungeon.setLevel(this.world.levelCatalog);
    this.items.setCatalog(catalog);
    this.enemies.setCatalog(catalog);
    this.hud.showNotice(`LANDED ON ${this.world.levelName}`, 4, '#e8c85a');
    // Exterior ambience and music belong to the landing, not to the slower procedural facility build.
    this.world.startLoop('outside', this.items.ambienceClip('outside'), { vol: 0.5 });
    this.startMoonMusic();
    await this.dungeon.generate(this.dayCount * 7919 + Date.now() % 1000);
    await this.items.spawnScrap();
    this._refreshLightSources();
    this.enemies.beginDay();
  }
  // the moon's ambient day music (the game's AmbientMusic tracks), one picked per landing
  startMoonMusic() {
    const tracks = ['b8_1748', 'b8_1800', 'b8_1568', 'b8_1656', 'b8_1667', 'b8_1728'];
    const clip = tracks[Math.floor(Math.random() * tracks.length)];
    this.world.startLoop('moonmusic', clip, { vol: 0.28 });
  }
  stopMoonMusic(fade = 2.0) { this.world.stopLoop('moonmusic', fade); }
  onShipLeft() { this.endDay(this.player.dead); }
  endDay(playerDead) {
    if (this.state !== 'play') return;
    this.state = 'results';
    this.spectating = false;
    const collected = this.items.scrapValueOnShip();
    this.scrapOnShip = collected;
    const lines = [];
    lines.push(playerDead ? 'The ship left without you. Your body was not recovered.' : (this.world.atCompany ? 'You left the Company building.' : `You returned from ${this.world.levelName}.`));
    lines.push(`Scrap on ship: $${collected}   (sell it at the Company)`);
    let fired = false;
    if (this.daysLeft <= 0) {
      // the deadline just passed
      if (this.quotaFulfilled >= this.quota) {
        lines.push(`\nQUOTA MET ($${this.quotaFulfilled} of $${this.quota}). The Company is... satisfied. New quota assigned.`);
        this.quotaRound++;
        this.quota = Math.round(this.quota + 100 * (1 + Math.pow(this.quotaRound, 2) / 16) * (0.85 + Math.random() * 0.3));
        this.quotaFulfilled = 0;
        this.daysLeft = 3;
        lines.push(`New profit quota: $${this.quota}. 3 days.`);
        setTimeout(() => { const q = this.items.sfx('newQuota'); if (q) this.sound.play(q, { vol: 0.65 }); }, 800);
      } else {
        lines.push(`\nQUOTA NOT MET ($${this.quotaFulfilled} of $${this.quota}). Performance review: unacceptable.\nYou have been let go. Every crew member is jettisoned into space.`);
        fired = true;
        setTimeout(() => { const f = this.items.sfx('fired'); if (f) this.sound.play(f, { vol: 0.75 }); }, 700);
      }
    } else {
      this.daysLeft--;
      lines.push(`Profit quota: $${this.quotaFulfilled} / $${this.quota}   (${this.daysLeft} day${this.daysLeft === 1 ? '' : 's'} left)`);
      if (this.daysLeft === 1) setTimeout(() => { const d = this.items.sfx('oneDay'); if (d) this.sound.play(d, { vol: 0.65 }); }, 700);
    }
    if (playerDead) lines.push('\nA new employee has been hired to replace you.');
    $('results-text').textContent = lines.join('\n');
    $('results').classList.remove('hidden');
    this._suppressSettings = true; this.player.unlock();
    this.fired = fired;
    this.enemies.clearAll();
    this.dungeon.clear();
    this.items.clearWorldScrap();
    this.world.stopLoop('outside'); this.world.stopLoop('inside'); this.world.stopLoop('company'); this.stopMoonMusic();
    this.hud.setSpectate('');
    const c = this.items.sfx('results'); if (c) this.sound.play(c, { vol: 0.5 });
  }
  continueAfterResults() {
    $('results').classList.add('hidden');
    if (this.fired) { this.quota = 130; this.credits = 60; this.daysLeft = 3; this.scrapOnShip = 0; this.quotaRound = 1; this.quotaFulfilled = 0; this.items.sellScrap(); this.fired = false; }
    this.player.dead = false; this.player.health = 100; this.player.inputEnabled = true; this.player.ladder = null;
    this.inside = false; this.spectating = false;
    this.spawnPlayerInShip();
    this.items.clearInventory();
    this.state = 'play';
    this.hud.setQuota(this.quotaFulfilled, this.quota, this.daysLeft, this.credits);
    this.player.lock();
    this.world.startLoop('thruster', this.world.clips.thruster, { vol: 0.25 });
  }

  // ---------- facility transitions ----------
  enterFacility(viaFireExit) {
    const spot = viaFireExit ? this.dungeon.fireExitInside : this.dungeon.entranceInside;
    if (!spot) return;
    this.inside = true;
    this.player.attachTo(null);
    this.player.teleport(spot.pos, spot.yaw);
    const c = pickClip(this.world.entrance?.clips); if (c) this.sound.play(c, { vol: 0.8 });
    this.world.stopLoop('outside'); this.world.startLoop('inside', this.items.ambienceClip('inside'), { vol: 0.45 });
    this.enemies.onPlayerEntered(true);
  }
  exitFacility(viaFireExit) {
    const ent = viaFireExit ? this.world.fireExit : this.world.entrance;
    if (!ent) return;
    this.inside = false;
    const p = this.world.worldPosOf(ent.tele);
    const q = new THREE.Quaternion(); ent.tele.getWorldQuaternion(q);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    this.player.teleport(p.clone().add(new THREE.Vector3(0, 0.1, 0)), Math.atan2(-f.x, -f.z));
    const c = pickClip(ent.clips); if (c) this.sound.play(c, { vol: 0.8 });
    this.world.stopLoop('inside'); this.world.startLoop('outside', this.items.ambienceClip('outside'), { vol: 0.5 });
    this.enemies.onPlayerEntered(false);
  }

  activeColliders() {
    const list = [];
    if (this.inside) { if (this.dungeon.collider) list.push(this.dungeon.collider); for (const d of this.dungeon.doors) if (d.collider && !d.open) list.push(d.collider); }
    else { list.push(this.world.shipCollider, ...this.world.doorColliders, ...this.decor.colliders()); if (!this.world.inOrbit && this.world.levelCollider) list.push(this.world.levelCollider); }
    if (this.inside) list.push(...this.dungeon.dynamicColliders);
    return list;
  }

  // ---------- loop ----------
  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(0.05, this.clock.getDelta());
    this.tick(dt);
    this.render();
  }

  step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) this.tick(dt); this.render(); }

  tick(dt) {
    const p = this.player;
    if (this.paused) { this.hud.update(dt); return; }
    if (this.lightPool) this.lightPool.gain = this.lightGain;
    if (this.state === 'play' || this.state === 'menu' || this.state === 'results') {
      this.world.update(dt);
      if (this.state === 'play') {
        // during the orbit idle and landing cutscene the player rides the ship: no gravity, no fall damage
        p.riding = !this.inside && (this.world.shipState === 'orbit' || this.world.shipState === 'landing');
        p.update(dt, this.activeColliders());
        p.heal(dt);
        if (!this.inside) {
          const w = this.world;
          if (w.shipState === 'orbit' || w.shipState === 'landing') {
            // during the orbit idle and the landing cutscene the hull moves fast; keep the player locked to the ship
            p.attachTo(w.shipObj); this._spaceT = 0;
          } else {
            // landed or leaving: the deck test decides riding, checked after this frame's move
            const onShipGeom = p.groundCollider === w.shipCollider || w.doorColliders.includes(p.groundCollider);
            const onDeck = onShipGeom || w.onShipDeck(p.pos);
            p.attachTo(onDeck ? w.shipObj : null);
            // walked off while it is taking off = space, but only after a moment so a single bad frame never kills
            if (w.shipState === 'leaving' && !onDeck) { this._spaceT = (this._spaceT || 0) + dt; if (this._spaceT > 2.0) p.damage(1000, 'space'); }
            else this._spaceT = 0;
          }
        }
        this.items.update(dt);
        this.enemies.update(dt);
        this.dungeon.update(dt);
        this.decor.update(dt);
        this._updateHud(dt);
        this._updateScan(dt);
        // deep water: two seconds under and you drown (the moon's KillTrigger volumes)
        if (!this.inside && !p.dead && !this.world.inOrbit && !this.world.atCompany && !p.attached) {
          let inWater = false;
          for (const z of (this.world.activeMoon.killZones || [])) if (z.containsPoint(p.pos)) { inWater = true; break; }
          if (inWater) { this.waterT = (this.waterT || 0) + dt; if (this.waterT > 2) { this.waterT = 0; p.damage(1000, 'drowning'); } }
          else this.waterT = 0;
          if (this.hud && this.hud.setUnderwater) this.hud.setUnderwater(inWater ? Math.min(1, this.waterT / 2) : 0);
        } else this.waterT = 0;
        this._updateSpectate();
      }
      this.dungeon.root.visible = this.inside;
      this.scene.environment = this.inside ? null : this.envTex;
      this.world.setExteriorVisible(!this.inside && !this.world.inOrbit);
      this.world.shipRoot.visible = !this.inside;
      this.world.sun.visible = !this.inside;
      this.world.setFocus(p.pos);
      this._updateLights();
      if (this.flashlightOn && this.items.flashlightBattery() <= 0) this.flashlightOn = false;
      const on = this.flashlightOn && this.items.hasFlashlight() && this.state === 'play';
      this.flash.intensity += ((on ? 105 : 0) - this.flash.intensity) * Math.min(1, dt * 14);
      this.nearLight.intensity = this.inside ? 0.06 : 0.1;
      this.sound.setListener(this.camera.position, new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion), new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion));
      this.hud.update(dt);
    }
    if (this.debug) this.debug.update(dt);
  }

  _updateHud(dt) {
    const w = this.world, p = this.player;
    const { h, m } = w.clockText();
    this.hud.setClock(h, m, w.dayFrac, !this.inside && !w.inOrbit);
    this.hud.setStamina(p.stamina, this.items.carryWeightLb());
    this.hud.setHealth(this.spectating ? 100 : p.health);   // no blood vignette on the spectator camera
    const t = this.lookTarget();
    this.hud.setTooltip(this.spectating ? '' : t ? (typeof t.label === 'function' ? t.label() : t.label) : (p.ladder ? 'W/S climb  ·  Space let go' : ''));
    this.hud.setQuota(this.quotaFulfilled, this.quota, this.daysLeft, this.credits, this.items.scrapValueOnShip());
    if (w.shipState === 'landed' && w.dayFrac >= 1 && !w.atCompany) { w.setShipState('leaving'); this.hud.showNotice('THE SHIP IS LEAVING', 4); this.stopMoonMusic(); this.world.stopLoop('outside', 2.0); }
    else if (w.shipState === 'landed' && w.dayFrac > 0.93 && !this._warned) { this._warned = true; this.hud.showNotice('THE SHIP LEAVES AT MIDNIGHT', 4, '#e8c85a'); const c = this.items.sfx('alert'); if (c) this.sound.play(c, { vol: 0.6 }); }
    if (w.shipState !== 'landed') this._warned = false;
  }

  _updateScan(dt) {
    this.scanCooldown = (this.scanCooldown || 0) - dt;
    if (this.scanT <= 0) { this.hud.setScanTags([]); return; }
    this.scanT -= dt;
    const tags = [];
    const v = new THREE.Vector3();
    for (const s of this.scanTargets) {
      const pos = s.pos();
      if (!pos) continue;
      v.copy(pos).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      tags.push({ x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, text: s.text, value: s.value, alpha: Math.min(1, this.scanT) });
    }
    this.hud.setScanTags(tags);
  }
}

new Game().boot();
