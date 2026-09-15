import { LOWTIDE_CONFIG, LOWTIDE_STATES, cloneLowtideConfig } from './config.mjs';

const clamp01 = value => Math.max(0, Math.min(1, value));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = t => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export function getTideWindow(config, index) {
  const tide = config.tide;
  const warningStart = tide.schedule[index] * config.daySeconds;
  const incomingStart = warningStart + tide.warningDuration;
  const highStart = incomingStart + tide.incomingDuration;
  const outgoingStart = highStart + tide.highDuration;
  const end = outgoingStart + tide.outgoingDuration;
  return { index, warningStart, incomingStart, highStart, outgoingStart, end };
}

export function tideSnapshotAt(config, gameTime) {
  const time = Math.max(0, gameTime);
  let previousTide = -1;
  for (let index = 0; index < config.tide.schedule.length; index++) {
    const window = getTideWindow(config, index);
    if (time < window.warningStart) {
      return {
        tideIndex: Math.max(0, index),
        state: previousTide >= 0 ? 'dry-after-tide' : 'dry',
        progress: 0,
        waterLevel: config.tide.lowLevel,
        coverage: 0,
      };
    }
    if (time < window.incomingStart) {
      const progress = clamp01((time - window.warningStart) / config.tide.warningDuration);
      return { tideIndex: index, state: 'warning', progress, waterLevel: config.tide.lowLevel, coverage: 0 };
    }
    if (time < window.highStart) {
      const progress = smoothstep((time - window.incomingStart) / config.tide.incomingDuration);
      return {
        tideIndex: index,
        state: 'incoming',
        progress,
        waterLevel: lerp(config.tide.lowLevel, config.tide.highLevel, progress),
        coverage: progress,
      };
    }
    if (time < window.outgoingStart) {
      const progress = clamp01((time - window.highStart) / config.tide.highDuration);
      return { tideIndex: index, state: 'high', progress, waterLevel: config.tide.highLevel, coverage: 1 };
    }
    if (time < window.end) {
      const progress = smoothstep((time - window.outgoingStart) / config.tide.outgoingDuration);
      return {
        tideIndex: index,
        state: 'outgoing',
        progress,
        waterLevel: lerp(config.tide.highLevel, config.tide.lowLevel, progress),
        coverage: 1 - progress,
      };
    }
    previousTide = index;
  }
  return {
    tideIndex: config.tide.schedule.length - 1,
    state: 'dry-after-tide',
    progress: 0,
    waterLevel: config.tide.lowLevel,
    coverage: 0,
  };
}

function forcedSnapshot(config, state, tideIndex) {
  const fixed = {
    dry: [0, config.tide.lowLevel, 0],
    warning: [0.65, config.tide.lowLevel, 0],
    incoming: [0.62, lerp(config.tide.lowLevel, config.tide.highLevel, 0.62), 0.62],
    high: [0.5, config.tide.highLevel, 1],
    outgoing: [0.62, lerp(config.tide.highLevel, config.tide.lowLevel, 0.62), 0.38],
    'dry-after-tide': [0, config.tide.lowLevel, 0],
  }[state];
  return { tideIndex, state, progress: fixed[0], waterLevel: fixed[1], coverage: fixed[2] };
}

