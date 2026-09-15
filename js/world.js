// World assembly: ship (driven by the game's own animation clips), moon exterior, sky/sun/fog, time of day.
import * as THREE from 'three';
import { Collider, collisionEntries } from './collision.js';
import { pickClip } from './audio.js';
import { Animator } from './anim.js';

const DAY_SECONDS = 780;          // ~13 real minutes from 8 AM to midnight (game: 1080 time units / 1.4)
const START_HOUR = 8, END_HOUR = 24;
// Unity "Environment" root of the ship scene (mirrored X); the ship's animation clips are relative to it
const ENVIRONMENT_POS = new THREE.Vector3(17.4, 7.6, -16.5);
const SHIP_LANDED_LOCAL = new THREE.Vector3(-18.71032, -7.326942, 8.971304);
export const MOON_DEFS = [
  { key: 'moon', asset: 'experimentation', name: '41-EXPERIMENTATION', catalog: 'experimentation' },
  { key: 'assurance', asset: 'assurance', name: '220-ASSURANCE', catalog: 'assurance' },
  { key: 'titan', asset: 'titan', name: '8-TITAN', catalog: 'titan', fogDay: 0x272b31, fogDusk: 0x15171c, sunDay: 0x9aa4b4, hemiSky: 0x5b6470, fogScale: 3.4, sunScale: 0.5, forceFlow: 'SlaughterhouseFlow', sizeMul: 2.2 },
  // 127 Eve-M: RosiePies' forest moon (Thunderstore), packed with tools/pack_mod_moon.py; skipped when its assets are missing
  { key: 'eve', asset: 'eve', name: '127-EVE-M', catalog: 'eve', fogDay: 0xb9c6b3, fogDusk: 0x3b4150, sunDay: 0xfff1d6, hemiSky: 0x9cc0e0, fogScale: 0.55, sunScale: 1.15, sizeMul: 1.4, optional: true },
  // 115 Wither: ScienceBird's late-game moon (Thunderstore); dry, dusty light
  { key: 'wither', asset: 'wither', name: '115-WITHER', catalog: 'wither', fogDay: 0xc7b9a2, fogDusk: 0x3a3128, sunDay: 0xffe0b8, hemiSky: 0xb9a98c, fogScale: 0.8, sunScale: 1.05, optional: true },
  // 42 Tranquillity: NeatWolf's A+ moon (Thunderstore); eternal low sun. Its custom Manor/Facility interior is NOT used - the
  // catalog was rewritten to the game's own facility/mineshaft tiles at even odds (tools/pack_mod_moon.py + catalog swap)
  { key: 'tranquillity', asset: 'tranquillity', name: '42-TRANQUILLITY', catalog: 'tranquillity', fogDay: 0xd2a978, fogDusk: 0x4a3222, sunDay: 0xffd6a0, hemiSky: 0xdcb07a, fogScale: 0.7, sunScale: 1.2, optional: true },
];

export class World {
  constructor(game) {
    this.game = game; this.lib = game.lib; this.scene = game.scene;
    this.ship = null;
    this.shipRoot = new THREE.Group(); this.shipRoot.name = 'ShipRoot';
    this.moons = {};
    for (const d of MOON_DEFS) {
      const root = new THREE.Group(); root.name = d.name + 'Root'; root.visible = false;
      this.moons[d.key] = { ...d, root, inst: null, collider: null, lights: [], entrance: null, fireExit: null, outsideNodes: [], ladders: [], entranceAnim: null };
    }
    this.scene.add(this.shipRoot, ...Object.values(this.moons).map(m => m.root));
    this.colliders = [];
    this.shipCollider = null; this.doorColliders = [];
    this.shipState = 'orbit';   // orbit | landing | landed | leaving
    this.shipT = 0;
    this.doorsOpen = false; this.doorPower = 1;
    this.lightsOn = true;
    this.time = 0; this.dayFrac = 0; this.hour = START_HOUR;
    this.sun = null; this.hemi = null; this.ambient = null;
    this.interactables = [];
    this.loops = {};
    this.ladders = [];
    this.anims = {};
    this.shipLandingPos = new THREE.Vector3();
    this.destination = 'moon';      // moon | assurance | titan | company
    this.companyRoot = new THREE.Group(); this.companyRoot.name = 'CompanyRoot'; this.scene.add(this.companyRoot);
    this.company = null; this.companyCollider = null; this.companyLights = [];
    this.desk = null;
  }

  get activeMoon() { return this.moons[this.destination] || this.moons.moon; }
  get moon() { return this.activeMoon.inst; }
  get moonRoot() { return this.activeMoon.root; }
  get moonCollider() { return this.activeMoon.collider; }
  get moonLights() { return this.activeMoon.lights; }
  get entrance() { return this.activeMoon.entrance; }
  get fireExit() { return this.activeMoon.fireExit; }
  get outsideNodes() { return this.activeMoon.outsideNodes; }
  get levelRoot() { return this.destination === 'company' ? this.companyRoot : this.activeMoon.root; }
  get levelCollider() { return this.destination === 'company' ? this.companyCollider : this.activeMoon.collider; }
  get levelName() { return this.destination === 'company' ? 'THE COMPANY BUILDING' : this.activeMoon.name; }
  get levelCatalog() { return this.atCompany ? null : this.activeMoon.catalog; }
  get atCompany() { return this.destination === 'company'; }

