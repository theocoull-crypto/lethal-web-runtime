import * as THREE from 'three';
import { Collider } from '../../collision.js';
import { LowtideSimulation } from './simulation.mjs';
import { LOWTIDE_CONFIG, cloneLowtideConfig } from './config.mjs';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

function seededRandom(seed = 14) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function smoothstep(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function segmentMatrix(a, b, width, height) {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const direction = end.clone().sub(start);
  const length = direction.length();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(FORWARD, direction.normalize());
  return new THREE.Matrix4().compose(
    start.add(end).multiplyScalar(0.5),
    quaternion,
    new THREE.Vector3(width, height, length),
  );
}

function pointInBox(point, volume) {
  return point.x >= volume.min[0] && point.x <= volume.max[0]
    && point.y >= volume.min[1] && point.y <= volume.max[1]
    && point.z >= volume.min[2] && point.z <= volume.max[2];
}

function createOpenedBodyGeometry() {
  const source = new THREE.SphereGeometry(1, 40, 22).toNonIndexed();
  const positions = source.attributes.position;
  const uvs = source.attributes.uv;
  const keptPositions = [];
  const keptUvs = [];
  for (let index = 0; index < positions.count; index += 3) {
    let cx = 0; let cy = 0; let cz = 0;
    for (let offset = 0; offset < 3; offset++) {
      cx += positions.getX(index + offset);
      cy += positions.getY(index + offset);
      cz += positions.getZ(index + offset);
    }
    cx /= 3; cy /= 3; cz /= 3;
    const inMouth = cx > 0.72 && Math.abs(cy) < 0.52 && Math.abs(cz) < 0.52;
    if (inMouth) continue;
    for (let offset = 0; offset < 3; offset++) {
      keptPositions.push(positions.getX(index + offset), positions.getY(index + offset), positions.getZ(index + offset));
      keptUvs.push(uvs.getX(index + offset), uvs.getY(index + offset));
    }
  }
  source.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(keptPositions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(keptUvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function terrainHeight(x, z, pools) {
  const broad = Math.sin(x * 0.031) * 0.22 + Math.cos(z * 0.025) * 0.19 + Math.sin((x + z) * 0.018) * 0.12;
  const compactedRoute = Math.exp(-Math.pow(x / 24, 2)) * (z > -125 && z < 220 ? -0.12 : 0);
  let height = broad + compactedRoute;
  for (const pool of pools) {
    const dx = x - pool.position[0];
    const dz = z - pool.position[2];
    const distance = Math.hypot(dx, dz);
    if (distance < pool.radius * 1.45) {
      const depth = pool.id.includes('deep') ? 4.2 : 1.1;
      const bowl = -depth * Math.pow(1 - distance / (pool.radius * 1.45), 2);
      height += bowl;
    }
  }
  return height;
}

function createTerrainGeometry(config, pools) {
  const geometry = new THREE.PlaneGeometry(config.map.width, config.map.depth, 78, 112);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const z = positions.getZ(index) - 15;
    positions.setZ(index, z);
    positions.setY(index, terrainHeight(x, z, pools));
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeLabelTexture(text, foreground = '#e7d99b', background = 'rgba(20,24,22,.84)') {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const context = canvas.getContext('2d');
  context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = foreground; context.lineWidth = 5; context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  context.fillStyle = foreground; context.font = '700 43px monospace'; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class LowtideMoon {
  constructor(options = {}) {
    if (!options.scene) throw new Error('createLowtideMoon requires a THREE.Scene');
    if (!options.assetLib) throw new Error('createLowtideMoon requires the existing AssetLib instance');
    this.scene = options.scene;
    this.renderer = options.renderer || null;
    this.lib = options.assetLib;
    this.sound = options.sound || null;
    this.config = cloneLowtideConfig(options.config || {});
    this.manageEnvironment = options.manageEnvironment !== false;
    this.root = new THREE.Group(); this.root.name = '14—LOWTIDE_EXTERIOR';
    this.staticRoot = new THREE.Group(); this.staticRoot.name = 'LOWTIDE_Static';
    this.breathRoot = new THREE.Group(); this.breathRoot.name = 'LOWTIDE_BreathingCreature';
    this.waterRoot = new THREE.Group(); this.waterRoot.name = 'LOWTIDE_TideWater';
    this.markerRoot = new THREE.Group(); this.markerRoot.name = 'LOWTIDE_DebugMarkers'; this.markerRoot.visible = false;
    this.testObjectRoot = new THREE.Group(); this.testObjectRoot.name = 'LOWTIDE_FloodTestObjects';
    this.root.add(this.staticRoot, this.breathRoot, this.waterRoot, this.markerRoot, this.testObjectRoot);
    this.scene.add(this.root);
    this.simulation = new LowtideSimulation({ config: this.config });
    this.staticEntries = [];
    this.dynamicEntries = [];
    this.colliders = [];
    this.testObjects = [];
    this.ownedGeometries = new Set();
    this.ownedMaterials = new Set();
    this.ownedTextures = new Set();
    this.audioHandles = new Set();
    this.unsubscribers = [];
    this.disposed = false;
    this.audioEnabled = false;
    this.audioGeneration = 0;
    this.breathElapsed = Infinity;
    this.eyeBlend = 0;
    this.poolVariant = 0;
    this._lastSnapshot = this.simulation.getSnapshot();
    this.previousEnvironment = { fog: this.scene.fog, background: this.scene.background };
    this.metadata = {
      id: this.config.id,
      displayName: this.config.displayName,
      exteriorOnly: true,
      engineTarget: 'portable-web-prototype',
      transforms: this.config.transforms,
      routes: this.config.routes,
      entrances: [
        { id: 'main-entrance', kind: 'main', ...this.config.transforms.mainEntrance },
        { id: 'fire-exit', kind: 'fire-exit', ...this.config.transforms.fireExit },
      ],
      spawnMarkers: this.config.spawnMarkers,
      floodedAreas: this.config.floodedAreas,
      audioZones: this.config.audioZones,
      routeTags: ['flats', 'anchor-chain', 'gullet'],
      integrationEvents: ['tide-state', 'tide-warning', 'cleanup', 'creature-breath', 'tide-withdrawn', 'eye-watch'],
    };
  }

  ownGeometry(geometry) { this.ownedGeometries.add(geometry); return geometry; }
  ownMaterial(material) { this.ownedMaterials.add(material); return material; }
  ownTexture(texture) { this.ownedTextures.add(texture); return texture; }

  addBox(parent, position, size, material, options = {}) {
    const geometry = options.geometry || this.unitBox;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = options.name || 'LOWTIDE_Box';
    mesh.position.fromArray(position);
    mesh.scale.fromArray(size);
    if (options.rotation) mesh.rotation.set(...options.rotation);
    mesh.castShadow = !!options.castShadow;
    mesh.receiveShadow = options.receiveShadow !== false;
    parent.add(mesh);
    mesh.updateMatrix();
    if (options.collision !== false) {
      const entries = parent === this.breathRoot ? this.dynamicEntries : this.staticEntries;
      entries.push({ geometry, matrix: mesh.matrix.clone() });
    }
    return mesh;
  }

  addCylinder(parent, position, radiusTop, radiusBottom, height, material, options = {}) {
    const geometry = this.ownGeometry(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, options.radialSegments || 10, 1, !!options.openEnded));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = options.name || 'LOWTIDE_Cylinder';
    mesh.position.fromArray(position);
    if (options.rotation) mesh.rotation.set(...options.rotation);
    if (options.scale) mesh.scale.fromArray(options.scale);
    mesh.castShadow = !!options.castShadow; mesh.receiveShadow = options.receiveShadow !== false;
    parent.add(mesh); mesh.updateMatrix();
    if (options.collision) {
      const entries = parent === this.breathRoot ? this.dynamicEntries : this.staticEntries;
      entries.push({ geometry, matrix: mesh.matrix.clone() });
    }
    return mesh;
  }

  async build() {
    this._createMaterials();
    this.unitBox = this.ownGeometry(new THREE.BoxGeometry(1, 1, 1));
    this._createEnvironment();
    this._createSeabed();
    this._createCreature();
    this._createResearchPlatform();
    this._createChainRoute();
    this._createTrawler();
    this._createLandingArea();
    this._createKelpAndDebris();
    this._createWater();
    this._createMarkers();
    this._createTestObjects();
    this.root.updateMatrixWorld(true);
    this.staticCollider = new Collider('lowtide-static').build(this.staticEntries, null);
    this.dynamicCollider = new Collider('lowtide-breathing-creature').build(this.dynamicEntries, this.breathRoot);
    this.colliders = [this.staticCollider, this.dynamicCollider];
    this._wireSimulation();
    await this._loadShipVisual();
    this.setPoolVariant(0);
    this.update(0, 0);
    return this;
  }

  _createMaterials() {
    const terrainMap = this.lib.texture('b19_750', 'color', [24, 34], [0, 0]);
    const terrainNormal = this.lib.texture('b19_757', 'normal', [24, 34], [0, 0]);
    this.materials = {
      sand: this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x6f7160, map: terrainMap, normalMap: terrainNormal, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.91, metalness: 0.03 })),
      body: this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x756f62, map: this.lib.texture('b19_555', 'color', [3, 1], [0, 0]), normalMap: this.lib.texture('b19_621', 'normal', [3, 1], [0, 0]), normalScale: new THREE.Vector2(0.38, 0.38), roughness: 0.9, metalness: 0.02 })),
      inner: this.ownMaterial(this.lib.material('b19_40').clone()),
      bone: this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xc3b99b, map: this.lib.texture('b8_322', 'color', [2, 1], [0, 0]), normalMap: this.lib.texture('b8_600', 'normal', [2, 1], [0, 0]), roughness: 0.86 })),
      rust: this.ownMaterial(this.lib.material('b19_207').clone()),
      chain: this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x624332, map: this.lib.texture('b19_396', 'color', [1, 1], [0, 0]), normalMap: this.lib.texture('b19_553', 'normal', [1, 1], [0, 0]), roughness: 0.74, metalness: 0.48 })),
      platform: this.ownMaterial(this.lib.material('b4_9').clone()),
      concrete: this.ownMaterial(this.lib.material('b8_103').clone()),
      door: this.ownMaterial(this.lib.material('b19_178').clone()),
      glass: this.ownMaterial(this.lib.material('b8_126').clone()),
      kelp: this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x26372b, roughness: 0.95, side: THREE.DoubleSide })),
      eyeWhite: this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x9a9b83, roughness: 0.42, metalness: 0.02 })),
      eyeBlack: this.ownMaterial(this.lib.material('b19_377').clone()),
      markerRoute: this.ownMaterial(new THREE.LineBasicMaterial({ color: 0x8ce6ff, transparent: true, opacity: 0.85, depthTest: false })),
      markerScrap: this.ownMaterial(new THREE.MeshBasicMaterial({ color: 0x55ff8b, wireframe: true, depthTest: false })),
      markerEnemy: this.ownMaterial(new THREE.MeshBasicMaterial({ color: 0xff4a4a, wireframe: true, depthTest: false })),
      markerHazard: this.ownMaterial(new THREE.MeshBasicMaterial({ color: 0xffd34a, wireframe: true, depthTest: false })),
      warning: this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xd4662a, emissive: 0xff3b00, emissiveIntensity: 1.6, roughness: 0.5 })),
    };
    this.materials.inner.color.set(0x321d1d);
    this.materials.inner.side = THREE.DoubleSide;
    this.materials.inner.roughness = 0.88;
    this.materials.rust.color.multiplyScalar(0.76);
    this.materials.chain.color.set(0x684a38);
    this.materials.chain.roughness = 0.93;
    this.materials.platform.color.multiplyScalar(0.58);
    this.materials.door.color.multiplyScalar(0.78);
    this.materials.glass.opacity = 0.34;
    this.materials.glass.transparent = true;
    this.materials.glass.depthWrite = false;
  }

  _createEnvironment() {
    const hemi = new THREE.HemisphereLight(0x9aa9a1, 0x201b18, 1.15);
    hemi.name = 'LOWTIDE_Hemisphere';
    const sun = new THREE.DirectionalLight(0xcfd8c8, 2.15);
    sun.name = 'LOWTIDE_OvercastSun'; sun.position.set(-95, 145, 80);
    sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -170; sun.shadow.camera.right = 170; sun.shadow.camera.top = 170; sun.shadow.camera.bottom = -170;
    sun.shadow.camera.near = 20; sun.shadow.camera.far = 480;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05;
    const ambient = new THREE.AmbientLight(0x39423e, 0.48); ambient.name = 'LOWTIDE_Ambient';
    this.root.add(hemi, sun, ambient);
    this.environmentLights = { hemi, sun, ambient };
    if (this.manageEnvironment) {
      this.scene.background = new THREE.Color(0x64716d);
      this.scene.fog = new THREE.FogExp2(0x64716d, 0.0032);
    }
  }

  _createSeabed() {
    const pools = [
      ...this.config.spawnMarkers.hazards,
      { id: 'shallow-01', position: [55, -0.4, 77], radius: 14 },
      { id: 'shallow-02', position: [-65, -0.4, 14], radius: 16 },
      { id: 'shallow-03', position: [48, -0.4, -78], radius: 12 },
    ];
    this.terrainGeometry = this.ownGeometry(createTerrainGeometry(this.config, pools));
    const terrain = new THREE.Mesh(this.terrainGeometry, this.materials.sand);
    terrain.name = 'LOWTIDE_ExposedSeabed'; terrain.receiveShadow = true;
    this.staticRoot.add(terrain);
    this.staticEntries.push({ geometry: this.terrainGeometry, matrix: new THREE.Matrix4() });
    this.terrain = terrain;

    const perimeterMaterial = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x343a35, roughness: 1 }));
    const backRidge = this.addBox(this.staticRoot, [0, 10, -286], [390, 22, 18], perimeterMaterial, { name: 'LOWTIDE_BackRidge', castShadow: false });
    backRidge.rotation.z = 0.015;
    this.addBox(this.staticRoot, [-191, 7, -15], [12, 17, 545], perimeterMaterial, { name: 'LOWTIDE_WestRidge' });
    this.addBox(this.staticRoot, [191, 7, -15], [12, 17, 545], perimeterMaterial, { name: 'LOWTIDE_EastRidge' });
  }

  _createCreature() {
    const bodyGeometry = this.ownGeometry(createOpenedBodyGeometry());
    const body = new THREE.Mesh(bodyGeometry, this.materials.body);
    body.name = 'LOWTIDE_StadiumCreature';
    body.position.set(0, 8, -170); body.scale.set(126, 30, 43);
    body.castShadow = true; body.receiveShadow = true;
    this.breathRoot.add(body); body.updateMatrix();
    this.dynamicEntries.push({ geometry: bodyGeometry, matrix: body.matrix.clone() });
    this.body = body;

    const ribGeometry = this.ownGeometry(new THREE.TorusGeometry(1, 0.055, 6, 18, Math.PI * 1.36));
    const ribs = new THREE.InstancedMesh(ribGeometry, this.materials.bone, 17);
    ribs.name = 'LOWTIDE_VisibleRibs'; ribs.castShadow = false; ribs.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < 17; index++) {
      const x = -91 + index * 11.4;
      const radius = 34 * Math.sqrt(Math.max(0.12, 1 - Math.pow(x / 122, 2)));
      const position = new THREE.Vector3(x, 11, -160.5);
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0.17));
      matrix.compose(position, quaternion, new THREE.Vector3(radius, radius * 0.76, radius));
      ribs.setMatrixAt(index, matrix);
    }
    this.breathRoot.add(ribs);

    const tunnelGeometry = this.ownGeometry(new THREE.CylinderGeometry(1, 1, 67, 18, 1, true));
    const tunnel = new THREE.Mesh(tunnelGeometry, this.materials.inner);
    tunnel.name = 'LOWTIDE_GulletCavity'; tunnel.position.set(87, 12.6, -170); tunnel.rotation.z = Math.PI / 2; tunnel.scale.set(9.7, 1, 13);
    tunnel.receiveShadow = true; this.breathRoot.add(tunnel); tunnel.updateMatrix();
    this.dynamicEntries.push({ geometry: tunnelGeometry, matrix: tunnel.matrix.clone() });
    this.gullet = tunnel;

    const gulletFloorMaterial = this.ownMaterial(this.materials.inner.clone());
    gulletFloorMaterial.color.set(0x4b3330);
    this.addBox(this.breathRoot, [87, 2.8, -170], [66, 1.1, 16], gulletFloorMaterial, { name: 'LOWTIDE_GulletFloor' });

    const innerRibGeometry = this.ownGeometry(new THREE.TorusGeometry(9.1, 0.42, 5, 12, Math.PI));
    for (let index = 0; index < 6; index++) {
      const rib = new THREE.Mesh(innerRibGeometry, this.materials.bone);
      rib.name = `LOWTIDE_GulletRib_${index + 1}`;
      rib.position.set(110 - index * 9.5, 4, -170);
      rib.rotation.set(0, Math.PI / 2, Math.PI / 2);
      rib.scale.y = 0.72;
      this.breathRoot.add(rib);
    }

    const toothGeometry = this.ownGeometry(new THREE.ConeGeometry(1.3, 6, 7));
    for (let index = 0; index < 10; index++) {
      const angle = (index / 10) * Math.PI * 2;
      const tooth = new THREE.Mesh(toothGeometry, this.materials.bone);
      tooth.name = `LOWTIDE_Tooth_${index + 1}`;
      tooth.position.set(120, 11 + Math.sin(angle) * 10, -170 + Math.cos(angle) * 14);
      tooth.rotation.z = Math.PI / 2 + Math.sin(angle) * 0.42;
      tooth.scale.setScalar(0.72 + (index % 3) * 0.1);
      this.breathRoot.add(tooth);
    }

    const eyeRoot = new THREE.Group(); eyeRoot.name = 'LOWTIDE_OpenEye'; eyeRoot.position.set(31, 15, -128.2);
    const scleraGeometry = this.ownGeometry(new THREE.SphereGeometry(1, 28, 16));
    const sclera = new THREE.Mesh(scleraGeometry, this.materials.eyeWhite); sclera.scale.set(12.5, 8.2, 3.2); sclera.castShadow = true;
    eyeRoot.add(sclera);
    const irisGeometry = this.ownGeometry(new THREE.CircleGeometry(4.6, 28));
    const irisMat = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x514a32, roughness: 0.34, metalness: 0.08 }));
    const iris = new THREE.Mesh(irisGeometry, irisMat); iris.position.z = 3.18;
    const pupilGeometry = this.ownGeometry(new THREE.CircleGeometry(2.15, 24));
    const pupil = new THREE.Mesh(pupilGeometry, this.materials.eyeBlack); pupil.position.z = 0.035;
    iris.add(pupil); eyeRoot.add(iris); this.breathRoot.add(eyeRoot);
    this.eyeRoot = eyeRoot; this.eyeIris = iris;
  }

  _createResearchPlatform() {
    this.addBox(this.breathRoot, [0, 40.5, -169], [72, 3, 46], this.materials.platform, { name: 'LOWTIDE_ResearchDeck', castShadow: true });
    this.addBox(this.breathRoot, [0, 45.5, -170], [30, 9, 22], this.materials.platform, { name: 'LOWTIDE_ResearchCabin', castShadow: true });
    this.addBox(this.breathRoot, [0, 45.4, -157.9], [9, 7.2, 1.2], this.materials.door, { name: 'LOWTIDE_MainEntrance', castShadow: true });
    for (const x of [-5.3, 5.3]) this.addBox(this.breathRoot, [x, 45.4, -157.15], [0.45, 7.6, 0.24], this.materials.warning, { name: 'LOWTIDE_EntranceWarningStripe', collision: false });
    const signTexture = this.ownTexture(makeLabelTexture('14 // LOWTIDE'));
    const signMaterial = this.ownMaterial(new THREE.MeshBasicMaterial({ map: signTexture, transparent: true }));
    const sign = new THREE.Mesh(this.ownGeometry(new THREE.PlaneGeometry(11, 2.75)), signMaterial);
    sign.name = 'LOWTIDE_MainEntranceSign'; sign.position.set(0, 50.4, -157.25);
    this.breathRoot.add(sign);

    for (const x of [-9.2, 9.2]) {
      this.addBox(this.breathRoot, [x, 47.2, -158.65], [5.2, 2.1, 0.18], this.materials.glass, { name: 'LOWTIDE_CabinWindow', collision: false });
      const lamp = new THREE.PointLight(0xe3b25c, 13, 18, 2); lamp.position.set(x, 47.3, -156.8); lamp.name = 'LOWTIDE_CabinLamp'; this.breathRoot.add(lamp);
    }

    this.addBox(this.breathRoot, [56.5, 6.5, -170], [1.2, 7.2, 7.5], this.materials.door, { name: 'LOWTIDE_FireExit', castShadow: false });
    const fireSignTexture = this.ownTexture(makeLabelTexture('FIRE EXIT // SEALED', '#d7b6a0', 'rgba(39,17,14,.9)'));
    const fireSignMaterial = this.ownMaterial(new THREE.SpriteMaterial({ map: fireSignTexture, transparent: true, depthTest: false }));
    const fireSign = new THREE.Sprite(fireSignMaterial); fireSign.name = 'LOWTIDE_FireExitSign'; fireSign.position.set(58, 10.8, -170); fireSign.scale.set(8, 2, 1); this.breathRoot.add(fireSign);

    const stepCount = 24;
    for (let index = 0; index < stepCount; index++) {
      const t = index / (stepCount - 1);
      this.addBox(
        this.breathRoot,
        [0, 1.05 + t * 38.3, -108 - t * 37],
        [9, 1.55, 3.1],
        this.materials.rust,
        { name: `LOWTIDE_FlankStep_${index + 1}`, castShadow: false },
      );
    }
    for (const x of [-5.2, 5.2]) {
      this.addBox(this.breathRoot, [x, 18, -132], [0.32, 1.2, 59], this.materials.chain, { name: 'LOWTIDE_StairRail', rotation: [-0.6, 0, 0], collision: false });
    }

    for (const x of [-32, 32]) {
      for (const z of [-188, -150]) this.addBox(this.breathRoot, [x, 46, z], [0.35, 9, 0.35], this.materials.rust, { name: 'LOWTIDE_DeckRailPost', collision: false });
    }
    this.addBox(this.breathRoot, [0, 50.2, -188], [65, 0.35, 0.35], this.materials.rust, { name: 'LOWTIDE_DeckRail', collision: false });

    for (const x of [-27, 27]) for (const z of [-183, -155]) this.addBox(this.breathRoot, [x, 37.4, z], [1.2, 7, 1.2], this.materials.rust, { name: 'LOWTIDE_PlatformBoltLeg', castShadow: false });

    this.addCylinder(this.breathRoot, [0, 53.5, -169], 0.45, 0.7, 16, this.materials.rust, { name: 'LOWTIDE_HornMast', radialSegments: 8, castShadow: true });
    const horn = this.addCylinder(this.breathRoot, [0, 59.2, -166.2], 2.2, 0.6, 5.5, this.materials.rust, { name: 'LOWTIDE_PlatformHorn', radialSegments: 10, openEnded: true, rotation: [Math.PI / 2, 0, 0] });
    this.horn = horn;
    const warningLight = new THREE.PointLight(0xff4b19, 0, 55, 2); warningLight.position.set(0, 58, -166); warningLight.name = 'LOWTIDE_WarningBeacon';
    this.breathRoot.add(warningLight); this.warningLight = warningLight;
  }

  _createChainRoute() {
    const route = this.config.routes.find(item => item.id === 'anchor-chain');
    const points3 = route.points.map((point, index) => {
      const t = index / (route.points.length - 1);
      return [point[0], 8.2 + t * 33.4, point[1]];
    });
    for (let index = 0; index < points3.length - 1; index++) {
      const matrix = segmentMatrix(points3[index], points3[index + 1], route.width, 0.55);
      const beam = new THREE.Mesh(this.unitBox, this.materials.chain);
      beam.name = `LOWTIDE_ChainWalkSurface_${index + 1}`; beam.applyMatrix4(matrix); beam.receiveShadow = true;
      this.staticRoot.add(beam);
      this.staticEntries.push({ geometry: this.unitBox, matrix });
    }

    const samples = [];
    for (let segment = 0; segment < points3.length - 1; segment++) {
      const a = new THREE.Vector3(...points3[segment]); const b = new THREE.Vector3(...points3[segment + 1]);
      const distance = a.distanceTo(b); const count = Math.max(2, Math.ceil(distance / 6.2));
      for (let index = 0; index < count; index++) samples.push(a.clone().lerp(b, index / count));
    }
    samples.push(new THREE.Vector3(...points3.at(-1)));
    const linkGeometry = this.ownGeometry(new THREE.TorusGeometry(2.2, 0.58, 6, 10));
    const links = new THREE.InstancedMesh(linkGeometry, this.materials.chain, samples.length);
    links.name = 'LOWTIDE_AnchorChainLinks'; links.castShadow = false; links.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < samples.length; index++) {
      const previous = samples[Math.max(0, index - 1)]; const next = samples[Math.min(samples.length - 1, index + 1)];
      const tangent = next.clone().sub(previous).normalize();
      const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), tangent);
      quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(tangent, index % 2 ? Math.PI / 2 : 0));
      matrix.compose(samples[index].clone().add(new THREE.Vector3(0, 0.48, 0)), quaternion, new THREE.Vector3(1.25, 0.8, 1));
      links.setMatrixAt(index, matrix);
    }
    this.staticRoot.add(links); this.chain = links;
  }

  _createTrawler() {
    const hull = this.addBox(this.staticRoot, [-105, 4.4, 151], [42, 7.5, 17], this.materials.rust, { name: 'LOWTIDE_WreckedTrawlerHull', rotation: [0.06, 0.14, -0.12], castShadow: true });
    hull.geometry.computeBoundingBox();
    this.addBox(this.staticRoot, [-109, 10.1, 154], [17, 5.5, 12], this.materials.rust, { name: 'LOWTIDE_TrawlerCabin', rotation: [0.04, 0.14, -0.12], castShadow: true });
    this.addBox(this.staticRoot, [-105, 13.8, 154], [0.6, 10, 0.6], this.materials.rust, { name: 'LOWTIDE_TrawlerMast', rotation: [0, 0, -0.18] });
    this.addBox(this.staticRoot, [-99, 12.2, 149], [12, 0.45, 0.45], this.materials.chain, { name: 'LOWTIDE_TrawlerBoom', rotation: [0, 0.2, -0.15], collision: false });
    const windowMat = this.materials.glass;
    for (const x of [-113, -108, -103]) this.addBox(this.staticRoot, [x, 10.8, 147.7], [3.2, 1.8, 0.2], windowMat, { name: 'LOWTIDE_TrawlerWindow', collision: false });
  }

  _createLandingArea() {
    this.addBox(this.staticRoot, [18, 0.4, 224], [28, 0.7, 25], this.materials.concrete, { name: 'LOWTIDE_ShipLandingSlab', receiveShadow: true });
    this.addBox(this.staticRoot, [0, 0.55, 205], [6, 1, 4], this.materials.platform, { name: 'LOWTIDE_PlayerSpawnPad', receiveShadow: true });
    const beaconPole = this.addCylinder(this.staticRoot, [42, 5, 218], 0.25, 0.3, 9, this.materials.rust, { name: 'LOWTIDE_ShipBeaconPole', radialSegments: 7 });
    beaconPole.castShadow = false;
    const beacon = new THREE.PointLight(0xe5a63b, 34, 45, 2); beacon.position.set(42, 9.8, 218); beacon.name = 'LOWTIDE_ShipBeacon';
    this.staticRoot.add(beacon);
  }

  _createKelpAndDebris() {
    const random = seededRandom(1409);
    const kelpGeometry = this.ownGeometry(new THREE.PlaneGeometry(0.9, 5.8, 1, 4));
    const positions = kelpGeometry.attributes.position;
    for (let index = 0; index < positions.count; index++) {
      const y = positions.getY(index) + 2.9;
      positions.setX(index, positions.getX(index) + Math.sin(y * 1.8) * 0.45);
      positions.setY(index, y);
    }
    positions.needsUpdate = true; kelpGeometry.computeVertexNormals();
    const kelpCount = 190;
    const kelp = new THREE.InstancedMesh(kelpGeometry, this.materials.kelp, kelpCount);
    kelp.name = 'LOWTIDE_DyingKelp'; kelp.castShadow = false; kelp.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < kelpCount; index++) {
      let x; let z;
      do { x = (random() - 0.5) * 340; z = -110 + random() * 345; } while (Math.abs(x) < 19 && z > -110);
      const y = terrainHeight(x, z, this.config.spawnMarkers.hazards);
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, random() * Math.PI * 2, (random() - 0.5) * 0.42));
      const scale = 0.45 + random() * 0.8;
      matrix.compose(new THREE.Vector3(x, y, z), quaternion, new THREE.Vector3(scale, scale, scale));
      kelp.setMatrixAt(index, matrix);
    }
    this.staticRoot.add(kelp);

    const debrisGeometry = this.unitBox;
    const debrisCount = 34;
    const debris = new THREE.InstancedMesh(debrisGeometry, this.materials.rust, debrisCount);
    debris.name = 'LOWTIDE_StrandedMarineDebris'; debris.castShadow = false; debris.receiveShadow = true;
    for (let index = 0; index < debrisCount; index++) {
      const x = (random() - 0.5) * 320; const z = -85 + random() * 300;
      const y = terrainHeight(x, z, this.config.spawnMarkers.hazards) + 0.3;
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 0.8, random() * Math.PI, random() * 0.8));
      matrix.compose(new THREE.Vector3(x, y, z), quaternion, new THREE.Vector3(0.5 + random() * 2.4, 0.15 + random() * 0.45, 0.3 + random() * 1.5));
      debris.setMatrixAt(index, matrix);
    }
    this.staticRoot.add(debris);
  }

  _createWater() {
    const waterGeometry = this.ownGeometry(new THREE.PlaneGeometry(this.config.map.width + 50, this.config.map.depth + 80, 28, 38));
    const waterMaterial = this.ownMaterial(new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0.7 },
        uColorShallow: { value: new THREE.Color(0x496b69) },
        uColorDeep: { value: new THREE.Color(0x203f43) },
      },
      vertexShader: `
        uniform float uTime;
        varying float vWave;
        void main() {
          vec3 p = position;
          float wave = sin(p.x * .10 + uTime * .8) * .09 + cos(p.y * .08 - uTime * .55) * .07;
          p.z += wave;
          vWave = wave;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        uniform vec3 uColorShallow;
        uniform vec3 uColorDeep;
        varying float vWave;
        void main() {
          vec3 color = mix(uColorDeep, uColorShallow, clamp(vWave * 4.0 + .55, 0.0, 1.0));
          gl_FragColor = vec4(color, uOpacity);
        }
      `,
    }));
    const tide = new THREE.Mesh(waterGeometry, waterMaterial);
    tide.name = 'LOWTIDE_ReturningTide'; tide.rotation.x = -Math.PI / 2; tide.renderOrder = 3;
    this.waterRoot.add(tide); this.tideMesh = tide; this.waterMaterial = waterMaterial;

    const foamGeometry = this.ownGeometry(new THREE.PlaneGeometry(this.config.map.width + 40, 1.2, 30, 1));
    const foamMaterial = this.ownMaterial(new THREE.MeshBasicMaterial({ color: 0x9cafaa, transparent: true, opacity: 0.32, depthWrite: false }));
    const foam = new THREE.Mesh(foamGeometry, foamMaterial); foam.name = 'LOWTIDE_VisibleWaterline'; foam.rotation.x = -Math.PI / 2; foam.renderOrder = 4;
    this.waterRoot.add(foam); this.foam = foam;

    this.poolVariants = [
      [[-33, 83, 10], [28, -18, 9], [-20, -76, 8], [55, 77, 14], [-65, 14, 16], [48, -78, 12]],
      [[-33, 83, 10], [28, -18, 9], [-20, -76, 8], [69, 55, 12], [-51, 35, 18], [31, -91, 10], [78, 128, 8]],
      [[-33, 83, 10], [28, -18, 9], [-20, -76, 8], [46, 96, 17], [-73, -8, 13], [61, -61, 15], [-18, 141, 9]],
    ];
    this.poolGroups = this.poolVariants.map((variant, variantIndex) => {
      const group = new THREE.Group(); group.name = `LOWTIDE_TidePools_Variant_${variantIndex}`;
      for (const [x, z, radius] of variant) {
        const geometry = this.ownGeometry(new THREE.CircleGeometry(radius, 26));
        const mesh = new THREE.Mesh(geometry, waterMaterial); mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, -0.72, z); mesh.renderOrder = 2; group.add(mesh);
      }
      this.waterRoot.add(group); return group;
    });
  }

  _createMarkers() {
    const markerGeometry = this.ownGeometry(new THREE.SphereGeometry(0.7, 8, 6));
    for (const route of this.config.routes) {
      const points = route.points.map(([x, z]) => new THREE.Vector3(x, 2.2, z));
      const lineGeometry = this.ownGeometry(new THREE.BufferGeometry().setFromPoints(points));
      const line = new THREE.Line(lineGeometry, this.materials.markerRoute); line.name = `ROUTE_${route.id}`; line.renderOrder = 20;
      this.markerRoot.add(line);
    }
    const addMarkers = (items, material, prefix) => {
      for (const item of items) {
        const marker = new THREE.Mesh(markerGeometry, material); marker.position.fromArray(item.position); marker.position.y += 1.2;
        marker.name = `${prefix}_${item.id}`; marker.renderOrder = 20; this.markerRoot.add(marker);
      }
    };
    addMarkers(this.config.spawnMarkers.scrap, this.materials.markerScrap, 'SCRAP');
    addMarkers(this.config.spawnMarkers.enemies, this.materials.markerEnemy, 'ENEMY');
    addMarkers(this.config.spawnMarkers.hazards, this.materials.markerHazard, 'HAZARD');
    for (const volume of this.config.floodedAreas.filter(item => item.tags.includes('cleanup'))) {
      const min = new THREE.Vector3(...volume.min); const max = new THREE.Vector3(...volume.max);
      const helper = new THREE.Box3Helper(new THREE.Box3(min, max), 0xffc64a); helper.name = `VOLUME_${volume.id}`;
      this.markerRoot.add(helper);
    }
  }

  _createTestObjects() {
    this.testCrateGeometry = this.ownGeometry(new THREE.BoxGeometry(1.5, 1.5, 1.5));
    this.testCrateMaterial = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xf1b730, emissive: 0x5a2d00, emissiveIntensity: 0.35, roughness: 0.72 }));
    this.spawnTestObject(new THREE.Vector3(15, 1.25, 44), 'FLOOD TEST A');
    this.spawnTestObject(new THREE.Vector3(91, 4.2, -169), 'FLOOD TEST B');
    this.spawnTestObject(new THREE.Vector3(-105, 15, 150), 'SAFE TEST');
  }

  spawnTestObject(position, label = `FLOOD TEST ${this.testObjects.length + 1}`) {
    const root = new THREE.Group(); root.name = `LOWTIDE_${label.replaceAll(' ', '_')}`; root.position.copy(position);
    const crate = new THREE.Mesh(this.testCrateGeometry, this.testCrateMaterial); crate.castShadow = false; crate.receiveShadow = true; root.add(crate);
    const texture = this.ownTexture(makeLabelTexture(label, '#1b1d1a', '#e4ad2e'));
    const material = this.ownMaterial(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    const sprite = new THREE.Sprite(material); sprite.scale.set(5.5, 1.35, 1); sprite.position.y = 2.1; root.add(sprite);
    this.testObjectRoot.add(root);
    const record = { id: `test-object-${Date.now()}-${this.testObjects.length}`, root, position: root.position, label };
    this.testObjects.push(record);
    return record;
  }

  _wireSimulation() {
    this.unsubscribers.push(
      this.simulation.on('tide-warning', event => this._onTideWarning(event)),
      this.simulation.on('creature-breath', event => this._onCreatureBreath(event)),
      this.simulation.on('cleanup', event => this._cleanupFloodedObjects(event)),
      this.simulation.on('tide-withdrawn', event => this.setPoolVariant(event.poolVariant)),
    );
  }

  async _loadShipVisual() {
    try {
      const manifest = await this.lib.manifest('scenes/ship.json');
      if (this.disposed) return;
      const instance = await this.lib.instantiate(manifest, { lights: false });
      if (this.disposed) return;
      const anchor = new THREE.Group(); anchor.name = 'LOWTIDE_LandedShipAsset';
      anchor.position.fromArray(this.config.transforms.shipLanding.position); anchor.rotation.y = this.config.transforms.shipLanding.yaw;
      instance.root.position.set(0, 0, 0); anchor.add(instance.root); this.staticRoot.add(anchor);
      this.shipAsset = { anchor, instance };
    } catch (error) {
      console.warn('LOWTIDE ship asset unavailable; landing transform remains valid.', error);
    }
  }

  _onTideWarning() {
    if (this.audioEnabled) this._playClip('b19_2441', { pos: new THREE.Vector3(0, 59 + this.breathRoot.position.y, -166), vol: 0.9, min: 8, max: 330 });
  }

  _onCreatureBreath() {
    this.breathElapsed = 0;
    if (this.audioEnabled) {
      this._playClip('b19_2048', { pos: new THREE.Vector3(0, 13, -145), vol: 0.86, min: 12, max: 360, pitch: 0.72 });
      this._playClip('b4_91', { pos: new THREE.Vector3(0, 7, -170), vol: 0.66, min: 10, max: 300, pitch: 0.62 });
    }
  }

  _cleanupFloodedObjects() {
    const cleanupVolumes = this.config.floodedAreas.filter(area => area.tags.includes('cleanup'));
    const removed = [];
    this.testObjects = this.testObjects.filter(object => {
      const world = object.root.getWorldPosition(new THREE.Vector3());
      const shouldRemove = cleanupVolumes.some(volume => pointInBox(world, volume)) && world.y < this.config.tide.highLevel + 0.5;
      if (shouldRemove) { object.root.removeFromParent(); removed.push(object.id); }
      return !shouldRemove;
    });
    if (removed.length) this.simulation.emit('objects-removed', { ids: removed });
  }

  async _playClip(clip, options) {
    if (!this.sound || !clip || this.disposed) return null;
    const generation = this.audioGeneration;
    const handle = await this.sound.play(clip, options);
    if (!handle) return null;
    if (this.disposed || generation !== this.audioGeneration || !this.audioEnabled) { handle.stop(); return null; }
    this.audioHandles.add(handle);
    return handle;
  }

  enableAudio() {
    if (this.audioEnabled || !this.sound) return;
    this.audioEnabled = true; this.audioGeneration++;
    this.sound.resume();
    this._playClip('b8_1520', { loop: true, vol: 0.24, pitch: 0.86 });
    this._playClip('b8_1717', { pos: new THREE.Vector3(84, 8, -170), loop: true, vol: 0.22, min: 5, max: 52, lowpass: 1250 });
  }

  disableAudio() {
    this.audioEnabled = false; this.audioGeneration++;
    for (const handle of this.audioHandles) handle.stop(0.3);
    this.audioHandles.clear();
  }

  playFootstep(surface = 'wet-sand', position = null) {
    if (!this.audioEnabled) return;
    const clips = surface === 'chain'
      ? ['b8_1738', 'b8_1769', 'b8_1673', 'b8_1708', 'b8_1686']
      : ['b8_1509', 'b8_1802', 'b8_1527', 'b8_1704'];
    const clip = clips[Math.floor(Math.random() * clips.length)];
    this._playClip(clip, { pos: position, vol: surface === 'chain' ? 0.38 : 0.23, min: 1.2, max: 24, pitch: 0.95 + Math.random() * 0.1 });
  }

  playSplash(position = null) {
    if (!this.audioEnabled) return;
    const clips = ['b8_1614', 'b8_1718', 'b8_1478', 'b8_1641', 'b8_1685'];
    this._playClip(clips[Math.floor(Math.random() * clips.length)], { pos: position, vol: 0.55, min: 1.5, max: 38 });
  }

  triggerBreath() {
    this.simulation.emit('creature-breath', { tideIndex: -1, liftMetres: this.config.breath.liftMetres, alertTag: 'eyeless-dog-compatible', manual: true });
  }

  setPoolVariant(index) {
    this.poolVariant = ((index % this.poolGroups.length) + this.poolGroups.length) % this.poolGroups.length;
    this.poolGroups.forEach((group, groupIndex) => { group.visible = groupIndex === this.poolVariant; });
  }

  setDebugVisible(visible) { this.markerRoot.visible = !!visible; }

  forceTideState(state) { return this.simulation.forceState(state); }
  resumeTideTimeline() { return this.simulation.forceState(null); }
  setEyeWatching(value = null) { return this.simulation.setEyeWatching(value); }
  on(type, listener) { return this.simulation.on(type, listener); }
  getRuntimeState() { return this.simulation.serialize(); }
  restoreRuntimeState(state) { const snapshot = this.simulation.restore(state); this.setPoolVariant(snapshot.poolVariant); return snapshot; }

  getWaterFrontZ(snapshot = this._lastSnapshot) {
    const min = this.config.map.minZ - 30;
    const span = this.config.map.depth + 60;
    return min + span * snapshot.coverage;
  }

  checkPlayerHazard(position) {
    if (position.y < -9 || position.x < this.config.map.minX - 4 || position.x > this.config.map.maxX + 4 || position.z < this.config.map.minZ - 4 || position.z > this.config.map.maxZ + 4) return 'void';
    for (const pool of this.config.spawnMarkers.hazards) {
      if (Math.hypot(position.x - pool.position[0], position.z - pool.position[2]) < pool.radius && position.y < -0.25) return 'deep-tide-pool';
    }
    const snapshot = this._lastSnapshot;
    if (snapshot.coverage > 0.02 && position.z <= this.getWaterFrontZ(snapshot) + 2 && position.y < snapshot.waterLevel - 0.5) return 'returning-tide';
    return null;
  }

  surfaceAt(position) {
    const route = this.config.routes.find(item => item.id === 'anchor-chain');
    for (let index = 0; index < route.points.length - 1; index++) {
      const a = new THREE.Vector2(...route.points[index]); const b = new THREE.Vector2(...route.points[index + 1]);
      const p = new THREE.Vector2(position.x, position.z);
      const line = b.clone().sub(a); const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(line) / line.lengthSq()));
      if (p.distanceTo(a.addScaledVector(line, t)) < 3.4) return 'chain';
    }
    if (position.x > 52 && position.z < -150 && position.z > -188) return 'gullet';
    return 'wet-sand';
  }

  update(deltaTime, gameTime = null) {
    const snapshot = this.simulation.update(deltaTime, gameTime);
    this._lastSnapshot = snapshot;
    const tideDepth = this.config.map.depth + 80;
    const visibleDepth = Math.max(0.01, tideDepth * snapshot.coverage);
    this.tideMesh.visible = snapshot.coverage > 0.008;
    this.foam.visible = snapshot.coverage > 0.008 && snapshot.coverage < 0.995;
    this.tideMesh.scale.y = Math.max(0.001, snapshot.coverage);
    this.tideMesh.position.set(0, snapshot.waterLevel, this.config.map.minZ - 30 + visibleDepth / 2);
    this.foam.position.set(0, snapshot.waterLevel + 0.08, this.getWaterFrontZ(snapshot));
    this.waterMaterial.uniforms.uTime.value += Math.max(0, deltaTime);
    this.waterMaterial.uniforms.uOpacity.value = 0.56 + snapshot.coverage * 0.18;

    const warningPulse = snapshot.state === 'warning' ? 0.5 + Math.sin(snapshot.gameTime * 5.2) * 0.5 : 0;
    this.warningLight.intensity = warningPulse * 75;

    const breath = this.config.breath;
    const totalBreath = breath.riseSeconds + breath.holdSeconds + breath.settleSeconds;
    this.breathElapsed += Math.max(0, deltaTime);
    let lift = 0;
    if (this.breathElapsed < breath.riseSeconds) lift = breath.liftMetres * smoothstep(this.breathElapsed / breath.riseSeconds);
    else if (this.breathElapsed < breath.riseSeconds + breath.holdSeconds) lift = breath.liftMetres;
    else if (this.breathElapsed < totalBreath) lift = breath.liftMetres * (1 - smoothstep((this.breathElapsed - breath.riseSeconds - breath.holdSeconds) / breath.settleSeconds));
    this.breathRoot.position.y = lift;
    this.breathRoot.updateMatrixWorld(true);

    const eyeTarget = snapshot.eyeWatching ? 1 : 0;
    this.eyeBlend += (eyeTarget - this.eyeBlend) * Math.min(1, deltaTime * 0.72);
    this.eyeIris.position.x = THREE.MathUtils.lerp(0, -3.6, this.eyeBlend);
    this.eyeIris.position.y = THREE.MathUtils.lerp(0, 2.6, this.eyeBlend);
    this.eyeIris.position.z = 3.18 + Math.sin(this.eyeBlend * Math.PI) * 0.12;

    if (this.manageEnvironment && this.scene.fog) {
      const flooded = snapshot.state === 'incoming' || snapshot.state === 'high' || snapshot.state === 'outgoing';
      const color = new THREE.Color(flooded ? 0x526763 : 0x64716d);
      this.scene.fog.color.lerp(color, Math.min(1, deltaTime * 1.2));
      this.scene.fog.density += ((flooded ? 0.004 : 0.0032) - this.scene.fog.density) * Math.min(1, deltaTime * 0.8);
      if (this.scene.background?.isColor) this.scene.background.lerp(color, Math.min(1, deltaTime * 0.8));
      this.environmentLights.hemi.intensity += ((flooded ? 0.88 : 1.15) - this.environmentLights.hemi.intensity) * Math.min(1, deltaTime);
    }
    return snapshot;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disableAudio();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.simulation.dispose();
    for (const collider of this.colliders) collider.dispose();
    this.colliders.length = 0;
    this.root.removeFromParent();
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    for (const texture of this.ownedTextures) texture.dispose();
    this.ownedGeometries.clear(); this.ownedMaterials.clear(); this.ownedTextures.clear();
    if (this.manageEnvironment) {
      this.scene.fog = this.previousEnvironment.fog;
      this.scene.background = this.previousEnvironment.background;
    }
  }
}

export async function createLowtideMoon(options) {
  const moon = new LowtideMoon(options);
  return moon.build();
}

export function updateLowtideMoon(moon, deltaTime, gameTime = null) {
  return moon.update(deltaTime, gameTime);
}

export function disposeLowtideMoon(moon) {
  return moon.dispose();
}

export { LOWTIDE_CONFIG };
