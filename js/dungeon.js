// Procedural facility built from the game's own DunGen tiles (Level1Flow), simplified re-implementation of DunGen.
import * as THREE from 'three';
import { Collider, collisionEntries } from './collision.js';
import { buildSkinned } from './loader.js';
import { MOON_DEFS } from './world.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Animator } from './anim.js';

const V = (o, mirror = true) => new THREE.Vector3(mirror ? -o.x : o.x, o.y, o.z);
/** swap two corners of every triangle of a non-indexed geometry (after baking a mirroring matrix) */
export function flipWinding(g) {
  for (const name of Object.keys(g.attributes)) {
    const at = g.attributes[name]; const a = at.array, n = at.itemSize;
    for (let t = 0; t + 3 * n <= a.length; t += 3 * n) for (let k = 0; k < n; k++) { const i1 = t + n + k, i2 = t + 2 * n + k; const tmp = a[i1]; a[i1] = a[i2]; a[i2] = tmp; }
    at.needsUpdate = true;
  }
  return g;
}

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function evalCurve(curve, t) {
  if (!curve || !curve.length) return 1;
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) { const a = curve[i - 1], b = curve[i]; const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]); return a[1] + (b[1] - a[1]) * f; }
  }
  return curve[curve.length - 1][1];
}

export class Dungeon {
  constructor(game) {
    this.game = game; this.lib = game.lib;
    this.root = new THREE.Group(); this.root.name = 'Dungeon'; this.root.visible = false;
    game.scene.add(this.root);
    this.catalog = null;
    this.catalogs = {};
    this.tileDefs = new Map();     // prefab file -> parsed def
    this.prefabCache = new Map();  // file -> manifest
    this.placed = [];
    this.collider = null;
    this.interactables = [];
    this.entranceInside = null; this.fireExitInside = null;
    this.scrapSpawns = []; this.hazardSpawns = []; this.vents = []; this.lights = [];
    this.doors = [];
    this.dynamicColliders = [];   // moving parts (the mineshaft elevator cage)
    this.elevator = null;
    this.graph = null;
    this.seed = 1;
  }

  async load() {
    const get = (file, what) => fetch(file).then(r => { if (!r.ok) throw new Error(what + ' assets are missing; run tools\extract.bat again.'); return r.json(); });
    const [experimentation, assurance, titan] = await Promise.all([get('assets/catalog.json', 'Experimentation'), get('assets/catalog_assurance.json', 'Assurance'), get('assets/catalog_titan.json', 'Titan')]);
    this.catalogs = { experimentation, assurance, titan };
    // every other moon in MOON_DEFS (mod moons are optional: skipped when their catalog was never packed)
    for (const m of MOON_DEFS) {
      if (this.catalogs[m.catalog]) continue;
      try { this.catalogs[m.catalog] = await get(`assets/catalog_${m.catalog}.json`, m.name); }
      catch (e) { if (!m.optional) throw e; }
    }
    await Promise.all(Object.values(this.catalogs).map(c => this._primeCatalog(c)));
    this.catalog = experimentation;
  }

  async _primeCatalog(catalog) {
    const files = new Set();
    for (const set of Object.values(catalog.tileSets)) for (const e of set) files.add(e.prefab);
    for (const f of catalog.doorParts) files.add(f);
    await Promise.all([...files].map(f => this.prefab(f)));
    for (const f of files) this.parseTile(f);
  }

  setLevel(key) {
    const catalog = this.catalogs[key] || this.catalogs.experimentation;
    this.catalog = catalog;
    return catalog;
  }

  async prefab(file) {
    if (!this.prefabCache.has(file)) this.prefabCache.set(file, this.lib.manifest('prefabs/' + file).catch(() => null));
    return this.prefabCache.get(file);
  }

  parseTile(file) {
    const man = this.prefabCache.get(file) && this._sync(file);
  }
  _sync(file) { return null; }