  setExteriorVisible(visible) {
    for (const [key, moon] of Object.entries(this.moons)) moon.root.visible = visible && this.destination === key;
    this.companyRoot.visible = visible && this.atCompany;
  }

  async load(progress) {
    const lib = this.lib;
    const shipMan = await lib.manifest('scenes/ship.json');
    progress && progress('Assembling the ship...');
    const shipInst = await lib.instantiate(shipMan, { lights: true });
    this.ship = shipInst;
    const shipObj = shipInst.root.children[0];      // HangarShip
    this.shipObj = shipObj;
    // ship root = Unity Environment; HangarShip local transform is what the clips animate
    shipObj.position.copy(SHIP_LANDED_LOCAL); shipObj.quaternion.identity();
    this.shipRoot.position.copy(ENVIRONMENT_POS);
    this.shipRoot.add(shipInst.root);
    this.shipRoot.updateMatrixWorld(true);
    this.shipLandingPos.copy(shipObj.getWorldPosition(new THREE.Vector3()));
    this._setupShipParts();
    // static ship collision (ship-local), minus the animated door panels which get their own moving colliders
    // Unity layers that the player never collides with in the game (interact triggers, placement volumes, triggers, radar, scan)
    const NOCOLLIDE = new Set([9, 13, 14, 15, 22, 26, 29]);
    const animDoor = shipInst.byName.get('AnimatedShipDoor')?.[0];
    const doorBlocker = animDoor ? animDoor.children.find(c => c.name === 'Cube') : null;   // animated doorway blocker
    const doorNames = new Set(['HangarDoorLeft', 'HangarDoorRight', 'HangarDoorLeft (1)', 'HangarDoorRight (1)']);
    const dynamicIds = new Set([doorBlocker && doorBlocker.userData.node.id].filter(Boolean));
    const entries = await collisionEntries(lib, shipInst, { relativeTo: shipObj, exclude: n => doorNames.has(n.name) || dynamicIds.has(n.id) || NOCOLLIDE.has(n.layer) });
    this.shipCollider = new Collider('ship').build(entries, shipObj);
    this.colliders.push(this.shipCollider);
    for (const o of [shipInst.byName.get('HangarDoorLeft (1)')?.[0], shipInst.byName.get('HangarDoorRight (1)')?.[0], doorBlocker]) {
      if (!o) continue;
      const id = o.userData.node.id;
      const e = await collisionEntries(lib, shipInst, { relativeTo: o, only: n => n.id === id });
      const c = new Collider('door').build(e, o); this.doorColliders.push(c); this.colliders.push(c);
    }
    await this._setupShipAnimators();

    for (const moon of Object.values(this.moons)) {
      progress && progress(`Loading ${moon.name}...`);
      let moonMan;
      try { moonMan = await lib.manifest(`scenes/${moon.asset}.json`); }
      catch (e) { if (moon.optional) { console.warn('moon assets missing, skipping', moon.key); delete this.moons[moon.key]; continue; } throw e; }
      const moonInst = await lib.instantiate(moonMan, { lights: true, staticRoot: moon.root });
      moon.inst = moonInst;
      moon.root.add(moonInst.root);
      moon.root.visible = false;
      // layer 15 = nav-mesh-only boxes, 22 = scan nodes, and the other trigger-only layers.
      const mEntries = await collisionEntries(lib, moonInst, { exclude: n => NOCOLLIDE.has(n.layer) });
      moon.collider = new Collider(moon.key).build(mEntries, null);
      this.colliders.push(moon.collider);
      this._setupMoonParts(moon);
    }
    progress && progress('Loading the Company building...');
    try {
      const cMan = await lib.manifest('scenes/company.json');
      const cInst = await lib.instantiate(cMan, { lights: true, staticRoot: this.companyRoot });
      this.company = cInst;
      this.companyRoot.add(cInst.root); this.companyRoot.visible = false;
      const cEntries = await collisionEntries(lib, cInst, { exclude: n => NOCOLLIDE.has(n.layer) });
      this.companyCollider = new Collider('company').build(cEntries, null);
      this.colliders.push(this.companyCollider);
      cInst.root.traverse(o => { if (o.isLight) { o.userData.baseIntensity = o.intensity; if (o.isPointLight || o.isSpotLight) { o.intensity = Math.min(o.userData.baseIntensity, 60) * 0.03; } else if (o.isDirectionalLight) o.visible = false; this.companyLights.push(o); } });
      this._setupCompanyParts();
    } catch (e) { console.warn('company building not available', e); }
    this._setupSky();
    this.setShipState('orbit', true);
    return this;
  }

