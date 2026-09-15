// Enemies: spawning by the level's real spawn tables, waypoint navigation on the dungeon graph, and behaviours that
// follow the real game's AI state machines (search routine, line of sight, hearing, stalking, lunges, sentry, ...).
import * as THREE from 'three';
import { pickClip } from './audio.js';
import { buildSkinned } from './loader.js';
import { Animator, collectIK } from './anim.js';

const UP = new THREE.Vector3(0, 1, 0);

// generic clip patterns (fallback when an enemy has no explicit clip map)
const CLIPS = {
  idle: [/^Idle$/i, /idle/i, /Stand/i, /Sit/i, /Sleep/i],
  walk: [/^Walk$/i, /^WalkForward/i, /^WalkCalm/i, /^CrawlSlow/i, /Creep/i, /Walk(?!Back|Side|Diag)/i, /Crawl/i, /Move/i, /Roam/i],
  run: [/^Run/i, /Sprint/i, /^Chase/i, /CrawlChase/i, /Charge/i, /Creep/i, /WalkForward/i, /WalkCalm/i, /Walk(?!Back|Side|Diag)/i],
  attack: [/Kill/i, /Attack/i, /Bite/i, /Grab/i, /Hit/i, /Slam/i, /Lunge/i, /Swing/i],
  die: [/Die/i, /Death/i, /Dead/i],
  stun: [/Stun/i],
};

// exact clip names per enemy (from the game's animator controllers)
const CLIPMAP = {
  Flowerman: { idle: 'Idle', walk: 'CreepForward', run: 'CreepForward', attack: 'Kill1', carry: 'CarryBodyFull', standUp: 'StandUp', die: 'FlowermanDie' },
  Crawler: { idle: 'CrawlSlow', walk: 'CrawlSlow', run: 'CrawlChase', attack: 'Attack', die: 'CrawlerDie', eat: 'CrawlerEatPlayer' },
  HoarderBug: { idle: 'HoarderIdle', walk: 'WalkForward', run: 'FlyChase', attack: 'HitPlayer', die: 'HoarderBugDie', hold: 'ArmsHoldItem' },
  Centipede: { idle: 'Walk', walk: 'Walk', run: 'Walk', propel: 'PropelToCeiling', fall: 'FallFromCeiling', cling: 'ClingToPlayerHead', die: 'DieCentipede' },
  SandSpider: { idle: 'SpiderIdle', walk: 'SpiderMove', run: 'SpiderMove', attack: 'SpiderAttack', spool: 'SpiderSpool', die: 'SpiderDie' },
  PufferEnemy: { idle: 'PufferIdle', walk: 'PufferWalkForward', run: 'PufferWalkForwardAlert', alert: 'PufferIdleAlert', sneeze: 'PufferSneeze', attack: 'PufferBite', stomp: 'PufferStomp', tail: 'PufferShakeTail' },
  DressGirl: { idle: 'IdleStare', walk: 'Walk', run: 'Walk', dance: 'IdleDance' },
  NutcrackerEnemy: { idle: 'Idle', walk: 'PatrolMarch', run: 'AttackMarch', inspect: 'Inspect', stare: 'InspectStare', aim: 'IdleAimDownwards', aimWalk: 'AimGunWalk', shoot: 'NutcrackerShootGun', reload: 'NutcrackerReload', attack: 'NutcrackerKick', die: 'NutcrackerDie' },
  MouthDog: { idle: 'Idle1', walk: 'WalkCalm', suspicious: 'WalkSuspicious', listen: 'IdleSuspicious', run: 'Chase', howl: 'ChaseHowl', lunge: 'Lunge', kill: 'LungeKill', standUp: 'LungeStandUp', die: 'KillDog' },
  ForestGiant: { idle: 'FGiantIdle', walk: 'FGiantWalk', run: 'FGiantChaseClose', eat: 'FGiantEatPlayer', stare: 'ForestGiantStare', die: 'FGiantDie' },
  DoublewingedBird: { idle: 'DoublewingIdle', idle2: 'DoublewingIdle2', takeoff: 'DoublewingTakeOff', glide: 'DoublewingGlide', land: 'DoublewingLand', flap: 'DoublewingFlapHard' },
};

// per-enemy tuning; hp = shovel hits to kill (null = cannot be killed)
const BEHAVIOURS = {
  Flowerman: { kind: 'bracken', speed: 3.4, angrySpeed: 9, killRange: 1.7, hp: 5 },
  Crawler: { kind: 'thumper', speed: 3.0, chaseSpeed: 9.5, damage: 40, hitRange: 2.3, hp: 4 },
  HoarderBug: { kind: 'hoarder', speed: 3.6, chaseSpeed: 5.0, damage: 30, hitRange: 1.8, hp: 3 },
  Centipede: { kind: 'snareflea', speed: 2.8, damage: 12, hp: 3 },
  SandSpider: { kind: 'spider', speed: 4.3, damage: 90, hitRange: 2.1, hp: 6 },
  Blob: { kind: 'blob', speed: 1.5, damage: 35, hitRange: 1.9, hp: null },
  PufferEnemy: { kind: 'puffer', speed: 2.2, fleeSpeed: 4.8, damage: 20, hp: 4 },
  DressGirl: { kind: 'ghost', speed: 3.6, hp: null },
  NutcrackerEnemy: { kind: 'nutcracker', speed: 3.4, chaseSpeed: 5.5, kickDamage: 30, hp: 5 },
  StingrayEnemy: { kind: 'idle', speed: 0, hp: 6 },
  MouthDog: { kind: 'dog', speed: 3.2, chaseSpeed: 11.5, killRange: 2.3, hp: 12 },
  ForestGiant: { kind: 'giant', speed: 2.6, chaseSpeed: 6.6, grabRange: 2.9, hp: 40, turn: 2.5 },
  SandWorm: { kind: 'none' },
  RadMechEnemy: { kind: 'none' },
  DoublewingedBird: { kind: 'bird', speed: 8, hp: 1 },
  RedLocustBees: { kind: 'none' },
  DocileLocustBees: { kind: 'locust', hp: null },
};

// Behaviours that have a web implementation. Entries still use each moon's real rarity and power budget.
const SUPPORTED_ENEMIES = new Set(['Flowerman', 'HoarderBug', 'Centipede', 'Crawler', 'SandSpider', 'Blob', 'PufferEnemy', 'DressGirl', 'NutcrackerEnemy', 'MouthDog', 'ForestGiant', 'DoublewingedBird', 'DocileLocustBees']);

const wrap = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const rand = (a, b) => a + Math.random() * (b - a);

export class Enemies {
  constructor(game) {
    this.game = game; this.lib = game.lib;
    this.list = [];
    this.spawnTimer = 45; this.outsideTimer = 30;
    this.insidePower = 0; this.outsidePower = 0;
    this.noises = [];
    this.catalog = null;
    this.webs = [];      // bunker spider webs: {pos, mesh, owner, yaw}
    this.clouds = [];    // spore clouds: {mesh, t}
  }

  async load() {
    const catalogs = Object.values(this.game.dungeon.catalogs);
    this.catalog = this.game.dungeon.catalog;
    const all = catalogs.flatMap(c => [...c.enemies.inside, ...c.enemies.outside, ...c.enemies.daytime]);
    for (const e of all) if (e.prefab) { e.man = await this.lib.manifest('prefabs/' + e.prefab).catch(() => null); e.beh = BEHAVIOURS[e.prefab.split('__')[0]] || { kind: 'idle', speed: 2, hp: 4 }; }
  }

  setCatalog(catalog) { this.catalog = catalog; }

  beginDay() { const diff = this.game && this.game.difficulty ? this.game.difficulty() : 1; this.clearAll(); this.spawnTimer = (40 + Math.random() * 40) / diff; this.outsideTimer = 20 / diff; this.insidePower = 0; this.outsidePower = 0; }
  clearAll() {
    for (const e of this.list) this._remove(e); this.list = [];
    for (const w of this.webs) w.mesh.parent && w.mesh.parent.remove(w.mesh); this.webs = [];
    for (const c of this.clouds) c.mesh.parent && c.mesh.parent.remove(c.mesh); this.clouds = [];
  }
  _remove(e) { if (e.root.parent) e.root.parent.remove(e.root); if (e.skin) e.skin.forEach(s => s.parent && s.parent.remove(s)); for (const h of e.loops) h && h.stop && h.stop(); if (e.carried) this._dropCarried(e, e.pos); }

