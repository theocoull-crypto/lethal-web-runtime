// Ship decor: buy furniture at the terminal, it turns up on the ship, and you rearrange it like the game's build mode:
// look at a piece and press B to pick it up, move the mouse to carry it, R (or the wheel) to rotate, left click or B to
// put it down. Pieces live under the ship object so they ride along on landing and take-off, and they collide.
import * as THREE from 'three';
import { Collider, collisionEntries } from './collision.js';
import { Animator } from './anim.js';

// ship-local spots where new purchases appear, tried in order; a spot is used only if the deck is bare floor there
// and no other piece is within reach of it (the back wall of the main room first, then the sides)
const SLOTS = [[-3.4, 0, -8.6], [0.8, 0, -8.6], [-3.5, 0, -6.2], [1.5, 0, -6.2], [-2, 0, -4.8], [1, 0, -4.8], [-0.5, 0, -5.4], [4, 0, -7.5], [6.4, 0, -6.6], [-1.2, 0, -8.6]];
// the cabin interior in ship-local coordinates (the door is on the +x side; beyond it is the outside catwalk)
const CABIN = { xMin: -9.4, xMax: 6.8, zMin: -9.5, zMax: -4.2 };
// pieces that hang rather than stand
const CEILING = /Disco Ball/i, WALL = /painting|welcome mat/i;
// the ship's built-in fixtures (ship-local x min, x max, z min, z max, with a little margin): nothing goes on top of these
const FIXTURES = [[-8.0, -4.3, -10.5, -7.3], [-10.5, -7.6, -10.5, -4.5], [-2.5, -0.5, -9.8, -8.3], [2.0, 6.6, -6.9, -4.0], [-10.4, -6.0, -5.5, -2.7], [-7.2, -4.7, -4.8, -2.7], [4.2, 6.3, -9.5, -8.2]];
const SAVE_KEY = 'lethalweb.decor';
const _v = new THREE.Vector3();
let _tv = null;
/** a small canvas of static for the television screen (no video here) */
function tvStatic() {
  if (_tv) return _tv;
  const c = document.createElement('canvas'); c.width = 96; c.height = 72; const x = c.getContext('2d');
  const img = x.createImageData(96, 72);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.flipY = false;
  _tv = { tex, t: 0, on: 0, refresh() { const d = img.data; for (let i = 0; i < d.length; i += 4) { const v = 40 + Math.random() * 215; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; } x.putImageData(img, 0, 0); tex.needsUpdate = true; } };
  _tv.refresh();
  return _tv;
}
let _flameTex = null;
function flameTexture() {
  if (_flameTex) return _flameTex;
  const c = document.createElement('canvas'); c.width = 32; c.height = 48; const x = c.getContext('2d');
  const g = x.createRadialGradient(16, 30, 1, 16, 26, 16);
  g.addColorStop(0, 'rgba(255,250,220,1)'); g.addColorStop(0.35, 'rgba(255,190,80,0.9)'); g.addColorStop(0.7, 'rgba(255,110,20,0.35)'); g.addColorStop(1, 'rgba(255,60,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 48);
  _flameTex = new THREE.CanvasTexture(c); _flameTex.colorSpace = THREE.SRGBColorSpace;
  return _flameTex;
}

export class Decor {
  constructor(game) {
    this.game = game; this.lib = game.lib;
    this.catalog = []; this.placed = []; this.carry = null; this.slot = 0;
  }

  async load() {
    try { this.catalog = await fetch('assets/decor.json').then(r => r.ok ? r.json() : []); } catch (e) { this.catalog = []; }
    for (const d of this.catalog) this.lib.manifest('prefabs/' + d.prefab).catch(() => null);
  }

  /** store entries for the terminal */
  storeList() {
    return this.catalog.map(d => ({ key: d.name.toLowerCase(), name: d.name, price: d.price, decor: d, names: [d.name.toLowerCase(), d.name.toLowerCase().split(' ')[0]] }));
  }

  owned(d) { return this.placed.filter(e => e.def === d).length; }

  async buy(d, opts = {}) {
    const g = this.game, w = g.world;
    const man = await this.lib.manifest('prefabs/' + d.prefab).catch(() => null);
    if (!man) return null;
    const inst = await this.lib.instantiate(man, { lights: true });
    const root = inst.root;
    // these prefabs are authored with the model already sitting at its default spot on the ship (the game moves the
    // model, not the container): re-centre so the root is the piece's footprint centre (bottom for floor pieces, top
    // for hanging ones)
    root.position.set(0, 0, 0); root.quaternion.identity(); root.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(root);
    if (!bb.isEmpty()) {
      const c = bb.getCenter(new THREE.Vector3());
      const anchor = new THREE.Vector3(c.x, CEILING.test(d.name) ? bb.max.y : bb.min.y, c.z);
      for (const ch of root.children) ch.position.sub(anchor);
    }
    // pure-white surfaces (the toilet, the shower) bloom under the cabin lights; take them down a notch
    root.traverse(o => { if (o.isMesh) { for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m.color && !m.userData.dimmed) { m.userData.dimmed = true; const mx = Math.max(m.color.r, m.color.g, m.color.b); if (mx > 0.8) m.color.multiplyScalar(0.8 / mx); } } });
    w.shipObj.add(root);
    const slot = opts.local || this._freeSlot();
    root.position.set(slot[0], slot[1], slot[2]); root.rotation.set(0, opts.yaw || 0, 0);
    root.updateMatrixWorld(true);
    const entry = { def: d, inst, root, col: null, anims: [], lights: [], triggers: [], yaw: opts.yaw || 0, sfx: null };
    for (const n of man.nodes) for (const c of n.comps) {
      if (c.t === 'MB' && /PlaceableShipObject$/.test(c.cls || '') && c.d && c.d.placeObjectSFX && c.d.placeObjectSFX.$) entry.sfx = c.d.placeObjectSFX.$;
    }
    await this._setupBehaviour(entry, man);
    await this._buildCollider(entry);
    this._settle(entry);
    this.placed.push(entry);
    w.interactables.push({ obj: root, radius: 1.5, reach: 3.2, label: () => this.carry ? '' : `[B] Move ${d.name}`, action: () => {}, decor: entry });
    if (!opts.silent && entry.sfx) g.sound.play(entry.sfx, { pos: root.getWorldPosition(new THREE.Vector3()), vol: 0.8, min: 2, max: 30 });
    this.save();
    return entry;
  }

  /** first candidate spot that is bare deck and clear of other furniture; otherwise beside the player */
  /** the floor area furniture may use (ship-local); the wider ship upgrade extends it */
  cabin() { return this.game.world.cabin || CABIN; }

  _freeSlot() {
    const w = this.game.world;
    for (const s of SLOTS) {
      const o = w.shipObj.localToWorld(new THREE.Vector3(s[0], 3.5, s[2]));
      const h = w.shipCollider.raycast(o, new THREE.Vector3(0, -1, 0), 6);
      if (!h) continue;
      const ly = w.shipObj.worldToLocal(h.point.clone()).y;
      if (ly > 0.15 || ly < -0.5) continue;
      const taken = this.placed.some(e => Math.hypot(e.root.position.x - s[0], e.root.position.z - s[2]) < 1.8);
      if (!taken && this._clearAt(s[0], s[2], 0.8)) return [s[0], ly, s[2]];
    }
    // every slot taken: any free bit of deck, scanned front to back
    const cab = this.cabin();
    for (let z = cab.zMin + 0.8; z < cab.zMax; z += 0.8) for (let x = cab.xMin + 0.8; x < cab.xMax; x += 0.8) {
      const ly = this._floorAt(x, z); if (ly == null) continue;
      if (this.placed.some(e => Math.hypot(e.root.position.x - x, e.root.position.z - z) < 1.6)) continue;
      if (!this._clearAt(x, z, 0.8)) continue;
      return [x, ly, z];
    }
    const pl = w.shipObj.worldToLocal(this.game.player.pos.clone());
    return [pl.x + 1.5, pl.y, pl.z];
  }

  /** what a piece does: idle animations, its lights, and the interact triggers with their sounds and animations */
  async _setupBehaviour(entry, man) {
    const g = this.game, inst = entry.inst, name = entry.def.name;
    // animators, remembered with their node so a trigger can find the one it drives (fridge doors each have their own)
    for (const n of man.nodes) for (const c of n.comps) {
      if (c.t === 'Animator' && c.controller) { const o = inst.objs.get(n.id); if (o) { const a = new Animator(o, c.controller); a.nodeId = n.id; entry.anims.push(a); await a.load().catch(() => null); } }
    }
    const clipsOf = a => (a && a.ready) ? a.names() : [];
    const playMatching = (re, opts, anims = entry.anims) => { for (const a of anims) { const nm = clipsOf(a).find(x => re.test(x)); if (nm) { a.play(nm, opts); return true; } } return false; };
    // lights: scale like the ship's own, remember the base so they can be switched
    entry.root.traverse(o => { if (o.isPointLight || o.isSpotLight) { o.intensity = Math.min(o.intensity, 60) * 0.03; o.distance = Math.max(o.distance || 0, 6); o.decay = 2; o.castShadow = false; o.userData.base = o.intensity; entry.lights.push(o); } });
    // lights the prefab keeps switched off until used (the television's) are not created by the loader: add them under the root
    entry.root.updateMatrixWorld(true);
    for (const n of man.nodes) for (const c of n.comps) {
      if (c.t !== 'Light' || c.type !== 2 || !(n.active === false || c.enabled === false)) continue;
      const o = inst.objs.get(n.id); if (!o) continue;
      const col = c.color ? new THREE.Color(c.color[0], c.color[1], c.color[2]) : new THREE.Color(1, 1, 1);
      const l = new THREE.PointLight(col, Math.min(c.intensity || 10, 60) * 0.03, Math.max(c.range || 0, 6), 2);
      l.position.copy(entry.root.worldToLocal(o.getWorldPosition(new THREE.Vector3()))); l.userData.base = l.intensity; l.castShadow = false;
      entry.root.add(l); entry.lights.push(l);
    }
    const setLights = on => { for (const l of entry.lights) l.intensity = on ? l.userData.base : 0; };
    // sprite renderers (the candle flames) are not loaded: stand in a small glowing billboard, shown while lit
    entry.sprites = [];
    for (const n of man.nodes) if (n.comps.some(c => c.t === 'SpriteRenderer')) {
      const o = inst.objs.get(n.id); if (!o) continue;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTexture(), color: 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.scale.set(0.8, 1.3, 1); sp.position.y = -0.3; sp.visible = false; o.add(sp); entry.sprites.push(sp);
    }
    const setSprites = on => { for (const sp of entry.sprites) sp.visible = on; };
    // idle behaviour per piece
    if (/Goldfish/i.test(name)) playMatching(/Fishbowl/i, { loop: true });
    if (/Disco/i.test(name)) { playMatching(/Spin/i, { loop: true }); setLights(true); entry.spin = true; }
    if (/Romantic|Electric|Microwave|Television/i.test(name)) setLights(false);   // candles, the chair's lights and the microwave light off until used
    // interact triggers (E): flush, water, record, candles, squeeze, fridge, pumpkin, TV, straps
    const byId = new Map(man.nodes.map(n => [n.id, n]));
    for (const n of man.nodes) {
      const it = n.comps.find(c => c.t === 'MB' && c.cls === 'InteractTrigger' && c.d);
      if (!it) continue;
      const tipRaw = (it.d.hoverTip || '').replace(/\s*:?\s*\[LMB\]\s*$/i, '').trim();
      if (!tipRaw || /^(Sit|Store item)$/i.test(tipRaw)) continue;
      const aot = (n.comps.find(c => c.t === 'MB' && c.cls === 'AnimatedObjectTrigger' && c.d) || {}).d || null;
      const obj = inst.objs.get(n.id); if (!obj) continue;
      const ids = arr => (arr || []).map(x => x && x.$).filter(Boolean);
      let anims = entry.anims;   // the closest animator up the chain drives this trigger
      for (let q = n; q; q = byId.get(q.parent)) { const a = entry.anims.find(x => x.nodeId === q.id); if (a) { anims = [a]; break; } }
      const trig = { obj, tip: tipRaw, aot, on: false, loop: null, name: n.name, anims,
        trueA: ids(aot && aot.boolTrueAudios), falseA: ids(aot && aot.boolFalseAudios), whileTrue: aot && aot.playWhileTrue && aot.playWhileTrue.$ };
      // the object's own audio source clips are the fallback (the toilet's flush lives on the trigger node)
      for (const c of n.comps) if (c.t === 'Audio' && c.clip && !trig.falseA.length) trig.falseA.push(c.clip);
      entry.triggers.push(trig);
      const wp = () => obj.getWorldPosition(new THREE.Vector3());
      g.world.interactables.push({ obj, radius: 1.0, reach: 2.8, label: () => this.carry ? '' : `[E] ${trig.tip}${trig.on ? '  (on)' : ''}`, action: () => this._use(entry, trig, wp()), decor: entry });
    }
    // switching helpers used by _use
    entry.setLights = setLights; entry.setSprites = setSprites; entry.playMatching = playMatching;
  }

  _use(entry, trig, pos) {
    const g = this.game;
    const play = (list, vol = 0.8) => { if (!list.length) return; g.sound.play(list[Math.floor(Math.random() * list.length)], { pos, vol, min: 2, max: 25 }); };
    const isBool = !!(trig.aot && trig.aot.isBool);
    if (isBool) {
      trig.on = !trig.on;
      play(trig.on ? trig.trueA : trig.falseA);
      if (trig.on && trig.whileTrue) { const r = g.sound.play(trig.whileTrue, { pos, vol: 0.6, min: 2, max: 25, loop: true }); if (r && r.then) r.then(h => { trig.loop = h; if (!trig.on && h && h.stop) h.stop(0.2); }); }
      if (!trig.on && trig.loop && trig.loop.stop) { trig.loop.stop(0.4); trig.loop = null; }
      if (trig.on) entry.playMatching(/On$|Open|Play|Strapped|Cook|Lit/i, { once: true, loop: false, fade: 0.1 }, trig.anims) || entry.playMatching(/./, { loop: true }, trig.anims);
      else entry.playMatching(/Off|Close|Stop/i, { once: true, loop: false, fade: 0.1 }, trig.anims) || (trig.anims.forEach(a => a.ready && a.stop()));
      if (/Romantic|Electric|Microwave/i.test(entry.def.name)) entry.setLights(trig.on);
      entry.setSprites(trig.on);
    } else {
      play(trig.falseA.length ? trig.falseA : trig.trueA);
      entry.playMatching(/Squeeze|Hit|Flush|Open/i, { once: true, loop: false, fade: 0.05 }, trig.anims);
      if (/Television/i.test(entry.def.name)) { entry.tvOn = !entry.tvOn; entry.setLights(entry.tvOn); this._tvSet(entry, entry.tvOn); }
    }
    g.enemies.onNoise(pos, 0.5);
  }

  // ---------- the television: plays the tapes in assets/tv (tools/pack_tv.py), static while a tape loads ----------
  _tvPlaylist() {
    if (!this._tvList) this._tvList = fetch('assets/tv/index.json').then(r => r.ok ? r.json() : []).catch(() => []);
    return this._tvList;
  }

  _tvScreens(entry) {
    const out = [];
    entry.root.traverse(o => { if (o.isMesh && o.material && /screen/i.test((o.material.name || '') + ' ' + o.name)) { if (!o.material.userData.tvSplit) { o.material = o.material.clone(); o.material.userData.tvSplit = true; } out.push(o.material); } });
    return out;
  }

  _tvSet(entry, on) {
    const mats = this._tvScreens(entry);
    if (!on) {
      this._tvStopVideo(entry);
      for (const m of mats) { m.emissiveMap = null; m.emissive.setRGB(0, 0, 0); m.needsUpdate = true; }
      return;
    }
    for (const m of mats) { m.emissiveMap = tvStatic().tex; m.emissive.setRGB(0.75, 0.78, 0.85); m.emissiveIntensity = 1; m.needsUpdate = true; }
    this._tvPlaylist().then(list => { if (entry.tvOn && list.length) this._tvPlay(entry, list); });
  }

  _tvPlay(entry, list) {
    this._tvStopVideo(entry);
    // a random tape, not the one that just ended
    let pick = list[Math.floor(Math.random() * list.length)];
    if (list.length > 1 && pick.file === entry.tvLast) pick = list[(list.indexOf(pick) + 1) % list.length];
    entry.tvLast = pick.file;
    const v = document.createElement('video');
    v.src = 'assets/tv/' + pick.file; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'; v.muted = false;
    const tex = new THREE.VideoTexture(v); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const tv = { video: v, tex, audio: null, title: pick.title };
    entry.tv = tv;
    const g = this.game;
    // the tape's sound comes out of the set
    try {
      g.sound.ensure();
      const ctx = g.sound.ctx, src = ctx.createMediaElementSource(v), gain = ctx.createGain(), pan = ctx.createPanner();
      gain.gain.value = 0.9; pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 1.5; pan.maxDistance = 30; pan.rolloffFactor = 1.2;
      const p = entry.root.getWorldPosition(new THREE.Vector3()); pan.positionX.value = p.x; pan.positionY.value = p.y + 0.6; pan.positionZ.value = p.z;
      src.connect(gain); gain.connect(pan); pan.connect(g.sound.master);
      tv.audio = { setPos(q) { pan.positionX.value = q.x; pan.positionY.value = q.y + 0.6; pan.positionZ.value = q.z; }, stop() { try { src.disconnect(); gain.disconnect(); pan.disconnect(); } catch (e) { } } };
    } catch (e) { console.warn('tv audio', e); }
    v.addEventListener('playing', () => { if (entry.tv !== tv) return; for (const m of this._tvScreens(entry)) { m.emissiveMap = tex; m.emissive.setRGB(1, 1, 1); m.emissiveIntensity = 1.35; m.needsUpdate = true; } });
    v.addEventListener('ended', () => { if (entry.tv === tv && entry.tvOn) this._tvPlay(entry, list); });
    v.addEventListener('error', () => { if (entry.tv === tv && entry.tvOn) setTimeout(() => { if (entry.tv === tv && entry.tvOn) this._tvPlay(entry, list); }, 1500); });
    v.play().catch(e => console.warn('tv play', e));
  }

  _tvStopVideo(entry) {
    const tv = entry.tv; if (!tv) return;
    entry.tv = null;
    try { tv.video.pause(); tv.video.removeAttribute('src'); tv.video.load(); } catch (e) { }
    if (tv.audio) tv.audio.stop();
    tv.tex.dispose();
  }

  async _buildCollider(entry) {
    const entries = await collisionEntries(this.lib, entry.inst, { relativeTo: entry.root, exclude: n => [9, 13, 14, 15, 22, 26, 29].includes(n.layer) });
    if (entries.length) entry.col = new Collider('decor').build(entries, entry.root);
  }

  /** deck height (ship-local y) at a ship-local x/z, or null when that spot is a fixture, a wall or off the deck */
  /** nothing of the ship (walls, poles, desks) within r of a deck spot at hip and shoulder height */
  _clearAt(x, z, r) {
    const w = this.game.world, q = w.shipObj.getWorldQuaternion(new THREE.Quaternion());
    for (const h of [0.5, 1.3]) {
      const c = w.shipObj.localToWorld(new THREE.Vector3(x, h, z));
      for (let k = 0; k < 8; k++) {
        const ang = k / 8 * Math.PI * 2;
        if (w.shipCollider.raycast(c, new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)).applyQuaternion(q), r)) return false;
      }
    }
    return true;
  }

  _floorAt(x, z) {
    const w = this.game.world;
    const o = w.shipObj.localToWorld(new THREE.Vector3(x, 3.2, z));
    const h = w.shipCollider.raycast(o, new THREE.Vector3(0, -1, 0), 6);
    if (!h) return null;
    const ly = w.shipObj.worldToLocal(h.point.clone()).y;
    if (ly > 0.3 || ly < -0.6) return null;
    for (const f of FIXTURES) if (x > f[0] && x < f[1] && z > f[2] && z < f[3]) return null;
    return ly;
  }

  /** drop the piece onto the deck under it (hanging pieces keep their height) */
  _settle(entry) {
    const root = entry.root;
    if (CEILING.test(entry.def.name)) {
      const w = this.game.world; const o = w.shipObj.localToWorld(new THREE.Vector3(root.position.x, 1.0, root.position.z));
      const h = w.shipCollider.raycast(o, new THREE.Vector3(0, 1, 0).applyQuaternion(w.shipObj.getWorldQuaternion(new THREE.Quaternion())), 8);
      if (h) root.position.y = w.shipObj.worldToLocal(h.point.clone()).y - 0.05;
    } else if (!(WALL.test(entry.def.name) && root.position.y > 0.4)) {
      const y = this._floorAt(root.position.x, root.position.z);
      if (y != null) root.position.y = y;
    }
    root.updateMatrixWorld(true);
  }

  /** take a piece off the ship (its sounds stop, its prompts go) */
  remove(entry) {
    if (this.carry === entry) this.cancel();
    for (const t of entry.triggers) if (t.loop && !t.loop.done) t.loop.stop(0.2);
    this._tvStopVideo(entry);
    for (const a of entry.anims) if (a.ready) a.stop();
    if (entry.root.parent) entry.root.parent.remove(entry.root);
    const w = this.game.world; w.interactables = w.interactables.filter(i => i.decor !== entry);
    this.placed = this.placed.filter(e => e !== entry);
    this.save();
  }

  clear() { for (const e of this.placed.slice()) this.remove(e); }

  colliders(except = null) { return this.placed.filter(e => e.col && e !== except && e !== this.carry).map(e => e.col); }

  // ---------- build mode ----------
  toggle() {
    if (this.carry) return this.place();
    const t = this.game.lookTarget();
    if (!t || !t.decor) return;
    const e = t.decor;
    this.carry = e; e.from = { pos: e.root.position.clone(), yaw: e.yaw };
    this.game.hud.showTip('[LMB] Place   [R] / wheel Rotate   [B] Put back', 6);
  }

  place() {
    const e = this.carry; if (!e) return;
    const w = this.game.world;
    if (!w.onShipDeck(e.root.getWorldPosition(new THREE.Vector3()))) { this.game.hud.showTip('Furniture has to stay on the ship.', 2); return; }
    this.carry = null; e.from = null;
    this._settle(e);
    if (e.sfx) this.game.sound.play(e.sfx, { pos: e.root.getWorldPosition(new THREE.Vector3()), vol: 0.7, min: 2, max: 30 });
    this.save();
  }

  cancel() {
    const e = this.carry; if (!e) return;
    if (e.from) { e.root.position.copy(e.from.pos); e.yaw = e.from.yaw; e.root.rotation.set(0, e.yaw, 0); }
    this.carry = null; e.from = null;
  }

  rotate(dir) { const e = this.carry; if (!e) return; e.yaw += dir * Math.PI / 12; e.root.rotation.set(0, e.yaw, 0); }

  update(dt) {
    if (_tv && this.placed.some(e => e.tvOn && !(e.tv && e.tv.video.readyState >= 3 && !e.tv.video.paused))) { _tv.t += dt; if (_tv.t > 0.07) { _tv.t = 0; _tv.refresh(); } }
    for (const e of this.placed) {
      for (const a of e.anims) if (a.ready) a.update(dt);
      for (const t of e.triggers) if (t.loop && !t.loop.done) t.loop.setPos(t.obj.getWorldPosition(_v));   // looping sounds follow the piece
      if (e.tv && e.tv.audio) e.tv.audio.setPos(e.root.getWorldPosition(_v));
    }
    const e = this.carry; if (!e) return;
    const g = this.game, w = g.world;
    const eye = g.camera.position.clone(), dir = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    // aim at the ship: floor, walls or another piece
    let hit = null;
    for (const c of this.colliders(e).concat([w.shipCollider])) { const h = c && c.raycast(eye, dir, 7); if (h && (!hit || h.distance < hit.distance)) hit = h; }
    let target;
    if (hit) target = hit.point.clone();
    else { target = eye.clone().addScaledVector(dir, 3.5); const h = w.shipCollider.raycast(target.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, -1, 0), 4); if (h) target.y = h.point.y; }
    const local = w.shipObj.worldToLocal(target);
    const cab = this.cabin();
    local.x = THREE.MathUtils.clamp(local.x, cab.xMin, cab.xMax); local.z = THREE.MathUtils.clamp(local.z, cab.zMin, cab.zMax);
    if (CEILING.test(e.def.name)) {
      // hangs from the ceiling above the aim point
      const o = w.shipObj.localToWorld(new THREE.Vector3(local.x, 1.0, local.z)); const h = w.shipCollider.raycast(o, new THREE.Vector3(0, 1, 0).applyQuaternion(w.shipObj.getWorldQuaternion(new THREE.Quaternion())), 8);
      if (h) { local.y = w.shipObj.worldToLocal(h.point.clone()).y - 0.05; e.root.position.lerp(local, Math.min(1, dt * 18)); }
    } else if (WALL.test(e.def.name) && hit && Math.abs(w.shipObj.worldToLocal(hit.point.clone()).y - local.y) < 0.01 && local.y > 0.4) {
      // aimed at a wall: sit on it, facing back into the room
      e.root.position.lerp(local, Math.min(1, dt * 18));
      const pl = w.shipObj.worldToLocal(g.player.pos.clone()); e.yaw = Math.atan2(pl.x - local.x, pl.z - local.z);
    } else {
      // furniture goes on the deck itself: find the floor under the aim point and refuse spots on top of fixtures
      const floorY = this._floorAt(local.x, local.z);
      if (floorY != null) { local.y = floorY; e.root.position.lerp(local, Math.min(1, dt * 18)); }
    }
    e.root.rotation.set(0, e.yaw, 0);
  }

  // ---------- persistence ----------
  save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.placed.map(e => ({ id: e.def.id, pos: e.root.position.toArray(), yaw: e.yaw })))); } catch (err) { }
  }
  async restore() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); } catch (err) { list = []; }
    for (const s of list) { const d = this.catalog.find(x => x.id === s.id); if (d) await this.buy(d, { local: s.pos, yaw: s.yaw, silent: true }); }
  }
}