  // ---------- the Company building ----------
  _setupCompanyParts() {
    const inst = this.company; const by = n => inst.byName.get(n) || [];
    const deskNode = by('DoorAndHookAnim')[0]; if (!deskNode) return;
    const mb = deskNode.userData.node.comps.find(c => c.t === 'MB' && c.cls === 'DepositItemsDesk');
    const d = mb && mb.d ? mb.d : {};
    const sellCube = by('InteractCube')[0];
    const bellTrig = by('BellDinger')[0] ? by('BellDinger')[0].children.find(c => c.name === 'Trigger') : null;
    const bellAnimNode = by('BellDingerAnimContainer')[0];
    const ac = deskNode.userData.node.comps.find(c => c.t === 'Animator');
    const bac = bellAnimNode ? bellAnimNode.userData.node.comps.find(c => c.t === 'Animator') : null;
    const bellAudio = bellTrig ? bellTrig.userData.node.comps.find(c => c.t === 'Audio') : null;
    const musicNode = by('Music')[0]; const musicAudio = musicNode ? musicNode.userData.node.comps.find(c => c.t === 'Audio') : null;
    // counter box in world space (the InteractCube's box)
    const box = sellCube ? sellCube.userData.node.comps.find(c => c.t === 'Box') : null;
    this.desk = {
      node: deskNode, sellCube, bellTrig, items: [], busy: false,
      anim: ac && ac.controller ? new Animator(deskNode, ac.controller) : null,
      bellAnim: bac && bac.controller ? new Animator(bellAnimNode, bac.controller) : null,
      clips: { doorOpen: d.doorOpenSFX && d.doorOpenSFX.$, doorShut: d.doorShutSFX && d.doorShutSFX.$, rumble: d.rumbleSFX && d.rumbleSFX.$, good: d.rewardGood && d.rewardGood.$, bad: d.rewardBad && d.rewardBad.$, mic: (d.microphoneAudios || []).map(x => x && x.$).filter(Boolean), bell: bellAudio && bellAudio.clip, music: musicAudio && musicAudio.clip },
      counterBox: box ? { center: new THREE.Vector3(box.c[0], box.c[1], box.c[2]), size: new THREE.Vector3(box.s[0], box.s[1], box.s[2]) } : null,
    };
    if (this.desk.anim) this.desk.anim.load(); if (this.desk.bellAnim) this.desk.bellAnim.load();
    if (sellCube) this.interactables.push({ obj: sellCube, radius: 1.6, reach: 2.8, area: 'company', label: () => this.game.items.inventory[this.game.items.active] ? '[E] Place item on counter' : 'Counter', action: () => this.game.items.placeOnCounter() });
    if (bellTrig) this.interactables.push({ obj: bellTrig, radius: 0.8, reach: 2.4, area: 'company', label: () => '[E] Ring bell', action: () => this.ringBell() });
  }

  /** is this world position on the counter (inside the deposit box)? */
  onCounter(p) {
    const d = this.desk; if (!d || !d.sellCube || !d.counterBox) return false;
    const l = d.sellCube.worldToLocal(p.clone()).sub(d.counterBox.center);
    return Math.abs(l.x) < d.counterBox.size.x / 2 + 0.3 && Math.abs(l.y) < d.counterBox.size.y / 2 + 0.8 && Math.abs(l.z) < d.counterBox.size.z / 2 + 0.3;
  }
  counterPoint() { const d = this.desk; return d && d.sellCube ? d.sellCube.localToWorld(d.counterBox.center.clone()) : null; }

  buyingRate() { const g = this.game; return g.daysLeft <= 0 ? 1 : 0.3 + (0.7 / 3) * (3 - g.daysLeft); }

  ringBell() {
    const d = this.desk, g = this.game; if (!d || d.busy) return;
    if (d.bellAnim && d.bellAnim.ready) d.bellAnim.play('BellDingerPress', { once: true, loop: false, fade: 0 });
    if (d.clips.bell) g.sound.play(d.clips.bell, { pos: this.worldPosOf(d.bellTrig), vol: 0.9 });
    const items = g.items.itemsOnCounter();
    if (!items.length) { g.hud.showTip('Place scrap on the counter first.', 3); return; }
    d.busy = true;
    const pos = this.counterPoint();
    setTimeout(() => {
      if (d.anim && d.anim.ready) d.anim.play('DoorOpen', { once: true, loop: false, fade: 0 });
      if (d.clips.doorOpen) g.sound.play(d.clips.doorOpen, { pos, vol: 0.9 });
      if (d.clips.mic.length) g.sound.play(d.clips.mic[Math.floor(Math.random() * d.clips.mic.length)], { pos, vol: 0.8 });
    }, 1200);
    setTimeout(() => {
      if (d.anim && d.anim.ready) d.anim.play('HookSwoop', { once: true, loop: false, fade: 0 });
      if (d.clips.rumble) g.sound.play(d.clips.rumble, { pos, vol: 0.7 });
    }, 3200);
    setTimeout(() => {
      const total = items.reduce((a, it) => a + (it.value || 0), 0);
      const rate = this.buyingRate();
      const profit = Math.round(total * rate);
      const quotaWasMet = g.quotaFulfilled >= g.quota;
      g.items.removeItems(items);
      g.credits += profit; g.quotaFulfilled += profit;
      g.hud.showNotice(`SOLD ${items.length} ITEM${items.length === 1 ? '' : 'S'} FOR $${profit}  (${Math.round(rate * 100)}%)`, 5, '#8fdc7a');
      const clip = profit >= g.credits / 4 ? d.clips.good : d.clips.bad; if (clip) g.sound.play(clip, { pos, vol: 0.9 });
      if (!quotaWasMet && g.quotaFulfilled >= g.quota) { const q = g.items.sfx('reachedQuota'); if (q) g.sound.play(q, { vol: 0.7 }); }
      if (d.anim && d.anim.ready) d.anim.play('DoorClose', { once: true, loop: false, fade: 0 });
      if (d.clips.doorShut) g.sound.play(d.clips.doorShut, { pos, vol: 0.9 });
      d.busy = false;
      g.hud.setQuota(g.quotaFulfilled, g.quota, g.daysLeft, g.credits);
    }, 5200);
  }

