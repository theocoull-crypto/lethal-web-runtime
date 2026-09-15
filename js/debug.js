// Debug menu (F3): cheats, teleports, spawns, time control, live stats. Not shown unless you open it.
import * as THREE from 'three';

const $ = id => document.getElementById(id);

export class DebugMenu {
  constructor(game) {
    this.game = game;
    this.open = false;
    this.el = document.createElement('div'); this.el.id = 'debug'; this.el.className = 'hidden';
    document.body.appendChild(this.el);
    this.fps = 0; this._acc = 0; this._n = 0;
    addEventListener('keydown', e => { if (e.code === 'F3') { e.preventDefault(); this.toggle(); } });
    this._build();
  }

  toggle() { this.open ? this.hide() : this.show(); }
  show() {
    this.open = true; this.el.classList.remove('hidden');
    this.game._suppressSettings = true; this.game.player.unlock();
    this.game.player.keys = {};
    this.refreshEnemyList();
  }
  hide() { this.open = false; this.el.classList.add('hidden'); if (this.game.state === 'play') { this.game._suppressSettings = true; this.game.player.lock(); } }

  _row(label, ...controls) {
    const r = document.createElement('div'); r.className = 'drow';
    const l = document.createElement('span'); l.className = 'dlabel'; l.textContent = label; r.appendChild(l);
    for (const c of controls) r.appendChild(c);
    this.el.appendChild(r); return r;
  }
  _btn(text, fn) { const b = document.createElement('button'); b.className = 'dbtn'; b.textContent = text; b.onclick = () => { try { fn(); } catch (e) { console.error(e); this.log('error: ' + e.message); } }; return b; }
  _check(text, get, set) {
    const w = document.createElement('label'); w.className = 'dcheck';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!get();
    c.onchange = () => set(c.checked);
    w.appendChild(c); w.appendChild(document.createTextNode(' ' + text)); return w;
  }
  _title(t) { const h = document.createElement('div'); h.className = 'dtitle'; h.textContent = t; this.el.appendChild(h); }

  log(t) { this.status.textContent = t; }