  /** Build a tile definition from its manifest (needs manifest resolved). */
  async tileDef(file) {
    if (this.tileDefs.has(file)) return this.tileDefs.get(file);
    const man = await this.prefab(file);
    if (!man) return null;
    const byId = new Map(man.nodes.map(n => [n.id, n]));
    const root = man.nodes.find(n => !n.parent);
    // local matrices (three space) for every node relative to the tile root
    const mats = new Map();
    const localOf = n => new THREE.Matrix4().compose(new THREE.Vector3(...n.p), new THREE.Quaternion(...n.r), new THREE.Vector3(...n.s));
    const worldOf = n => {
      if (mats.has(n.id)) return mats.get(n.id);
      let m;
      // DunGen's TileProxy zeroes the prefab root's position and rotation but keeps its scale (the mineshaft tiles are 0.85)
      if (!n.parent || n.id === root.id) m = new THREE.Matrix4().makeScale(root.s[0], root.s[1], root.s[2]);
      else m = new THREE.Matrix4().multiplyMatrices(worldOf(byId.get(n.parent)), localOf(n));
      mats.set(n.id, m); return m;
    };
    let tile = null; const doorways = [];
    for (const n of man.nodes) {
      for (const c of n.comps) {
        if (c.t !== 'MB' || !c.d) continue;
        if (c.cls === 'Tile') tile = c.d;
        if (c.cls === 'Doorway') {
          const m = worldOf(n); const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          m.decompose(pos, q, s);
          // forward straight from the matrix: the mineshaft's cave tiles sit under mirrored (negative-scale) parents, which
          // flips the doorway's facing in a way a decomposed quaternion cannot express - the old way sent caves the wrong way
          // full 3D frame, as DunGen's DoorwayProxy (LocalRotation): the mineshaft's cave tiles are authored on their side and
          // their doorways carry the tilt, which the placement rotation undoes
          const fwd = new THREE.Vector3(0, 0, 1).transformDirection(m).normalize();
          const up = new THREE.Vector3(0, 1, 0).transformDirection(m).normalize();
          { const zA = fwd.clone(), xA = new THREE.Vector3().crossVectors(up, zA).normalize(), yA = new THREE.Vector3().crossVectors(zA, xA).normalize(); q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA)); }
          doorways.push({
            node: n, pos, q, fwd, up, socket: (c.d.socket || {}).n || 'NormalDoor', priority: c.d.DoorPrefabPriority || 0,
            connectors: (c.d.ConnectorPrefabWeights || []).map(w => w.GameObject && w.GameObject.$).filter(Boolean),
            connectorWeights: (c.d.ConnectorPrefabWeights || []).filter(w => w.GameObject && w.GameObject.$).map(w => w.Weight ?? 1),
            blockers: (c.d.BlockerPrefabWeights || []).map(w => w.GameObject && w.GameObject.$).filter(Boolean),
            blockerWeights: (c.d.BlockerPrefabWeights || []).filter(w => w.GameObject && w.GameObject.$).map(w => w.Weight ?? 1),
            connScene: (c.d.ConnectorSceneObjects || []).map(x => x && x.$).filter(Boolean),
            blockScene: (c.d.BlockerSceneObjects || []).map(x => x && x.$).filter(Boolean),
          });
        }
      }
    }
    let b = null;
    if (tile) {
      const src = tile.OverrideAutomaticTileBounds ? tile.TileBoundsOverride : tile.placement && tile.placement.localBounds;
      if (src && (src.m_Extent.x > 0.01 || src.m_Extent.y > 0.01 || src.m_Extent.z > 0.01)) {
        const c = V(src.m_Center), e = src.m_Extent;   // V mirrors X into three.js space
        b = new THREE.Box3(new THREE.Vector3(c.x - e.x, c.y - e.y, c.z - e.z), new THREE.Vector3(c.x + e.x, c.y + e.y, c.z + e.z)).applyMatrix4(new THREE.Matrix4().makeScale(root.s[0], root.s[1], root.s[2]));
      }
    }
    // DunGen's automatic bounds: every renderer and non-trigger collider in the prefab (the mod's vent ducts rely on this;
    // their packed placement bounds are zero-sized, which let them run straight through other rooms)
    if (!b) {
      const auto = new THREE.Box3();
      const tmp = new THREE.Box3();
      for (const n of man.nodes) {
        if (n.active === false) continue;
        let q = n, dead = false; while (q && q.parent) { q = byId.get(q.parent); if (q && q.active === false) { dead = true; break; } }
        if (dead) continue;
        const m = worldOf(n);
        for (const c of n.comps) {
          if ((c.t === 'MR' || c.t === 'SMR') && n.mesh) {
            const geoms = await this.lib.mesh(n.mesh).catch(() => []);
            for (const g of geoms) { if (!g.boundingBox) g.computeBoundingBox(); if (g.boundingBox.isEmpty()) continue; tmp.copy(g.boundingBox).applyMatrix4(m); auto.union(tmp); }
          } else if (c.t === 'Box' && !c.trigger && c.enabled !== false) {
            tmp.set(new THREE.Vector3(c.c[0] - c.s[0] / 2, c.c[1] - c.s[1] / 2, c.c[2] - c.s[2] / 2), new THREE.Vector3(c.c[0] + c.s[0] / 2, c.c[1] + c.s[1] / 2, c.c[2] + c.s[2] / 2)).applyMatrix4(m); auto.union(tmp);
          }
        }
      }
      if (!auto.isEmpty()) b = auto;
    }
    if (!b) b = new THREE.Box3(new THREE.Vector3(-5, -1, -5), new THREE.Vector3(5, 5, 5));
    const def = { file, man, byId, root, tile, doorways, bounds: b, allowRotation: tile ? tile.AllowRotation !== false : true, repeat: tile ? tile.RepeatMode : 0, worldOf };
    this.tileDefs.set(file, def);
    return def;
  }

  // ------------------------------------------------------------ generation
  async generate(seed) {
    this.clear();
    this.seed = seed;
    for (let attempt = 0; attempt < 12; attempt++) {
      const rnd = mulberry32(seed + attempt * 7919);
      this.rnd = rnd;
      const ok = await this._generateOnce(rnd);
      if (ok) break;
      this.placed = [];
      console.warn('dungeon: retrying generation', attempt);
    }
    await this._finalize();
    console.log('dungeon: placed', this.placed.length, 'tiles, doors', this.doors.length, 'scrap spawns', this.scrapSpawns.length, 'vents', this.vents.length, 'fire exits', this.fireExits.length);
  }

  pickWeighted(entries, rnd, key, depth) {
    let total = 0; const ws = entries.map(e => { const w = Math.max(0, (e[key] ?? 1) * evalCurve(e.depthCurve, depth)); total += w; return w; });
    if (total <= 0) return entries[Math.floor(rnd() * entries.length)];
    let r = rnd() * total;
    for (let i = 0; i < entries.length; i++) { r -= ws[i]; if (r <= 0) return entries[i]; }
    return entries[entries.length - 1];
  }

  /** the interiors this moon can roll (the game's SelectableLevel.dungeonFlowTypes weights) */
  flowsFor(catalog = this.catalog) {
    const flows = catalog.flows ? Object.values(catalog.flows) : [Object.assign({ name: 'Level1Flow', rarity: 300 }, catalog.flow)];
    return flows.filter(f => f && f.nodes && f.nodes.length);
  }
  pickFlow(rnd) {
    const flows = this.flowsFor();
    const want = this.forceFlow || (this.game.world.activeMoon && this.game.world.activeMoon.forceFlow);   // debug override, else the moon's fixed interior
    if (want) { const f = flows.find(x => x.name === want); if (f) return f; }
    const total = flows.reduce((a, f) => a + (f.rarity || 0), 0);
    if (total <= 0) return flows[0];
    let r = rnd() * total;
    for (const f of flows) { r -= (f.rarity || 0); if (r <= 0) return f; }
    return flows[flows.length - 1];
  }
  get interiorName() { return this.flow && this.flow.name === 'Level3Flow' ? 'mineshaft' : 'facility'; }

  archetypeAt(f) {
    const lines = this.flow.lines;
    for (const l of lines) if (f >= l.pos - 1e-6 && f <= l.pos + l.len + 1e-6) return l.archetypes[0];
    return lines[lines.length - 1].archetypes[0];
  }

  async _generateOnce(rnd) {
    const flow = this.flow = this.pickFlow(rnd);
    // the game scales the flow's lengths by the moon's factory size multiplier (Titan 2.2); mod interiors clamp it
    const moon = this.game.world.activeMoon; let sizeMul = (moon && moon.sizeMul) || (this.catalog.level && this.catalog.level.factorySizeMultiplier) || 1;
    if (this.catalog.modInterior && this.catalog.modInterior.includes(flow.name) && this.catalog.extended) { const ex = this.catalog.extended; sizeMul = Math.min(ex.dungeonSizeMax || sizeMul, Math.max(ex.dungeonSizeMin || 1, sizeMul)); }
    this.sizeMul = sizeMul;
    const L = Math.round((flow.Length.Min + Math.floor(rnd() * (flow.Length.Max - flow.Length.Min + 1))) * sizeMul);
    // start tile
    const startSet = this.catalog.tileSets[flow.nodes[0].tileSets[0]];
    const startDef = await this.tileDef(startSet[0].prefab);
    const start = this._place(startDef, new THREE.Matrix4(), null, null, 0, true);
    this.placed.push(start);
    let prev = start;
    for (let i = 1; i < L; i++) {
      const f = i / (L - 1);
      let entries;
      if (i === L - 1) entries = this.catalog.tileSets[flow.nodes[1].tileSets[0]];
      else { const arch = this.archetypeAt(f); entries = [].concat(...arch.tileSets.map(n => this.catalog.tileSets[n])); }
      const next = await this._attach(prev, entries, rnd, 'main', f, i);
      if (!next) {
        // backtrack once
        if (this.placed.length > 2) { const bad = this.placed.pop(); this._unplace(bad); prev = this.placed[this.placed.length - 1]; i -= 2; if (i < 0) return false; continue; }
        return false;
      }
      this.placed.push(next); prev = next;
    }
    // branches
    const mainTiles = this.placed.slice();
    const want = Math.round((flow.BranchCount.Min + Math.floor(rnd() * (flow.BranchCount.Max - flow.BranchCount.Min + 1))) * (this.sizeMul || 1));
    let made = 0, tries = 0;
    while (made < want && tries < want * 6) {
      tries++;
      const from = mainTiles[1 + Math.floor(rnd() * (mainTiles.length - 1))];
      const arch = this.archetypeAt(from.depthF);
      const blen = 1 + Math.floor(rnd() * 3);
      let cur = from; let grown = 0;
      for (let j = 0; j < blen; j++) {
        const last = j === blen - 1;
        let entries;
        if (j === 0 && arch.branchStart.length && rnd() < 0.5) entries = [].concat(...arch.branchStart.map(n => this.catalog.tileSets[n]));
        else if (last && arch.branchCap.length) entries = [].concat(...arch.branchCap.map(n => this.catalog.tileSets[n]));
        else entries = [].concat(...arch.tileSets.map(n => this.catalog.tileSets[n]));
        const t = await this._attach(cur, entries, rnd, 'branch', from.depthF, from.index, j / Math.max(1, blen - 1));
        if (!t) break;
        this.placed.push(t); cur = t; grown++;
      }
      if (grown) made++;
    }
    return this.placed.length >= L;
  }

  _place(def, matrix, viaDoorway, parentTile, index, isMain) {
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    matrix.decompose(pos, q, s);
    const bounds = def.bounds.clone().applyMatrix4(matrix);
    const doorways = def.doorways.map(d => ({ def: d, pos: d.pos.clone().applyMatrix4(matrix), fwd: d.fwd.clone().applyQuaternion(q).normalize(), up: d.up.clone().applyQuaternion(q).normalize(), q: q.clone().multiply(d.q), used: false, connected: null, socket: d.socket }));
    this._serial = (this._serial || 0) + 1;
    return { def, matrix, pos, q, bounds, doorways, parent: parentTile, index, serial: this._serial, isMain, depthF: 0, obj: null, viaDoorway };
  }

  _unplace(t) { if (t.viaDoorway) { t.viaDoorway.used = false; t.viaDoorway.connected = null; } }

  async _attach(prev, entries, rnd, kind, depthF, index, branchF = 0) {
    const open = prev.doorways.filter(d => !d.used);
    if (!open.length) return null;
    // drop tiles the repeat rules forbid before weighting, otherwise a heavy one-off tile (a start room at weight 500) eats every attempt
    const pool = [];
    for (const e of entries) {
      const def = await this.tileDef(e.prefab); if (!def) continue;
      if (def.repeat === 2 && this.placed.some(p => p.def === def)) continue;   // DunGen Disallow: once per dungeon
      if (def.repeat === 1 && prev.def === def) continue;                      // DisallowImmediate
      pool.push(e);
    }
    if (!pool.length) return null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const e = this.pickWeighted(pool, rnd, kind === 'main' ? 'main' : 'branch', kind === 'main' ? depthF : branchF);
      const def = await this.tileDef(e.prefab);
      if (!def) continue;
      const shuffled = open.slice().sort(() => rnd() - 0.5);
      for (const pd of shuffled) {
        const cands = def.doorways.filter(d => d.socket === pd.socket);
        if (!cands.length) continue;
        const cd = cands[Math.floor(rnd() * cands.length)];
        // DunGen PositionBySocket: turn the tile so its doorway frame faces the open doorway, forward against forward
        // and up matched, i.e. Rotation = LookRotation(-other.Forward, other.Up) * inverse(my.LocalRotation)
        let q;
        if (def.allowRotation) {
          const zA = pd.fwd.clone().negate().normalize(), xA = new THREE.Vector3().crossVectors(pd.up, zA).normalize(), yA = new THREE.Vector3().crossVectors(zA, xA).normalize();
          const look = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA));
          q = look.multiply(cd.q.clone().invert());
        } else {
          if (cd.fwd.dot(pd.fwd) > -0.9998) continue;   // no rotation allowed: the doorway must already face the right way
          q = new THREE.Quaternion();
        }
        const rotatedDoor = cd.pos.clone().applyQuaternion(q);
        const pos = pd.pos.clone().sub(rotatedDoor);
        const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
        const t = this._place(def, m, pd, prev, index, kind === 'main');
        t.depthF = depthF;
        if (this._overlaps(t)) continue;
        pd.used = true; pd.connected = t;
        const cdw = t.doorways.find(d => d.def === cd); cdw.used = true; cdw.connected = prev;
        t.viaDoorway = pd; t.entryDoorway = cdw;
        return t;
      }
    }
    return null;
  }

  _overlaps(t) {
    const b = t.bounds.clone(); b.min.addScalar(0.3); b.max.addScalar(-0.3);
    for (const p of this.placed) { if (p.bounds.intersectsBox(b)) return true; }
    return false;
  }

  // ------------------------------------------------------------ build meshes
  async _finalize() {
    const lib = this.lib;
    const collision = [];
    const propGroups = new Map();
    this._propGroups = propGroups;
    this._pendingSynced = [];
    this.doors = []; this.scrapSpawns = []; this.hazardSpawns = []; this.vents = []; this.lights = []; this.interactables = []; this.fireExits = [];
    for (const t of this.placed) {
      const inst = await lib.instantiate(t.def.man, { lights: true, filter: n => true });
      const rootObj = inst.root.children[0];
      // reset prefab root transform, apply placement
      rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); rootObj.scale.set(t.def.root.s[0], t.def.root.s[1], t.def.root.s[2]);   // as DunGen: root pos/rot zeroed, scale kept
      inst.root.matrix.copy(t.matrix); inst.root.matrix.decompose(inst.root.position, inst.root.quaternion, inst.root.scale);
      this.root.add(inst.root);
      inst.root.updateMatrixWorld(true);
      t.obj = inst.root; t.inst = inst;
      this._collectHazards(inst);
      // doorway scene objects
      for (const d of t.doorways) {
        const on = d.used ? d.def.connScene : d.def.blockScene, off = d.used ? d.def.blockScene : d.def.connScene;
        for (const id of on) { const o = inst.objs.get(id); if (o) o.visible = true; }
        for (const id of off) { const o = inst.objs.get(id); if (o) o.visible = false; }
      }
      // props: local prop sets + global props
      const propNodes = new Set();
      // an object under a switched-off doorway blocker is not a candidate for anything (mod interiors keep fire exits inside blockers)
      const liveObj = id => { const o = inst.objs.get(id); if (!o) return null; let q = o.parent; while (q && q !== inst.root) { if (q.visible === false) return null; q = q.parent; } return o; };
      for (const n of t.def.man.nodes) for (const c of n.comps) {
        if (c.t !== 'MB' || !c.d) continue;
        if (c.cls === 'LocalPropSet') {
          const ws = (c.d.Props && c.d.Props.Weights) || [];
          const ids = ws.map(w => w.Value && w.Value.$).filter(Boolean);
          ids.forEach(id => propNodes.add(id));
          const min = c.d.PropCount ? c.d.PropCount.Min : 1, max = c.d.PropCount ? c.d.PropCount.Max : 1;
          const count = min + Math.floor(this.rnd() * (max - min + 1));
          const pool = ws.slice();
          for (let i = 0; i < count && pool.length; i++) {
            const pick = this.pickWeighted(pool.map(w => ({ w, main: w.MainPathWeight, branch: w.BranchPathWeight })), this.rnd, t.isMain ? 'main' : 'branch', t.depthF);
            pool.splice(pool.indexOf(pick.w), 1);
            const o = inst.objs.get(pick.w.Value && pick.w.Value.$); if (o) o.userData.propOn = true;
          }
        } else if (c.cls === 'GlobalProp') {
          propNodes.add(n.id);
          if (!liveObj(n.id)) continue;
          const g = c.d.PropGroupID;
          if (!propGroups.has(g)) propGroups.set(g, []);
          propGroups.get(g).push({ inst, id: n.id, main: c.d.MainPathWeight, branch: c.d.BranchPathWeight, isMain: t.isMain, depthF: t.depthF });
        } else if (c.cls === 'RandomScrapSpawn') {
          const o = liveObj(n.id); if (o) this.scrapSpawns.push({ pos: o.getWorldPosition(new THREE.Vector3()), range: c.d.itemSpawnRange || 1, tile: t });
        } else if (c.cls === 'RandomMapObject') {
          const o = inst.objs.get(n.id); if (o) this.hazardSpawns.push({ pos: o.getWorldPosition(new THREE.Vector3()), range: c.d.spawnRange || 3, prefabs: (c.d.spawnablePrefabs || []).map(p => p && p.$).filter(Boolean), tile: t });
        } else if (c.cls === 'SpawnSyncedObject') {
          const o = inst.objs.get(n.id); const pf = c.d.spawnPrefab && c.d.spawnPrefab.$;
          if (o && pf) t.synced = (t.synced || []).concat([{ obj: o, prefab: pf, name: c.d.spawnPrefab.n }]);
        }
      }
      for (const id of propNodes) { const o = inst.objs.get(id); if (o && !o.userData.propOn) o.visible = false; }
      // skinned renderers (the Slaughterhouse's hanging carcasses): real skinned meshes under the dungeon root, bones carry the tile transform
      await buildSkinned(lib, inst, this.root);
    }
    // doors + blockers at doorways (their global props / synced spawns are collected, not spawned yet)
    for (const t of this.placed) {
      for (const d of t.doorways) {
        if (d.used) {
          // one side spawns the door: the side with higher priority, or the tile placed first
          const other = d.connected; const od = other.doorways.find(x => x.connected === t);
          const mine = d.def.priority > (od ? od.def.priority : -1) || (d.def.priority === (od ? od.def.priority : -1) && t.serial < other.serial && d.def.connectors.length);
          // demo: the terminal-controlled blast doors (BigDoorSpawn) are left out, hallway connections stay open
          const pick = (dd) => { const ids = dd.def.connectors, ws = dd.def.connectorWeights; const keep = ids.map((id, i) => [id, ws[i]]).filter(([id]) => !this._isBigDoor(id)); return keep.length ? this._pickPart(keep.map(x => x[1]), keep.map(x => x[0])) : null; };
          if (mine && d.def.connectors.length) { const id = pick(d); if (id) await this._spawnDoorPart(d, id, t, true); }
          else if (mine && !d.def.connectors.length && od && od.def.connectors.length) { const id = pick(od); if (id) await this._spawnDoorPart(od, id, other, true); }
        } else if (d.def.blockers.length) {
          await this._spawnDoorPart(d, this._pickPart(d.def.blockerWeights, d.def.blockers), t, false);
        }
      }
      for (const s of (t.synced || [])) this._pendingSynced.push([s, t]);
    }
    // global props by group budget: tiles AND door parts together (this is what limits fire exits to one)
    for (const [g, list] of propGroups) {
      const range = (this.flow.GlobalProps || []).find(x => x.ID === g);
      const min = range ? range.Count.Min : 0, max = range ? range.Count.Max : 2;
      let count = Math.min(list.length, min + Math.floor(this.rnd() * (max - min + 1)));
      const pool = list.slice();
      while (count-- > 0 && pool.length) {
        const pick = this.pickWeighted(pool, this.rnd, 'main', 0.5);
        pool.splice(pool.indexOf(pick), 1);
        const o = pick.inst.objs.get(pick.id); if (o) o.visible = true;
      }
    }
    // synced objects (vents, valves, breaker box, entrance teleports) - only under active objects
    for (const [s, t] of this._pendingSynced) {
      let p = s.obj, on = true; while (p && p !== this.root) { if (p.visible === false) { on = false; break; } p = p.parent; }
      if (on) await this._spawnSynced(s, t);
    }
    // collision
    const entries = [];
    // a door leaf's own colliders swing with it: keep them out of the static collider (the door's DoorLock box follows the leaf instead).
    // The Slaughterhouse pig-pen gates carry a box on the gate mesh itself, which kept the pens sealed after the gate opened.
    const doorRoots = new Set(this.doors.map(d => d.root));
    const underAnimator = (inst, n) => { const byId = inst.manifest && inst.manifest.nodes ? (inst._byId || (inst._byId = new Map(inst.manifest.nodes.map(x => [x.id, x])))) : null; if (!byId) return false; let q = byId.get(n.parent); while (q) { if (q.comps.some(c => c.t === 'Animator' && c.controller)) return true; q = byId.get(q.parent); } return false; };
    for (const t of this.placed) {
      const e = await collisionEntries(lib, t.inst, { exclude: n => [9, 13, 14, 15, 22, 26, 29].includes(n.layer) });
      for (const x of e) entries.push(x);
      for (const ex of (t.extraInst || [])) { const dyn = ex.root.userData.dynamicIds; const isDoor = doorRoots.has(ex.root); const e2 = await collisionEntries(lib, ex, { exclude: n => [9, 13, 14, 15, 22, 26, 29].includes(n.layer) || (dyn && dyn.has(n.id)) || n.comps.some(c => c.t === 'MB' && c.cls === 'DoorLock') || (isDoor && underAnimator(ex, n)) }); for (const x of e2) entries.push(x); }
    }
    this.collider = new Collider('dungeon').build(entries, null);
    // drop vents that float in the room (no wall within 1.2 m behind or in front of them)
    this.vents = this.vents.filter(v => {
      const c = v.inst.root.userData.ventCheck; if (!c) return true;
      if (this.interiorName === 'mineshaft') return true;   // cave vents sit in rough rock; the wall test is for the facility's flat walls
      const o = c.pos.clone(); o.y += 0.6;
      const hitB = this.collider.raycast(o, c.back, 1.4), hitF = this.collider.raycast(o, c.fwd, 1.4);
      if (hitB || hitF) return true;
      v.inst.root.visible = false; return false;
    });
    for (const t of this.placed) this._mergeStatic(t);
    console.log('dungeon collider tris', this.collider.triCount);
    this._buildGraph();
    this._collectLights();
    this.root.updateMatrixWorld(true);
  }

  /** Merge a tile's static meshes per material to cut draw calls (props / animated bits stay separate). */
  _mergeStatic(t) {
    const inst = t.inst; if (!inst) return;
    const groups = new Map();
    const rootInv = new THREE.Matrix4().copy(inst.root.matrixWorld).invert();
    inst.root.updateMatrixWorld(true);
    const list = [];
    inst.root.traverse(o => {
      if (!o.isMesh || o.isSkinnedMesh) return;
      let p = o, ok = true;
      while (p && p !== inst.root) { if (p.visible === false || p.userData.propOn !== undefined) { ok = false; break; } p = p.parent; }
      if (!ok) return;
      const m = o.material; if (!m || m.transparent || m.visible === false) return;
      const g = o.geometry; if (!g.attributes.position || !g.attributes.normal) return;
      list.push(o);
    });
    for (const o of list) {
      const key = o.material.uuid;
      if (!groups.has(key)) groups.set(key, { mat: o.material, geoms: [] });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', o.geometry.attributes.position);
      g.setAttribute('normal', o.geometry.attributes.normal);
      g.setAttribute('uv', o.geometry.attributes.uv || new THREE.BufferAttribute(new Float32Array(o.geometry.attributes.position.count * 2), 2));
      if (o.geometry.index) g.setIndex(o.geometry.index);
      const gg = g.toNonIndexed();
      const mm = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
      gg.applyMatrix4(mm);
      if (mm.determinant() < 0) flipWinding(gg);   // mirrored objects: keep the faces pointing outward once baked
      groups.get(key).geoms.push(gg);
      o.parent.remove(o);
    }
    let count = 0;
    for (const { mat, geoms } of groups.values()) {
      if (!geoms.length) continue;
      const merged = mergeGeometries(geoms, false);
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mat); m.castShadow = true; m.receiveShadow = true; m.userData.merged = true;
      inst.root.add(m); count++;
    }
    t.mergedCount = count;
  }

  _isBigDoor(aid) { const f = this.catalog.doorParts.find(f => f.endsWith('__' + aid + '.json')); return !!f && /BigDoor/.test(f); }

  _pickPart(weights, ids) {
    let total = 0; for (const w of weights) total += Math.max(0, w);
    let r = this.rnd() * (total || ids.length);
    for (let i = 0; i < ids.length; i++) { r -= total ? Math.max(0, weights[i]) : 1; if (r <= 0) return ids[i]; }
    return ids[ids.length - 1];
  }

  async _spawnDoorPart(d, prefabAid, tile, isConnector) {
    const file = this.catalog.doorParts.find(f => f.endsWith('__' + prefabAid + '.json'));
    if (!file) return;
    const man = await this.prefab(file); if (!man) return;
    const inst = await this.lib.instantiate(man, { lights: true });
    const rootObj = inst.root.children[0];
    if (rootObj) { rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); }
    inst.root.position.copy(d.pos); inst.root.quaternion.copy(d.q);
    this.root.add(inst.root); inst.root.updateMatrixWorld(true);
    await buildSkinned(this.lib, inst, this.root);   // e.g. the grinder's pig
    tile.extraInst = (tile.extraInst || []).concat([inst]);
    // nested synced spawns (e.g. BigDoorSpawn -> BigDoor, blockers -> EntranceTeleportB) and global props (fire exit containers)
    for (const n of man.nodes) for (const c of n.comps) {
      if (c.t !== 'MB' || !c.d) continue;
      if (c.cls === 'SpawnSyncedObject' && c.d.spawnPrefab) {
        const o = inst.objs.get(n.id); if (o) this._pendingSynced.push([{ obj: o, prefab: c.d.spawnPrefab.$, name: c.d.spawnPrefab.n }, tile]);
      } else if (c.cls === 'GlobalProp') {
        const o = inst.objs.get(n.id); if (o) o.visible = false;
        const g = c.d.PropGroupID;
        if (!this._propGroups.has(g)) this._propGroups.set(g, []);
        this._propGroups.get(g).push({ inst, id: n.id, main: c.d.MainPathWeight, branch: c.d.BranchPathWeight, isMain: tile.isMain, depthF: tile.depthF });
      }
    }
  }

  async _spawnSynced(s, tile) {
    const sname = s.name || '';
    // one main entrance, and no more fire exits than the flow's budget allows (some mod tiles carry spare spawners)
    if (/^EntranceTeleportA/.test(sname) && this.entranceInside) return;
    if (/^EntranceTeleportB/.test(sname)) { const g = (this.flow.GlobalProps || []).find(x => x.ID === 1231); const cap = g ? g.Count.Max : 99; if (this.fireExits.length >= cap) return; }
    const file = this.catalog.doorParts.find(f => f.endsWith('__' + s.prefab + '.json'));
    if (!file) return;
    const man = await this.prefab(file); if (!man) return;
    const inst = await this.lib.instantiate(man, { lights: true });
    const rootObj = inst.root.children[0];
    if (rootObj) { rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); }
    s.obj.getWorldPosition(inst.root.position); s.obj.getWorldQuaternion(inst.root.quaternion);
    this.root.add(inst.root); inst.root.updateMatrixWorld(true);
    tile.extraInst = (tile.extraInst || []).concat([inst]);
    const name = s.name || '';
    if (/BigDoor|SteelDoor|FancyDoor|DoorMapModel|DoorContainer/.test(name)) this._setupDoor(inst, name);
    if (/^VentEntrance/.test(name)) {
      // vents must sit against a wall: check for geometry just behind the vent, otherwise drop it
      const vp = inst.root.getWorldPosition(new THREE.Vector3()); const vq = inst.root.getWorldQuaternion(new THREE.Quaternion());
      inst.userData = inst.userData || {}; inst.root.userData.ventCheck = { pos: vp, back: new THREE.Vector3(0, 0, -1).applyQuaternion(vq), fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(vq) };
      this.vents.push({ pos: vp, inst, tile });
    }
    if (/^LungApparatus/.test(name)) this.game.items.registerApparatus(inst);
    if (/^MineshaftElevator/.test(name)) await this._setupElevator(inst);
    this._collectHazards(inst);
    if (/^EntranceTeleportA/.test(name)) this._setupEntrance(inst, false);
    if (/^EntranceTeleportB/.test(name)) this._setupEntrance(inst, true);
  }

  _setupEntrance(inst, isFire) {
    const root = inst.root;
    const tele = root.getObjectByName('telePoint') || root;
    const p = tele.getWorldPosition(new THREE.Vector3()); const q = tele.getWorldQuaternion(new THREE.Quaternion());
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const spot = { pos: p.clone().add(new THREE.Vector3(0, 0.1, 0)), yaw: Math.atan2(-f.x, -f.z) };
    if (isFire) { this.fireExitInside = spot; this.fireExits.push(spot); } else this.entranceInside = spot;
    const doorPos = root.getWorldPosition(new THREE.Vector3());
    this.interactables.push({ pos: doorPos.clone().add(new THREE.Vector3(0, 1.2, 0)), radius: 1.6, reach: 3.0, label: () => isFire ? '[E] Exit (fire exit)' : '[E] Exit facility', action: () => this.game.exitFacility(isFire) });
  }

  _setupDoor(inst, name) {
    // SteelDoorMapModel: DoorMesh has an Animator (Door1Open / Door1Close) and a DoorSound audio source; the trigger box sits on DoorMesh/Cube
    const root = inst.root;
    let mesh = root.getObjectByName('DoorMesh');
    if (!mesh) { root.traverse(o => { if (!mesh && o !== root && o.userData.node && o.userData.node.comps.some(c => c.t === 'Animator' && c.controller)) mesh = o; }); }   // mod doors: the animated leaf is not always called DoorMesh
    if (!mesh) return;
    const ac = mesh.userData.node.comps.find(c => c.t === 'Animator');
    const anim = ac && ac.controller ? new Animator(mesh, ac.controller) : null;
    if (anim) anim.load();
    let clipOpen = null, clipClose = null;
    const snd = root.getObjectByName('DoorSound');
    if (snd) { const a = snd.userData.node.comps.find(c => c.t === 'Audio'); if (a) clipOpen = clipClose = a.clip; }
    inst.manifest.nodes.forEach(n => n.comps.forEach(c => { if (c.t === 'MB' && c.d && c.cls === 'AnimatedObjectTrigger') { const o = (c.d.boolTrueAudios || []).map(x => x && x.$).filter(Boolean), cl = (c.d.boolFalseAudios || []).map(x => x && x.$).filter(Boolean); if (o[0]) clipOpen = o[0]; if (cl[0]) clipClose = cl[0]; } }));
    const door = { inst, root, mesh, anim, open: false, clipOpen, clipClose, pos: mesh.getWorldPosition(new THREE.Vector3()), collider: null };
    // the door leaf gets its own collider that follows the swing (the merged dungeon collider skips DoorLock boxes)
    let trig = mesh.children.find(c => c.userData.node && c.userData.node.comps.some(x => x.t === 'MB' && x.cls === 'DoorLock'));
    if (!trig) root.traverse(o => { if (!trig && o.userData.node && o.userData.node.comps.some(x => x.t === 'MB' && x.cls === 'DoorLock' && o.userData.node.comps.some(b => b.t === 'Box' && !b.trigger))) trig = o; });
    if (trig) {
      const n = trig.userData.node; const box = n.comps.find(c => c.t === 'Box' && !c.trigger);
      if (box) {
        const g = new THREE.BoxGeometry(1, 1, 1);
        const local = new THREE.Matrix4().compose(new THREE.Vector3(box.c[0], box.c[1], box.c[2]), new THREE.Quaternion(), new THREE.Vector3(box.s[0] * 1.2, box.s[1], box.s[2]));
        const m = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(mesh.matrixWorld).invert(), trig.matrixWorld).multiply(local);
        door.collider = new Collider('steeldoor').build([{ geometry: g, matrix: m }], mesh);
      }
    }
    this.doors.push(door);
    // interaction point = the door leaf's trigger box (the DoorMesh pivot sits on the hinge)
    const ipos = trig ? trig.getWorldPosition(new THREE.Vector3()) : door.pos.clone().add(new THREE.Vector3(0, 1.3, 0));
    door.ipos = ipos;
    this.interactables.push({ pos: ipos, radius: 1.3, reach: 2.6, label: () => door.open ? '[E] Close door' : '[E] Use door', action: () => this.toggleDoor(door) });
  }

  toggleDoor(door) {
    door.open = !door.open;
    if (door.anim && door.anim.ready) { const n = door.anim.find(door.open ? [/Open/] : [/Close/]); if (n) door.anim.play(n, { once: true, loop: false, fade: 0.05 }); }
    const clip = door.open ? door.clipOpen : door.clipClose;
    if (clip) this.game.sound.play(clip, { pos: door.pos, vol: 0.8, min: 2, max: 30 });
    this.game.enemies.onNoise(door.pos, 0.6);
  }

  _buildGraph() {
    // waypoint graph for enemy navigation: doorway points + tile centres
    const nodes = [], edges = [];
    const add = (p, tile) => { nodes.push({ p, tile, n: [] }); return nodes.length - 1; };
    for (const t of this.placed) { t.center = t.bounds.getCenter(new THREE.Vector3()); t.center.y = t.bounds.min.y + 0.5; t.nodeId = add(t.center, t); }
    for (const t of this.placed) {
      for (const d of t.doorways) {
        if (!d.used || d.nodeId != null) continue;
        const other = d.connected; if (!other || other.nodeId == null) continue;   // a connection to a tile that is no longer placed
        const od = other.doorways.find(x => x.connected === t);
        const id = add(d.pos.clone().add(new THREE.Vector3(0, 0.3, 0)), t);
        d.nodeId = id; if (od) od.nodeId = id;
        edges.push([t.nodeId, id]); edges.push([other.nodeId, id]);
      }
    }
    for (const [a, b] of edges) { nodes[a].n.push(b); nodes[b].n.push(a); }
    this.graph = { nodes };
  }

  _collectLights() {
    this.lights = [];
    this.root.traverse(o => {
      if (o.isPointLight || o.isSpotLight) {
        let p = o, vis = true; while (p && p !== this.root) { if (p.visible === false) { vis = false; break; } p = p.parent; }
        if (!vis) return;
        // the pool only has omni lights: a spot (the mineshaft entrance's two big ones aim down the shaft) becomes a much
        // dimmer, shorter point light instead of flooding the whole area
        // only in the mineshaft (its entrance pair is 436 and aims down the shaft); the facility's own 512 spots light its
        // big rooms and stay exactly as they were
        const spot = o.isSpotLight && /Level3/.test(String((this.flow && (this.flow.name || this.flow.key)) || this.flow || ''));
        const inten = Math.min(o.userData.unity?.intensity || 20, 120) * 0.05 * (spot ? 0.3 : 1);
        const dist = spot ? Math.max(Math.min(o.distance || 8, 14), 8) : Math.max((o.distance || 8) * 1.6, 13);
        this.lights.push({ pos: o.getWorldPosition(new THREE.Vector3()), color: o.color.clone(), intensity: inten, distance: dist, obj: o });
        o.visible = false;
      }
    });
  }

  tileAt(p) { for (const t of this.placed) if (t.bounds.containsPoint(p)) return t; let best = null, bd = 1e9; for (const t of this.placed) { const d = t.bounds.distanceToPoint(p); if (d < bd) { bd = d; best = t; } } return best; }

  nearestNode(p) { let b = -1, bd = 1e9; this.graph.nodes.forEach((n, i) => { const d = n.p.distanceToSquared(p); if (d < bd) { bd = d; b = i; } }); return b; }

  path(from, to) {
    const N = this.graph.nodes; const a = this.nearestNode(from), b = this.nearestNode(to);
    if (a < 0 || b < 0) return [];
    const prev = new Map([[a, -1]]); const q = [a];
    while (q.length) { const c = q.shift(); if (c === b) break; for (const n of N[c].n) if (!prev.has(n)) { prev.set(n, c); q.push(n); } }
    if (!prev.has(b)) return [];
    const out = []; let c = b; while (c !== -1) { out.push(N[c].p); c = prev.get(c); }
    return out.reverse();
  }

  scannables(from, range) { return []; }

  update(dt) {
    for (const d of this.doors) if (d.anim && d.anim.ready) d.anim.update(dt);
    this._updateElevator(dt);
    // kill volumes: shaft pits, grinders, crushing doors
    const p = this.game.player;
    if (this.game.inside && !p.dead) {
      for (const z of (this.killZones || [])) if (z.containsPoint(p.pos)) { p.damage(1000, 'fall'); break; }
      if (!p.dead) for (const h of (this.hazardZones || [])) { let q = h.obj, on = true; while (q && q !== this.root) { if (q.visible === false) { on = false; break; } q = q.parent; } if (on && (h.box.containsPoint(p.pos) || h.box.containsPoint(p.eye))) { p.damage(1000, h.cause); break; } }
    }
  }

  /** trigger boxes that hurt: the mod's DamageTrigger components and anything named KillTrigger */
  _collectHazards(inst) {
    this.hazardZones = this.hazardZones || [];
    for (const [id, o] of inst.objs) {
      const n = o.userData.node; if (!n) continue;
      const dmg = n.comps.find(c => c.t === 'MB' && /(^|\.)DamageTrigger$/.test(c.cls || ''));
      const isKill = /KillTrigger/.test(n.name);
      if (!dmg && !isKill) continue;
      // the mod arms door-crush triggers only while a door moves; without its scripts only the always-on ones (grinders, pits) count
      if (dmg && !isKill && !(dmg.d && (dmg.d.continuousDamage || dmg.d.continuousRaycastDamage))) continue;
      const box = n.comps.find(c => c.t === 'Box'); if (!box) continue;
      o.updateMatrixWorld(true);
      const pts = []; const c = box.c, s = box.s;
      for (let i = 0; i < 8; i++) pts.push(o.localToWorld(new THREE.Vector3(c[0] + (i & 1 ? 0.5 : -0.5) * s[0], c[1] + (i & 2 ? 0.5 : -0.5) * s[1], c[2] + (i & 4 ? 0.5 : -0.5) * s[2])));
      const cause = isKill ? 'fall' : (/grind/i.test(inst.root.name + ' ' + n.name) ? 'grinder' : 'crushed');
      this.hazardZones.push({ obj: o, box: new THREE.Box3().setFromPoints(pts), cause });
    }
  }

  // ---------- mineshaft elevator ----------
  async _setupElevator(inst) {
    const first = n => (inst.byName.get(n) || [])[0];
    const cage = first('AnimContainer'); if (!cage) return;
    const man = inst.manifest;
    // the animator lives on the prefab root
    let anim = null;
    for (const [id, o] of inst.objs) { const n = o.userData.node; const ac = n && n.comps.find(c => c.t === 'Animator' && c.controller); if (ac) { anim = new Animator(o, ac.controller); await anim.load().catch(() => null); break; } }
    // everything under the cage moves: give it its own collider that follows the cage, and keep it out of the static one
    const ids = new Set([cage.userData.node.id]);
    let grew = true; while (grew) { grew = false; for (const n of man.nodes) if (!ids.has(n.id) && ids.has(n.parent)) { ids.add(n.id); grew = true; } }
    inst.root.userData.dynamicIds = ids;
    cage.updateMatrixWorld(true);
    const entries = await collisionEntries(this.lib, inst, { relativeTo: cage, only: n => ids.has(n.id), exclude: n => [9, 13, 14, 15, 22, 26, 29].includes(n.layer) });
    const col = new Collider('elevator').build(entries, cage);
    this.dynamicColliders.push(col);
    // ride region: the cage's own bounds (cage-local), open upward so a standing player counts as inside
    const bounds = new THREE.Box3();
    for (const e of entries) { if (!e.geometry.boundingBox) e.geometry.computeBoundingBox(); bounds.union(e.geometry.boundingBox.clone().applyMatrix4(e.matrix)); }
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-2, -1, -2), new THREE.Vector3(2, 3, 2));
    const floorY = bounds.min.y;
    bounds.expandByScalar(-0.15); bounds.min.y = floorY - 0.9; bounds.max.y = floorY + 4.5;
    // buttons: one in the cage, one on each landing
    const cubes = inst.byName.get('Cube') || [];
    const under = (o, name) => { let q = o; while (q && q !== inst.root) { if (q.name === name) return true; q = q.parent; } return false; };
    const btnIn = cubes.find(o => under(o, 'AnimContainer')), btnTop = cubes.find(o => under(o, 'TopElevatorPanel')), btnBottom = cubes.find(o => under(o, 'BottomElevatorPanel'));
    const ctrl = man.nodes.flatMap(n => n.comps).find(c => c.t === 'MB' && c.cls === 'MineshaftElevatorController'); const d = (ctrl && ctrl.d) || {};
    const clip = k => d[k] && d[k].$ ? d[k].$ : null;
    const e = this.elevator = { inst, cage, anim, col, bounds, atBottom: false, moving: false, goDown: false, t: 0, len: 8, cooldown: 0, btnIn, btnTop, btnBottom, travel: null, speed: 0.28,
      sfx: { startUp: clip('elevatorStartUpSFX'), startDown: clip('elevatorStartDownSFX'), travel: clip('elevatorTravelSFX'), finishUp: clip('elevatorFinishUpSFX'), finishDown: clip('elevatorFinishDownSFX') } };
    if (anim && anim.ready && anim.has('MineshaftElevatorGoUp')) { anim.play('MineshaftElevatorGoUp', { once: true, loop: false, fade: 0 }); const c = anim.clips.get('MineshaftElevatorGoUp'); anim.update(((c && c.data && c.data.length) || 8) + 0.1); cage.updateMatrixWorld(true); }
    // the pit at the bottom of the shaft kills, like the game's kill trigger
    this.killZones = this.killZones || [];
    for (const t of this.placed) for (const o of (t.inst && t.inst.byName.get('KillTrigger')) || []) {
      const n = o.userData.node; const box = n && n.comps.find(c => c.t === 'Box');
      if (!box) continue;
      o.updateMatrixWorld(true);
      const centre = o.localToWorld(new THREE.Vector3(box.c[0], box.c[1], box.c[2])); const sc = o.getWorldScale(new THREE.Vector3());
      const half = new THREE.Vector3(box.s[0] * sc.x, box.s[1] * sc.y, box.s[2] * sc.z).multiplyScalar(0.5);
      this.killZones.push(new THREE.Box3(centre.clone().sub(half), centre.clone().add(half)));
    }
    const wp = o => { const v = new THREE.Vector3(); o.getWorldPosition(v); return v; };
    const moving = 'Elevator moving';
    if (btnIn) this.interactables.push({ pos: wp(btnIn), radius: 1.2, reach: 2.6, dynamicObj: btnIn, label: () => e.moving ? moving : (e.atBottom ? '[E] Go up' : '[E] Go down'), action: () => this.callElevator('toggle') });
    if (btnTop) this.interactables.push({ pos: wp(btnTop), radius: 1.2, reach: 2.6, label: () => e.moving ? moving : (e.atBottom ? '[E] Call elevator' : 'Elevator is here'), action: () => this.callElevator('up') });
    if (btnBottom) this.interactables.push({ pos: wp(btnBottom), radius: 1.2, reach: 2.6, label: () => e.moving ? moving : (e.atBottom ? 'Elevator is here' : '[E] Call elevator'), action: () => this.callElevator('down') });
  }
  callElevator(where) {
    const e = this.elevator; if (!e || e.moving || e.cooldown > 0) return;
    const goDown = where === 'toggle' ? !e.atBottom : where === 'down';
    if (goDown === e.atBottom) return;
    const clipName = goDown ? 'MineshaftElevatorGoDown' : 'MineshaftElevatorGoUp';
    if (e.anim && e.anim.ready && e.anim.has(clipName)) { e.anim.play(clipName, { once: true, loop: false, fade: 0, speed: e.speed }); const c = e.anim.clips.get(clipName); e.len = ((c && c.data && c.data.length) || 8) / e.speed; }
    else e.len = 8;
    e.moving = true; e.goDown = goDown; e.t = 0;
    const pos = e.cage.getWorldPosition(new THREE.Vector3());
    const s = e.sfx[goDown ? 'startDown' : 'startUp']; if (s) this.game.sound.play(s, { pos, vol: 0.9, min: 3, max: 40 });
    if (e.sfx.travel) { const r = this.game.sound.play(e.sfx.travel, { pos, vol: 0.6, min: 3, max: 40, loop: true }); if (r && r.then) r.then(h => { e.travel = h; }); }
    this.game.enemies.onNoise(pos, 0.8);
  }
  _updateElevator(dt) {
    const e = this.elevator; if (!e) return;
    if (e.anim && e.anim.ready) e.anim.update(dt);
    e.cooldown -= dt;
    if (e.moving) {
      e.t += dt;
      if (e.t >= e.len - 0.05) {
        e.moving = false; e.atBottom = e.goDown; e.cooldown = 1.0;
        if (e.travel && e.travel.stop) e.travel.stop(0.3); e.travel = null;
        const pos = e.cage.getWorldPosition(new THREE.Vector3());
        const s = e.sfx[e.goDown ? 'finishDown' : 'finishUp']; if (s) this.game.sound.play(s, { pos, vol: 0.9, min: 3, max: 40 });
      }
    }
    // the in-cage button moves with the cage
    for (const it of this.interactables) if (it.dynamicObj) it.dynamicObj.getWorldPosition(it.pos);
    // ride: stand in the cage and you move with it
    const p = this.game.player;
    if (this.game.inside && !p.dead && this.killZones) for (const z of this.killZones) if (z.containsPoint(p.pos)) { p.damage(1000, 'fall'); break; }
    if (this.game.inside && !p.dead) {
      e.cage.updateMatrixWorld(true);
      const local = e.cage.worldToLocal(p.pos.clone());
      const inCage = e.bounds.containsPoint(local);
      if (inCage) p.attachTo(e.cage); else if (p.attached === e.cage) p.attachTo(null);
    } else if (p.attached === e.cage) p.attachTo(null);
  }

  /** door panels as dynamic collision: treat closed doors as thin boxes */
  doorBlocks(p) { return null; }

  clear() {
    for (const t of this.placed) { if (t.obj) this.root.remove(t.obj); for (const ex of (t.extraInst || [])) this.root.remove(ex.root); }
    this.placed = []; this.doors = []; this.interactables = []; this.scrapSpawns = []; this.vents = []; this.lights = []; this.hazardSpawns = [];
    this.entranceInside = null; this.fireExitInside = null;
    if (this.collider) { this.collider.dispose(); this.collider = null; }
    for (const c of this.dynamicColliders) c.dispose(); this.dynamicColliders = []; this.elevator = null; this.killZones = [];
    while (this.root.children.length) this.root.remove(this.root.children[0]);
  }
}