  // ---------- ship ----------
  _setupShipParts() {
    const by = n => this.ship.byName.get(n)?.[0] || null;
    this.by = by;
    // the HangarShip-level door copies are only used by the landing cutscene; the AnimatedShipDoor pair is the real door
    for (const n of ['HangarDoorLeft', 'HangarDoorRight']) { const o = by(n); if (o) o.visible = false; }
    this.doorL = by('HangarDoorLeft (1)'); this.doorR = by('HangarDoorRight (1)');
    this.lever = by('StartGameLever'); this.leverModel = by('HangarDoorLever');
    this.lightSwitch = by('LightSwitch') || by('LightSwitchContainer');
    this.terminal = by('Terminal');
    this.clipboard = by('ClipboardManual');
    this.btnOpen = by('StartButton'); this.btnClose = by('StopButton');
    this.animDoorNode = by('AnimatedShipDoor'); this.buttonPanel = by('HangarDoorButtonPanel');
    this.lightsNode = by('ShipElectricLights');
    const clipOf = n => { const o = by(n); if (!o) return null; const c = o.userData.node.comps.find(x => x.t === 'Audio'); return c ? c.clip : null; };
    this.clips = {
      thruster: clipOf('ThrusterAmbientAudio'), turbulence: clipOf('ShipLandingTurbulence'), lamp: clipOf('LampSqueakAudio'),
      doorsJingle: clipOf('ShipDoorsCloseJingle'), hangarDoor: clipOf('HangarDoorAudioSource'), shipAmb: clipOf('HangarShip'),
    };
    const mb = (o, cls) => o ? (o.userData.node.comps.find(x => x.t === 'MB' && x.cls === cls) || null) : null;
    const shipDoorEv = mb(this.animDoorNode, 'PlayAudioAnimationEvent');
    if (shipDoorEv && shipDoorEv.d) { this.clips.doorOpen = shipDoorEv.d.audioClip?.$ || null; this.clips.doorShut = shipDoorEv.d.audioClip2?.$ || null; }
    const leverEv = mb(this.leverModel, 'PlayAudioAnimationEvent');
    if (leverEv && leverEv.d) { this.clips.leverStart = leverEv.d.audioClip2?.$ || leverEv.d.audioClip?.$; this.clips.leverEnd = leverEv.d.audioClip?.$; }
    const sw = mb(this.lightSwitch, 'AnimatedObjectTrigger');
    if (sw && sw.d) { this.clips.switchOn = sw.d.boolTrueAudios?.[0]?.$ || sw.d.boolFalseAudios?.[0]?.$; }
    const btn = mb(this.btnOpen ? this.btnOpen.children.find(c => c.name.startsWith('Cube')) : null, 'AnimatedObjectTrigger');
    if (btn && btn.d) this.clips.button = btn.d.boolTrueAudios?.[0]?.$ || btn.d.boolFalseAudios?.[0]?.$;
    // ship lights: point lights from the manifest; lamp materials glow
    this.shipLights = [];
    this.ship.root.traverse(o => { if (o.isLight) { o.userData.baseIntensity = o.intensity; this.shipLights.push(o); } });
    this.lampMaterials = new Set();
    this.ship.root.traverse(o => { if (o.isMesh && o.material && o.material.emissive && o.material.emissiveIntensity > 0.05) { o.material.userData.baseEmissive = o.material.emissiveIntensity; this.lampMaterials.add(o.material); } });
    // interactables
    if (this.lever) this.interactables.push({ obj: this.lever, radius: 1.5, reach: 2.5, label: () => this.shipState === 'orbit' ? '[E] Pull lever : land ship' : this.shipState === 'landed' ? '[E] Pull lever : leave moon' : '', action: () => this.pullLever() });
    if (this.lightSwitch) this.interactables.push({ obj: this.lightSwitch, radius: 1.0, reach: 2.2, label: () => '[E] Switch lights', action: () => this.toggleLights() });
    if (this.terminal) this.interactables.push({ obj: this.terminal, radius: 1.6, reach: 2.5, label: () => '[E] Use terminal', action: () => this.game.openTerminal() });
    if (this.clipboard) this.interactables.push({ obj: this.clipboard, radius: 1.0, label: () => '[E] Read clipboard', action: () => this.game.showManual() });
    if (this.btnOpen) this.interactables.push({ obj: this.btnOpen, radius: 0.5, reach: 2.2, label: () => this.doorsOpen ? 'Open door' : '[E] Open door', action: () => this.pressDoorButton(true) });
    // ladders on the ship (they move with it, so their world positions are read when used)
    for (const [id, o] of this.ship.objs) {
      const n = o.userData.node;
      const lt = n.comps.find(c => c.t === 'MB' && c.cls === 'InteractTrigger' && c.d && c.d.isLadder);
      if (!lt) continue;
      const get = k => { const r = lt.d[k]; return r && r.$ ? this.ship.objs.get(r.$) : null; };
      const top = get('topOfLadderPosition'), bottom = get('bottomOfLadderPosition'), node = get('ladderPlayerPositionNode') || get('ladderHorizontalPosition') || o;
      if (!top || !bottom) continue;
      const ld = { obj: o, top, bottom, node, tip: 'Climb' };
      const refresh = () => { ld.topPos = this.worldPosOf(top); ld.bottomPos = this.worldPosOf(bottom); const hp = this.worldPosOf(node); ld.lineX = hp.x; ld.lineZ = hp.z; ld.height = Math.abs(ld.topPos.y - ld.bottomPos.y); };
      this.interactables.push({ obj: o, radius: 0.9, reach: 2.4, segment: () => [this.worldPosOf(bottom), this.worldPosOf(top)], label: () => '[E] Climb ladder', action: () => { refresh(); this.game.player.startLadder(ld); } });
    }
    // item charger
    const chargeTrig = [...this.ship.objs.values()].find(o => o.userData.node.comps.some(c => c.t === 'MB' && c.cls === 'ItemCharger'));
    if (chargeTrig) {
      const cs = by('ChargeStation');
      const ac = cs ? cs.userData.node.comps.find(c => c.t === 'Animator') : null;
      const zap = chargeTrig.userData.node.comps.find(c => c.t === 'Audio');
      this.interactables.push({ obj: chargeTrig, radius: 1.0, reach: 2.2, label: () => '[E] Charge item', action: () => {
        if (this.game.items.chargeHeld()) {
          if (this.anims.charger && this.anims.charger.ready) this.anims.charger.play(this.anims.charger.names()[0], { once: true, loop: false, fade: 0 });
          if (zap && zap.clip) this.game.sound.play(zap.clip, { pos: this.worldPosOf(chargeTrig), vol: 0.8 });
        }
      } });
      if (cs && ac && ac.controller) { this.anims.charger = new Animator(cs, ac.controller); this.anims.charger.load(); }
    }
    if (this.btnClose) this.interactables.push({ obj: this.btnClose, radius: 0.5, reach: 2.2, label: () => !this.doorsOpen ? 'Close door' : '[E] Close door', action: () => this.pressDoorButton(false) });
  }