export class LowtideSimulation {
  constructor(options = {}) {
    this.config = cloneLowtideConfig(options.config || options);
    this.gameTime = 0;
    this.snapshot = tideSnapshotAt(this.config, 0);
    this.completedTides = 0;
    this.withdrawnTides = 0;
    this.poolVariant = 0;
    this.eyeWatching = false;
    this.eyeOverride = null;
    this.forcedState = null;
    this.listeners = new Map();
    this._highTriggered = new Set();
    this._withdrawalTriggered = new Set();
  }

  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  emit(type, detail = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ type, ...detail });
    for (const listener of this.listeners.get('*') || []) listener({ type, ...detail });
  }

  _setEyeWatching(watching, reason) {
    const next = this.eyeOverride == null ? watching : this.eyeOverride;
    if (this.eyeWatching === next) return;
    this.eyeWatching = next;
    this.emit('eye-watch', { watching: next, reason });
  }

  _completeHighTide(index) {
    if (this._highTriggered.has(index)) return;
    this._highTriggered.add(index);
    this.completedTides = this._highTriggered.size;
    this.emit('high-tide', { tideIndex: index, completedTides: this.completedTides });
    this.emit('cleanup', { tideIndex: index, zoneTag: 'cleanup' });
    this.emit('creature-breath', { tideIndex: index, liftMetres: this.config.breath.liftMetres, alertTag: 'eyeless-dog-compatible' });
    if (this.completedTides >= 2) this._setEyeWatching(true, 'second-tide');
  }

  _completeWithdrawal(index) {
    if (this._withdrawalTriggered.has(index)) return;
    this._withdrawalTriggered.add(index);
    this.withdrawnTides = this._withdrawalTriggered.size;
    this.poolVariant = this.withdrawnTides % this.config.tide.poolVariantCount;
    this.emit('tide-withdrawn', { tideIndex: index, poolVariant: this.poolVariant });
  }

  _syncMilestones(time) {
    for (let index = 0; index < this.config.tide.schedule.length; index++) {
      const window = getTideWindow(this.config, index);
      if (time >= window.highStart) this._completeHighTide(index);
      if (time >= window.end) this._completeWithdrawal(index);
    }
  }

  update(deltaTime, gameTime = null) {
    const previous = this.snapshot;
    if (gameTime == null) this.gameTime += Math.max(0, deltaTime);
    else this.gameTime = Math.max(0, gameTime);
    if (!this.forcedState) this._syncMilestones(this.gameTime);
    const next = this.forcedState
      ? forcedSnapshot(this.config, this.forcedState, Math.min(this.completedTides, this.config.tide.schedule.length - 1))
      : tideSnapshotAt(this.config, this.gameTime);
    this.snapshot = next;
    if (previous.state !== next.state || previous.tideIndex !== next.tideIndex) {
      this.emit('tide-state', { previous: previous.state, state: next.state, tideIndex: next.tideIndex, snapshot: { ...next } });
      if (next.state === 'warning') this.emit('tide-warning', { tideIndex: next.tideIndex });
    }
    return this.getSnapshot();
  }

  forceState(state) {
    if (state == null) {
      this.forcedState = null;
      return this.update(0, this.gameTime);
    }
    if (!LOWTIDE_STATES.includes(state)) throw new Error(`Unknown LOWTIDE state: ${state}`);
    const index = Math.min(this.completedTides, this.config.tide.schedule.length - 1);
    if (state === 'high' || state === 'outgoing' || state === 'dry-after-tide') this._completeHighTide(index);
    if (state === 'dry-after-tide') this._completeWithdrawal(index);
    const previous = this.snapshot;
    this.forcedState = state;
    this.snapshot = forcedSnapshot(this.config, state, index);
    if (previous.state !== state) {
      this.emit('tide-state', { previous: previous.state, state, tideIndex: index, snapshot: this.getSnapshot() });
      if (state === 'warning') this.emit('tide-warning', { tideIndex: index });
    }
    return this.getSnapshot();
  }

  setEyeWatching(watching = null) {
    this.eyeOverride = watching == null ? null : !!watching;
    this._setEyeWatching(this.completedTides >= 2, watching == null ? 'timeline' : 'debug');
    return this.eyeWatching;
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      gameTime: this.gameTime,
      completedTides: this.completedTides,
      withdrawnTides: this.withdrawnTides,
      poolVariant: this.poolVariant,
      eyeWatching: this.eyeWatching,
      forcedState: this.forcedState,
    };
  }

  serialize() {
    return {
      version: 1,
      gameTime: this.gameTime,
      completedTides: this.completedTides,
      withdrawnTides: this.withdrawnTides,
      poolVariant: this.poolVariant,
      eyeWatching: this.eyeWatching,
      eyeOverride: this.eyeOverride,
      forcedState: this.forcedState,
      highTriggered: [...this._highTriggered],
      withdrawalTriggered: [...this._withdrawalTriggered],
    };
  }

  restore(data = {}) {
    this.gameTime = Math.max(0, Number(data.gameTime) || 0);
    this._highTriggered = new Set(Array.isArray(data.highTriggered) ? data.highTriggered : []);
    this._withdrawalTriggered = new Set(Array.isArray(data.withdrawalTriggered) ? data.withdrawalTriggered : []);
    this.completedTides = this._highTriggered.size;
    this.withdrawnTides = this._withdrawalTriggered.size;
    this.poolVariant = Number.isInteger(data.poolVariant) ? data.poolVariant % this.config.tide.poolVariantCount : this.withdrawnTides % this.config.tide.poolVariantCount;
    this.eyeOverride = typeof data.eyeOverride === 'boolean' ? data.eyeOverride : null;
    this.eyeWatching = this.eyeOverride == null ? this.completedTides >= 2 : this.eyeOverride;
    this.forcedState = LOWTIDE_STATES.includes(data.forcedState) ? data.forcedState : null;
    this.snapshot = this.forcedState
      ? forcedSnapshot(this.config, this.forcedState, Math.min(this.completedTides, this.config.tide.schedule.length - 1))
      : tideSnapshotAt(this.config, this.gameTime);
    return this.getSnapshot();
  }

  dispose() {
    this.listeners.clear();
  }
}

export { LOWTIDE_CONFIG };
