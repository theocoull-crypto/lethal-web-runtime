// The ship terminal: a text console with the commands the demo supports (help, store, buy, moons, route, scan, quota, exit).
// Partial words and typos are silently matched to the closest command, moon or item ("the com" -> The Company building).
import { encode, decode, capture, restore, describe } from './savecode.js';
const $ = id => document.getElementById(id);

const COMMANDS = ['help', 'moons', 'store', 'buy', 'route', 'scan', 'quota', 'save', 'load', 'clear', 'exit', 'view', 'confirm', 'deny'];
const MOONS = [
  { key: 'moon', label: '41-Experimentation', names: ['experimentation', '41-experimentation', '41'] },
  { key: 'assurance', label: '220-Assurance', names: ['assurance', '220-assurance', '220'] },
  { key: 'titan', label: '8-Titan', names: ['titan', '8-titan', '8'] },
  { key: 'eve', label: '127-Eve-M', names: ['eve', '127-eve', '127-eve-m', 'eve-m', '127'] },
  { key: 'wither', label: '115-Wither', names: ['wither', '115-wither', '115'] },
  { key: 'tranquillity', label: '42-Tranquillity', names: ['tranquillity', 'tranquility', '42-tranquillity', '42-tranquility', '42', 'tranq'] },
  { key: 'company', label: 'The Company building', names: ['company', 'the company building', 'company building', 'the company'] },
];

// edit distance, for typo tolerance
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// how well `input` matches `word`: lower is better, null = no match
function score(input, word) {
  if (!input) return null;
  if (word === input) return 0;
  if (word.startsWith(input)) return 1 + (word.length - input.length) * 0.001;
  if (input.length >= 3) {
    const d = lev(input, word.slice(0, input.length));   // typo inside a prefix ("expermen" -> "experimen")
    if (d <= Math.max(1, Math.floor(input.length / 4))) return 2 + d;
    const w = word.split(/[\s-]+/).find(x => x.startsWith(input));   // a later word ("company" in "the company building")
    if (w) return 2.5;
  }
  return null;
}

// best candidate from a list of {names:[...]} objects (ties keep list order)
function best(input, cands) {
  let hit = null;
  for (const c of cands) for (const name of c.names) {
    const s = score(input, name);
    if (s != null && (!hit || s < hit.score)) hit = { cand: c, name, score: s };
  }
  return hit;
}