  async _setupShipAnimators() {
    const mk = async (obj, ctrl) => { if (!obj) return null; const a = new Animator(obj, ctrl); await a.load(); return a.ready && a.names().length ? a : null; };
    const ctrlOf = o => o ? (o.userData.node.comps.find(c => c.t === 'Animator') || {}).controller : null;
    this.anims.ship = await mk(this.shipObj, ctrlOf(this.shipObj));
    this.anims.door = await mk(this.animDoorNode, ctrlOf(this.animDoorNode));
    this.anims.lever = await mk(this.leverModel, ctrlOf(this.leverModel));
    this.anims.lights = await mk(this.lightsNode, ctrlOf(this.lightsNode));
    this.anims.switch = await mk(this.lightSwitch, ctrlOf(this.lightSwitch));
    this.anims.panel = await mk(this.buttonPanel, ctrlOf(this.buttonPanel));
    console.log('ship animators', Object.fromEntries(Object.entries(this.anims).map(([k, v]) => [k, v ? v.names().join(',') : null])));
  }

  playShip(name, opts) { const a = this.anims.ship; if (a && a.has(name)) return a.play(name, opts); return null; }

  toggleLights() {
    this.lightsOn = !this.lightsOn;
    this.game.sound.play(this.clips.switchOn, { pos: this.worldPosOf(this.lightSwitch), vol: 0.7 });
    if (this.anims.switch) this.anims.switch.play('LightSwitchFlick', { once: true, loop: false, fade: 0 });
  }

  worldPosOf(o) { const v = new THREE.Vector3(); o.getWorldPosition(v); return v; }

  pullLever() {
    if (this.shipState !== 'orbit' && this.shipState !== 'landed') return;
    const landing = this.shipState === 'orbit';
    if (this.anims.lever) this.anims.lever.play(landing ? 'IntroLeverPull' : 'IntroLeverPush', { once: true, loop: false, fade: 0.05 });
    this.game.sound.play(landing ? this.clips.leverStart : this.clips.leverEnd, { pos: this.worldPosOf(this.lever), vol: 0.8 });
    if (landing) { this.setShipState('landing'); this.game.onShipDeparting(false); }
    else { this.setShipState('leaving'); this.game.onShipDeparting(true); }
  }

  pressDoorButton(open) {
    if (this.shipState === 'orbit' && open) { this.game.hud.showTip('The doors stay shut in orbit.', 2); return; }
    if (this.anims.panel) this.anims.panel.play(open ? 'StartButton' : 'StopButton', { once: true, loop: false, fade: 0 });
    if (this.clips.button) this.game.sound.play(this.clips.button, { pos: this.worldPosOf(open ? this.btnOpen : this.btnClose), vol: 0.6 });
    this.setDoors(open);
  }

