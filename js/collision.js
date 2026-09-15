// Capsule-vs-triangle collision on merged static geometry using three-mesh-bvh.
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three/addons/three-mesh-bvh.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

const _tri = new THREE.Triangle();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _seg = new THREE.Line3(), _box = new THREE.Box3();
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();

/** A static collision volume: a BVH over merged triangles, optionally attached to a moving Object3D. */
export class Collider {
  constructor(name = 'collider') {
    this.name = name;
    this.mesh = null;   // THREE.Mesh with BVH geometry (local space of `parent`)
    this.parent = null; // Object3D whose matrixWorld maps local -> world (null = world space)
    this.enabled = true;
  }

  /** entries: [{geometry, matrix}] where matrix maps geometry -> parent space */
  build(entries, parent = null) {
    const geoms = [];
    for (const { geometry, matrix } of entries) {
      if (!geometry || !geometry.attributes.position) continue;
      let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
      const pos = g.attributes.position;
      const clean = new THREE.BufferGeometry();
      clean.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos.array), 3));
      if (matrix) {
        clean.applyMatrix4(matrix);
        if (matrix.determinant() < 0) {   // mirrored: swap two corners so the faces still point outward (the BVH is one-sided)
          const a = clean.attributes.position.array;
          for (let t = 0; t + 9 <= a.length; t += 9) for (let k = 0; k < 3; k++) { const tmp = a[t + 3 + k]; a[t + 3 + k] = a[t + 6 + k]; a[t + 6 + k] = tmp; }
        }
      }
      geoms.push(clean);
    }
    if (!geoms.length) { this.mesh = null; return this; }
    const merged = mergeGeometries(geoms, false);
    merged.computeBoundsTree({ maxLeafTris: 8 });
    this.mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ wireframe: true, color: 0x00ff00 }));
    this.mesh.visible = false;
    this.parent = parent;
    this.triCount = merged.attributes.position.count / 3;
    return this;
  }

  dispose() { if (this.mesh) { this.mesh.geometry.disposeBoundsTree(); this.mesh.geometry.dispose(); this.mesh = null; } }

  worldToLocal() {
    if (this.parent) { this.parent.updateMatrixWorld(); _inv.copy(this.parent.matrixWorld).invert(); return _inv; }
    return _inv.identity();
  }

  localToWorld() { if (this.parent) return _m.copy(this.parent.matrixWorld); return _m.identity(); }

  /**
   * Push a world-space capsule (segment start->end with radius) out of geometry.
   * Returns total world-space displacement applied to `start`/`end` (mutated), plus max upward normal component.
   */
  resolveCapsule(start, end, radius, out) {
    if (!this.mesh || !this.enabled) return false;
    const w2l = this.worldToLocal();
    // assume no scale on parent (ship / dungeon roots are unscaled)
    _seg.start.copy(start).applyMatrix4(w2l);
    _seg.end.copy(end).applyMatrix4(w2l);
    _box.makeEmpty(); _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
    _box.min.addScalar(-radius); _box.max.addScalar(radius);
    let hit = false;
    const bvh = this.mesh.geometry.boundsTree;
    const disp = _v2.set(0, 0, 0);
    bvh.shapecast({
      intersectsBounds: box => box.intersectsBox(_box),
      intersectsTriangle: tri => {
        const dist = tri.closestPointToSegment(_seg, _v1, _tri.a);
        if (dist < radius) {
          const depth = radius - dist;
          const dir = _tri.a.sub(_v1).normalize(); // from tri point to capsule point
          if (dir.lengthSq() < 1e-8) return false;
          _seg.start.addScaledVector(dir, depth);
          _seg.end.addScaledVector(dir, depth);
          disp.addScaledVector(dir, depth);
          _box.min.addScaledVector(dir, depth); _box.max.addScaledVector(dir, depth);
          hit = true;
          if (out) {
            const up = dir.y;
            if (up > out.maxUp) { out.maxUp = up; out.groundCollider = this; }
            if (up < out.minUp) out.minUp = up;
          }
        }
        return false;
      }
    });
    if (hit) {
      const l2w = this.localToWorld();
      start.copy(_seg.start).applyMatrix4(l2w);
      end.copy(_seg.end).applyMatrix4(l2w);
    }
    return hit;
  }

  raycast(origin, dir, far = 100) {
    if (!this.mesh || !this.enabled) return null;
    const w2l = this.worldToLocal();
    const ray = new THREE.Ray(origin.clone().applyMatrix4(w2l), dir.clone().transformDirection(w2l).normalize());
    const hit = this.mesh.geometry.boundsTree.raycastFirst(ray, THREE.DoubleSide);   // both faces: mirrored tiles and imported meshes wind either way
    if (!hit || hit.distance > far) return null;
    const l2w = this.localToWorld();
    hit.point.applyMatrix4(l2w);
    if (hit.face) hit.face.normal.transformDirection(l2w);
    hit.collider = this;
    return hit;
  }
}

/** Collect collision entries from an instantiated manifest (MeshCollider + BoxCollider components). */
export async function collisionEntries(lib, inst, opts = {}) {
  const entries = [];
  const box = new THREE.BoxGeometry(1, 1, 1);
  const rootInv = new THREE.Matrix4();
  inst.root.updateMatrixWorld(true);
  if (opts.relativeTo) rootInv.copy(opts.relativeTo.matrixWorld).invert(); else rootInv.identity();
  const pending = [];
  for (const [id, o] of inst.objs) {
    const n = o.userData.node;
    if (!n || n.active === false) continue;
    if (opts.exclude && opts.exclude(n)) continue;
    if (opts.only && !opts.only(n)) continue;
    // skip inactive ancestors
    let p = o, dead = false; while (p && p !== inst.root) { if (p.visible === false) { dead = true; break; } p = p.parent; }
    if (dead) continue;
    for (const c of n.comps) {
      if (opts.layers && !opts.layers(n.layer)) break;
      if (c.t === 'MeshCol' && c.mesh && !c.trigger && c.enabled !== false) {
        pending.push(lib.mesh(c.mesh).then(geoms => {
          const mat = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
          for (const g of geoms) entries.push({ geometry: g, matrix: mat });
        }));
      } else if (c.t === 'Box' && !c.trigger && c.enabled !== false && opts.boxes !== false) {
        const local = new THREE.Matrix4().compose(new THREE.Vector3(c.c[0], c.c[1], c.c[2]), new THREE.Quaternion(), new THREE.Vector3(c.s[0], c.s[1], c.s[2]));
        const mat = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld).multiply(local);
        entries.push({ geometry: box, matrix: mat });
      }
    }
  }
  // render meshes flagged as collision (e.g. static batched world geometry when no collider exists) are handled by caller
  await Promise.all(pending);
  return entries;
}
