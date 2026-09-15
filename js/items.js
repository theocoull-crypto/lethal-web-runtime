// Scrap and tools: spawning, pickup, drop, inventory, ship counting, sound tables.
import * as THREE from 'three';
import { pickClip } from './audio.js';

const F = new THREE.Matrix4().makeScale(-1, 1, 1);
export function unityEulerToQuat(x, y, z) {
  const d = Math.PI / 180;
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x * d);
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), y * d);
  const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), z * d);
  const q = qy.multiply(qx).multiply(qz); // Unity: Z, then X, then Y
  return new THREE.Quaternion(q.x, -q.y, -q.z, q.w); // mirror X
}

// camera-relative poses for the store tools (rot = degrees YXZ, pos = camera space)
const HOLD_POSES = {
  BBFlashlight: { rot: [-90, 0, 0], pos: [0.38, -0.32, -0.55] },
  FlashlightItem: { rot: [-90, 0, 0], pos: [0.38, -0.32, -0.55] },
  WalkieTalkie: { rot: [-90, 0, -90], pos: [0.42, -0.42, -0.65] },
  ShovelItem: { rot: [-20, 15, -95], pos: [0.36, -0.42, -0.62] },
};

export class Items {
  constructor(game) {
    this.game = game; this.lib = game.lib;
    this.catalog = null;
    this.world = [];        // item instances in the world
    this.inventory = [null, null, null, null];
    this.active = 0;
    this.heldObj = null;
    this.sfxTable = {}; this.footsteps = {};
    this.ambience = { inside: 'b8_1757', outside: 'b7_174', cues: { inside: [], outside: [], ship: [] } };
    this.cueTimer = 20;
    this.swingT = 0;
    this.honks = 0;
    this.deliveries = []; this.deliveryTimer = 0;
  }

  // ---------- store deliveries ----------
  queueDelivery(tool, name) { this.deliveries.push({ tool, name }); if (this.deliveryTimer <= 0) this.deliveryTimer = 30; }
  onLanded() { if (this.deliveries.length && this.deliveryTimer <= 0) this.deliveryTimer = 25; }
  async makeTool(toolKey, displayName) {
    const t = this.toolDefs[toolKey]; if (!t) return null;
    const def = Object.assign({ name: displayName || toolKey, prefab: t.prefab, weight: 1.0 }, t.item, { itemName: t.item.itemName || displayName || toolKey });
    const it = await this.makeInstance(def, 0);
    it.name = def.itemName; it.tool = toolKey;
    if (/Flashlight/i.test(toolKey)) it.isFlashlight = true;
    if (def.requiresBattery) { it.battery = 1; it.batterySeconds = def.batteryUsage || 200; }
    return it;
  }

  /** the flashlight whose battery is used: the active one if it is a flashlight, else the first charged one */
  flashlightItem() {
    const a = this.inventory[this.active];
    if (a && a.isFlashlight) return a;
    return this.inventory.find(x => x && x.isFlashlight && (x.battery == null || x.battery > 0)) || this.inventory.find(x => x && x.isFlashlight) || null;
  }
  flashlightBattery() { const f = this.flashlightItem(); return f ? (f.battery == null ? 1 : f.battery) : 0; }
  chargeHeld() {
    const it = this.inventory[this.active];
    if (!it || it.battery == null) { this.game.hud.showTip('Hold a battery-powered item to charge it.', 3); return false; }
    it.battery = 1; this.select(this.active); return true;
  }

  async _deliver() {
    const g = this.game; const list = this.deliveries.splice(0);
    // drop next to the ship, in front of the door
    const base = g.world.shipObj.localToWorld(new THREE.Vector3(-14.5, 0.5, -6.5));
    const c = this.sfx('deliver'); if (c) g.sound.play(c, { pos: base, vol: 0.9, min: 4, max: 80 });
    for (let i = 0; i < list.length; i++) {
      const it = await this.makeTool(list[i].tool, list[i].name); if (!it) continue;
      g.scene.add(it.obj);
      this.placeOnFloor(it, base.clone().add(new THREE.Vector3((i % 3) * 0.9, 0.3, Math.floor(i / 3) * 0.9)), [g.world.levelCollider], Math.random() * 6.28);
      it.area = 'outside'; it.onShip = false;
      this.world.push(it);
    }
    g.hud.showTip('Your order has been delivered next to the ship.', 5);
  }