  setShipState(s, instant = false) {
    this.shipState = s; this.shipT = 0;
    const a = this.anims.ship;
    if (s === 'orbit') {
      this.setExteriorVisible(false);
      this.setDoors(false, true);
      if (a && a.has('ShipIdle')) a.play('ShipIdle', { fade: instant ? 0 : 0.5 });
      else this.shipObj.position.copy(SHIP_LANDED_LOCAL).add(new THREE.Vector3(-98, 70, 0));
    }
    if (s === 'landing') {
      this.levelRoot.visible = true;
      this.startLoop('turbulence', this.clips.turbulence, { vol: 0.9 });
      this.setDoors(true);   // doors open for the descent: you watch the moon come up instead of staring at a wall
      if (a && a.has('HangarShipLandB')) { const act = a.play('HangarShipLandB', { once: true, loop: false, fade: 0.2 }); this.shipClipLen = a.clips.get('HangarShipLandB').data.length; }
      else this.shipClipLen = 9;
    }
    if (s === 'landed') {
      this.stopLoop('turbulence');
      if (a && a.has('ShipIdleLanded')) a.play('ShipIdleLanded', { once: true, loop: false, fade: 0.1 });
      else this.shipObj.position.copy(SHIP_LANDED_LOCAL);
      this.setDoors(true);
      this.time = 0;
    }
    if (s === 'leaving') {
      this.setDoors(false);
      this.startLoop('turbulence', this.clips.turbulence, { vol: 0.9 });
      if (a && a.has('ShipLeave')) { a.play('ShipLeave', { once: true, loop: false, fade: 0.2 }); this.shipClipLen = a.clips.get('ShipLeave').data.length; }
      else this.shipClipLen = 8;
    }
  }

  setDoors(open, instant = false) {
    if (this.doorsOpen === open && !instant) return;
    this.doorsOpen = open;
    const a = this.anims.door;
    if (a) {
      const name = open ? 'ShipDoorOpen' : 'ShipDoorClose';
      if (a.has(name)) { const act = a.play(name, { once: true, loop: false, fade: 0 }); if (instant && act) { act.time = a.clips.get(name).data.length - 0.001; a.mixer.update(0); } }
    }
    if (!instant) this.game.sound.play(open ? this.clips.doorOpen : this.clips.doorShut, { pos: this.worldPosOf(this.doorL || this.shipObj), vol: 0.9, min: 3, max: 60 });
  }

  startLoop(name, clip, opts) {
    if (!clip || this.loops[name]) return;
    this.loops[name] = true;
    this.game.sound.play(clip, { loop: true, ...opts }).then(h => { if (this.loops[name] === true) this.loops[name] = h; else if (h) h.stop(); });
  }
  stopLoop(name, fade = 1) { const h = this.loops[name]; if (h && h !== true) h.stop(fade); delete this.loops[name]; }