  onNoise(pos, loudness) { this.noises.push({ pos: pos.clone(), loudness, t: 0 }); if (this.noises.length > 20) this.noises.shift(); }
  onPlayerEntered(inside) { }

  pickWeighted(list, budget) {
    const cands = list.filter(e => e.man && e.beh.kind !== 'none' && SUPPORTED_ENEMIES.has(e.prefab.split('__')[0]) && (e.power || 1) <= budget && this.list.filter(x => x.def === e).length < (e.maxCount || 1));
    const total = cands.reduce((a, e) => a + e.rarity, 0);
    if (!total) return null;
    let r = Math.random() * total;
    for (const e of cands) { r -= e.rarity; if (r <= 0) return e; }
    return cands[cands.length - 1];
  }

  async spawn(def, pos, area) {
    const inst = await this.lib.instantiate(def.man, { lights: false });
    const rootObj = inst.root.children[0];
    if (rootObj) { rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); }
    const root = inst.root; root.position.copy(pos);
    const parent = area === 'inside' ? this.game.dungeon.root : this.game.world.levelRoot;
    parent.add(root); root.updateMatrixWorld(true);
    const skin = await buildSkinned(this.lib, inst, parent);
    let scanName = def.enemyName || def.name;
    for (const n of def.man.nodes) for (const c of n.comps) if (c.t === 'MB' && c.cls === 'ScanNodeProperties' && c.d && c.d.headerText) scanName = c.d.headerText;
    // body size from the skinned meshes' bind-pose bounds (they are not children of root), else from the static meshes
    const bb = new THREE.Box3().setFromObject(root);
    for (const s of skin || []) { try { if (s.skeleton) s.skeleton.update(); const b = new THREE.Box3().setFromObject(s, true); if (isFinite(b.min.y) && isFinite(b.max.y)) bb.union(b); } catch (err) { } }
    let sizeY = bb.isEmpty() ? 0 : bb.max.y - Math.min(bb.min.y, pos.y), sizeXZ = bb.isEmpty() ? 0 : Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.6;
    const base = def.prefab.split('__')[0];
    const e = { def, base, beh: def.beh, clipmap: CLIPMAP[base] || {}, root, inst, skin, area, pos: root.position, state: 'idle', t: 0, target: null, path: [], pathT: 0,
      hp: def.beh.hp == null ? Infinity : def.beh.hp, scanName, loops: [], cooldown: 0, seenT: 0, anger: 0, dead: false, yaw: Math.random() * Math.PI * 2,
      height: THREE.MathUtils.clamp(sizeY, 0.5, 12), radius: THREE.MathUtils.clamp(sizeXZ * 0.5, 0.45, 2.5), home: pos.clone(), lastPlayerPos: null, lastSeenT: 99, wanderT: 0, anim: null, moveAmount: 0, spd: 0,
      animKey: 'idle', oneShotT: 0, voiceT: rand(4, 12), search: null, unseenT: 0, stateT: 0 };
    root.userData.enemy = e;
    this.list.push(e);
    for (const [id, o] of inst.objs) {
      const n = o.userData.node; const ac = n && n.comps.find(c => c.t === 'Animator' && c.controller);
      if (ac) { e.anim = new Animator(o, ac.controller); e.anim.load().then(() => { e.anim.ik = collectIK(inst); this.playAnim(e, 'idle'); }); break; }
    }
    e.sfx = def.sfx || {};
    this._onSpawned(e);
    return e;
  }

  // ---------- animation ----------
  clipFor(e, key) {
    if (!e.anim || !e.anim.ready) return null;
    const exact = e.clipmap[key]; if (exact && e.anim.has(exact)) return exact;
    let name = e.anim.find(CLIPS[key] || []);
    if (!name && key === 'run') name = this.clipFor(e, 'walk');
    if (!name && key === 'walk') name = e.anim.find(CLIPS.run);
    return name;
  }
  playAnim(e, key, opts = {}) {
    const name = this.clipFor(e, key); if (!name) return false;
    e.anim.play(name, opts); return true;
  }
  /** one-shot clip (attack, die...) that holds for `hold` seconds before the movement animation takes over again */
  oneShot(e, key, hold = 1.0, opts = {}) {
    if (this.playAnim(e, key, Object.assign({ once: true, loop: false, fade: 0.08 }, opts))) { e.oneShotT = hold; return true; }
    e.oneShotT = hold; return false;
  }
  setVisible(e, v) { e.root.visible = v; if (e.skin) e.skin.forEach(s => s.visible = v); }

  _onSpawned(e) {
    const kind = e.beh.kind;
    if (kind === 'snareflea') { e.state = 'seekCeiling'; }
    if (kind === 'spider') { e.state = 'lurk'; this._spinWebs(e); }
    if (kind === 'hoarder') { e.nest = e.pos.clone(); e.nestItems = []; e.state = 'search'; }
    if (kind === 'ghost') { e.state = 'hidden'; e.stateT = rand(12, 30); e.haunt = 0; this.setVisible(e, false); }
    if (kind === 'nutcracker') { e.state = 'patrol'; e.stateT = rand(5, 9); }
    if (kind === 'dog') { e.state = 'roam'; e.suspicion = 0; }
    if (kind === 'giant') e.state = 'roam';
    if (kind === 'bracken' || kind === 'thumper' || kind === 'blob' || kind === 'puffer') e.state = 'search';
    if (kind === 'bird') { e.state = 'ground'; e.stateT = rand(3, 8); }
    if (kind === 'locust') { e.state = 'hover'; }
    if (kind === 'idle') e.state = 'idle';
  }

  // ---------- perception ----------
  /** line of sight from the enemy's eyes to a point */
  canSee(e, target, maxDist = 30) {
    const from = e.pos.clone().add(new THREE.Vector3(0, e.height * 0.7, 0));
    const to = target.clone(); const d = from.distanceTo(to);
    if (d > maxDist) return false;
    const dir = to.clone().sub(from).normalize();
    const col = e.area === 'inside' ? this.game.dungeon.collider : this.game.world.levelCollider;
    const hit = col && col.raycast(from, dir, d - 0.3);
    return !hit;
  }
  /** sees the player: within range, inside the view cone (fovDeg, 360 = all round), line of sight */
  seesPlayer(e, range, fovDeg = 360, nearAlways = 3) {
    const p = this.game.player; if (p.dead) return false;
    const eye = p.eye.clone();
    const to = eye.clone().sub(e.pos); const d = to.length();
    if (d > range) return false;
    if (d > nearAlways && fovDeg < 360) {
      const f = new THREE.Vector3(Math.sin(e.yaw), 0, Math.cos(e.yaw));
      const flat = to.clone(); flat.y = 0; flat.normalize();
      if (f.dot(flat) < Math.cos(THREE.MathUtils.degToRad(fovDeg / 2))) return false;
    }
    return this.canSee(e, eye, range);
  }
  playerLookingAt(e, cosTol = 0.82) {
    const cam = this.game.camera;
    const dir = e.pos.clone().add(new THREE.Vector3(0, e.height * 0.6, 0)).sub(cam.position);
    const d = dir.length(); dir.normalize();
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    return f.dot(dir) > cosTol && d < 45 && this.canSee(e, cam.position, 45);
  }
  playerMoving() { const p = this.game.player; return Math.hypot(p.vel.x, p.vel.z) > 0.6 || p.moveAmount > 0.6; }
  facePlayer(e, dt, turn = 5) { const p = this.game.player; return this.turnToward(e, p.pos, dt, turn); }
  turnToward(e, target, dt, turn = 5) {
    const dy = wrap(Math.atan2(target.x - e.pos.x, target.z - e.pos.z) - e.yaw);
    e.yaw += THREE.MathUtils.clamp(dy, -turn * dt, turn * dt); e.root.rotation.y = e.yaw;
    return Math.abs(dy);
  }

  // ---------- movement ----------
  groundFollow(e, dt, rate = 10) {
    const col = e.area === 'inside' ? this.game.dungeon.collider : this.game.world.levelCollider;
    if (!col) return;
    const hit = col.raycast(e.pos.clone().add(new THREE.Vector3(0, 1.2, 0)), new THREE.Vector3(0, -1, 0), 4);
    if (hit) e.pos.y += (hit.point.y - e.pos.y) * Math.min(1, dt * rate);
  }
  /** steer toward a point: turns first, only moves when roughly facing it (no more orbiting around targets) */
  moveToward(e, target, speed, dt, turn = 6, stop = 0) {
    const to = target.clone().sub(e.pos); to.y = 0;
    const d = to.length(); if (d < 0.05) return d;
    to.normalize();
    const dy = wrap(Math.atan2(to.x, to.z) - e.yaw);
    e.yaw += THREE.MathUtils.clamp(dy, -turn * dt, turn * dt);
    const ady = Math.abs(dy);
    const align = ady > 1.3 ? 0.1 : Math.max(0.15, Math.cos(dy));
    const step = Math.min(Math.max(0, d - stop), speed * dt * align);
    if (d < 0.35 && !stop) { e.pos.x = target.x; e.pos.z = target.z; }
    else if (step > 0) { e.pos.x += Math.sin(e.yaw) * step; e.pos.z += Math.cos(e.yaw) * step; }
    this.groundFollow(e, dt);
    e.root.rotation.y = e.yaw;
    return d;
  }
  followPath(e, target, speed, dt, turn = 6, stop = 0) {
    if (e.area === 'inside') {
      // straight line when the target is close and nothing is in the way (no detour via the tile centre)
      const flat = Math.hypot(target.x - e.pos.x, target.z - e.pos.z);
      if (flat < 14) {
        const from = e.pos.clone().add(new THREE.Vector3(0, 0.6, 0)), to = target.clone().add(new THREE.Vector3(0, 0.6, 0));
        const col = this.game.dungeon.collider; const dir = to.clone().sub(from); const len = dir.length(); dir.normalize();
        if (!col || !col.raycast(from, dir, Math.max(0, len - 0.3))) { e.path = []; return this.moveToward(e, target, speed, dt, turn, stop); }
      }
      const stale = !e.path.length || e.pathT > 2.0 || (e.pathEnd && e.pathEnd.distanceTo(target) > 2.5);
      if (stale) { e.path = this.game.dungeon.path(e.pos, target); e.pathT = 0; e.pathEnd = target.clone(); if (e.path.length) e.path.push(target.clone()); }
      e.pathT += dt;
      // skip waypoints we are already next to (avoids doubling back)
      while (e.path.length > 1 && new THREE.Vector2(e.path[0].x - e.pos.x, e.path[0].z - e.pos.z).length() < 0.9) e.path.shift();
      if (!e.path.length) return this.moveToward(e, target, speed, dt, turn, stop);
      const next = e.path[0];
      const d = this.moveToward(e, next, speed, dt, turn);
      if (d < 0.6) e.path.shift();
      return new THREE.Vector2(target.x - e.pos.x, target.z - e.pos.z).length();
    }
    return this.moveToward(e, target, speed, dt, turn, stop);
  }
  nodesFor(e) { return e.area === 'inside' ? this.game.dungeon.graph.nodes.map(n => n.p) : this.game.world.outsideNodes; }
  /** the game's search routine: visit unsearched nodes nearest to us, around a centre, until all are done */
  searchRoutine(e, speed, dt, centre = null, radius = 60) {
    const nodes = this.nodesFor(e); if (!nodes.length) return;
    if (!e.search || (centre && e.search.centre.distanceTo(centre) > 3)) e.search = { centre: (centre || e.pos).clone(), done: new Set(), target: null, id: -1, waitT: 0 };
    const s = e.search;
    if (s.waitT > 0) { s.waitT -= dt; e.animKey = 'idle'; return; }
    if (s.target == null) {
      let best = -1, bd = 1e9;
      nodes.forEach((p, i) => { if (s.done.has(i)) return; if (p.distanceTo(s.centre) > radius) return; const d = p.distanceToSquared(e.pos) + Math.random() * 4; if (d < bd) { bd = d; best = i; } });
      if (best < 0) { s.done.clear(); return; }
      s.id = best; s.target = nodes[best].clone(); e.path = [];
    }
    const d = this.followPath(e, s.target, speed, dt, e.beh.turn || 6);
    if (d < 1.2) { s.done.add(s.id); s.target = null; s.waitT = e.beh.kind === 'nutcracker' ? 0 : rand(0.2, 1.2); }
  }
  farthestNodeFrom(e, from, hiddenFrom = null) {
    const nodes = this.nodesFor(e); let best = null, bd = -1;
    for (let i = 0; i < 16 && nodes.length; i++) {
      const n = nodes[Math.floor(Math.random() * nodes.length)]; let d = n.distanceTo(from);
      if (hiddenFrom && this.canSee({ pos: n, height: e.height, area: e.area }, hiddenFrom, 60)) d *= 0.4;
      if (d > bd) { bd = d; best = n; }
    }
    return best ? best.clone() : e.pos.clone();
  }
  nodeNear(e, from, min, max, needLos = false) {
    const nodes = this.nodesFor(e); const c = [];
    for (const n of nodes) { const d = n.distanceTo(from); if (d >= min && d <= max) c.push(n); }
    for (let i = 0; i < 10 && c.length; i++) { const n = c[Math.floor(Math.random() * c.length)]; if (!needLos || this.canSee({ pos: n, height: e.height, area: e.area }, from, max + 5)) return n.clone(); }
    return c.length ? c[0].clone() : null;
  }

  playSfx(e, key, vol = 0.9) {
    const c = pickClip(e.sfx && e.sfx[key]); if (c) this.game.sound.play(c, { pos: e.pos.clone(), vol, min: 2, max: 40 });
  }
  voice(e, minGap = 6, maxGap = 16, vol = 0.8) {
    if (e.voiceT <= 0) { this.playSfx(e, 'audioClips', vol); e.voiceT = rand(minGap, maxGap); }
  }

  // ---------- main update ----------
  update(dt) {
    const g = this.game, w = g.world, p = g.player;
    if (w.shipState !== 'landed' && w.shipState !== 'leaving') return;
    for (const n of this.noises) n.t += dt;
    this.noises = this.noises.filter(n => n.t < 6);
    // spawning: inside enemies from vents, chance rises through the day
    const diff = g.difficulty ? g.difficulty() : 1;   // harder moons: enemies come sooner
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && g.dungeon.vents.length) {
      this.spawnTimer = (55 + Math.random() * 50) / diff;
      const chance = 0.25 + w.dayFrac * 0.65;
      if (Math.random() < chance && this.insidePower < this.catalog.level.maxEnemyPowerCount) {
        const def = this.pickWeighted(this.catalog.enemies.inside, this.catalog.level.maxEnemyPowerCount - this.insidePower);
        if (def) { const vp = this.vent(p.pos); vp.y += 0.1; this.spawn(def, vp, 'inside').then(e => { this.insidePower += def.power || 1; }); }
      }
    }
    this.outsideTimer -= dt;
    if (this.outsideTimer <= 0 && w.outsideNodes.length) {
      this.outsideTimer = (40 + Math.random() * 40) / diff;
      const night = w.dayFrac > 0.62;
      const list = night ? this.catalog.enemies.outside : this.catalog.enemies.daytime;
      const budget = night ? this.catalog.level.maxOutsideEnemyPowerCount : this.catalog.level.maxDaytimeEnemyPowerCount;
      if (Math.random() < (night ? 0.7 : 0.35) && this.outsidePower < budget) {
        const def = this.pickWeighted(list, budget - this.outsidePower);
        if (def) {
          const far = w.outsideNodes.filter(n => n.distanceTo(p.pos) > 40);
          const at = (far.length ? far : w.outsideNodes)[Math.floor(Math.random() * (far.length ? far.length : w.outsideNodes.length))].clone();
          this.spawn(def, at, 'outside').then(e => { this.outsidePower += def.power || 1; });
        }
      }
    }
    // webs and spore clouds
    for (const web of this.webs) {
      if (web.broken) continue;
      if (g.inside && Math.hypot(p.pos.x - web.pos.x, p.pos.z - web.pos.z) < 1.1 && Math.abs(p.pos.y - web.pos.y) < 2.5) {
        p.slowT = Math.max(p.slowT || 0, 0.4);
        if (!web.tripT || web.tripT <= 0) { web.tripT = 3; if (web.owner && !web.owner.dead) { web.owner.alertPos = web.pos.clone(); web.owner.alertT = 6; } this.onNoise(web.pos, 0.3); }
      }
      if (web.tripT > 0) web.tripT -= dt;
    }
    for (const c of this.clouds) { c.t += dt; const s = Math.min(1, c.t / 1.5) * 3.2; c.mesh.scale.setScalar(s); c.mesh.material.opacity = c.t < 8 ? 0.85 : Math.max(0, 0.85 - (c.t - 8) * 0.4); }
    this.clouds = this.clouds.filter(c => { if (c.t > 10.5) { c.mesh.parent && c.mesh.parent.remove(c.mesh); return false; } return true; });

    for (const e of this.list) {
      e.voiceT -= dt; e.oneShotT -= dt; e.stateT -= dt;
      if (!e.dead && !this.frozen) { const before = e.pos.clone(); e.animKey = null; this._updateEnemy(e, dt); e.moveAmount = Math.hypot(e.pos.x - before.x, e.pos.z - before.z) / Math.max(1e-4, dt); }
      if (e.anim && e.anim.ready && !e.dead) {
        if (e.oneShotT <= 0) {
          const key = e.animKey || (e.moveAmount > (e.beh.runAt || 4.5) ? 'run' : e.moveAmount > 0.15 ? 'walk' : 'idle');
          this.playAnim(e, key);
        }
        e.anim.update(dt);
      } else if (e.anim && e.anim.ready) e.anim.update(dt);
      e.root.updateMatrixWorld(true);
    }
  }

  vent(pos) { return this.game.dungeon.vents.length ? this.game.dungeon.vents[Math.floor(Math.random() * this.game.dungeon.vents.length)].pos.clone() : pos; }

  // ---------- behaviours ----------
  _updateEnemy(e, dt) {
    const g = this.game, p = g.player, b = e.beh;
    const sameArea = (e.area === 'inside') === !!g.inside;
    const pp = p.pos.clone();
    const dist = sameArea ? e.pos.distanceTo(pp) : 1e9;
    e.cooldown -= dt; e.t += dt;
    const hurt = (dmg, cd = 1.1, source = e.scanName) => { if (sameArea && !p.dead) { p.damage(dmg, source); e.cooldown = Math.max(e.cooldown, cd); this.playSfx(e, 'hitBodySFX'); return true; } return false; };
    const onShip = !!p.attached;
    switch (b.kind) {

      // Bracken: sneaks up from behind, freezes when looked at, backs off when stared at, snaps if stared at too long.
      case 'bracken': {
        const looking = sameArea && this.playerLookingAt(e);
        const sees = sameArea && this.seesPlayer(e, 35);
        if (sees) { e.lastPlayerPos = pp.clone(); e.unseenT = 0; } else e.unseenT += dt;
        if (looking) { e.stareT = (e.stareT || 0) + dt; e.anger += dt * (0.6 + 6 / Math.max(2, dist)); }
        else { e.stareT = Math.max(0, (e.stareT || 0) - dt * 0.7); e.anger = Math.max(0, e.anger - dt * 0.12); }
        if (e.anger > 5 && e.state !== 'angry' && e.state !== 'carry') { e.state = 'angry'; this.playSfx(e, 'audioClips', 1); }
        if (e.state === 'search') {
          this.searchRoutine(e, b.speed, dt);
          if (sees) { e.state = 'stalk'; }
        } else if (e.state === 'stalk') {
          // approach a spot behind the player; freeze while watched; retreat once stared at
          if (e.stareT > 1.1 && dist < 20) { e.state = 'evade'; e.target = this.farthestNodeFrom(e, pp, p.eye); e.path = []; e.stareT = 0; e.evadeCount = (e.evadeCount || 0) + 1; break; }
          if (dist < b.killRange && !looking && !p.dead) {
            p.damage(1000, 'Bracken'); this.oneShot(e, 'attack', 1.6); this.playSfx(e, 'hitEnemyVoiceSFX', 1);
            e.state = 'carry'; e.stateT = 8; e.target = this.farthestNodeFrom(e, pp); e.path = []; break;
          }
          if (looking && dist < 25) { e.animKey = 'idle'; this.facePlayer(e, dt, 3); }
          else {
            const f = p.forward(new THREE.Vector3());
            const behind = (e.lastPlayerPos || pp).clone().addScaledVector(f, dist > 6 ? -2.5 : 0);
            this.followPath(e, dist < 3 ? pp : behind, dist < 8 ? b.speed * 0.8 : b.speed * 1.3, dt);
            if (e.unseenT > 20) e.state = 'search';
          }
        } else if (e.state === 'evade') {
          if (!e.target) e.target = this.farthestNodeFrom(e, pp, p.eye);
          const d = this.followPath(e, e.target, b.angrySpeed * 0.8, dt);
          e.animKey = 'run';
          if (d < 1.5 || e.pos.distanceTo(pp) > 28) { e.state = 'hide'; e.stateT = rand(5, 14); }
        } else if (e.state === 'hide') {
          e.animKey = 'idle';
          if (looking && dist < 18) { e.stareT += dt; if (e.stareT > 1) { e.state = 'evade'; e.target = null; e.stareT = 0; } }
          else if (e.stateT <= 0) { e.state = sees || dist < 30 ? 'stalk' : 'search'; }
        } else if (e.state === 'angry') {
          e.animKey = 'run';
          this.followPath(e, pp, b.angrySpeed, dt, 8);
          this.voice(e, 3, 6, 1);
          if (dist < b.killRange && !p.dead) { p.damage(1000, 'Bracken'); this.oneShot(e, 'attack', 1.6); this.playSfx(e, 'hitEnemyVoiceSFX', 1); e.state = 'carry'; e.stateT = 8; e.anger = 0; e.target = this.farthestNodeFrom(e, pp); e.path = []; }
          if (!sameArea) { e.state = 'search'; e.anger = 0; }
        } else if (e.state === 'carry') {
          e.animKey = 'carry';
          if (e.oneShotT <= 0) this.followPath(e, e.target || e.home, b.speed * 1.4, dt);
          if (e.stateT <= 0) { e.state = 'search'; e.search = null; }
        } else e.state = 'search';
        break;
      }

      // Thumper: searches; on sight, charges - fast in straight lines, slow through turns; bites; searches the last spot when it loses you.
      case 'thumper': {
        const sees = sameArea && this.seesPlayer(e, 30, 120, 6);
        if (sees) { e.lastPlayerPos = pp.clone(); e.unseenT = 0; if (e.state !== 'chase') { e.state = 'chase'; e.spd = b.speed; this.playSfx(e, 'audioClips', 1); } }
        else e.unseenT += dt;
        if (e.state === 'chase') {
          const tgt = e.lastPlayerPos || pp;
          if (e.attackT > 0) { e.attackT -= dt; e.animKey = 'attack'; this.facePlayer(e, dt, 6); if (e.attackT <= 0.2 && !e.attackDone) { e.attackDone = true; if (dist < b.hitRange + 0.6) hurt(b.damage, 0.3); } break; }
          // acceleration in straight lines, braking in turns
          const next = e.path.length ? e.path[0] : tgt;
          const turnNeeded = Math.abs(wrap(Math.atan2(next.x - e.pos.x, next.z - e.pos.z) - e.yaw));
          if (turnNeeded > 0.7) e.spd = Math.max(2.2, e.spd - 22 * dt); else e.spd = Math.min(b.chaseSpeed, e.spd + 4.5 * dt);
          e.beh.runAt = 4.0;
          const d = this.followPath(e, tgt, e.spd, dt, 3.2, 1.5);
          this.voice(e, 4, 9, 0.9);
          if (dist < b.hitRange && e.cooldown <= 0 && !p.dead) { e.attackT = 0.55; e.attackDone = false; e.cooldown = 1.3; this.oneShot(e, 'attack', 0.6); e.spd = 1; }
          if (!sees && (d < 1.2 || e.unseenT > 10)) { e.state = 'search'; e.search = null; e.searchCentre = tgt.clone(); }
        } else {
          e.spd = 0; this.searchRoutine(e, b.speed, dt, e.searchCentre, e.searchCentre ? 25 : 60);
          if (e.search && e.search.done.size > 8) e.searchCentre = null;
        }
        break;
      }

      // Hoarding bug: gathers scrap into a nest, watches you near it, and attacks if you take its stuff.
      case 'hoarder': {
        const items = g.items.world;
        const stolen = e.nestItems.filter(it => it.held || (it.carriedBy && it.carriedBy !== e));
        const holdingTarget = e.wantItem && e.wantItem.held;
        if ((stolen.length || holdingTarget) && sameArea && e.state !== 'angry') { e.state = 'angry'; e.stateT = 12; this.playSfx(e, 'audioClips', 1); }
        if (e.state === 'angry') {
          e.animKey = 'run';
          this.followPath(e, pp, b.chaseSpeed, dt, 7, 1.2);
          if (dist < b.hitRange && e.cooldown <= 0) { this.oneShot(e, 'attack', 0.7); hurt(b.damage, 1.3); }
          const stillStolen = e.nestItems.some(it => it.held) || (e.wantItem && e.wantItem.held);
          if (!stillStolen) { e.stateT -= dt; if (e.stateT <= 0 || dist > 20) e.state = 'search'; } else e.stateT = 6;
          if (!sameArea && e.stateT <= 0) e.state = 'search';
          break;
        }
        // watch players who come near the nest
        if (sameArea && dist < 6 && pp.distanceTo(e.nest) < 8 && e.state !== 'fetch' && e.state !== 'return') { e.animKey = 'idle'; this.facePlayer(e, dt, 4); break; }
        if (e.state === 'search') {
          this.searchRoutine(e, b.speed, dt, e.nest, 45);
          if (e.t % 1.5 < dt) {
            let best = null, bd = 1e9;
            for (const it of items) { if (it.held || it.carriedBy || it.onShip || it.area !== 'inside' || !it.value || e.nestItems.includes(it) || it.name === 'Apparatus') continue; const d = it.obj.getWorldPosition(new THREE.Vector3()).distanceTo(e.pos); if (d < 22 && d < bd) { bd = d; best = it; } }
            if (best) { e.wantItem = best; e.state = 'fetch'; e.path = []; }
          }
        } else if (e.state === 'fetch') {
          const it = e.wantItem;
          if (!it || it.held || it.carriedBy || it.onShip) { e.state = 'search'; e.wantItem = null; break; }
          const ip = it.obj.getWorldPosition(new THREE.Vector3());
          const d = this.followPath(e, ip, b.speed, dt);
          if (d < 1.2) { this._carry(e, it); e.state = 'return'; e.path = []; }
        } else if (e.state === 'return') {
          e.animKey = e.moveAmount > 0.2 ? 'walk' : 'hold';
          const d = this.followPath(e, e.nest, b.speed, dt);
          if (d < 1.5) { if (e.carried) { const drop = e.nest.clone().add(new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1))); const it = e.carried; this._dropCarried(e, drop); e.nestItems.push(it); } e.state = 'search'; e.search = null; e.wantItem = null; }
        } else e.state = 'search';
        break;
      }

      // Snare flea: climbs onto a ceiling and waits, drops onto whoever walks under, suffocates them; leaves when you get outside.
      case 'snareflea': {
        if (e.state === 'seekCeiling') {
          e.animKey = 'walk';
          this.searchRoutine(e, b.speed, dt);
          if (e.search && e.search.waitT > 0) {
            const up = g.dungeon.collider && g.dungeon.collider.raycast(e.pos.clone().add(new THREE.Vector3(0, 0.5, 0)), UP, 9);
            if (up && up.point.y - e.pos.y > 2.2) { e.ceilY = up.point.y - 0.35; e.floorY = e.pos.y; e.state = 'propel'; this.oneShot(e, 'propel', 0.8); }
          }
        } else if (e.state === 'propel') {
          e.pos.y = Math.min(e.ceilY, e.pos.y + 9 * dt); e.animKey = 'propel';
          if (e.pos.y >= e.ceilY - 0.01) { e.state = 'ceiling'; e.root.rotation.x = Math.PI; e.stateT = rand(45, 90); }
        } else if (e.state === 'ceiling') {
          e.animKey = 'idle';
          const flat = Math.hypot(e.pos.x - pp.x, e.pos.z - pp.z);
          if (sameArea && flat < 1.6 && e.pos.y > pp.y && e.pos.y - pp.y < 10 && !p.dead) { e.state = 'drop'; e.root.rotation.x = 0; this.oneShot(e, 'fall', 0.5); this.playSfx(e, 'audioClips', 1); }
          else if (e.stateT <= 0) { e.state = 'drop'; e.root.rotation.x = 0; e.relocate = true; this.oneShot(e, 'fall', 0.5); }
        } else if (e.state === 'drop') {
          e.pos.y -= 14 * dt;
          const flat = Math.hypot(e.pos.x - pp.x, e.pos.z - pp.z);
          if (!e.relocate && sameArea && flat < 1.8 && e.pos.y <= pp.y + 1.9 && !p.dead) { e.state = 'latched'; e.latchT = 0; e.mash = 0; g.hud.showNotice('SNARE FLEA! MASH E', 3); this.oneShot(e, 'cling', 99); this.playSfx(e, 'hitEnemyVoiceSFX', 1); }
          else if (e.pos.y <= (e.floorY != null ? e.floorY : pp.y) + 0.05) { e.pos.y = e.floorY != null ? e.floorY : pp.y; e.state = e.relocate ? 'seekCeiling' : 'chase'; e.relocate = false; e.search = null; e.stateT = 8; }
        } else if (e.state === 'chase') {
          // missed: scurry after the player for a bit, latch if it reaches them
          e.animKey = 'walk';
          this.followPath(e, pp, b.speed * 1.6, dt, 8);
          if (sameArea && dist < 1.2 && !p.dead) { e.state = 'latched'; e.latchT = 0; e.mash = 0; g.hud.showNotice('SNARE FLEA! MASH E', 3); this.oneShot(e, 'cling', 99); this.playSfx(e, 'hitEnemyVoiceSFX', 1); }
          if (e.stateT <= 0 || !sameArea) { e.state = 'seekCeiling'; e.search = null; }
        } else if (e.state === 'latched') {
          e.latchT += dt; e.pos.copy(pp); e.pos.y += 1.55; e.yaw = p.yaw + Math.PI; e.root.rotation.y = e.yaw;
          if (e.latchT % 0.9 < dt) p.damage(b.damage, 'Snare flea');
          const release = (e.mash || 0) >= 10 || !sameArea || !g.inside;
          if (release || p.dead) { e.state = 'flee'; e.stateT = 5; e.oneShotT = 0; g.hud.showNotice('', 0.1); e.pos.y = pp.y; e.search = null; }
        } else if (e.state === 'flee') {
          e.animKey = 'walk';
          if (!e.target || e.stateT % 2 < dt) { e.target = this.farthestNodeFrom(e, pp); e.path = []; }
          this.followPath(e, e.target, b.speed * 2.2, dt, 8);
          if (e.stateT <= 0) { e.state = 'seekCeiling'; e.search = null; }
        } else { e.state = 'seekCeiling'; }
        break;
      }

      // Bunker spider: spins webs near its spot, rushes anything that touches one, hits hard, returns home.
      case 'spider': {
        const sees = sameArea && this.seesPlayer(e, 15, 360, 4);
        if (sees) { e.lastPlayerPos = pp.clone(); e.unseenT = 0; } else e.unseenT += dt;
        if (e.alertT > 0) e.alertT -= dt;
        if (e.state === 'lurk') {
          if (sees && dist < 14) { e.state = 'chase'; this.playSfx(e, 'audioClips', 1); }
          else if (e.alertT > 0 && e.alertPos) { e.state = 'investigate'; e.target = e.alertPos.clone(); e.path = []; }
          else {
            // idle around the webs, occasionally re-spooling
            if (e.stateT <= 0) { e.stateT = rand(4, 9); e.target = this.nodeNear(e, e.home, 0, 6) || e.home.clone(); e.path = []; if (Math.random() < 0.3) this.oneShot(e, 'spool', 2.5); }
            if (e.target && e.oneShotT <= 0) { const d = this.followPath(e, e.target, b.speed * 0.35, dt); if (d < 0.8) e.animKey = 'idle'; }
          }
        } else if (e.state === 'investigate') {
          const d = this.followPath(e, e.target, b.speed, dt, 7);
          if (sees) e.state = 'chase';
          else if (d < 1.2) { e.animKey = 'idle'; e.stateT = 3; e.state = 'look'; }
        } else if (e.state === 'look') {
          e.animKey = 'idle'; e.yaw += dt * 1.5; e.root.rotation.y = e.yaw;
          if (sees) e.state = 'chase'; else if (e.stateT <= 0) { e.state = 'return'; }
        } else if (e.state === 'chase') {
          if (e.attackT > 0) { e.attackT -= dt; e.animKey = 'attack'; this.facePlayer(e, dt, 8); if (e.attackT <= 0.25 && !e.attackDone) { e.attackDone = true; if (dist < b.hitRange + 0.5) hurt(b.damage, 0.5); } break; }
          const tgt = sees ? pp : (e.lastPlayerPos || pp);
          const d = this.followPath(e, tgt, b.speed, dt, 7, 1.4);
          this.voice(e, 5, 10, 0.8);
          if (dist < b.hitRange && e.cooldown <= 0 && !p.dead) { e.attackT = 0.6; e.attackDone = false; e.cooldown = 1.6; this.oneShot(e, 'attack', 0.7); }
          if ((!sees && d < 1.5) || e.unseenT > 8 || e.pos.distanceTo(e.home) > 32 || !sameArea) { e.state = 'return'; }
        } else if (e.state === 'return') {
          const d = this.followPath(e, e.home, b.speed * 0.8, dt);
          if (sees && dist < 12) e.state = 'chase';
          else if (d < 1.5) { e.state = 'lurk'; e.stateT = 1; }
        } else e.state = 'lurk';
        break;
      }

      // Hygrodere: slow, relentless, sticks to you when it reaches you. Cannot be killed.
      case 'blob': {
        const sees = sameArea && this.seesPlayer(e, 22, 360);
        if (sees) { e.lastPlayerPos = pp.clone(); e.unseenT = 0; if (e.state !== 'chase') this.playSfx(e, 'audioClips', 0.7); e.state = 'chase'; } else e.unseenT += dt;
        if (e.state === 'chase') {
          const tgt = sees ? pp : (e.lastPlayerPos || pp);
          const d = this.followPath(e, tgt, dist < 4 ? b.speed * 1.4 : b.speed, dt, 3, 1.2);
          if (dist < b.hitRange && e.cooldown <= 0) hurt(b.damage, 0.9);
          if ((!sees && d < 1) || e.unseenT > 30 || !sameArea) { e.state = 'search'; e.search = null; }
        } else this.searchRoutine(e, b.speed * 0.5, dt);
        break;
      }

      // Spore lizard: skittish. Faces you, puffs a spore cloud and backs away; only bites when cornered.
      case 'puffer': {
        const sees = sameArea && this.seesPlayer(e, 14, 360);
        if (sees) { e.unseenT = 0; if (e.state === 'search') { e.state = 'alert'; e.stateT = 0; this.oneShot(e, 'tail', 1.2); this.playSfx(e, 'audioClips', 0.8); } } else e.unseenT += dt;
        if (e.state === 'alert') {
          if (e.unseenT > 10) { e.state = 'search'; e.search = null; break; }
          if (e.puffT > 0) { e.puffT -= dt; e.animKey = 'sneeze'; break; }
          if (sameArea && dist < 7.5) {
            if (dist < 1.9 && e.cooldown <= 0 && !p.dead) { this.oneShot(e, 'attack', 0.7); hurt(b.damage, 2.2); }
            else if (dist < 4.5 && (e.cloudCd || 0) <= 0) { e.cloudCd = 9; e.puffT = 1.1; this.oneShot(e, 'sneeze', 1.1); this._sporeCloud(e); }
            else {
              // back away to the node farthest from the player among nearby ones
              if (!e.target || e.stateT <= 0) { e.target = this.farthestNodeFrom(e, pp) ; e.path = []; e.stateT = 3; }
              e.beh.runAt = 3; this.followPath(e, e.target, b.fleeSpeed, dt, 7);
            }
          } else { e.animKey = 'alert'; this.facePlayer(e, dt, 4); }
        } else { this.searchRoutine(e, b.speed, dt); }
        e.cloudCd = Math.max(0, (e.cloudCd || 0) - dt);
        break;
      }

      // Ghost girl: haunts you. Appears staring from a distance, vanishes when approached; sometimes she chases, and her touch kills.
      case 'ghost': {
        const looking = sameArea && e.root.visible && this.playerLookingAt(e, 0.9);
        if (e.state === 'hidden') {
          e.animKey = 'idle';
          if (e.stateT <= 0 && sameArea) {
            const chase = Math.random() < 0.18 + e.haunt * 0.25;
            const spot = this.nodeNear(e, pp, chase ? 12 : 8, chase ? 26 : 22, true);
            if (spot) {
              e.pos.copy(spot); this.groundFollow(e, 1, 1e3); e.path = []; this.setVisible(e, true); this.facePlayer(e, 1, 100);
              if (chase) { e.state = 'chase'; e.stateT = 24; e.spd = b.speed; this.playSfx(e, 'audioClips', 1); }
              else { e.state = 'stare'; e.stateT = rand(5, 9); e.stareT = 0; e.haunt = Math.min(1, e.haunt + 0.2); if (Math.random() < 0.5) this.playSfx(e, 'audioClips', 0.6); }
            } else e.stateT = 3;
          }
        } else if (e.state === 'stare') {
          e.animKey = e.haunt > 0.6 && Math.random() < 0.002 ? 'dance' : 'idle';
          this.facePlayer(e, dt, 3);
          if (looking) e.stareT += dt;
          if (e.stateT <= 0 || e.stareT > 2.2 || dist < 5 || !sameArea) { this.setVisible(e, false); e.state = 'hidden'; e.stateT = rand(15, 40) * (1 - e.haunt * 0.5); }
        } else if (e.state === 'chase') {
          e.animKey = 'walk';
          e.spd = Math.min(7.5, e.spd + dt * 0.18);   // she gets faster the longer she has been after you
          this.followPath(e, pp, e.spd, dt, 8);
          const hb = g.items.sfx('heartbeat'); if (hb && (e.hbT = (e.hbT || 0) - dt) <= 0) { e.hbT = THREE.MathUtils.clamp(dist / 12, 0.35, 1.4); g.sound.play(hb, { vol: 0.5 }); }
          if (dist < 1.4 && sameArea && !p.dead) { p.damage(1000, 'Ghost girl'); this.setVisible(e, false); e.state = 'hidden'; e.stateT = 30; e.haunt = 0; }
          if (e.stateT <= 0 || !sameArea) { this.setVisible(e, false); e.state = 'hidden'; e.stateT = rand(20, 45); e.haunt = 0; }
        } else e.state = 'hidden';
        break;
      }

      // Nutcracker: patrols and stops to inspect. It only spots movement. Then it aims, fires the shotgun, reloads, and marches after you.
      case 'nutcracker': {
        const moving = this.playerMoving();
        const inCone = sameArea && this.seesPlayer(e, 40, e.state === 'inspect' ? 360 : 110, 2.5);
        const spotted = inCone && (moving || dist < 3);
        if (spotted) { e.lastPlayerPos = pp.clone(); e.unseenT = 0; } else e.unseenT += dt;
        const beginAttack = () => { e.state = 'aim'; e.stateT = 0.9; this.playSfx(e, 'audioClips', 1); };
        if (e.state === 'patrol') {
          this.searchRoutine(e, b.speed, dt);
          if (e.stateT <= 0 && !(e.search && e.search.waitT > 0)) { e.state = 'inspect'; e.stateT = 3.5; e.inspectYaw0 = e.yaw; this.oneShot(e, 'inspect', 3.5); }
          if (spotted) beginAttack();
        } else if (e.state === 'inspect') {
          e.animKey = 'inspect';
          e.yaw = e.inspectYaw0 + (1 - e.stateT / 3.5) * Math.PI * 2; e.root.rotation.y = e.yaw;
          if (spotted) beginAttack();
          else if (e.stateT <= 0) { e.state = 'patrol'; e.stateT = rand(6, 11); e.oneShotT = 0; }
        } else if (e.state === 'aim') {
          e.animKey = 'aim';
          const dy = this.facePlayer(e, dt, 5);
          if (dist < 2.4 && e.cooldown <= 0 && !p.dead) { this.oneShot(e, 'attack', 0.8); hurt(b.kickDamage, 1.6); }
          else if (e.stateT <= 0 && dy < 0.35) { this._shotgun(e, sameArea, dist); e.state = 'reload'; e.stateT = 2.4; this.oneShot(e, 'shoot', 0.9); }
          if (!sameArea || e.unseenT > 4) { e.state = 'hunt'; }
        } else if (e.state === 'reload') {
          if (e.oneShotT <= 0) e.animKey = 'reload';
          this.facePlayer(e, dt, 2);
          if (dist < 2.4 && e.cooldown <= 0 && !p.dead) { this.oneShot(e, 'attack', 0.8); hurt(b.kickDamage, 1.6); }
          if (e.stateT <= 0) e.state = (spotted || e.unseenT < 2) ? 'aim' : 'hunt';
          if (e.state === 'aim') e.stateT = 0.9;
        } else if (e.state === 'hunt') {
          e.animKey = 'run';
          const tgt = e.lastPlayerPos || pp;
          const d = this.followPath(e, tgt, b.chaseSpeed, dt, 6, 1.8);
          if (spotted && dist < 30) beginAttack();
          else if (d < 1.5 || e.unseenT > 12) { e.state = 'patrol'; e.stateT = 1; e.search = null; e.searchCentre = tgt.clone(); }
        } else e.state = 'patrol';
        break;
      }

      // Eyeless dog: blind. Investigates sounds, chases loud or repeated ones, lunges at the last thing it heard.
      case 'dog': {
        // hearing
        let heard = null;
        for (const n of this.noises) { if (n.t > dt * 1.5) continue; const d = n.pos.distanceTo(e.pos); const range = 6 + n.loudness * 26; if (d < range && (!heard || n.loudness > heard.loudness)) heard = { pos: n.pos.clone(), loudness: n.loudness, d }; }
        if (heard && !p.attached) {
          e.heardPos = heard.pos; e.heardT = 0;
          e.suspicion += heard.loudness * (heard.d < 10 ? 2 : 1);
          if (e.state === 'roam') { e.state = 'suspicious'; e.stateT = 10; e.path = []; }
          if ((e.state === 'suspicious' || e.state === 'listen') && (e.suspicion >= 2.2 || (heard.loudness >= 0.9 && heard.d < 16))) { e.state = 'chase'; e.stateT = 12; this.oneShot(e, 'howl', 0.8); this.playSfx(e, 'audioClips', 1); }
          if (e.state === 'chase') e.stateT = 12;
        }
        e.heardT = (e.heardT || 0) + dt;
        e.suspicion = Math.max(0, e.suspicion - dt * 0.15);
        const contactKill = () => { if (sameArea && !p.attached && !p.dead && dist < b.killRange) { p.damage(1000, 'Eyeless dog'); this.oneShot(e, 'kill', 2.5); this.playSfx(e, 'hitEnemyVoiceSFX', 1); return true; } return false; };
        if (e.state === 'roam') {
          this.searchRoutine(e, b.speed, dt);
        } else if (e.state === 'suspicious') {
          e.animKey = e.moveAmount > 0.2 ? 'suspicious' : 'listen';
          const d = this.moveToward(e, e.heardPos, b.speed * 1.6, dt, 4);
          if (d < 1.5) { e.state = 'listen'; e.stateT = 4; }
          else if (e.stateT <= 0) e.state = 'roam';
        } else if (e.state === 'listen') {
          e.animKey = 'listen';
          if (e.stateT <= 0) { e.state = e.suspicion > 0.5 ? 'suspicious' : 'roam'; e.stateT = 10; if (e.state === 'roam') e.search = null; }
        } else if (e.state === 'chase') {
          if (e.oneShotT > 0 && e.animKey !== 'run') { /* howl */ }
          e.animKey = 'run'; e.beh.runAt = 1;
          const d = this.moveToward(e, e.heardPos, b.chaseSpeed, dt, 3.5);
          if (contactKill()) { e.state = 'listen'; e.stateT = 3; break; }
          if (d < 4.5) { e.state = 'lunge'; e.stateT = 0.55; e.lungeDir = new THREE.Vector3(Math.sin(e.yaw), 0, Math.cos(e.yaw)); this.oneShot(e, 'lunge', 0.6); }
          else if (e.stateT <= 0) { e.state = 'listen'; e.stateT = 3; }
        } else if (e.state === 'lunge') {
          e.animKey = 'lunge';
          e.pos.addScaledVector(e.lungeDir, 15 * dt); this.groundFollow(e, dt, 20);
          if (contactKill()) { e.state = 'listen'; e.stateT = 3; break; }
          if (e.stateT <= 0) { e.state = 'listen'; e.stateT = 2.2; this.oneShot(e, 'standUp', 1.2); }
        } else e.state = 'roam';
        break;
      }

      // Forest keeper: wanders, spots you from far away, runs you down and eats you. Loses interest if you stay out of sight.
      case 'giant': {
        const sees = sameArea && !p.attached && this.seesPlayer(e, 70, 170, 8);
        if (sees) { e.lastPlayerPos = pp.clone(); e.unseenT = 0; e.sightT = (e.sightT || 0) + dt; } else { e.unseenT += dt; e.sightT = 0; }
        if (e.state === 'roam') {
          this.searchRoutine(e, b.speed, dt);
          if (sees && e.sightT > 0.2) { e.state = 'chase'; this.playSfx(e, 'audioClips', 1); }
        } else if (e.state === 'chase') {
          e.animKey = 'run'; e.beh.runAt = 1;
          const tgt = sees ? pp : e.lastPlayerPos;
          const d = this.moveToward(e, tgt, b.chaseSpeed, dt, 2.2);
          this.voice(e, 4, 8, 1);
          if (sameArea && dist < b.grabRange && !p.attached && !p.dead) { e.state = 'eat'; e.stateT = 4; this.oneShot(e, 'eat', 4); p.damage(1000, 'Forest keeper'); }
          else if (!sees && d < 2) { e.state = 'investigate'; e.stateT = 3; this.oneShot(e, 'stare', 3); }
          else if (e.unseenT > 14) e.state = 'roam';
        } else if (e.state === 'investigate') {
          e.animKey = 'stare';
          if (sees) e.state = 'chase'; else if (e.stateT <= 0) { e.state = 'roam'; e.search = null; }
        } else if (e.state === 'eat') {
          e.animKey = 'eat';
          if (e.stateT <= 0) { e.state = 'roam'; e.search = null; }
        } else e.state = 'roam';
        break;
      }

      // Manticoil: harmless. Pecks around, flies off when approached, lands somewhere else.
      case 'bird': {
        if (e.state === 'ground') {
          e.animKey = 'idle';
          if (e.stateT <= 0) { e.stateT = rand(3, 8); e.yaw += rand(-1, 1); e.root.rotation.y = e.yaw; }
          if (sameArea && dist < 9) { e.state = 'takeoff'; e.stateT = 0.6; this.oneShot(e, 'takeoff', 0.6); e.flyTarget = this.nodeNear(e, pp, 25, 60) || e.home.clone(); e.flyT = 0; e.flyFrom = e.pos.clone(); }
        } else if (e.state === 'takeoff') {
          e.pos.y += 3 * dt; if (e.stateT <= 0) { e.state = 'fly'; }
        } else if (e.state === 'fly') {
          e.animKey = 'glide';
          e.flyT += dt; const T = Math.max(3, e.flyFrom.distanceTo(e.flyTarget) / b.speed);
          const k = Math.min(1, e.flyT / T);
          e.pos.lerpVectors(e.flyFrom, e.flyTarget, k); e.pos.y += Math.sin(k * Math.PI) * 9;
          this.turnToward(e, e.flyTarget, dt, 3);
          if (k >= 1) { e.state = 'land'; e.stateT = 0.8; this.oneShot(e, 'land', 0.8); this.groundFollow(e, 1, 1e3); }
        } else if (e.state === 'land') { if (e.stateT <= 0) { e.state = 'ground'; e.stateT = rand(3, 8); } }
        else e.state = 'ground';
        break;
      }

      // Locust swarm: hovers, scatters when you walk into it.
      case 'locust': {
        if (e.state === 'hover') { e.pos.y = e.home.y + 1 + Math.sin(e.t * 2) * 0.3; if (sameArea && dist < 4) { e.state = 'scatter'; e.stateT = 8; e.away = e.pos.clone().sub(pp).setY(0).normalize(); } }
        else { e.pos.addScaledVector(e.away, 6 * dt); e.pos.y = e.home.y + 2 + Math.sin(e.t * 5); if (e.stateT <= 0) { e.state = 'hover'; e.home.copy(e.pos); } }
        break;
      }
      default: e.animKey = 'idle'; break;
    }
  }

  // ---------- helpers for behaviours ----------
  _carry(e, it) {
    if (!it || it.held) return;
    it.carriedBy = e;
    const holder = e.root; it.obj.parent && it.obj.parent.remove(it.obj);
    holder.add(it.obj); it.obj.position.set(0, e.height * 0.55, 0.5); it.obj.rotation.set(0, 0, 0);
    it.obj.scale.setScalar(1);
    e.carried = it;
  }
  _dropCarried(e, at) {
    const it = e.carried; if (!it) return;
    e.carried = null; it.carriedBy = null;
    it.obj.parent && it.obj.parent.remove(it.obj);
    this.game.scene.add(it.obj);
    this.game.items.placeOnFloor(it, at.clone().add(new THREE.Vector3(0, 0.4, 0)), [this.game.dungeon.collider].filter(Boolean), Math.random() * 6.28);
    it.area = 'inside'; it.onShip = false;
  }
  _spinWebs(e) {
    const g = this.game; const graph = g.dungeon.graph; if (!graph) return;
    const near = graph.nodes.map((n, i) => ({ n, i, d: n.p.distanceTo(e.home) })).filter(x => x.d > 1.5 && x.d < 16).sort((a, b) => a.d - b.d).slice(0, 7);
    const mat = new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.55 });
    for (const x of near.slice(0, 4 + Math.floor(Math.random() * 3))) {
      const pts = [];
      const R = 1.1;
      for (let s = 0; s < 8; s++) { const a = s / 8 * Math.PI * 2; pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0)); }
      for (let ring = 1; ring <= 3; ring++) { const r = R * ring / 3; for (let s = 0; s < 8; s++) { const a0 = s / 8 * Math.PI * 2, a1 = (s + 1) / 8 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a0) * r, Math.sin(a0) * r, 0), new THREE.Vector3(Math.cos(a1) * r, Math.sin(a1) * r, 0)); } }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mesh = new THREE.LineSegments(geo, mat);
      const pos = x.n.p.clone(); pos.y += 1.3;
      // face along the direction to the tile centre so the web spans the doorway
      const tc = x.n.tile && x.n.tile.center ? x.n.tile.center : e.home;
      const yaw = Math.atan2(tc.x - pos.x, tc.z - pos.z);
      mesh.position.copy(pos); mesh.rotation.y = yaw;
      g.dungeon.root.add(mesh);
      this.webs.push({ pos, mesh, owner: e, yaw, tripT: 0 });
    }
  }
  _sporeCloud(e) {
    const geo = new THREE.SphereGeometry(1, 12, 10);
    const mat = new THREE.MeshBasicMaterial({ color: 0xb9a6c9, transparent: true, opacity: 0.85, depthWrite: false, fog: true });
    const mesh = new THREE.Mesh(geo, mat); mesh.position.copy(e.pos).add(new THREE.Vector3(Math.sin(e.yaw) * 1.2, 1.0, Math.cos(e.yaw) * 1.2)); mesh.scale.setScalar(0.1);
    (e.area === 'inside' ? this.game.dungeon.root : this.game.world.levelRoot).add(mesh);
    this.clouds.push({ mesh, t: 0 });
  }
  _shotgun(e, sameArea, dist) {
    const g = this.game, p = g.player;
    const clip = g.items.sfx('shotgun') || pickClip(e.sfx.audioClips); if (clip) g.sound.play(clip, { pos: e.pos.clone(), vol: 1, min: 3, max: 80 });
    this.onNoise(e.pos, 1.5);
    if (!sameArea || p.dead) return;
    const hit = this.canSee(e, p.eye, 40);
    if (!hit) return;
    const dmg = dist < 3.7 ? 100 : dist < 10 ? 60 : dist < 22 ? 30 : 12;
    p.damage(dmg, 'Nutcracker');
  }

  // ---------- reactions ----------
  onMash() { for (const e of this.list) if (e.state === 'latched') e.mash = (e.mash || 0) + 1; }

  /** the shovel: hit whatever enemy (or web) is in front of the player */
  hitInFront(player, range, force) {
    const f = player.forward(new THREE.Vector3());
    let hitSomething = false;
    for (const e of this.list) {
      if (e.dead || !e.root.visible || (e.area === 'inside') !== !!this.game.inside) continue;
      // nearest point of the body (a vertical capsule of the enemy's radius/height) to the player's eye
      const eye = player.eye.clone();
      const cy = THREE.MathUtils.clamp(eye.y, e.pos.y + 0.2, e.pos.y + Math.max(0.4, e.height - 0.2));
      const centre = new THREE.Vector3(e.pos.x, cy, e.pos.z);
      const to = centre.sub(eye); const d = Math.max(0, to.length() - e.radius);
      const flat = new THREE.Vector3(to.x, 0, to.z).normalize();
      if (d < range && flat.dot(f) > 0.45) { this.hitEnemy(e, force); hitSomething = true; }
    }
    for (const w of this.webs) {
      if (w.broken || !this.game.inside) continue;
      const to = w.pos.clone().sub(player.eye); const d = to.length();
      if (d < range + 0.5 && to.normalize().dot(f) > 0.6) { w.broken = true; w.mesh.visible = false; hitSomething = true; }
    }
    return hitSomething;
  }
  hitEnemy(e, force) {
    const b = e.beh, p = this.game.player;
    this.playSfx(e, 'hitBodySFX'); this.playSfx(e, 'hitEnemyVoiceSFX', 0.8);
    if (e.hp !== Infinity) e.hp -= force;
    // reactions
    if (b.kind === 'bracken') { e.anger = 99; e.state = 'angry'; }
    if (b.kind === 'hoarder') { e.state = 'angry'; e.stateT = 12; }
    if (b.kind === 'spider' || b.kind === 'thumper' || b.kind === 'blob') { e.state = 'chase'; e.lastPlayerPos = p.pos.clone(); e.unseenT = 0; }
    if (b.kind === 'nutcracker' && e.state !== 'aim' && e.state !== 'reload') { e.state = 'aim'; e.stateT = 0.4; e.lastPlayerPos = p.pos.clone(); e.unseenT = 0; }
    if (b.kind === 'dog') { e.heardPos = p.pos.clone(); e.suspicion = 5; e.state = 'chase'; e.stateT = 8; }
    if (b.kind === 'puffer') { e.state = 'alert'; e.cloudCd = 0; }
    if (b.kind === 'snareflea' && e.state === 'ceiling') { e.state = 'drop'; e.relocate = true; e.root.rotation.x = 0; }
    if (b.kind === 'bird' && e.state === 'ground') { e.state = 'takeoff'; e.stateT = 0.6; e.flyTarget = this.nodeNear(e, p.pos, 25, 60) || e.home.clone(); e.flyT = 0; e.flyFrom = e.pos.clone(); }
    if (e.hp <= 0 && e.def.canDie !== false) this.kill(e);
  }
  kill(e) {
    e.dead = true; e.oneShotT = 99;
    this.playSfx(e, 'deathSFX', 1);
    if (!this.oneShot(e, 'die', 99)) e.root.rotation.z = Math.PI / 2;
    if (e.carried) this._dropCarried(e, e.pos);
    if (e.state === 'latched') { this.game.hud.showNotice('', 0.1); }
    for (const w of this.webs) if (w.owner === e) { /* webs stay */ }
    if (e.area === 'inside') this.insidePower -= e.def.power || 1; else this.outsidePower -= e.def.power || 1;
  }

  scannables(from, range) {
    return this.list.filter(e => (e.area === 'inside') === !!this.game.inside && e.root.visible && e.pos.distanceTo(from) < range).map(e => ({ pos: () => e.pos.clone().add(new THREE.Vector3(0, e.height * 0.8, 0)), text: e.scanName + (e.dead ? ' (dead)' : ''), value: null }));
  }
}
