import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LOWTIDE_CONFIG } from '../config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '../../../..');

test('LOWTIDE remains absent from the existing game and moon rotation', () => {
  for (const relative of ['js/main.js', 'js/world.js', 'js/terminal.js', 'index.html']) {
    const source = readFileSync(resolve(project, relative), 'utf8');
    assert.doesNotMatch(source, /lowtide/i, `${relative} must not integrate LOWTIDE`);
  }
});

test('public module exposes the standalone lifecycle contract', () => {
  const source = readFileSync(resolve(project, 'js/moons/lowtide/lowtide-moon.mjs'), 'utf8');
  for (const name of ['createLowtideMoon', 'updateLowtideMoon', 'disposeLowtideMoon', 'getRuntimeState', 'restoreRuntimeState']) {
    assert.match(source, new RegExp(`\\b${name}\\b`));
  }
});

test('metadata declares the three routes and sealed exterior entrances', () => {
  assert.deepEqual(LOWTIDE_CONFIG.routes.map(route => route.id), ['flats', 'anchor-chain', 'gullet']);
  const chain = LOWTIDE_CONFIG.routes.find(route => route.id === 'anchor-chain');
  assert.equal(chain.twoHandedTurningAllowed, false);
  assert.ok(chain.width < 3);
  assert.equal(LOWTIDE_CONFIG.transforms.mainEntrance.sealed, true);
  assert.equal(LOWTIDE_CONFIG.transforms.fireExit.sealed, true);
});

test('all referenced Lethal Company audio clips are already bundled', () => {
  const ids = new Set(LOWTIDE_CONFIG.audioZones.map(zone => zone.clip));
  for (const id of ids) assert.equal(existsSync(resolve(project, `assets/audio/${id}.ogg`)), true, `${id}.ogg is missing`);
});

test('enemy metadata is integration-only and uses the dog compatibility tag', () => {
  assert.ok(LOWTIDE_CONFIG.spawnMarkers.enemies.length >= 1);
  for (const marker of LOWTIDE_CONFIG.spawnMarkers.enemies) assert.equal(marker.type, 'eyeless-dog-compatible');
});

test('the standalone page is the only HTML entry for the prototype', () => {
  assert.equal(existsSync(resolve(project, 'lowtide/index.html')), true);
  const page = readFileSync(resolve(project, 'lowtide/index.html'), 'utf8');
  assert.match(page, /preview\.mjs/);
  assert.match(page, /NOT IN CONTRACT ROTATION/);
});