  // ---------- moon ----------
  _setupMoonParts(moon) {
    const inst = moon.inst;
    const by = n => inst.byName.get(n) || [];
    const ents = [];
    for (const [id, o] of inst.objs) {
      const n = o.userData.node;
      const et = n.comps.find(c => c.t === 'MB' && c.cls === 'EntranceTeleport');
      if (et) {
        const tp = o.children.find(ch => ch.name === 'telePoint');
        ents.push({ obj: o, tele: tp || o, id: et.d?.entranceId ?? 0, isEntrance: et.d?.isEntranceToBuilding, clips: [et.d?.doorAudios?.[0]?.$, et.d?.doorAudios?.[1]?.$].filter(Boolean) });
      }
      // ladders
      const lt = n.comps.find(c => c.t === 'MB' && c.cls === 'InteractTrigger' && c.d && c.d.isLadder);
      if (lt) {
        const get = k => { const r = lt.d[k]; return r && r.$ ? inst.objs.get(r.$) : null; };
        const top = get('topOfLadderPosition'), bottom = get('bottomOfLadderPosition'), horiz = get('ladderHorizontalPosition'), node = get('ladderPlayerPositionNode');
        if (top && bottom) moon.ladders.push({ obj: o, top, bottom, horiz: horiz || o, node: node || horiz || o, tip: lt.d.hoverTip || 'Climb' });
      }
    }
    ents.sort((a, b) => a.id - b.id);
    moon.entrance = ents[0] || null; moon.fireExit = ents[1] || null;
    for (const e of ents) {
      const isFire = e !== moon.entrance;
      this.interactables.push({ obj: e.obj, radius: 1.8, reach: 3.0, area: moon.key, label: () => this.game.dungeon.placed.length ? (isFire ? '[E] Enter (fire exit)' : '[E] Enter facility') : 'Facility is sealed', action: () => { if (this.game.dungeon.placed.length) { this.playEntranceDoor(true); this.game.enterFacility(isFire); } } });
    }
    // the main entrance's visible double doors have their own animator
    const vis = by('OutsideEntranceVisualDoorsContainer')[0];
    if (vis) { const ac = vis.userData.node.comps.find(c => c.t === 'Animator'); if (ac && ac.controller) { moon.entranceAnim = new Animator(vis, ac.controller); moon.entranceAnim.load(); } }
    for (const o of by('OutsideAIPoints')) o.children.forEach(c => moon.outsideNodes.push(this.worldPosOf(c)));
    if (!moon.outsideNodes.length) { inst.root.traverse(o => { if (/OutsideAINode/.test(o.name)) moon.outsideNodes.push(this.worldPosOf(o)); }); }
    inst.root.traverse(o => { if (o.isLight) { o.userData.baseIntensity = o.intensity; moon.lights.push(o); } });
    for (const l of moon.lights) {
      if (l.isPointLight || l.isSpotLight) { l.intensity = Math.min(l.userData.baseIntensity, 60) * 0.03; l.distance = Math.max(l.distance, 14); l.decay = 2; l.castShadow = false; }
      else if (l.isDirectionalLight) { l.visible = false; }
    }
    // deep water / drop kill triggers on the moon (March drowns you)
    moon.killZones = [];
    for (const [id, o] of inst.objs) {
      const n = o.userData.node; if (!n || !/KillTrigger/.test(n.name)) continue;
      const box = n.comps.find(c => c.t === 'Box'); if (!box) continue;
      o.updateMatrixWorld(true);
      const centre = o.localToWorld(new THREE.Vector3(box.c[0], box.c[1], box.c[2])); const sc = o.getWorldScale(new THREE.Vector3());
      const half = new THREE.Vector3(Math.abs(box.s[0] * sc.x), Math.abs(box.s[1] * sc.y), Math.abs(box.s[2] * sc.z)).multiplyScalar(0.5);
      moon.killZones.push(new THREE.Box3(centre.clone().sub(half), centre.clone().add(half)));
    }
    for (const ld of moon.ladders) {
      const top = this.worldPosOf(ld.top), bottom = this.worldPosOf(ld.bottom);
      const mid = top.clone().add(bottom).multiplyScalar(0.5);
      ld.topPos = top; ld.bottomPos = bottom; ld.height = Math.abs(top.y - bottom.y);
      const hp = this.worldPosOf(ld.node);
      ld.lineX = hp.x; ld.lineZ = hp.z;
      // the reachable part runs down to the trigger box / the ladder's standing node: a mod ladder can have its bottom
      // exit point metres above the ground (Eve's outpost ladder), and the climb then starts from that height like the game
      const low = bottom.clone(); low.y = Math.min(low.y, this.worldPosOf(ld.horiz).y, this.worldPosOf(ld.obj).y - 1.2);
      ld.reachPos = low;
      this.interactables.push({ pos: mid, radius: 0.9, reach: 2.4, segment: () => [ld.reachPos, ld.topPos], label: () => '[E] Climb ladder', action: () => this.game.player.startLadder(ld), area: moon.key });
    }
  }

