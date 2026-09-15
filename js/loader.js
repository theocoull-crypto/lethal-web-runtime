// Loads packed Unity hierarchies (see tools/pack.py) into three.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ASSETS = 'assets/';
// Unity layers that only exist for physics / minimap / scanning in Lethal Company
const HIDDEN_LAYERS = new Set([11, 13, 14, 15, 22, 26, 28]);
// objects a mod's own scripts would switch off at runtime (config-gated joke modes): floating "COW"/"FOX" text meshes
const HIDDEN_NAMES = /^(COW|FOX)$|Carnophobia|Cow_Text|FoxPinata/;
// interact hitboxes: InteractTrigger-tagged cubes rendered with the game's debug trigger materials are invisible in-game
const TRIGGER_MATS = /^(testTrigger|testTriggerRed|DefaultHDMaterial)$/;

export class AssetLib {
  constructor(renderer) {
    this.renderer = renderer;
    this.gltf = new GLTFLoader();
    this.texLoader = new THREE.TextureLoader();
    this.materials = null;
    this.texMeta = null;
    this.matCache = new Map();
    this.texCache = new Map();
    this.meshCache = new Map();
    this.manifestCache = new Map();
    this.audioCache = new Map();
    this.maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
    this.onProgress = null;
    this._loaded = 0; this._total = 0;
  }

  async init() {
    const [m, t] = await Promise.all([fetch(ASSETS + 'materials.json').then(r => r.json()), fetch(ASSETS + 'textures.json').then(r => r.json())]);
    this.materials = m; this.texMeta = t;
  }

  _tick() { this._loaded++; if (this.onProgress) this.onProgress(this._loaded, this._total); }

  async manifest(path) {
    if (!this.manifestCache.has(path)) {
      this.manifestCache.set(path, fetch(ASSETS + path).then(r => { if (!r.ok) throw new Error('missing manifest ' + path); return r.json(); }));
    }
    return this.manifestCache.get(path);
  }

  texture(id, role, scale, offset) {
    const key = id + '|' + (scale ? scale.join(',') : '') + '|' + (offset ? offset.join(',') : '');
    if (this.texCache.has(key)) return this.texCache.get(key);
    this._total++;
    const tex = this.texLoader.load(ASSETS + 'tex/' + id + '.png', () => this._tick(), undefined, () => this._tick());
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = role === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = Math.min(8, this.maxAniso);
    tex.flipY = false;   // Unity UVs match glTF convention after AssetRipper export
    if (scale) tex.repeat.set(scale[0], scale[1]);
    if (offset) tex.offset.set(offset[0], offset[1]);
    this.texCache.set(key, tex);
    return tex;
  }

  material(id) {
    if (!id) return this.fallbackMaterial();
    if (this.matCache.has(id)) return this.matCache.get(id);
    const d = this.materials[id];
    let mat;
    if (!d || !d.name) {
      mat = this.fallbackMaterial();
    } else {
      mat = this.buildMaterial(d, id);
    }
    this.matCache.set(id, mat);
    return mat;
  }

  fallbackMaterial() {
    if (!this._fallback) this._fallback = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
    return this._fallback;
  }