  async load() {
    const catalogs = Object.values(this.game.dungeon.catalogs);
    this.setCatalog(this.game.dungeon.catalog);
    const sys = await this.lib.manifest('scenes/systems.json').catch(() => null);
    const shipMan = await this.lib.manifest('scenes/ship.json').catch(() => null);
    const nodesAll = [].concat(sys ? sys.nodes : [], shipMan ? shipMan.nodes : []);
    if (sys) {
      for (const n of nodesAll) for (const c of n.comps) {
        if (c.t !== 'MB' || !c.d) continue;
        const d = c.d, id = x => x && x.$;
        if (c.cls === 'StartOfRound') {
          for (const s of (d.footstepSurfaces || [])) this.footsteps[(s.surfaceTag || '').toLowerCase()] = (s.clips || []).map(id).filter(Boolean);
          Object.assign(this.sfxTable, { damage: id(d.damageSFX), fallDamage: id(d.fallDamageSFX), landSoft: id(d.playerHitGroundSoft), landHard: id(d.playerHitGroundHard), jump: id(d.playerJumpSFX), death: id(d.playerFallDeath), grab: id(d.playerGrabSFX), space: id(d.suckedIntoSpaceSFX), fired: id(d.firedVoiceSFX), depart: id(d.shipDepartSFX), arrive: id(d.shipArriveSFX), alarm: id(d.alarmSFX), zeroDays: id(d.zeroDaysLeftAlertSFX), doorMetal: id(d.shutDoorMetal), intro: id(d.shipIntroSpeechSFX), systemAlert: id(d.HUDSystemAlertSFX), allDead: id(d.allPlayersDeadAudio) });
        }
        if (c.cls === 'Terminal') Object.assign(this.sfxTable, { enterTerminal: id(d.enterTerminalSFX), exitTerminal: id(d.leaveTerminalSFX), key: pickClip(d.keyboardClips), purchase: id(d.syncedAudios ? d.syncedAudios[0] : null) });
        if (c.cls === 'ItemDropship') Object.assign(this.sfxTable, { deliver: id(d.shipLandAudio || d.shipAudio) });
        if (c.cls === 'HUDManager') Object.assign(this.sfxTable, { scan: id(d.scanSFX), alert: pickClip(d.warningSFX), notify: id(d.globalNotificationSFX), results: pickClip(d.endStatsMusic), addScrap: id(d.addToScrapTotalSFX), finishScrap: id(d.finishAddingToTotalSFX), tips: pickClip(d.tipsSFX), newQuota: id(d.newProfitQuotaSFX), reachedQuota: id(d.reachedQuotaSFX), oneDay: id(d.OneDayToMeetQuotaSFX), critical: id(d.criticalInjury), uiSelect: id(d.levelIncreaseSFX), uiBack: id(d.levelDecreaseSFX), daysLeft: id(d.profitQuotaDaysLeftCalmSFX), collectedScrap: id(d.displayCollectedScrapSFX) });
        if (c.cls === 'SoundManager') Object.assign(this.sfxTable, { heartbeat: pickClip(d.heartbeatClips), steelOpen: pickClip(d.steelDoorOpenSFX), steelClose: pickClip(d.steelDoorCloseSFX) });
        if (c.cls === 'TimeOfDay') this.sfxTable.timeCues = (d.timeOfDayCues || []).map(id);
      }
    }
    // preload manifests
    const allScrap = catalogs.flatMap(c => c.scrap).filter(s => s.prefab);
    await Promise.all([...new Set(allScrap.map(s => s.prefab))].map(f => this.lib.manifest('prefabs/' + f).catch(() => null)));
    this.toolDefs = {};
    for (const catalog of catalogs) for (const [k, v] of Object.entries(catalog.tools)) if (!k.endsWith('_item') && v) { this.toolDefs[k] = { name: k, prefab: v, item: catalog.tools[k + '_item'] || {} }; await this.lib.manifest('prefabs/' + v).catch(() => null); }
    // flashlight click clips from the prefab
    // shovel clips (reel up / swing / hit) from the shovel prefab
    const sh = this.toolDefs.ShovelItem ? await this.lib.manifest('prefabs/' + this.toolDefs.ShovelItem.prefab).catch(() => null) : null;
    if (sh) for (const n of sh.nodes) for (const c of n.comps) if (c.t === 'MB' && c.cls === 'Shovel' && c.d) { const id = x => x && x.$; this.sfxTable.shovelReel = id(c.d.reelUp); this.sfxTable.shovelSwing = id(c.d.swing); this.sfxTable.shovelHit = (c.d.hitSFX || []).map(id).filter(Boolean); }
    for (const key of ['BBFlashlight', 'FlashlightItem']) {
      const fl = this.toolDefs[key] ? await this.lib.manifest('prefabs/' + this.toolDefs[key].prefab).catch(() => null) : null;
      if (fl) for (const n of fl.nodes) for (const c of n.comps) if (c.t === 'MB' && c.cls === 'FlashlightItem' && c.d) { const cl = (c.d.flashlightClips || []).map(x => x && x.$).filter(Boolean); if (cl.length && !this.sfxTable.flashOn) { this.sfxTable.flashOn = cl[0]; this.sfxTable.flashOff = cl[1] || cl[0]; } }
    }
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    this.defs = catalog.scrap.filter(s => s.prefab);
    this.ambience.cues = { inside: [], outside: [], ship: [] };
    const amb = catalog.level.ambienceData;
    if (amb) {
      this.ambience.cues.inside = (amb.insideAmbience || []).map(x => x && x.$).filter(Boolean);
      this.ambience.cues.outside = (amb.outsideAmbience || []).map(x => x && x.$).filter(Boolean);
      this.ambience.cues.ship = (amb.shipAmbience || []).map(x => x && x.$).filter(Boolean);
    }
  }

