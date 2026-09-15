// The Wider Ship Mod (mborsh, Thunderstore) as a ship upgrade you buy at the terminal.  The mod's own hull, floor, catwalk,
// posters and inner-wall prefabs (packed from its 'newship' bundle by tools/pack_wider_ship.py) replace the vanilla
// hull, and every prop its plugin moves is moved the same way - the numbers below are its CreateBothSides(), with X
// mirrored like every other transform in this port.
import * as THREE from 'three';
import { Collider, collisionEntries } from './collision.js';

const SAVE_KEY = 'lethalweb.ship';
const NOCOLLIDE = new Set([9, 13, 14, 15, 22, 26, 29]);
const P = (x, y, z) => new THREE.Vector3(-x, y, z);                       // Unity local position -> three
const unityQuat = (x, y, z, w) => new THREE.Quaternion(x, -y, -z, w);      // Unity quaternion -> three (mirror X)
function unityEuler(x, y, z) {                                             // Unity Euler angles (degrees) -> three
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z), 'YXZ'));
  return unityQuat(q.x, q.y, q.z, q.w);
}

export class WiderShip {
  constructor(game) { this.game = game; this.owned = false; this.applied = false; this.parts = []; this.walls = []; this.price = 400; }

  load() { try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); this.owned = !!s.wider; } catch (e) { } }
  save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ wider: this.owned })); } catch (e) { } }

  /** bought at the terminal: installs immediately */
  async buy() { this.owned = true; this.save(); await this.apply(); }

  async apply() {
    if (this.applied || !this.owned) return;
    const g = this.game, w = g.world, lib = g.lib, ship = w.ship, shipObj = w.shipObj;
    const list = await fetch('assets/widership.json').then(r => r.ok ? r.json() : null).catch(() => null);
    if (!list) { console.warn('wider ship: assets missing - run tools/pack_wider_ship.py'); return; }
    this.applied = true;
    const byName = (name, parent) => (ship.byName.get(name) || []).find(o => !parent || (o.parent && o.parent.name === parent));
    const direct = name => shipObj.children.find(c => c.name === name) || byName(name);

    // 1. the vanilla hull, rails, catwalk and posters go (the plugin disables or destroys them)
    for (const n of ['ShipInside', 'ShipRails', 'ShipRailPosts', 'CatwalkShip', 'CatwalkRailLiningB', 'CatwalkRailLining', 'Railing', 'WallInsulator', 'WallInsulator2', 'Plane.001']) {
      const o = direct(n); if (o) o.visible = false;
    }

    // 2. the mod's prefabs under HangarShip
    const add = async (key, setup) => {
      const man = await lib.manifest('prefabs/' + list[key]).catch(() => null); if (!man) return null;
      const inst = await lib.instantiate(man, { lights: true });
      const root = inst.root.children[0];
      shipObj.add(inst.root);
      if (setup) setup(root, inst);
      inst.root.updateMatrixWorld(true);
      this.parts.push(inst); return inst;
    };
    await add('ShipBoth', (root, inst) => {
      root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1);
      for (const n of ['left_window', 'right_window', 'floor_window']) for (const o of inst.byName.get(n) || []) o.visible = false;   // window variants are for ShipWindows
    });
    await add('Plane.001Both', root => { root.position.copy(P(6.913, 2.157811, -9.453)); });
    for (const [key, z] of [['wall_left', -5.224], ['wall_right', -8.16]]) {
      const inst = await add(key, (root, inst) => { root.position.copy(P(-6, 0.952, z)); root.quaternion.copy(unityEuler(0, 180, 0)); for (const o of inst.byName.get('Wall') || []) o.visible = false; });   // beams only (the non-solid default)
      if (inst) this.walls.push(inst);
    }

    // 3. props the plugin moves out of the way (CreateBothSides)
    const shipQ = shipObj.getWorldQuaternion(new THREE.Quaternion());
    const rotUp = (o, deg) => {   // Unity RotateAround(position, Vector3.up, deg): a world-Y turn, mirrored
      const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-deg));
      const pq = o.parent.getWorldQuaternion(new THREE.Quaternion());
      const wq = pq.clone().multiply(o.quaternion);
      const nq = shipQ.clone().multiply(r).multiply(shipQ.clone().invert()).multiply(wq);
      o.quaternion.copy(pq.invert().multiply(nq));
    };
    const moveTo = (name, parent, x, y, z) => { const o = byName(name, parent); if (o) o.position.copy(P(x, y, z)); return o; };
    const attach = (child, parentName) => { const c = byName(child), p = byName(parentName); if (c && p) p.attach(c); };
    moveTo('LadderShort (1)', 'HangarShip', -6.93, -2.58, -16.156);
    const ladder = moveTo('LadderShort', 'HangarShip', 6.568, -2.58, 2); if (ladder) ladder.quaternion.copy(unityEuler(0, 120, 0));
    attach('Pipework2.002', 'SideMachineryLeft');
    const sml = moveTo('SideMachineryLeft', 'HangarShip', 8.304, 1.6, -2.597); if (sml) { sml.quaternion.copy(unityEuler(180, 90, -90)); sml.scale.set(0.5793436, 0.4392224, 0.1953938); }
    moveTo('GiantCylinderMagnet', 'HangarShip', -0.08, 2.46, -14.72);
    attach('MeterBoxDevice.001', 'SideMachineryRight');
    moveTo('SideMachineryRight', 'HangarShip', -4, 1.947363, 1.08);
    moveTo('VentEntrance', 'HangarShip', -1.37, 0.567, 0.721);
    const charger = byName('ChargeStation', 'ShipModels2b'); if (charger) { rotUp(charger, -60); charger.position.copy(P(4.201, 1.25, -3.774)); }
    const l3 = moveTo('Light (3)', 'ShipModels2b', 3, 3.13, -3.1); if (l3) rotUp(l3, -85);
    moveTo('Light (1)', 'ShipModels2b', 4.742, 3.249997, -10.823);
    const l0 = moveTo('Light', 'ShipModels2b', -8.672, 3.13, -3.295); if (l0) l0.quaternion.copy(unityEuler(-90, 0, -120));
    moveTo('Light (2)', 'ShipModels2b', -9.911, 3.25, -11.063);
    const screen = byName('SingleScreen', 'MonitorWall'); if (screen) { screen.quaternion.copy(unityEuler(-90, -90, -28)); screen.position.copy(P(-3.7253, -1.017, 1.9057)); }
    moveTo('Cube.005', 'HangarShip', 5.027, 3.469644, -2.696);
    moveTo('Cube.006', 'HangarShip', 4.724743, 3.469644, -2.696);
    const outside = byName('OutsideShipRoom', 'HangarShip'); if (outside) outside.position.z += 5;
    moveTo('CatwalkUnderneathSupports', 'HangarShip', -7.093815, -0.1557276, -2.39);
    moveTo('Cube.005 (2)', 'ShipModels2b', -5.92, 1.907, -1.103);
    const c1 = moveTo('Cube.005 (1)', 'ShipModels2b', 0.674, 3.2079, 0.8735); if (c1) rotUp(c1, 180);
    const panel = byName('HangarDoorButtonPanel', 'AnimatedShipDoor'); if (panel) { panel.position.copy(P(6.412, 2.546, -3.328)); panel.quaternion.copy(unityEuler(90, 0, 0)); }

    // 4. lamps for the new sides: the plugin copies these six 4.5 m to each side
    for (const dz of [-4.5, 4.5]) for (const n of ['HangingLamp (3)', 'HangingLamp (4)', 'Area Light (4)', 'Area Light (5)', 'Area Light (8)', 'Area Light (7)']) {
      const o = byName(n, 'ShipElectricLights'); if (!o) continue;
      const c = o.clone(); c.name = n + (dz < 0 ? '_left' : '_right');
      o.parent.add(c);
      const wp = o.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0, dz).applyQuaternion(shipQ));
      c.position.copy(o.parent.worldToLocal(wp));
      c.traverse(x => { if (x.isLight) { x.userData.baseIntensity = o.userData.baseIntensity != null ? o.userData.baseIntensity : x.intensity; x.intensity = o.intensity; w.shipLights.push(x); } });
    }
    shipObj.updateMatrixWorld(true);

    // 5. the room is wider now: bounds for "inside the ship" tests and the furniture builder
    w.roomBounds = { xMin: -10.8, xMax: 7.2, zMin: -14.7, zMax: 1.4 };
    w.deckBounds = { xMin: -11.5, xMax: 13, zMin: -16.5, zMax: 4.5 };
    w.cabin = { xMin: -9.4, xMax: 6.8, zMin: -13.6, zMax: 0.0 };

    // 6. rebuild the static ship collision without the hidden vanilla parts, with the new hull
    const animDoor = (ship.byName.get('AnimatedShipDoor') || [])[0];
    const doorBlocker = animDoor ? animDoor.children.find(c => c.name === 'Cube') : null;
    const doorNames = new Set(['HangarDoorLeft', 'HangarDoorRight', 'HangarDoorLeft (1)', 'HangarDoorRight (1)']);
    const dynamicIds = new Set([doorBlocker && doorBlocker.userData.node.id].filter(Boolean));
    const entries = await collisionEntries(lib, ship, { relativeTo: shipObj, exclude: n => doorNames.has(n.name) || dynamicIds.has(n.id) || NOCOLLIDE.has(n.layer) });
    for (const inst of this.parts) {
      const wallRoot = this.walls.includes(inst) ? inst.root.children[0].userData.node : null;
      const e = await collisionEntries(lib, inst, { relativeTo: shipObj, exclude: n => NOCOLLIDE.has(n.layer) || (wallRoot && n.id === wallRoot.id) });   // inner walls are beams only: no wall box
      for (const x of e) entries.push(x);
    }
    const old = w.shipCollider;
    w.shipCollider = new Collider('ship').build(entries, shipObj);
    const i = w.colliders.indexOf(old); if (i >= 0) w.colliders[i] = w.shipCollider; else w.colliders.push(w.shipCollider);
    if (old && old.dispose) old.dispose();
    if (g._refreshLightSources) g._refreshLightSources();
    if (g.player && g.player.resyncAttach) g.player.resyncAttach();
  }
}