  _build() {
    const g = this.game, el = this.el;
    const head = document.createElement('div'); head.className = 'dhead'; head.innerHTML = '<b>DEBUG</b> <span>F3 to close</span>'; el.appendChild(head);
    this.stats = document.createElement('pre'); this.stats.className = 'dstats'; el.appendChild(this.stats);

    this._title('Cheats');
    this._row('', this._check('God mode', () => g.player.god, v => g.player.god = v),
      this._check('Noclip / fly', () => g.player.noclip, v => { g.player.noclip = v; if (!v) g.player.vel.set(0, 0, 0); }),
      this._check('Infinite stamina', () => g.player.infStamina, v => g.player.infStamina = v),
      this._check('Infinite battery', () => g.items.infBattery, v => g.items.infBattery = v),
      this._check('Enemies frozen', () => g.enemies.frozen, v => g.enemies.frozen = v));
    this._row('', this._btn('+$500 credits', () => { g.credits += 500; this.log('credits ' + g.credits); }),
      this._btn('Quota met', () => { g.quotaFulfilled = g.quota; this.log('quota fulfilled'); }),
      this._btn('Heal', () => { g.player.health = 100; g.player.dead = false; g.player.inputEnabled = true; }),
      this._btn('Give flashlight + walkie', async () => { const f = await g.items.makeTool('BBFlashlight', 'Flashlight'); g.items.addToInventory(f); const w = await g.items.makeTool('WalkieTalkie', 'Walkie-talkie'); g.items.addToInventory(w); }),
      this._btn('Clear ship decor', () => { g.decor.clear(); this.log('decor cleared'); }),
      this._btn('Give 4 random scrap', async () => { for (let i = 0; i < 4; i++) { const d = g.items.defs[Math.floor(Math.random() * g.items.defs.length)]; const it = await g.items.makeInstance(d, Math.round((d.minValue + Math.random() * (d.maxValue - d.minValue)) * 0.4)); if (!g.items.addToInventory(it)) break; } }));

    this._title('Ship & time');
    this._row('', this._btn('Land now', () => { if (g.world.shipState === 'orbit') g.world.pullLever(); this._skipShip(); }),
      this._btn('Leave now', () => { if (g.world.shipState === 'landed') g.world.pullLever(); this._skipShip(); }),
      this._btn('Skip cutscene', () => this._skipShip()),
      this._btn('Route: Experimentation', () => { g.world.destination = 'moon'; this.log('route Experimentation'); }),
      this._btn('Route: Assurance', () => { g.world.destination = 'assurance'; this.log('route Assurance'); }),
      this._btn('Route: Titan', () => { g.world.destination = 'titan'; this.log('route Titan'); }),
      this._btn('Route: Eve', () => { if (!g.world.moons.eve) return this.log('Eve not installed'); g.world.destination = 'eve'; this.log('route Eve'); }),
      this._btn('Route: Wither', () => { if (!g.world.moons.wither) return this.log('Wither not installed'); g.world.destination = 'wither'; this.log('route Wither'); }),
      this._btn('Route: company', () => { g.world.destination = 'company'; this.log('route company'); }));
    const time = document.createElement('input'); time.type = 'range'; time.min = 0; time.max = 1; time.step = 0.01; time.className = 'drange';
    const timeLbl = document.createElement('span'); timeLbl.className = 'dval';
    time.oninput = () => { g.world.setDayFrac(parseFloat(time.value)); timeLbl.textContent = this._clock(); };
    this.timeSlider = time; this.timeLbl = timeLbl;
    this._row('Time of day', time, timeLbl, this._btn('Night', () => { g.world.setDayFrac(0.85); }), this._btn('Morning', () => { g.world.setDayFrac(0.02); }));

    this._title('Teleport');
    this._row('', this._btn('Ship', () => { g.inside = false; g.spawnPlayerInShip(); }),
      this._btn('Facility entrance (outside)', () => { if (!g.world.entrance || g.world.atCompany) return this.log('no entrance here'); g.exitFacility(false); }),
      this._btn('Inside facility', () => { if (!g.dungeon.entranceInside) return this.log('facility not generated (land first)'); g.enterFacility(false); }),
      this._btn('Fire exit (inside)', () => { if (!g.dungeon.fireExitInside) return this.log('no fire exit'); g.enterFacility(true); }),
      this._btn('Company counter', () => { const p = g.world.counterPoint(); if (!p) return this.log('no counter'); g.inside = false; g.player.attachTo(null); g.player.teleport(p.clone().add(new THREE.Vector3(2.5, -0.5, 0)), Math.PI / 2); }),
      this._btn('Random tile', () => { const t = g.dungeon.placed[Math.floor(Math.random() * g.dungeon.placed.length)]; if (!t) return this.log('no tiles'); g.inside = true; g.player.attachTo(null); const c = t.center || t.bounds.getCenter(new THREE.Vector3()); g.player.teleport(new THREE.Vector3(c.x, t.bounds.min.y + 0.5, c.z), 0); this.log('tile ' + t.def.file.split('__')[0]); }));

    this._title('Spawn');
    this.enemySel = document.createElement('select'); this.enemySel.className = 'dsel';
    this._row('Enemy', this.enemySel, this._btn('Spawn in front', () => this._spawnEnemy()), this._btn('Kill all', () => { g.enemies.clearAll(); this.log('enemies cleared'); }));
    const flowSel = document.createElement('select'); flowSel.className = 'dsel';
    for (const [v, t] of [['', "Interior: moon's own odds"], ['Level1Flow', 'Interior: facility'], ['Level1Flow3Exits', 'Interior: facility (3 exits)'], ['Level1FlowExtraLarge', 'Interior: facility (extra large)'], ['Level3Flow', 'Interior: mineshaft'], ['SlaughterhouseFlow', 'Interior: Slaughterhouse (mod)']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; flowSel.appendChild(o); }
    flowSel.onchange = () => { g.dungeon.forceFlow = flowSel.value || null; this.log('next facility: ' + (flowSel.value || 'random')); };
    this._row('World', flowSel, this._btn('Regenerate facility', () => { if (g.world.shipState !== 'landed' || g.world.atCompany) return this.log('land on the moon first'); g.enemies.clearAll(); g.items.clearWorldScrap(); g.dungeon.generate(Date.now() % 100000).then(() => { g.items.spawnScrap(); g._refreshLightSources(); this.log('regenerated: ' + g.dungeon.placed.length + ' tiles'); }); }),
      this._btn('Drop scrap here', async () => { const d = g.items.defs[Math.floor(Math.random() * g.items.defs.length)]; const it = await g.items.makeInstance(d, 40); g.items.addToInventory(it); g.items.dropHeld(); }),
      this._btn('Open all doors', () => { for (const d of g.dungeon.doors) if (!d.open) g.dungeon.toggleDoor(d); }));

    this._title('Rendering');
    this._row('', this._check('Collision wireframe', () => this.wire, v => this._wire(v)),
      this._btn('Reload page', () => location.reload()));
    this.status = document.createElement('div'); this.status.className = 'dstatus'; el.appendChild(this.status);
  }

  _clock() { const { h, m } = this.game.world.clockText(); const h12 = ((h + 11) % 12) + 1; return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }

  _skipShip() {
    const w = this.game.world;
    if (w.shipState === 'landing') { w.shipT = (w.shipClipLen || 9); }
    else if (w.shipState === 'leaving') { w.shipT = (w.shipClipLen || 8); }
    this.log('ship ' + w.shipState);
  }

  refreshEnemyList() {
    const g = this.game; const sel = this.enemySel; sel.innerHTML = '';
    const all = [...g.enemies.catalog.enemies.inside, ...g.enemies.catalog.enemies.outside, ...g.enemies.catalog.enemies.daytime];
    for (const e of all) { if (!e.man) continue; const o = document.createElement('option'); o.value = e.name; o.textContent = (e.enemyName || e.name) + (e.beh && e.beh.kind === 'none' ? ' (static)' : ''); sel.appendChild(o); }
  }

  async _spawnEnemy() {
    const g = this.game; const name = this.enemySel.value;
    const all = [...g.enemies.catalog.enemies.inside, ...g.enemies.catalog.enemies.outside, ...g.enemies.catalog.enemies.daytime];
    const def = all.find(e => e.name === name); if (!def) return;
    const f = g.player.forward(new THREE.Vector3()); const pos = g.player.pos.clone().addScaledVector(f, 5);
    const e = await g.enemies.spawn(def, pos, g.inside ? 'inside' : 'outside');
    if (!g.inside && g.world.atCompany) { g.world.levelRoot.add(e.root); e.root.updateMatrixWorld(true); }
    e.yaw = g.player.yaw + Math.PI; e.root.rotation.y = e.yaw;
    this.log('spawned ' + e.scanName);
  }

  _wire(on) {
    this.wire = on; const g = this.game;
    const pairs = [[g.world.shipCollider, g.world.shipObj], ...Object.values(g.world.moons).map(m => [m.collider, m.root]), [g.world.companyCollider, g.world.companyRoot], [g.dungeon.collider, g.dungeon.root]];
    for (const [c, parent] of pairs) {
      if (!c || !c.mesh) continue;
      if (on && !c.mesh.parent) (parent || g.scene).add(c.mesh);
      c.mesh.visible = on;
    }
  }

  update(dt) {
    this._acc += dt; this._n++;
    if (this._acc >= 0.5) { this.fps = Math.round(this._n / this._acc); this._acc = 0; this._n = 0; }
    if (!this.open) return;
    const g = this.game, r = g.renderer.info.render, p = g.player, w = g.world;
    const lp = p.pos; const local = w.shipObj ? w.shipObj.worldToLocal(lp.clone()) : lp;
    this.stats.textContent =
      `fps ${this.fps}  draws ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k  lights ${g.lightPool.pool.filter(l => l.visible).length}\n` +
      `state ${g.state}  ship ${w.shipState}  dest ${w.destination}  inside ${g.inside}  time ${this._clock()} (${w.dayFrac.toFixed(2)})\n` +
      `player ${lp.x.toFixed(1)},${lp.y.toFixed(1)},${lp.z.toFixed(1)}  ship-local ${local.x.toFixed(1)},${local.y.toFixed(1)},${local.z.toFixed(1)}  hp ${Math.round(p.health)}  ground ${p.groundCollider ? p.groundCollider.name : '-'}  riding ${p.attached ? p.attached.name : '-'}\n` +
      `tiles ${g.dungeon.placed.length}  doors ${g.dungeon.doors.length}  vents ${g.dungeon.vents.length}  items ${g.items.world.length}  enemies ${g.enemies.list.length}  credits $${g.credits}  quota $${g.quotaFulfilled}/$${g.quota}  days ${g.daysLeft}`;
    if (document.activeElement !== this.timeSlider) { this.timeSlider.value = w.dayFrac; this.timeLbl.textContent = this._clock(); }
  }
}