  // ---------- sky / time ----------
  _setupSky() {
    this.sun = new THREE.DirectionalLight(0xffe6c8, 1.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 400;
    const s = 70; this.sun.shadow.camera.left = -s; this.sun.shadow.camera.right = s; this.sun.shadow.camera.top = s; this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0008; this.sun.shadow.normalBias = 0.05;
    this.sunTarget = new THREE.Object3D(); this.scene.add(this.sunTarget); this.sun.target = this.sunTarget;
    this.scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x8a7e78, 0x2a2118, 0.6); this.hemi.layers.enable(1); this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0x403830, 0.35); this.scene.add(this.ambient);
    this.scene.fog = new THREE.FogExp2(0x5c4e44, 0.012);
    this.scene.background = new THREE.Color(0x5c4e44);
    const g = new THREE.BufferGeometry(); const pts = [];
    for (let i = 0; i < 1500; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(900); pts.push(v.x, v.y, v.z); }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: true, fog: false }));
    this.scene.add(this.stars);
    const planet = new THREE.Mesh(new THREE.SphereGeometry(260, 48, 32), new THREE.MeshStandardMaterial({ color: 0x7a5a48, roughness: 1, fog: false }));
    planet.position.set(120, -420, -520); this.planet = planet; this.scene.add(planet);
  }

  get inOrbit() { return this.shipState === 'orbit'; }

  update(dt) {
    for (const a of Object.values(this.anims)) if (a) a.update(dt);
    for (const moon of Object.values(this.moons)) if (moon.entranceAnim) moon.entranceAnim.update(dt);
    if (this.shipState === 'landing') {
      this.shipT += dt;
      if (this.shipT >= (this.shipClipLen || 9) - 0.05) { this.setShipState('landed'); this.game.onShipLanded(); }
    } else if (this.shipState === 'leaving') {
      this.shipT += dt;
      if (this.shipT >= (this.shipClipLen || 8) - 0.05) { this.setShipState('orbit'); this.game.onShipLeft(); }
    } else if (this.shipState === 'landed') {
      this.time += dt;
    }
    this.shipRoot.updateMatrixWorld(true);
    if (this.shipState === 'landed' || this.shipState === 'leaving') this.dayFrac = Math.min(1, this.time / DAY_SECONDS);
    this.hour = START_HOUR + this.dayFrac * (END_HOUR - START_HOUR);
    this._updateSky();
    const lit = this.lightsOn ? 1 : 0;
    for (const m of this.lampMaterials) m.emissiveIntensity += ((m.userData.baseEmissive || 1) * lit - m.emissiveIntensity) * Math.min(1, dt * 10);
  }

  _updateSky() {
    const orbit = this.shipState === 'orbit';
    const f = this.atCompany ? 0.35 : this.dayFrac;   // the Company sits in permanent overcast afternoon
    const elev = orbit ? 0.6 : Math.sin(Math.PI * Math.min(1, Math.max(0, (f - 0.02) / 0.72))) * 0.95 - 0.05;
    const dusk = THREE.MathUtils.smoothstep(f, 0.55, 0.78);
    const night = THREE.MathUtils.smoothstep(f, 0.7, 0.9);
    const az = -0.8 + f * 2.6;
    this.sun.position.set(Math.cos(az) * 120, Math.max(0.03, elev) * 150, Math.sin(az) * 120).add(this.sunTarget.position);
    const moon = this.atCompany ? null : this.activeMoon;
    const dayCol = new THREE.Color(moon && moon.sunDay ? moon.sunDay : 0xffe2c0), duskCol = new THREE.Color(0xd06a3a), nightCol = new THREE.Color(0x1a2038);
    this.sun.color.copy(dayCol.clone().lerp(duskCol, dusk).lerp(nightCol, night));
    this.sun.intensity = (orbit ? 2.0 : (1.4 * Math.max(0, elev) + 0.15) * (1 - night * 0.97)) * (moon && moon.sunScale ? moon.sunScale : 1);
    const fogDay = new THREE.Color(moon && moon.fogDay ? moon.fogDay : 0x5e5048), fogDusk = new THREE.Color(moon && moon.fogDusk ? moon.fogDusk : 0x3f2b24), fogNight = new THREE.Color(0x07080b);
    const fog = fogDay.clone().lerp(fogDusk, dusk).lerp(fogNight, night);
    let fogScale = moon && moon.fogScale ? moon.fogScale : 1;
    if (this.shipState === 'landing') { const k = THREE.MathUtils.smoothstep(this.shipT / (this.shipClipLen || 9), 0.55, 0.95); fogScale = THREE.MathUtils.lerp(Math.min(0.35, fogScale), fogScale, k); }
    else if (this.shipState === 'leaving') { const k = THREE.MathUtils.smoothstep(this.shipT / (this.shipClipLen || 8), 0.1, 0.6); fogScale = THREE.MathUtils.lerp(fogScale, Math.min(0.35, fogScale), k); }
    if (orbit) { this.scene.fog.density = 0.0; this.scene.background.set(0x000004); this.stars.visible = true; this.planet.visible = true; }
    else { this.scene.fog.color.copy(fog); this.scene.fog.density = (0.011 + night * 0.006) * fogScale; this.scene.background.copy(fog); this.stars.visible = night > 0.6; this.planet.visible = false; }
    if (this.hemi) this.hemi.color.set(moon && moon.hemiSky ? moon.hemiSky : 0x8a7e78);
    if (this.game.inside) { this.scene.fog.color.set(0x030303); this.scene.fog.density = 0.028; this.scene.background.set(0x030303); this.stars.visible = false; this.planet.visible = false; }
    this.hemi.intensity = orbit ? 0.3 : this.game.inside ? 0.14 : 0.65 * (1 - night * 0.85) + 0.06;
    this.hemi.color.copy(new THREE.Color(0x9a8c84).lerp(new THREE.Color(0x202838), night));
    this.ambient.intensity = orbit ? 0.2 : this.game.inside ? 0.1 : 0.35 * (1 - night * 0.8) + 0.04;
  }

  playEntranceDoor(open) {
    const a = this.activeMoon.entranceAnim; if (!a || !a.ready) return;
    const name = a.find(open ? [/Open/] : [/Shut|Close/]); if (name) a.play(name, { once: true, loop: false, fade: 0 });
    if (!open) return;
    clearTimeout(this._entT); this._entT = setTimeout(() => this.playEntranceDoor(false), 2500);
  }

  setDayFrac(f) { this.dayFrac = Math.max(0, Math.min(1, f)); this.time = this.dayFrac * DAY_SECONDS; }

  setFocus(p) { this.sunTarget.position.copy(p); this.sunTarget.updateMatrixWorld(); }
  clockText() { const h = Math.floor(this.hour) % 24; const m = Math.floor((this.hour % 1) * 60); return { h, m }; }
  isNight() { return this.dayFrac > 0.72; }

  /** is a world point inside the ship's room (local box of HangarShip) */
  inShipRoom(worldPos) {
    const l = this.shipObj.worldToLocal(worldPos.clone());
    const b = this.roomBounds || { xMin: -10.8, xMax: 7.2, zMin: -12.6, zMax: -1.0 };   // the wider ship upgrade widens these
    return l.x > b.xMin && l.x < b.xMax && l.z > b.zMin && l.z < b.zMax && l.y > -2.5 && l.y < 5.5;
  }
  onShipDeck(worldPos) {
    const l = this.shipObj.worldToLocal(worldPos.clone());
    const b = this.deckBounds || { xMin: -11.5, xMax: 13, zMin: -13.5, zMax: 1.5 };
    return l.x > b.xMin && l.x < b.xMax && l.z > b.zMin && l.z < b.zMax && l.y > -3 && l.y < 6;
  }
}
