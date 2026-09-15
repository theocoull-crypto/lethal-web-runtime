export const LOWTIDE_STATES = Object.freeze([
  'dry',
  'warning',
  'incoming',
  'high',
  'outgoing',
  'dry-after-tide',
]);

export const LOWTIDE_CONFIG = Object.freeze({
  id: '14-lowtide',
  displayName: '14—LOWTIDE',
  daySeconds: 780,
  startHour: 8,
  endHour: 24,
  tide: Object.freeze({
    lowLevel: -2.4,
    highLevel: 6.5,
    warningDuration: 12,
    incomingDuration: 18,
    highDuration: 32.5,
    outgoingDuration: 18,
    // Fractions of the 13-minute working day at which each warning begins.
    schedule: Object.freeze([0.18, 0.48, 0.76]),
    poolVariantCount: 3,
  }),
  breath: Object.freeze({
    liftMetres: 4,
    riseSeconds: 2.8,
    holdSeconds: 1.2,
    settleSeconds: 5.5,
  }),
  map: Object.freeze({
    width: 390,
    depth: 560,
    minX: -195,
    maxX: 195,
    minZ: -295,
    maxZ: 265,
  }),
  transforms: Object.freeze({
    playerSpawn: Object.freeze({ position: Object.freeze([0, 2.2, 205]), yaw: 0 }),
    shipLanding: Object.freeze({ position: Object.freeze([18, 0.25, 224]), yaw: Math.PI }),
    mainEntrance: Object.freeze({ position: Object.freeze([0, 45.4, -157]), yaw: 0, sealed: true }),
    fireExit: Object.freeze({ position: Object.freeze([57, 6.5, -170]), yaw: -Math.PI / 2, sealed: true }),
  }),
  routes: Object.freeze([
    Object.freeze({
      id: 'flats',
      label: 'THE FLATS',
      width: 34,
      floodPriority: 1,
      twoHandedTurningAllowed: true,
      points: Object.freeze([[0, 205], [2, 125], [-3, 40], [0, -55], [0, -112], [0, -145]]),
    }),
    Object.freeze({
      id: 'anchor-chain',
      label: 'ANCHOR CHAIN',
      width: 2.8,
      floodPriority: 0,
      twoHandedTurningAllowed: false,
      points: Object.freeze([[-104, 154], [-88, 92], [-70, 28], [-53, -42], [-38, -104], [-29, -147]]),
    }),
    Object.freeze({
      id: 'gullet',
      label: 'THE GULLET',
      width: 9,
      floodPriority: 2,
      twoHandedTurningAllowed: true,
      points: Object.freeze([[0, 205], [54, 120], [96, 12], [127, -126], [117, -170], [57, -170]]),
    }),
  ]),
  spawnMarkers: Object.freeze({
    scrap: Object.freeze([
      Object.freeze({ id: 'gullet-scrap-01', position: Object.freeze([105, 4.1, -168]), tags: Object.freeze(['gullet', 'flood-risk']) }),
      Object.freeze({ id: 'gullet-scrap-02', position: Object.freeze([92, 4.1, -173]), tags: Object.freeze(['gullet', 'flood-risk']) }),
      Object.freeze({ id: 'gullet-scrap-03', position: Object.freeze([77, 4.1, -166]), tags: Object.freeze(['gullet', 'flood-risk']) }),
      Object.freeze({ id: 'flats-scrap-01', position: Object.freeze([22, 0.5, 26]), tags: Object.freeze(['flats', 'flood-risk']) }),
      Object.freeze({ id: 'trawler-scrap-01', position: Object.freeze([-107, 6, 143]), tags: Object.freeze(['trawler', 'elevated']) }),
    ]),
    enemies: Object.freeze([
      Object.freeze({ id: 'dog-01', type: 'eyeless-dog-compatible', position: Object.freeze([-142, 1, 14]), tags: Object.freeze(['outside', 'land-only']) }),
      Object.freeze({ id: 'dog-02', type: 'eyeless-dog-compatible', position: Object.freeze([145, 1, 58]), tags: Object.freeze(['outside', 'land-only']) }),
      Object.freeze({ id: 'dog-03', type: 'eyeless-dog-compatible', position: Object.freeze([-125, 1, -83]), tags: Object.freeze(['outside', 'land-only']) }),
    ]),
    hazards: Object.freeze([
      Object.freeze({ id: 'pool-deep-west', type: 'deep-tide-pool', position: Object.freeze([-33, -1.4, 83]), radius: 10 }),
      Object.freeze({ id: 'pool-deep-east', type: 'deep-tide-pool', position: Object.freeze([28, -1.4, -18]), radius: 9 }),
      Object.freeze({ id: 'pool-deep-north', type: 'deep-tide-pool', position: Object.freeze([-20, -1.4, -76]), radius: 8 }),
    ]),
  }),
  floodedAreas: Object.freeze([
    Object.freeze({ id: 'flats-flood-zone', min: Object.freeze([-92, -8, -138]), max: Object.freeze([92, 8, 218]), tags: Object.freeze(['cleanup', 'water-danger']) }),
    Object.freeze({ id: 'gullet-flood-zone', min: Object.freeze([50, -5, -187]), max: Object.freeze([132, 9, -152]), tags: Object.freeze(['cleanup', 'water-danger', 'fire-exit-route']) }),
    Object.freeze({ id: 'outer-seabed-flood-zone', min: Object.freeze([-195, -8, -295]), max: Object.freeze([195, 7, 265]), tags: Object.freeze(['water-danger']) }),
  ]),
  audioZones: Object.freeze([
    Object.freeze({ id: 'platform-horn', position: Object.freeze([0, 59, -166]), radius: 280, clip: 'b19_2441', assetName: 'AirHornFar' }),
    Object.freeze({ id: 'wind', position: Object.freeze([0, 8, 20]), radius: 500, clip: 'b8_1520', assetName: 'v50ShipWind' }),
    Object.freeze({ id: 'gullet-ambience', position: Object.freeze([83, 7, -170]), radius: 50, clip: 'b8_1717', assetName: 'DarkAmbianceNonDiagetic' }),
    Object.freeze({ id: 'creature-breath', position: Object.freeze([0, 12, -170]), radius: 350, clip: 'b19_2048', assetName: 'Breathe1' }),
  ]),
});

export function cloneLowtideConfig(overrides = {}) {
  return {
    ...LOWTIDE_CONFIG,
    ...overrides,
    tide: { ...LOWTIDE_CONFIG.tide, ...(overrides.tide || {}) },
    breath: { ...LOWTIDE_CONFIG.breath, ...(overrides.breath || {}) },
    map: { ...LOWTIDE_CONFIG.map, ...(overrides.map || {}) },
    transforms: { ...LOWTIDE_CONFIG.transforms, ...(overrides.transforms || {}) },
  };
}