export class Terminal {
  constructor(game) {
    this.game = game;
    this.el = $('terminal'); this.out = $('term-out'); this.input = $('term-input');
    this.open = false;
    this.pending = null;   // {kind:'buy'|'route', ...} awaiting confirm
    this.store = [
      { key: 'flashlight', name: 'Flashlight', price: 15, tool: 'BBFlashlight', names: ['flashlight', 'pro-flashlight', 'light'] },
      { key: 'walkie', name: 'Walkie-talkie', price: 12, tool: 'WalkieTalkie', names: ['walkie-talkie', 'walkie', 'walkie talkie', 'radio'] },
      { key: 'shovel', name: 'Shovel', price: 30, tool: 'ShovelItem', names: ['shovel', 'spade'] },
    ];
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { const v = this.input.value; this.input.value = ''; this.run(v); }
      if (e.key === 'Escape') this.hide();
    });
  }

  show() {
    this.open = true; this.el.classList.remove('hidden');
    this.game.player.unlock();
    this.game.player.keys = {};
    const c = this.game.items.sfx('enterTerminal'); if (c) this.game.sound.play(c, { vol: 0.5 });
    if (!this.booted) { this.booted = true; this.print(this.banner()); }
    setTimeout(() => this.input.focus(), 50);
  }

  hide() {
    this.open = false; this.el.classList.add('hidden');
    this.pending = null;
    const c = this.game.items.sfx('exitTerminal'); if (c) this.game.sound.play(c, { vol: 0.5 });
    this.game.player.lock();
  }

  /** tools plus the ship decor (furniture) once it is loaded */
  allStore() { return this.store.concat(this.upgrades(), this.game.decor ? this.game.decor.storeList() : []); }

  /** ship upgrades (the Wider Ship mod's hull) */
  upgrades() { const g = this.game; return [{ key: 'widership', name: 'Wider ship', price: g.shipmods ? g.shipmods.price : 400, upgrade: 'wider', names: ['wider ship', 'wider', 'wide ship', 'bigger ship', 'big ship', 'ship upgrade', 'ship extension'] }]; }

  banner() {
    return `Welcome to the FORTUNE-9 OS
                   Courtesy of the Company

Type "Help" for a list of commands.
`;
  }

  print(t) { this.out.textContent += t + '\n'; this.out.scrollTop = this.out.scrollHeight; }
  clear() { this.out.textContent = ''; }

  // ---------- commands ----------
  run(line) {
    const g = this.game;
    const words = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const key = g.items.sfx('key'); if (key) g.sound.play(key, { vol: 0.35 });
    this.print('> ' + line);
    const first = words[0], rest = words.slice(1).join(' ');
    if (this.pending) {
      if ('confirm'.startsWith(first)) { const p = this.pending; this.pending = null; return p.kind === 'buy' ? this.doBuy(p) : this.doRoute(p.moon); }
      if ('deny'.startsWith(first)) { const wasRoute = this.pending.kind === 'route'; this.pending = null; return this.print(wasRoute ? 'Cancelled.\n' : 'Cancelled order.\n'); }
      this.pending = null;   // anything else abandons the prompt and runs as a new command
    }
    const cmdHit = best(first, COMMANDS.map(c => ({ names: [c] })));
    const moonHit = best(words.join(' '), MOONS);
    const itemHit = best(words.join(' '), this.allStore());
    // a bare moon or item name beats a weak command match ("exp" -> Experimentation, "fla" -> Flashlight, "com" -> Company)
    const cmdScore = cmdHit ? cmdHit.score : 9;
    if (moonHit && moonHit.score < cmdScore) return this.askRoute(moonHit.cand);
    if (itemHit && itemHit.score < cmdScore) return this.askBuy(itemHit.cand, 1);
    if (!cmdHit) return this.print(`[Unknown command. Type HELP]\n`);
    const cmd = cmdHit.cand.names[0];
    switch (cmd) {
      case 'help': return this.print(`>MOONS
To see the list of moons the autopilot can route to.

>STORE
To see the store's selection of useful items.

>BUY [item]
To order an item from the store. It is delivered by dropship to the moon.

>SCAN
To scan for the number of items left on the current moon.

>QUOTA
Current profit quota and deadline.

>ROUTE [moon]
To route the autopilot to a moon or to the Company building (sell your scrap there).

>SAVE
Prints a save code: one number that holds your credits, quota, upgrades, furniture and tools.

>LOAD [code]
Restores a run from a save code.

>CLEAR   >EXIT
`);
      case 'moons': return this.print(`Welcome to the exomoons catalogue.
To route the autopilot to a moon, use the word ROUTE.
____________________________

* The Company building   //   Buying at ${Math.round(g.world.buyingRate() * 100)}%${g.world.destination === 'company' ? '   (current route)' : ''}

* 41-Experimentation   ${this.weather('moon')}${g.world.destination === 'moon' ? '   (current route)' : ''}

* 220-Assurance        ${this.weather('assurance')}${g.world.destination === 'assurance' ? '   (current route)' : ''}

* 8-Titan              ${this.weather('titan')}${g.world.destination === 'titan' ? '   (current route)' : ''}
${g.world.moons.eve ? `\n* 127-Eve-M            ${this.weather('eve')}${g.world.destination === 'eve' ? '   (current route)' : ''}\n` : ''}${g.world.moons.wither ? `\n* 115-Wither           ${this.weather('wither')}${g.world.destination === 'wither' ? '   (current route)' : ''}\n` : ''}${g.world.moons.tranquillity ? `\n* 42-Tranquillity      ${this.weather('tranquillity')}${g.world.destination === 'tranquillity' ? '   (current route)' : ''}\n` : ''}`);
      case 'store': return this.print(`Welcome to the Company store.
Use words BUY to buy an item.
____________________________

${this.store.map(s => `* ${s.name}  //  Price: $${s.price}`).join('\n')}

Ship upgrades:
${this.upgrades().map(s => `* ${s.name}  //  ${g.shipmods && g.shipmods.owned ? 'Installed' : 'Price: $' + s.price}`).join('\n')}

Ship decor (arrives on the ship; press B to move it around):
${(g.decor ? g.decor.storeList() : []).map(s => `* ${s.name}  //  Price: $${s.price}`).join('\n')}

Your credits: $${g.credits}
`);
      case 'buy': {
        const qty = Math.max(1, parseInt(words[words.length - 1]) || 1);
        const name = rest.replace(/\s*\d+$/, '');
        const hit = best(name, this.allStore());
        if (!hit) return this.print(name ? `[Item not found in this demo's store. Try STORE]\n` : 'Buy what? Type STORE to see the items.\n');
        return this.askBuy(hit.cand, qty);
      }
      case 'route': {
        const hit = best(rest, MOONS);
        if (!rest) return this.print('Route where? Type MOONS to see the list.\n');
        if (!hit) return this.print('That moon is not in the autopilot catalogue. Type MOONS to see available routes.\n');
        return this.askRoute(hit.cand);
      }
      case 'scan': {
        if (!g.dungeon.placed.length) return this.print('There are no scrap objects to scan while in orbit.\n');
        const left = g.items.world.filter(it => it.area === 'inside' && it.value);
        return this.print(`There are ${left.length} objects outside the ship, totalling at an approximate value of $${left.reduce((a, i) => a + i.value, 0)}.\n`);
      }
      case 'quota': return this.print(`Profit quota: $${g.quotaFulfilled} / $${g.quota}\nScrap on ship: $${g.items.scrapValueOnShip()}\nDays until deadline: ${g.daysLeft}\nCompany buying rate: ${Math.round(g.world.buyingRate() * 100)}%\nCredits: $${g.credits}\n`);
      case 'save': {
        const code = encode(capture(g));
        return this.print(`SAVE CODE
${code}

Write it down. LOAD <code> at any terminal brings back: ${describe(capture(g))}.
`);
      }
      case 'load': {
        const st = decode(rest);
        if (!rest) return this.print('Load what? Type LOAD followed by a save code.\n');
        if (!st) return this.print('That is not a valid save code (check the digits).\n');
        restore(g, st).then(notes => this.print(`Save code accepted: ${describe(st)}.
${notes.length ? notes.join(', ') + '.\n' : ''}`));
        return;
      }
      case 'clear': return this.clear();
      case 'exit': return this.hide();
      case 'view': return this.print('The ship monitor is not available in this build.\n');
      case 'confirm': case 'deny': return this.print('There is nothing to confirm.\n');
    }
    this.print(`[Unknown command. Type HELP]\n`);
  }

  askBuy(s, qty) {
    const g = this.game;
    if (s.upgrade) { if (g.shipmods && g.shipmods.owned) return this.print(`The ${s.name} is already installed.
`); qty = 1; }
    const total = s.price * qty;
    if (total > g.credits) return this.print(`You could not afford this item! Your balance is $${g.credits}. Total cost of item: $${total}.\n`);
    this.pending = { kind: 'buy', item: s, qty, total };
    this.print(`You have requested to order ${qty} ${s.name}${qty > 1 ? 's' : ''}. Amount: $${total}.
Please CONFIRM or DENY.
`);
  }

  doBuy(p) {
    const g = this.game;
    g.credits -= p.total;
    const c = g.items.sfx('purchase'); if (c) g.sound.play(c, { vol: 0.6 });
    if (p.item.upgrade) {
      g.shipmods.buy();
      return this.print(`Ordered the ${p.item.name}. Your new balance is $${g.credits}.
The Company's engineers have extended the ship on both sides.
`);
    }
    if (p.item.decor) {
      for (let i = 0; i < p.qty; i++) g.decor.buy(p.item.decor);
      return this.print(`Ordered ${p.qty} ${p.item.name}${p.qty > 1 ? 's' : ''}. Your new balance is $${g.credits}.\nIt has been placed on the ship. Look at it and press B to move it.\n`);
    }
    for (let i = 0; i < p.qty; i++) g.items.queueDelivery(p.item.tool, p.item.name);
    const where = g.world.inOrbit ? 'It will be delivered next to the ship shortly after you land.' : 'The dropship is on its way.';
    this.print(`Ordered ${p.qty} ${p.item.name}${p.qty > 1 ? 's' : ''}. Your new balance is $${g.credits}.\n${where}\n`);
  }

  askRoute(moon) {
    const g = this.game;
    if (!g.world.inOrbit) return this.print('You can only route the autopilot while in orbit.\n');
    if (moon.key !== 'company' && !g.world.moons[moon.key]) return this.print(`${moon.label} is not installed in this build (its assets have not been extracted).\n`);
    if (g.world.destination === moon.key) return this.print(`The autopilot is already routed to ${moon.label}.\nPull the lever to land.\n`);
    this.pending = { kind: 'route', moon };
    if (moon.key === 'company') this.print(`The cost to route to ${moon.label} is $0. The Company is buying at ${Math.round(g.world.buyingRate() * 100)}%.\nPlease CONFIRM or DENY.\n`);
    else this.print(`The cost to route to ${moon.label} is $0. It is currently ${this.weather(moon.key).replace(/[()]/g, '')}.\nPlease CONFIRM or DENY.\n`);
  }

  doRoute(moon) {
    const g = this.game;
    if (!g.world.inOrbit) return this.print('You can only route the autopilot while in orbit.\n');
    g.world.destination = moon.key;
    const c = g.items.sfx('notify'); if (c) g.sound.play(c, { vol: 0.45 });
    this.print(`The autopilot is now routed to ${moon.label}.\nPull the lever to land.\n`);
  }

  weather(moon = this.game.world.destination) {
    if (this.game.world.dayFrac > 0.72) return '(Night)';
    return moon === 'assurance' || moon === 'eve' || moon === 'wither' || moon === 'tranquillity' ? '(Clear)' : moon === 'titan' ? '(Snowy)' : '(Foggy)';
  }
}
