import test from 'node:test';
import assert from 'node:assert/strict';
import { LowtideSimulation, getTideWindow, tideSnapshotAt } from '../simulation.mjs';
import { LOWTIDE_CONFIG, LOWTIDE_STATES } from '../config.mjs';

test('timeline exposes every required tide state in order', () => {
  const config = LOWTIDE_CONFIG;
  const first = getTideWindow(config, 0);
  const samples = [
    tideSnapshotAt(config, 0).state,
    tideSnapshotAt(config, first.warningStart + 0.1).state,
    tideSnapshotAt(config, first.incomingStart + 0.1).state,
    tideSnapshotAt(config, first.highStart + 0.1).state,
    tideSnapshotAt(config, first.outgoingStart + 0.1).state,
    tideSnapshotAt(config, first.end + 0.1).state,
  ];
  assert.deepEqual(samples, LOWTIDE_STATES);
});

test('incoming tide visibly advances coverage and water height', () => {
  const first = getTideWindow(LOWTIDE_CONFIG, 0);
  const early = tideSnapshotAt(LOWTIDE_CONFIG, first.incomingStart + 2);
  const late = tideSnapshotAt(LOWTIDE_CONFIG, first.highStart - 2);
  assert.equal(early.state, 'incoming');
  assert.equal(late.state, 'incoming');
  assert.ok(late.coverage > early.coverage);
  assert.ok(late.waterLevel > early.waterLevel);
  assert.ok(late.waterLevel < LOWTIDE_CONFIG.tide.highLevel);
});

test('forty in-game minutes maps to the configured high-tide hold', () => {
  const playableMinutes = (LOWTIDE_CONFIG.endHour - LOWTIDE_CONFIG.startHour) * 60;
  const representedMinutes = LOWTIDE_CONFIG.tide.highDuration / LOWTIDE_CONFIG.daySeconds * playableMinutes;
  assert.equal(representedMinutes, 40);
});

test('each high tide emits one breath and one cleanup event', () => {
  const simulation = new LowtideSimulation();
  const breaths = []; const cleanups = [];
  simulation.on('creature-breath', event => breaths.push(event));
  simulation.on('cleanup', event => cleanups.push(event));
  const first = getTideWindow(simulation.config, 0);
  simulation.update(0, first.highStart + 0.01);
  simulation.update(0, first.highStart + 10);
  assert.equal(breaths.length, 1);
  assert.equal(cleanups.length, 1);
  assert.equal(breaths[0].liftMetres, 4);
  assert.equal(breaths[0].alertTag, 'eyeless-dog-compatible');
});

test('the eye moves exactly once after the second completed tide', () => {
  const simulation = new LowtideSimulation();
  const eyeEvents = [];
  simulation.on('eye-watch', event => eyeEvents.push(event));
  const first = getTideWindow(simulation.config, 0);
  const second = getTideWindow(simulation.config, 1);
  simulation.update(0, first.highStart + 0.01);
  assert.equal(simulation.eyeWatching, false);
  simulation.update(0, second.highStart + 0.01);
  simulation.update(0, second.outgoingStart + 1);
  assert.equal(simulation.eyeWatching, true);
  assert.equal(eyeEvents.length, 1);
  assert.equal(eyeEvents[0].reason, 'second-tide');
});

test('withdrawal changes the deterministic tide-pool variant', () => {
  const simulation = new LowtideSimulation();
  const first = getTideWindow(simulation.config, 0);
  simulation.update(0, first.end + 0.01);
  assert.equal(simulation.withdrawnTides, 1);
  assert.equal(simulation.poolVariant, 1);
  simulation.update(0, first.end + 20);
  assert.equal(simulation.withdrawnTides, 1);
  assert.equal(simulation.poolVariant, 1);
});

test('runtime state round-trips without replaying completed milestones', () => {
  const original = new LowtideSimulation();
  const second = getTideWindow(original.config, 1);
  original.update(0, second.end + 0.01);
  const saved = JSON.parse(JSON.stringify(original.serialize()));
  const restored = new LowtideSimulation();
  const events = [];
  restored.on('*', event => events.push(event.type));
  restored.restore(saved);
  restored.update(0, saved.gameTime);
  assert.deepEqual(restored.serialize(), saved);
  assert.deepEqual(events, []);
  assert.equal(restored.getSnapshot().eyeWatching, true);
});

test('debug forcing covers every state and rejects unknown states', () => {
  const simulation = new LowtideSimulation();
  for (const state of LOWTIDE_STATES) assert.equal(simulation.forceState(state).state, state);
  assert.throws(() => simulation.forceState('tsunami'), /Unknown LOWTIDE state/);
  assert.equal(simulation.forceState(null).forcedState, null);
});
