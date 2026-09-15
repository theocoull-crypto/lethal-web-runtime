// In-game settings (Esc): brightness, light gain, shadows, FOV, sensitivity, volume, pixel filter, grain. Saved in localStorage.
import { encode, decode, capture, restore, describe } from './savecode.js';
const $ = id => document.getElementById(id);
const DEFAULTS = { exposure: 1.15, lightGain: 1.0, shadows: 1, fov: 75, sensitivity: 1.0, volume: 0.9, pixel: true, pixelSize: 2, grain: true, bloom: true, grade: true };

export class Settings {
  constructor(game) {
    this.game = game;
    this.v = Object.assign({}, DEFAULTS);
    try { const s = JSON.parse(localStorage.getItem('lethalweb.settings') || '{}'); Object.assign(this.v, s); } catch (e) { }
    this.el = $('settings');
    this.open = false;
    this._build();
    this.apply();
  }

  _build() {
    const rows = [
      ['exposure', 'Brightness', 'range', 0.5, 2.5, 0.05],
      ['lightGain', 'Light strength', 'range', 0.3, 3.0, 0.1],
      ['shadows', 'Shadows', 'select', ['Off', 'Sun + flashlight', 'Sun + flashlight + 2 lamps', 'Sun + flashlight + 4 lamps']],
      ['fov', 'Field of view', 'range', 60, 105, 1],
      ['sensitivity', 'Mouse sensitivity', 'range', 0.05, 5.0, 0.05],
      ['volume', 'Volume', 'range', 0, 1, 0.05],
      ['pixel', 'Pixel filter (P)', 'check'],
      ['pixelSize', 'Pixel size', 'select', ['Fine (520 lines)', 'Game (440 lines)', 'Strong (360 lines)', 'Chunky (280 lines)']],
      ['bloom', 'Light bloom', 'check'],
      ['grade', 'Colour grade', 'check'],
      ['grain', 'Film grain', 'check'],
    ];
    const box = $('settings-rows');
    box.innerHTML = '';
    for (const [key, label, type, a, b, c] of rows) {
      const row = document.createElement('div'); row.className = 'srow';
      const lab = document.createElement('label'); lab.textContent = label; row.appendChild(lab);
      let input;
      if (type === 'range') { input = document.createElement('input'); input.type = 'range'; input.min = a; input.max = b; input.step = c; input.value = this.v[key]; }
      else if (type === 'check') { input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!this.v[key]; }
      else { input = document.createElement('select'); a.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = t; input.appendChild(o); }); input.value = this.v[key]; }
      const val = document.createElement('span'); val.className = 'sval';
      const show = () => { val.textContent = type === 'range' ? (key === 'fov' ? Math.round(this.v[key]) : (+this.v[key]).toFixed(2)) : ''; };
      input.addEventListener('input', () => { this.v[key] = type === 'check' ? input.checked : parseFloat(input.value); show(); this.apply(); this.save(); });
      row.appendChild(input); row.appendChild(val); box.appendChild(row); show();
    }
    this._buildSaveRows(box);
    $('btn-settings-close').onclick = () => this.hide();
    $('btn-settings-reset').onclick = () => { this.v = Object.assign({}, DEFAULTS); this.save(); this._build(); this.apply(); };
    $('btn-settings-menu').onclick = () => { this.hide(); this.game.backToMenu(); };
    // restart: a fresh run (credits, quota, furniture and the ship upgrade all reset) - asks once
    const rb = $('btn-settings-restart'); let armed = null;
    rb.onclick = () => {
      if (armed) { clearTimeout(armed); armed = null; rb.textContent = '> Restarting...'; this.game.restartRun(); return; }
      rb.textContent = '> Really restart? Click again'; armed = setTimeout(() => { armed = null; rb.textContent = '> Restart run'; }, 4000);
    };
  }

  save() { try { localStorage.setItem('lethalweb.settings', JSON.stringify(this.v)); } catch (e) { } }

  apply() {
    const g = this.game, v = this.v;
    g.renderer.toneMappingExposure = v.exposure;
    g.lightGain = v.lightGain;
    if (g.bloomPass) { g.bloomPass.enabled = v.bloom !== false; g.gradePass.enabled = v.grade !== false; }
    g.shadowLamps = [0, 0, 2, 4][v.shadows] || 0;
    g.shadowsOn = v.shadows > 0;
    g.renderer.shadowMap.enabled = g.shadowsOn;
    if (g.world && g.world.sun) g.world.sun.castShadow = g.shadowsOn;
    if (g.flash) g.flash.castShadow = g.shadowsOn;
    g.camera.fov = v.fov; g.camera.updateProjectionMatrix();
    if (g.player) g.player.lookSensitivity = 0.0022 * v.sensitivity;
    if (g.sound && g.sound.master) g.sound.master.gain.value = v.volume;
    const lines = [520, 440, 360, 280][v.pixelSize] || 440;
    if (g.pixelFilter !== !!v.pixel || g.pixelLines !== lines) { g.pixelFilter = !!v.pixel; g.pixelLines = lines; g._resize(); }
    document.body.classList.toggle('nofilter', !v.pixel);
    document.body.classList.toggle('nograin', !v.grain);
    if (g.lightPool) g.lightPool.setShadowCount(g.shadowLamps);
    // materials need a recompile when the shadow map toggles
    if (this._lastShadows !== g.shadowsOn) { g.scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; }); this._lastShadows = g.shadowsOn; }
  }

  /** save code rows: the code for the current run (copy it), and a field to load one */
  _buildSaveRows(box) {
    const mk = (label, placeholder, readonly) => {
      const row = document.createElement('div'); row.className = 'srow';
      const lab = document.createElement('label'); lab.textContent = label;
      const input = document.createElement('input'); input.type = 'text'; input.spellcheck = false; input.autocomplete = 'off'; input.placeholder = placeholder; if (readonly) input.readOnly = true;
      input.addEventListener('keydown', e => e.stopPropagation());
      const btn = document.createElement('button'); btn.className = 'dbtn';
      row.appendChild(lab); row.appendChild(input); row.appendChild(btn); box.appendChild(row);
      return { row, input, btn };
    };
    const save = mk('Save code', '', true); save.btn.textContent = 'Copy';
    save.input.addEventListener('focus', () => save.input.select());
    save.btn.onclick = () => { save.input.select(); try { navigator.clipboard.writeText(save.input.value); } catch (e) { document.execCommand('copy'); } save.btn.textContent = 'Copied'; setTimeout(() => { save.btn.textContent = 'Copy'; }, 1200); };
    const load = mk('Load code', 'paste a save code', false); load.btn.textContent = 'Load';
    const note = document.createElement('div'); note.className = 'menu-foot'; note.textContent = 'The code holds credits, quota, upgrades, furniture and tools. Nothing else is saved.'; box.appendChild(note);
    load.btn.onclick = () => {
      const st = decode(load.input.value);
      if (!st) { note.textContent = 'That is not a valid save code.'; return; }
      note.textContent = 'Loading...';
      restore(this.game, st).then(notes => { note.textContent = 'Loaded: ' + describe(st) + '.'; save.input.value = encode(capture(this.game)); load.input.value = ''; });
    };
    this.saveInput = save.input; this.saveNote = note;
  }

  show() {
    if (this.open) return;
    this.open = true; this.el.classList.remove('hidden');
    if (this.saveInput && this.game.state === 'play') { try { this.saveInput.value = encode(capture(this.game)); } catch (e) { this.saveInput.value = ''; } }
    this.game.player.unlock();
    this.game.player.keys = {};
    this.game.paused = true;
  }
  hide() {
    if (!this.open) return;
    this.open = false; this.el.classList.add('hidden');
    this.game.paused = false;
    if (this.game.state === 'play') this.game.player.lock();
  }
  toggle() { this.open ? this.hide() : this.show(); }
}