  sfx(name) { return this.sfxTable[name] || null; }
  footstep(surface) {
    const map = { metal: 'catwalk', concrete: 'concrete', dirt: 'gravel', rock: 'rock' };
    const list = this.footsteps[map[surface] || surface] || this.footsteps.concrete || [];
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }
  ambienceClip(area) { return this.ambience[area]; }

  // ---------- instances ----------
  async makeInstance(def, value) {
    const man = await this.lib.manifest('prefabs/' + def.prefab);
    const inst = await this.lib.instantiate(man, { lights: false });
    const rootObj = inst.root.children[0];
    const scale = rootObj ? rootObj.scale.clone() : new THREE.Vector3(1, 1, 1);
    if (rootObj) { rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); }
    // scan header text
    let scanName = def.itemName || def.name;
    for (const n of man.nodes) for (const c of n.comps) if (c.t === 'MB' && c.cls === 'ScanNodeProperties' && c.d && c.d.headerText) scanName = c.d.headerText;
    const bbox = new THREE.Box3().setFromObject(inst.root);
    const it = { def, value, obj: inst.root, inst, held: false, onShip: false, scanName, name: def.itemName || def.name, weightLb: Math.max(0, Math.round(((def.weight || 1) - 1) * 105)), twoHanded: !!def.twoHanded, size: bbox.getSize(new THREE.Vector3()), bboxMinY: bbox.min.y, grabSFX: pickClip(def.grabSFX), dropSFX: pickClip(def.dropSFX) };
    inst.root.userData.item = it;
    inst.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = true; } });
    return it;
  }

  restQuat(def) {
    const r = def.restingRotation || { x: 0, y: 0, z: 0 };
    return unityEulerToQuat(r.x || 0, r.y || 0, r.z || 0);
  }

  placeOnFloor(it, pos, colliders, yaw) {
    // raycast down to find the floor
    const origin = pos.clone(); origin.y += 1.5;
    let y = pos.y;
    for (const c of colliders) { const h = c.raycast(origin, new THREE.Vector3(0, -1, 0), 8); if (h) { y = h.point.y; break; } }
    it.obj.quaternion.copy(this.restQuat(it.def));
    if (yaw != null) it.obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    it.obj.position.set(pos.x, y, pos.z);
    it.obj.updateMatrixWorld(true);
    // lift so the lowest point sits on the floor
    const bb = new THREE.Box3().setFromObject(it.obj);
    if (isFinite(bb.min.y)) it.obj.position.y += (y - bb.min.y) + 0.01;
    it.obj.position.y += (it.def.floorYOffset || 0) * 0.0 ;
  }

  async spawnScrap() {
    this.clearWorldScrap();
    const lvl = this.catalog.level, d = this.game.dungeon;
    if (!d.scrapSpawns.length) return;
    const diff = this.game.difficulty ? this.game.difficulty() : 1;   // harder moons carry more scrap
    const count = Math.round((lvl.minScrap + Math.floor(Math.random() * (lvl.maxScrap - lvl.minScrap + 1))) * diff);
    const total = this.defs.reduce((a, s) => a + s.rarity, 0);
    const pick = () => { let r = Math.random() * total; for (const s of this.defs) { r -= s.rarity; if (r <= 0) return s; } return this.defs[0]; };
    const colliders = [d.collider];
    const spawns = d.scrapSpawns.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) {
      const def = pick();
      const value = Math.round((def.minValue + Math.random() * (def.maxValue - def.minValue)) * 0.4);
      const sp = spawns[i % spawns.length];
      const a = Math.random() * Math.PI * 2, r = Math.random() * Math.min(sp.range, 3);
      const pos = sp.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.5, Math.sin(a) * r));
      const it = await this.makeInstance(def, value);
      d.root.add(it.obj);
      this.placeOnFloor(it, pos, colliders, Math.random() * Math.PI * 2);
      it.area = 'inside';
      this.world.push(it);
    }
  }

  async giveStarterItems() {
    return;   // the demo starts with nothing, like the game: buy gear at the terminal
    if (this.inventory.some(x => x)) return;
    const fl = this.toolDefs.FlashlightItem;
    if (fl) {
      const def = Object.assign({ name: 'Pro-flashlight', prefab: fl.prefab, weight: 1.05, twoHanded: false }, fl.item, { itemName: fl.item.itemName || 'Pro-flashlight' });
      const it = await this.makeInstance(def, 0);
      it.isFlashlight = true; it.name = def.itemName;
      this.addToInventory(it, 0);
    }
    const w = this.toolDefs.WalkieTalkie;
    if (w) {
      const def = Object.assign({ name: 'Walkie-talkie', prefab: w.prefab, weight: 1.0 }, w.item, { itemName: w.item.itemName || 'Walkie-talkie' });
      const it = await this.makeInstance(def, 0); it.name = def.itemName;
      this.addToInventory(it, 1);
    }
    this.select(0);
  }

  // ---------- inventory ----------
  addToInventory(it, slot) {
    if (slot == null) { slot = this.inventory[this.active] ? this.inventory.findIndex(x => !x) : this.active; }
    if (slot < 0) return false;
    this.inventory[slot] = it; it.held = true; it.onShip = false;
    if (it.obj.parent) it.obj.parent.remove(it.obj);
    const i = this.world.indexOf(it); if (i >= 0) this.world.splice(i, 1);
    this.select(slot);
    this.updateWeight();
    return true;
  }

  select(i) {
    this.active = i;
    const it = this.inventory[i];
    if (this.heldObj) { this.game.camera.remove(this.heldObj); this.heldObj = null; }
    if (it) {
      const o = it.obj; this.heldObj = o;
      const pose = HOLD_POSES[it.tool] || null;
      if (pose) {
        o.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pose.rot[0]), THREE.MathUtils.degToRad(pose.rot[1]), THREE.MathUtils.degToRad(pose.rot[2]), 'YXZ'));
        o.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      } else {
        const ro = it.def.rotationOffset || { x: 0, y: 0, z: 0 }, po = it.def.positionOffset || { x: 0, y: 0, z: 0 };
        o.quaternion.copy(unityEulerToQuat(ro.x || 0, ro.y || 0, ro.z || 0));
        const base = it.twoHanded ? new THREE.Vector3(0.05, -0.5, -0.75) : new THREE.Vector3(0.42, -0.36, -0.62);
        o.position.copy(base).add(new THREE.Vector3(-(po.x || 0), po.y || 0, po.z || 0));
      }
      o.traverse(m => { if (m.isMesh) { m.frustumCulled = false; m.castShadow = false; m.layers.set(1); } });
      this.game.camera.add(o);
    }
    this.game.hud.setInventory(this.inventory.map(x => x ? { name: x.name, value: x.value, battery: x.battery } : null), this.active);
    this.game.flashlightOn = this.game.flashlightOn && this.hasFlashlight();
  }

  hasFlashlight() { return this.inventory.some(x => x && x.isFlashlight); }
  carryWeightLb() { return this.inventory.reduce((a, x) => a + (x ? x.weightLb : 0), 0); }
  updateWeight() { this.game.player.carryWeight = this.carryWeightLb(); }

  interactables() {
    const out = [];
    const eye = this.game.camera.position;
    for (const it of this.world) {
      if (it.carriedBy) continue;   // a hoarding bug has it
      if (it.area === 'inside' && !this.game.inside) continue;
      if (it.area !== 'inside' && this.game.inside) continue;
      if (it.area === 'company' && !this.game.world.atCompany) continue;
      if (it.area === 'outside' && this.game.world.atCompany) continue;
      const p = it.obj.getWorldPosition(new THREE.Vector3());
      if (p.distanceToSquared(eye) > 36) continue;
      out.push({ pos: p, radius: Math.max(0.5, Math.max(it.size.x, it.size.z) * 0.6 + 0.2), label: () => this.inventory.every(x => x) ? `${it.scanName}\n(inventory full)` : `[E] Grab ${it.scanName}${it.value ? '  $' + it.value : ''}`, action: () => this.pickUp(it) });
    }
    return out;
  }

  pickUp(it) {
    if (this.inventory.every(x => x)) return;
    if (!this.addToInventory(it)) return;
    const c = it.grabSFX || this.sfx('grab'); if (c) this.game.sound.play(c, { vol: 0.7 });
    this.game.enemies.onNoise(this.game.player.pos, 0.3);
  }

  dropHeld() {
    const it = this.inventory[this.active];
    if (!it) return;
    this.inventory[this.active] = null; it.held = false;
    this.game.camera.remove(it.obj);
    it.obj.traverse(m => { if (m.isMesh) { m.frustumCulled = true; m.castShadow = true; m.layers.set(0); } });
    const p = this.game.player;
    const fwd = p.forward(new THREE.Vector3());
    const pos = p.pos.clone().addScaledVector(fwd, 0.9); pos.y += 0.4;
    this._placeInWorld(it, pos);
    this.select(this.active);
    this.updateWeight();
    const c = it.dropSFX || this.sfx('grab'); if (c) this.game.sound.play(c, { vol: 0.6 });
  }

  dropAll() { for (let i = 0; i < 4; i++) { if (this.inventory[i]) { this.active = i; this.dropHeld(); } } this.select(0); }

  _placeInWorld(it, pos) {
    const g = this.game;
    if (g.inside) { g.dungeon.root.add(it.obj); this.placeOnFloor(it, pos, [g.dungeon.collider], g.player.yaw); it.area = 'inside'; it.onShip = false; }
    else {
      const onDeck = g.world.onShipDeck(pos);
      if (onDeck) { g.scene.add(it.obj); this.placeOnFloor(it, pos, [g.world.shipCollider, ...g.world.doorColliders], g.player.yaw); g.world.shipObj.attach(it.obj); it.onShip = g.world.inShipRoom(it.obj.getWorldPosition(new THREE.Vector3())); it.area = 'ship'; }
      else { g.scene.add(it.obj); this.placeOnFloor(it, pos, [g.world.levelCollider, g.world.shipCollider].filter(Boolean), g.player.yaw); it.onShip = false; it.area = g.world.atCompany ? 'company' : 'outside'; it.onCounter = g.world.atCompany && g.world.onCounter(it.obj.getWorldPosition(new THREE.Vector3())); }
    }
    this.world.push(it);
    if (it.onShip && it.value) {
      const c = this.sfx('addScrap'); if (c) g.sound.play(c, { vol: 0.55 });
      clearTimeout(this._scrapFinishTimer);
      this._scrapFinishTimer = setTimeout(() => { const done = this.sfx('finishScrap'); if (done) g.sound.play(done, { vol: 0.5 }); }, 650);
    }
  }

  useHeld() {
    const it = this.inventory[this.active];
    if (!it) return;
    const g = this.game;
    if (it.isFlashlight) { g.toggleFlashlight(); return; }
    const n = (it.def.name || '').toLowerCase();
    if (/airhorn|clownhorn|whoopie|bell|remote|boombox/.test(n)) {
      const clips = []; it.inst.manifest.nodes.forEach(nd => nd.comps.forEach(c => { if (c.t === 'MB' && c.d) { for (const k of Object.keys(c.d)) { const v = c.d[k]; if (Array.isArray(v)) v.forEach(x => { if (x && x.c === 'AudioClip') clips.push(x.$); }); else if (v && v.c === 'AudioClip') clips.push(v.$); } } }));
      const c = clips[Math.floor(Math.random() * clips.length)]; if (c) g.sound.play(c, { vol: 0.9 });
      g.enemies.onNoise(g.player.pos, 1.5);
      return;
    }
    if (/shovel|sign|stopsign|yieldsign/.test(n) || it.def.name === 'ShovelItem') { this.swing(it); return; }
    if (/walkie/.test(n)) { g.hud.showTip('Nobody is on the other end.', 2); return; }
  }

  /** shovel: reel up, then swing; whatever is in front gets hit at the bottom of the swing */
  swing(it) {
    if (this.swingT > 0) return;
    const g = this.game;
    this.swingT = 0.75; this.swingHit = false;
    const reel = this.sfx('shovelReel'); if (reel) g.sound.play(reel, { vol: 0.6 });
    setTimeout(() => {
      if (this.inventory[this.active] !== it) return;
      const sw = this.sfx('shovelSwing'); if (sw) g.sound.play(sw, { vol: 0.7 });
      g.enemies.onNoise(g.player.pos, 0.6);
      const hit = g.enemies.hitInFront(g.player, 2.6, 1);
      if (hit) { const h = this.sfx('shovelHit'); const c = Array.isArray(h) ? h[Math.floor(Math.random() * h.length)] : h; if (c) g.sound.play(c, { vol: 0.9 }); }
    }, 300);
  }

  /** the facility's apparatus (spawned with the tiles) is grabbable scrap worth $80 */
  registerApparatus(inst) {
    const root = inst.root;
    const bbox = new THREE.Box3().setFromObject(root);
    const def = { name: 'Apparatus', itemName: 'Apparatus', weight: 1.25, twoHanded: false, restingRotation: { x: 0, y: 0, z: 0 } };
    const it = { def, value: 80, obj: root, inst, held: false, onShip: false, scanName: 'Apparatus', name: 'Apparatus', weightLb: 26, twoHanded: false, size: bbox.getSize(new THREE.Vector3()), bboxMinY: bbox.min.y, grabSFX: this.sfx('grab'), dropSFX: this.sfx('grab'), area: 'inside' };
    root.userData.item = it;
    this.world.push(it);
    return it;
  }

  /** drop the held item onto the Company counter */
  placeOnCounter() {
    const g = this.game, it = this.inventory[this.active];
    if (!it) return;
    const p = g.world.counterPoint(); if (!p) return;
    this.inventory[this.active] = null; it.held = false;
    g.camera.remove(it.obj);
    it.obj.traverse(m => { if (m.isMesh) { m.frustumCulled = true; m.castShadow = true; m.layers.set(0); } });
    g.scene.add(it.obj);
    const spot = p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.6, 0.6, (Math.random() - 0.5) * 0.8));
    this.placeOnFloor(it, spot, [g.world.companyCollider], Math.random() * 6.28);
    it.area = 'company'; it.onShip = false; it.onCounter = true;
    this.world.push(it);
    this.select(this.active); this.updateWeight();
    const c = it.dropSFX || this.sfx('grab'); if (c) g.sound.play(c, { vol: 0.6 });
  }
  itemsOnCounter() { return this.world.filter(it => it.onCounter || (it.area === 'company' && this.game.world.onCounter(it.obj.getWorldPosition(new THREE.Vector3())))); }
  removeItems(list) { for (const it of list) { it.obj.parent && it.obj.parent.remove(it.obj); const i = this.world.indexOf(it); if (i >= 0) this.world.splice(i, 1); } }

  // ---------- queries ----------
  scannables(from, range) {
    const out = [];
    for (const it of this.world) {
      if ((it.area === 'inside') !== !!this.game.inside) continue;
      const p = it.obj.getWorldPosition(new THREE.Vector3());
      if (p.distanceTo(from) > range) continue;
      out.push({ pos: () => it.obj.getWorldPosition(new THREE.Vector3()), text: it.scanName, value: it.value || null });
    }
    return out;
  }

  scrapValueOnShip() { return this.world.reduce((a, it) => a + (it.onShip ? it.value : 0), 0); }

  sellScrap() { for (const it of this.world.slice()) if (it.onShip) { it.obj.parent && it.obj.parent.remove(it.obj); this.world.splice(this.world.indexOf(it), 1); } }

  clearWorldScrap() {
    for (const it of this.world.slice()) if (it.area === 'inside' || it.area === 'outside' || it.area === 'company') { it.obj.parent && it.obj.parent.remove(it.obj); this.world.splice(this.world.indexOf(it), 1); }
  }
  clearInventory() { for (let i = 0; i < 4; i++) { const it = this.inventory[i]; if (it) { this.game.camera.remove(it.obj); this.inventory[i] = null; } } this.select(0); this.updateWeight(); }

  update(dt) {
    if (this.deliveryTimer > 0 && !this.game.world.inOrbit && this.game.world.shipState === 'landed' && !this.game.world.atCompany) { this.deliveryTimer -= dt; if (this.deliveryTimer <= 0 && this.deliveries.length) this._deliver(); }
    if (this.game.flashlightOn) {
      const f = this.flashlightItem();
      if (f && f.battery != null && !this.infBattery) { f.battery = Math.max(0, f.battery - dt / (f.batterySeconds || 200)); this._batT = (this._batT || 0) + dt; if (this._batT > 1) { this._batT = 0; this.game.hud.setInventory(this.inventory.map(x => x ? { name: x.name, value: x.value, battery: x.battery } : null), this.active); } }
    }
    if (this.swingT > 0) {
      this.swingT -= dt;
      if (this.heldObj) {
        // 0.75 -> 0.45: reel up (raise), 0.45 -> 0.25: swing down, then settle back
        const t = 0.75 - this.swingT;
        const raise = t < 0.3 ? t / 0.3 : t < 0.5 ? 1 - (t - 0.3) / 0.2 * 1.6 : -0.6 + (t - 0.5) / 0.25 * 0.6;
        const it = this.inventory[this.active]; const pose = it && HOLD_POSES[it.tool];
        if (pose) {
          this.heldObj.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pose.rot[0] + raise * 55), THREE.MathUtils.degToRad(pose.rot[1] - raise * 25), THREE.MathUtils.degToRad(pose.rot[2]), 'YXZ'));
          this.heldObj.position.set(pose.pos[0] - raise * 0.12, pose.pos[1] + raise * 0.18, pose.pos[2] + raise * 0.1);
        } else this.heldObj.rotation.x = raise * 0.8;
      }
    }
    // held item sway
    if (this.heldObj) { const p = this.game.player; this.heldObj.position.y += (Math.sin(p.bob * 2) * p.bobAmp * 0.5 - (this.heldObj.userData.sw || 0)); this.heldObj.userData.sw = Math.sin(p.bob * 2) * p.bobAmp * 0.5; }
    // ambience cues
    this.cueTimer -= dt;
    if (this.cueTimer <= 0) {
      this.cueTimer = 15 + Math.random() * 35;
      const g = this.game;
      const area = g.inside ? 'inside' : g.player.attached ? 'ship' : (g.world.atCompany ? 'ship' : 'outside');
      const list = this.ambience.cues[area];
      if (list && list.length && g.state === 'play' && !g.world.inOrbit) {
        const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 12;
        const pos = g.player.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 1, Math.sin(a) * r));
        g.sound.play(list[Math.floor(Math.random() * list.length)], { pos, vol: 0.6, min: 3, max: 40 });
      }
    }
  }
}