  /** Unity terrain: up to 6 tiled splat layers blended by two RGBA alphamaps (packed by tools/pack.py from the TerrainData) */
  terrainMaterial(d, id) {
    const mat = new THREE.MeshStandardMaterial({ name: d.name || 'terrain', roughness: 0.95, metalness: 0 });
    const size = d.size || [1000, 1000];
    const layers = (d.layers || []).slice(0, 8);
    const alphas = (d.alphas || []).slice(0, 2);
    const alphaTex = alphas.map(aid => { const t = this.texture(aid, 'data'); t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; });
    const layTex = layers.map(l => l ? this.texture(l.map, 'color') : null);
    mat.map = alphaTex[0] || null;   // gives the shader vMapUv; overridden below
    mat.envMapIntensity = 0.3;
    const u = {};
    for (let i = 0; i < 2; i++) u['tAlpha' + i] = { value: alphaTex[i] || alphaTex[0] || null };
    for (let i = 0; i < 8; i++) {
      const l = layers[i];
      u['tLay' + i] = { value: layTex[i] || layTex.find(Boolean) || null };
      // Unity terrains tile by world size / tile size; mesh-terrain graphs tile the mesh UVs directly
      u['uTile' + i] = { value: l ? (d.uvTiling ? new THREE.Vector2(l.tile[0] || 1, l.tile[1] || 1) : new THREE.Vector2(size[0] / (l.tile[0] || 1), size[1] / (l.tile[1] || 1))) : new THREE.Vector2(1, 1) };
      u['uTint' + i] = { value: l ? new THREE.Color(l.tint[0], l.tint[1], l.tint[2]) : new THREE.Color(1, 1, 1) };
    }
    const n = layers.length;
    const flipV = d.flipAlphaV !== false;
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, u);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
uniform sampler2D tAlpha0, tAlpha1, tLay0, tLay1, tLay2, tLay3, tLay4, tLay5, tLay6, tLay7;
uniform vec2 uTile0, uTile1, uTile2, uTile3, uTile4, uTile5, uTile6, uTile7;
uniform vec3 uTint0, uTint1, uTint2, uTint3, uTint4, uTint5, uTint6, uTint7;`)
        .replace('#include <map_fragment>', `
vec2 suv = ${flipV ? 'vec2(vMapUv.x, 1.0 - vMapUv.y)' : 'vMapUv'};
vec4 a0 = texture2D(tAlpha0, suv); vec4 a1 = texture2D(tAlpha1, suv);
float w0 = a0.r, w1 = a0.g, w2 = a0.b, w3 = a0.a, w4 = a1.r, w5 = a1.g, w6 = a1.b, w7 = a1.a;
${n <= 1 ? 'w0 = 1.0; w1 = w2 = w3 = w4 = w5 = w6 = w7 = 0.0;' : ''}
${n <= 4 ? 'w4 = 0.0; w5 = 0.0; w6 = 0.0; w7 = 0.0;' : ''}
${n > 4 && n <= 6 ? 'w6 = 0.0; w7 = 0.0;' : ''}
float wsum = max(0.001, w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7);
vec3 blend = vec3(0.0);
blend += w0 * texture2D(tLay0, vMapUv * uTile0).rgb * uTint0;
blend += w1 * texture2D(tLay1, vMapUv * uTile1).rgb * uTint1;
blend += w2 * texture2D(tLay2, vMapUv * uTile2).rgb * uTint2;
blend += w3 * texture2D(tLay3, vMapUv * uTile3).rgb * uTint3;
blend += w4 * texture2D(tLay4, vMapUv * uTile4).rgb * uTint4;
blend += w5 * texture2D(tLay5, vMapUv * uTile5).rgb * uTint5;
blend += w6 * texture2D(tLay6, vMapUv * uTile6).rgb * uTint6;
blend += w7 * texture2D(tLay7, vMapUv * uTile7).rgb * uTint7;
diffuseColor.rgb *= blend / wsum;`);
    };
    mat.customProgramCacheKey = () => 'terrain' + n + (flipV ? 'f' : '');
    mat.userData.terrain = true;
    return mat;
  }

  buildMaterial(d, id) {
    if (d.shader === 'Terrain') return this.terrainMaterial(d, id);
    const name = d.name || '';
    const shader = d.shader || '';
    const p = { name };
    const c = d.color || [1, 1, 1, 1];
    const unlit = /Unlit/i.test(shader);
    const mat = unlit ? new THREE.MeshBasicMaterial(p) : new THREE.MeshStandardMaterial(p);
    mat.color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    if (d.map) mat.map = this.texture(d.map.id, 'color', d.map.scale, d.map.offset);
    if (!unlit) {
      if (d.normalMap) {
        mat.normalMap = this.texture(d.normalMap.id, 'normal', d.map ? d.map.scale : d.normalMap.scale, d.map ? d.map.offset : d.normalMap.offset);
        const ns = Math.min(2.5, Math.max(0.2, (d.normalScale || 1) * 0.5));
        mat.normalScale.set(ns, ns);
      }
      const smooth = d.smoothness == null ? 0.5 : d.smoothness;
      if (!d.map && d.maskMap && mat.normalMap && /rock|stone|cliff|cave|boulder|gravel/i.test(name)) mat.normalScale.set(1.1, 1.1);   // untextured rocks: the game shows their detail through the normal map alone
      if (d.maskMap) {
        // HDRP: smoothness = lerp(remapMin, remapMax, mask.A); metallic = mask.R; AO = lerp(aoMin, aoMax, mask.G)
        const rm = d.smoothnessRemap || [0, 1];
        const orm = this.ormTexture(d.maskMap.id, rm, d.map ? d.map.scale : d.maskMap.scale, d.map ? d.map.offset : d.maskMap.offset);
        mat.roughnessMap = orm; mat.metalnessMap = orm; mat.aoMap = orm;
        mat.roughness = 1.0; mat.metalness = 1.0; mat.aoMapIntensity = 1.0;
      } else {
        mat.roughness = 1 - smooth;
        mat.metalness = d.metallic || 0;
      }
      mat.envMapIntensity = 0.3;
      const e = d.emissive || [0, 0, 0];
      const emax = Math.max(e[0], e[1], e[2]);
      // Shader Graph materials carry a default white _EmissiveColor that means nothing; only trust it with an emissive map,
      // an HDR value, an explicit intensity switch, or the stock HDRP shaders
      const emissiveReal = emax > 0.001 && (d.emissiveMap || emax > 1.01 || d.useEmissiveIntensity || /^HDRP\//.test(shader) || /^b\d/.test(id));   // the game's own materials are trusted as-is
      if (emissiveReal) {
        // HDRP emissive colors are HDR (linear). Normalise to a sane range for a non-physical renderer.
        const scale = emax > 1 ? 1 / emax : 1;
        mat.emissive.setRGB(e[0] * scale, e[1] * scale, e[2] * scale, THREE.LinearSRGBColorSpace);
        mat.emissiveIntensity = Math.min(6, emax > 1 ? Math.log2(emax + 1) : emax);
        if (d.emissiveMap) mat.emissiveMap = this.texture(d.emissiveMap.id, 'color', d.map ? d.map.scale : d.emissiveMap.scale, d.map ? d.map.offset : d.emissiveMap.offset);
      }
    }
    if (d.surfaceType === 1 || (d.queue >= 3000 && d.queue < 4000 && d.surfaceType !== 0)) {
      mat.transparent = true;
      mat.opacity = c[3] == null ? 1 : c[3];
      mat.depthWrite = !!d.zwrite;
    }
    if (d.alphaTest) { mat.alphaTest = d.cutoff || 0.5; mat.transparent = false; }
    if (d.doubleSided || d.cull === 0) mat.side = THREE.DoubleSide;
    if (/testTrigger|Trigger/i.test(name) && d.surfaceType === 1) { mat.visible = false; }
    if (name === 'HangarShipHull') { mat.color.setRGB(0.8, 0.8, 0.78, THREE.SRGBColorSpace); mat.roughness = 0.7; mat.metalness = 0.3; }
    if (/^(MarchWater|CaveWater|Water_mat)/.test(name)) { mat.color.setRGB(0.09, 0.16, 0.17, THREE.SRGBColorSpace); mat.transparent = true; mat.opacity = 0.78; mat.roughness = 0.12; mat.metalness = 0.0; mat.envMapIntensity = 0.9; mat.depthWrite = false; mat.side = THREE.DoubleSide; }
    if (/HDRP\/Decal/.test(shader)) { mat.visible = false; }   // projected decals (puddles, grime) are not supported
    if (name === 'metal_06_M_Inst') {   // the Slaughterhouse stair metal is a near-flat grey; use its own diamond-plate texture so the steps read
      try { mat.map = this.texture('shg0_-5612978485270795831', 'color', [2, 2], [0, 0]); mat.normalMap = this.texture('shg0_3054774846283771768', 'normal', [2, 2], [0, 0]); mat.normalScale.set(0.8, 0.8); mat.roughness = 0.55; mat.metalness = 0.35; } catch (e) { }
    }
    if (/LayeredLit/.test(shader)) {   // splat-blended terrain: its base map is a placeholder and the real layers are not blended here, so lay the moon's tiled snow over it
      try { mat.map = this.texture('b18_20', 'color', [90, 90], [0, 0]); mat.normalMap = this.texture('b19_460', 'normal', [90, 90], [0, 0]); mat.normalScale.set(0.6, 0.6); mat.maskMap = null; mat.roughnessMap = null; mat.metalnessMap = null; mat.aoMap = null; } catch (e) { }
      mat.color.setRGB(0.9, 0.92, 0.95, THREE.SRGBColorSpace); mat.roughness = 0.95; mat.metalness = 0;
    }
    return mat;
  }

  /** ORM texture with the HDRP smoothness remap baked into the roughness channel. */
  ormTexture(id, remap, scale, offset) {
    const key = 'orm|' + id + '|' + remap.join(',') + '|' + (scale ? scale.join(',') : '') + '|' + (offset ? offset.join(',') : '');
    if (this.texCache.has(key)) return this.texCache.get(key);
    const base = this.texture(id, 'mask', scale, offset);
    if (Math.abs(remap[0]) < 1e-3 && Math.abs(remap[1] - 1) < 1e-3) { this.texCache.set(key, base); return base; }
    const tex = base.clone();
    const apply = img => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const im = ctx.getImageData(0, 0, c.width, c.height); const p = im.data;
      const lo = remap[0], hi = remap[1];
      for (let i = 0; i < p.length; i += 4) { const s = 1 - p[i + 1] / 255; const s2 = lo + (hi - lo) * s; p[i + 1] = Math.round((1 - s2) * 255); }
      ctx.putImageData(im, 0, 0);
      tex.image = c; tex.needsUpdate = true;
    };
    if (base.image && base.image.width) apply(base.image);
    else { const t = setInterval(() => { if (base.image && base.image.width) { clearInterval(t); apply(base.image); } }, 100); }
    this.texCache.set(key, tex);
    return tex;
  }

  mesh(id) {
    if (this.meshCache.has(id)) return this.meshCache.get(id);
    this._total++;
    const p = this.gltf.loadAsync(ASSETS + 'meshes/' + id + '.glb').then(g => {
      this._tick();
      // collect submeshes in order (SubMesh_0..n)
      const subs = [];
      g.scene.traverse(o => { if (o.isMesh) subs.push(o); });
      subs.sort((a, b) => {
        const ia = parseInt((a.parent && /SubMesh_(\d+)/.exec(a.parent.name) || /SubMesh_(\d+)/.exec(a.name) || [0, 0])[1]);
        const ib = parseInt((b.parent && /SubMesh_(\d+)/.exec(b.parent.name) || /SubMesh_(\d+)/.exec(b.name) || [0, 0])[1]);
        return ia - ib;
      });
      return subs.map(s => s.geometry);
    }).catch(e => { this._tick(); console.warn('mesh failed', id, e); return []; });
    this.meshCache.set(id, p);
    return p;
  }

  audio(id) {
    if (!this.audioCache.has(id)) {
      this.audioCache.set(id, new Promise((res) => {
        const a = new Audio(ASSETS + 'audio/' + id + '.ogg');
        a.preload = 'auto';
        res(a);
      }));
    }
    return this.audioCache.get(id);
  }

  /**
   * Instantiate a packed manifest.
   * opts.filter(node) -> bool, opts.staticRoot: Object3D receiving static-batched meshes (world space),
   * opts.lights: create lights, opts.collision: array to receive meshes usable for collision
   */
  async instantiate(man, opts = {}) {
    const root = new THREE.Group();
    root.name = man.name;
    const objs = new Map();
    const byName = new Map();
    const nodes = man.nodes;
    // create objects
    for (const n of nodes) {
      if (opts.filter && !opts.filter(n)) continue;
      const o = new THREE.Group();
      o.name = n.name;
      o.userData.node = n;
      o.position.set(n.p[0], n.p[1], n.p[2]);
      o.quaternion.set(n.r[0], n.r[1], n.r[2], n.r[3]);
      o.scale.set(n.s[0], n.s[1], n.s[2]);
      o.visible = n.active !== false;
      objs.set(n.id, o);
      if (!byName.has(n.name)) byName.set(n.name, []);
      byName.get(n.name).push(o);
    }
    // link
    for (const n of nodes) {
      const o = objs.get(n.id); if (!o) continue;
      const par = n.parent ? objs.get(n.parent) : null;
      if (par) par.add(o); else if (!n.parent) root.add(o);
      else root.add(o);
    }
    root.updateMatrixWorld(true);
    const staticRoot = opts.staticRoot || root;
    const pending = [];
    const lights = [];
    // LOD groups by name: 'GeneratorLOD0' / 'GeneratorLOD1', 'rock.015_LOD1' (alone: keep it). Only the finest present copy draws.
    const lodSkip = new Set();
    { const best = new Map(), members = [], byId = new Map(man.nodes.map(n => [n.id, n]));
      const hasMR = n => !!n && n.comps.some(c => c.t === 'MR');
      for (const n of man.nodes) { const mm = /^(.*?)_?LOD(\d)(?![0-9])(.*)$/.exec(n.name); if (!mm || /Nav$/.test(n.name) || !hasMR(n)) continue; const key = (n.parent || '') + '|' + mm[1] + '|' + mm[3]; const lod = +mm[2]; members.push({ id: n.id, key, lod, parentMR: hasMR(byId.get(n.parent)) }); if (!best.has(key) || lod < best.get(key)) best.set(key, lod); }
      // the LOD0 is usually the parent itself ('rock.015 (1)' > 'rock.015_LOD1'); a lone LOD1 with no finer copy anywhere stays
      for (const m of members) if (m.lod > best.get(m.key) || (m.lod > 0 && m.parentMR)) lodSkip.add(m.id); }
    const audios = [];
    const skinned = [];
    for (const n of nodes) {
      const o = objs.get(n.id); if (!o) continue;
      for (const c of n.comps) {
        if (c.t === 'MR' && n.mesh) {
          if (opts.noRender) continue;
          if (HIDDEN_LAYERS.has(n.layer)) continue;   // triggers, colliders, map radar dots, scan nodes
          if (HIDDEN_NAMES.test(n.name)) continue;
          if (lodSkip.has(n.id)) continue;   // a lower-detail copy of a sibling that also has a finer LOD (LODGroup refs are not packed)
          if (n.tag === 'InteractTrigger' && (c.mats || []).length && (c.mats || []).every(id => { const d = this.materials[id]; return d && TRIGGER_MATS.test(d.name || ''); })) continue;
          pending.push(this.mesh(n.mesh).then(geoms => {
            if (!geoms.length) return;
            const mats = c.mats || [];
            let list = [];
            if (c.sb) {
              for (let i = 0; i < c.sb[1]; i++) {
                const g = geoms[c.sb[0] + i]; if (!g) continue;
                list.push([g, mats[i] ?? mats[mats.length - 1]]);
              }
            } else {
              for (let i = 0; i < geoms.length; i++) list.push([geoms[i], mats[Math.min(i, mats.length - 1)]]);
            }
            for (const [g, mid] of list) {
              const mat = this.material(mid);
              if (mat.visible === false) continue;
              const m = new THREE.Mesh(g, mat);
              m.castShadow = !!c.shadows; m.receiveShadow = true;
              m.userData.nodeId = n.id; m.userData.layer = n.layer; m.userData.tag = n.tag;
              m.name = n.name;
              if (c.sb) { staticRoot.add(m); m.userData.static = true; }
              else o.add(m);
              if (opts.collision) opts.collision.push(m);
            }
          }));
        } else if (c.t === 'SMR' && c.mesh) {
          skinned.push({ node: n, obj: o, comp: c });
        } else if (c.t === 'Light' && opts.lights !== false) {
          if (n.active === false || c.enabled === false) continue;
          const hd = n.comps.find(x => x.t === 'MB' && x.cls === 'HDAdditionalLightData');
          const col = new THREE.Color().setRGB(c.color[0], c.color[1], c.color[2], THREE.SRGBColorSpace);
          let l;
          const inten = (c.intensity || 1);
          if (c.type === 2) { // point
            l = new THREE.PointLight(col, inten, c.range || 10, 2);
          } else if (c.type === 0) { // spot
            l = new THREE.SpotLight(col, inten, c.range || 10, THREE.MathUtils.degToRad((c.spot || 30) / 2), 0.5, 2);
            const t = new THREE.Object3D(); t.position.set(0, 0, 1); l.add(t); l.target = t;
          } else if (c.type === 1) {
            l = new THREE.DirectionalLight(col, inten);
          }
          if (l) { l.userData.unity = c; o.add(l); lights.push(l); }
        } else if (c.t === 'Audio') {
          audios.push({ node: n, obj: o, comp: c });
        }
      }
    }
    await Promise.all(pending);
    return { root, objs, byName, lights, audios, skinned, manifest: man };
  }
}

export function findNode(inst, name) { const a = inst.byName.get(name); return a ? a[0] : null; }

const _F = new THREE.Matrix4().makeScale(-1, 1, 1);
/**
 * Build three.js SkinnedMeshes for every SkinnedMeshRenderer in an instantiated hierarchy.
 * Bones are the instantiated node objects; inverse bind matrices come from assets/meshes/<aid>.bind.json (Unity, mirrored).
 * Skinned meshes are added to `sceneRoot` with identity transform (bones carry the world transform).
 */
export async function buildSkinned(lib, inst, sceneRoot, opts = {}) {
  const out = [];
  let lodSeen = new Set();
  for (const s of inst.skinned) {
    const c = s.comp;
    if (c.enabled === false) continue;
    { let q = s.obj, hidden = false; while (q && q !== inst.root) { if (q.visible === false) { hidden = true; break; } q = q.parent; } if (hidden) continue; }   // switched-off props and blockers
    // only the highest LOD: names LOD1/LOD2/LOD3 or ..._LOD1 -> keep the first encountered per parent
    const parentId = s.node.parent;
    if (/^LOD\d|_LOD\d$/.test(s.node.name)) { if (lodSeen.has(parentId)) continue; lodSeen.add(parentId); }
    const geoms = await lib.mesh(c.mesh);
    if (!geoms.length) continue;
    let bind = null;
    if (!opts.static) { try { bind = await fetch(ASSETS + 'meshes/' + c.mesh + '.bind.json').then(r => r.ok ? r.json() : null); } catch (e) { } }
    const bones = c.bones.map(id => inst.objs.get(id) || null);
    if (opts.static || !bind || !bones.length || bones.some(b => !b)) {
      // fallback: static meshes at the renderer node
      for (let i = 0; i < geoms.length; i++) { const m = new THREE.Mesh(geoms[i], lib.material(c.mats[Math.min(i, c.mats.length - 1)])); s.obj.add(m); out.push(m); }
      continue;
    }
    const inverses = bind.bindposes.map(r => {
      const m = new THREE.Matrix4().set(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15]);
      return new THREE.Matrix4().multiplyMatrices(_F, m).multiply(_F);
    });
    const skeleton = new THREE.Skeleton(bones, inverses);
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i];
      if (!g.attributes.skinIndex || !g.attributes.skinWeight) { const m = new THREE.Mesh(g, lib.material(c.mats[Math.min(i, c.mats.length - 1)])); s.obj.add(m); out.push(m); continue; }
      const mat = lib.material(c.mats[Math.min(i, c.mats.length - 1)]);
      const sm = new THREE.SkinnedMesh(g, mat);
      sm.frustumCulled = false; sm.castShadow = true; sm.receiveShadow = true;
      sceneRoot.add(sm);
      sm.bind(skeleton, new THREE.Matrix4());
      sm.userData.smrNode = s.node; sm.name = s.node.name;
      out.push(sm);
    }
  }
  return out;
}
