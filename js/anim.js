// Animation playback for packed Unity clips (assets/anims/<id>.json) + a TwoBoneIK solver for Animation Rigging constraints.
import * as THREE from 'three';

const clipCache = new Map();
export async function loadClip(id) {
  if (!clipCache.has(id)) clipCache.set(id, fetch('assets/anims/' + id + '.json').then(r => r.ok ? r.json() : null).catch(() => null));
  return clipCache.get(id);
}
let animIndex = null;
export async function loadAnimIndex() {
  if (!animIndex) animIndex = await fetch('assets/anims/index.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  return animIndex;
}

/** Resolve "a/b/c" relative to the animator object by child names. */
function findPath(root, path) {
  if (!path || path === 'null') return root;
  let o = root;
  for (const seg of path.split('/')) {
    if (!o) return null;
    o = o.children.find(ch => ch.name === seg) || null;
  }
  return o;
}

/** Build a THREE.AnimationClip whose tracks target objects under `root`. */
export function buildClip(data, root) {
  const tracks = [];
  for (const [path, t] of Object.entries(data.tracks)) {
    const o = findPath(root, path);
    if (!o) continue;
    if (t.rot.length) {
      const times = t.rot.map(k => k[0]); const vals = []; t.rot.forEach(k => vals.push(k[1], k[2], k[3], k[4]));
      tracks.push(new THREE.QuaternionKeyframeTrack(o.uuid + '.quaternion', times, vals));
    }
    if (t.pos.length) {
      const times = t.pos.map(k => k[0]); const vals = []; t.pos.forEach(k => vals.push(k[1], k[2], k[3]));
      tracks.push(new THREE.VectorKeyframeTrack(o.uuid + '.position', times, vals));
    }
    if (t.scale.length) {
      const times = t.scale.map(k => k[0]); const vals = []; t.scale.forEach(k => vals.push(k[1], k[2], k[3]));
      tracks.push(new THREE.VectorKeyframeTrack(o.uuid + '.scale', times, vals));
    }
  }
  // GameObject active toggles (m_IsActive float curves)
  for (const f of data.floats || []) {
    if (f.attr === 'm_IsActive' && f.keys.length) {
      const o = findPath(root, f.path); if (!o) continue;
      const times = f.keys.map(k => k[0]); const vals = f.keys.map(k => k[1] > 0.5);
      tracks.push(new THREE.BooleanKeyframeTrack(o.uuid + '.visible', times, vals));
    }
  }
  const clip = new THREE.AnimationClip(data.name, data.length || -1, tracks);
  return clip;
}

/** An animator on one object hierarchy: plays clips by name with crossfades. */
export class Animator {
  constructor(root, controllerId, objsByUuid) {
    this.root = root; this.controllerId = controllerId;
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = new Map(); this.actions = new Map();
    this.current = null; this.ready = false;
    this.ik = [];
  }

  async load() {
    const idx = await loadAnimIndex();
    const entry = idx[this.controllerId];
    if (!entry) return this;
    await Promise.all(entry.clips.map(async c => {
      const data = await loadClip(c.id);
      if (!data) return;
      const clip = buildClip(data, this.root);
      if (clip.tracks.length) { this.clips.set(c.name, { clip, data }); }
    }));
    this.ready = true;
    return this;
  }

  has(name) { return this.clips.has(name); }
  names() { return [...this.clips.keys()]; }

  /** find a clip by regex list, first match wins */
  find(patterns) {
    for (const p of patterns) { for (const n of this.clips.keys()) if (p.test(n)) return n; }
    return null;
  }

  play(name, { fade = 0.25, loop = true, speed = 1, once = false } = {}) {
    if (!this.clips.has(name)) return null;
    if (this.current === name && !once) return this.actions.get(name);
    let a = this.actions.get(name);
    if (!a) { a = this.mixer.clipAction(this.clips.get(name).clip); this.actions.set(name, a); }
    a.enabled = true; a.setLoop(loop && !once ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); a.clampWhenFinished = once; a.timeScale = speed;
    if (this.current && this.current !== name && this.actions.get(this.current)) { a.reset().play(); this.actions.get(this.current).crossFadeTo(a, fade, false); }
    else a.reset().fadeIn(fade).play();
    this.current = name;
    return a;
  }

  stop() { this.mixer.stopAllAction(); this.current = null; }

  update(dt) {
    this.mixer.update(dt);
    for (const ik of this.ik) solveTwoBoneIK(ik);
  }
}

// ---------------- Two bone IK (Animation Rigging TwoBoneIKConstraint) ----------------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _h = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _ax = new THREE.Vector3(), _ax2 = new THREE.Vector3(), _inv = new THREE.Quaternion();

function rotateBoneWorld(bone, q) {
  // apply a world-space rotation q to bone (bone.quaternion is local)
  const parentQ = bone.parent ? bone.parent.getWorldQuaternion(_inv) : _inv.identity();
  const worldQ = _q2.copy(parentQ).multiply(bone.quaternion);
  worldQ.premultiply(q);
  bone.quaternion.copy(parentQ.clone().invert().multiply(worldQ));
  bone.updateMatrixWorld(true);
}

export function solveTwoBoneIK({ root, mid, tip, target, hint, weight = 1, hintWeight = 1 }) {
  if (!root || !mid || !tip || !target || weight <= 0) return;
  root.updateMatrixWorld(true);
  root.getWorldPosition(_a); mid.getWorldPosition(_b); tip.getWorldPosition(_c); target.getWorldPosition(_t);
  const lab = _a.distanceTo(_b), lbc = _b.distanceTo(_c);
  let lat = _a.distanceTo(_t);
  const eps = 1e-4;
  lat = Math.min(Math.max(lat, Math.abs(lab - lbc) + eps), lab + lbc - eps);
  // angle at root and mid using law of cosines
  const cosA0 = clampCos((lab * lab + _a.distanceToSquared(_c) - lbc * lbc) / (2 * lab * _a.distanceTo(_c)));
  const cosB0 = clampCos((lab * lab + lbc * lbc - _a.distanceToSquared(_c)) / (2 * lab * lbc));
  const cosA1 = clampCos((lab * lab + lat * lat - lbc * lbc) / (2 * lab * lat));
  const cosB1 = clampCos((lab * lab + lbc * lbc - lat * lat) / (2 * lab * lbc));
  const angA = Math.acos(cosA1) - Math.acos(cosA0), angB = Math.acos(cosB1) - Math.acos(cosB0);
  // bend axis
  const ab = _b.clone().sub(_a), ac = _c.clone().sub(_a), at = _t.clone().sub(_a);
  let axis = ab.clone().cross(ac);
  if (hint && hintWeight > 0) { hint.getWorldPosition(_h); const ah = _h.clone().sub(_a); const proj = ah.clone().sub(at.clone().multiplyScalar(ah.dot(at) / Math.max(1e-6, at.lengthSq()))); if (proj.lengthSq() > 1e-6 && axis.lengthSq() < 1e-6) axis = at.clone().cross(proj); }
  if (axis.lengthSq() < 1e-8) axis = ab.clone().cross(new THREE.Vector3(0, 1, 0)); if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0);
  axis.normalize();
  const w = weight;
  rotateBoneWorld(mid, _q.setFromAxisAngle(axis, angB * w));
  rotateBoneWorld(root, _q.setFromAxisAngle(axis, angA * w));
  // aim root so that the tip points at target
  tip.getWorldPosition(_c);
  const ac2 = _c.clone().sub(_a).normalize(), at2 = _t.clone().sub(_a).normalize();
  const rot = new THREE.Quaternion().setFromUnitVectors(ac2, at2);
  if (w < 1) rot.slerp(new THREE.Quaternion(), 1 - w);
  rotateBoneWorld(root, rot);
  // hint: rotate around root->target axis to bring mid toward hint plane
  if (hint && hintWeight > 0) {
    mid.getWorldPosition(_b); hint.getWorldPosition(_h);
    const axisAT = _t.clone().sub(_a).normalize();
    const bProj = _b.clone().sub(_a); bProj.sub(axisAT.clone().multiplyScalar(bProj.dot(axisAT)));
    const hProj = _h.clone().sub(_a); hProj.sub(axisAT.clone().multiplyScalar(hProj.dot(axisAT)));
    if (bProj.lengthSq() > 1e-6 && hProj.lengthSq() > 1e-6) {
      const q = new THREE.Quaternion().setFromUnitVectors(bProj.normalize(), hProj.normalize());
      if (hintWeight < 1) q.slerp(new THREE.Quaternion(), 1 - hintWeight);
      rotateBoneWorld(root, q);
    }
  }
}
function clampCos(v) { return Math.max(-1, Math.min(1, isFinite(v) ? v : 0)); }

/** Collect TwoBoneIKConstraint components from an instantiated manifest into solver entries. */
export function collectIK(inst) {
  const out = [];
  for (const [id, o] of inst.objs) {
    const n = o.userData.node; if (!n) continue;
    for (const c of n.comps) {
      if (c.t !== 'MB' || c.cls !== 'TwoBoneIKConstraint' || !c.d) continue;
      const d = c.d.m_Data || c.d;
      const get = k => { const r = d[k]; return r && r.$ ? (inst.objs.get(r.$) || null) : null; };
      const e = { root: get('m_Root'), mid: get('m_Mid'), tip: get('m_Tip'), target: get('m_Target'), hint: get('m_Hint'), weight: (c.d.m_Weight ?? 1) * (d.m_TargetPositionWeight ?? 1), hintWeight: d.m_HintWeight ?? 1, node: o };
      if (e.root && e.mid && e.tip && e.target) out.push(e);
    }
  }
  return out;
}
