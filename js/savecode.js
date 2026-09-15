// Save codes: everything that matters about a run packed into one big number.  Each fact is a digit range of a
// mixed-radix integer (credits, quota, days, upgrades, how many of each furniture piece and tool you own), so the
// code IS the save - nothing is stored anywhere.  Two check digits at the end catch typos.  Positions, the current
// moon and the time of day are deliberately not in it.

const VERSION = 1;
// furniture by its unlockable id (the order is part of the code format - append, never reorder)
const DECOR_IDS = [6, 9, 10, 12, 13, 14, 20, 21, 22, 23, 27, 28, 29, 30, 31, 32, 33];
const TOOLS = ['BBFlashlight', 'WalkieTalkie', 'ShovelItem'];
const FIELDS = [
  ['version', 10],
  ['credits', 1000000], ['quota', 1000000], ['fulfilled', 1000000],
  ['daysLeft', 5], ['quotaRound', 100], ['dayCount', 1000],
  ['wider', 2],
  ...DECOR_IDS.map(id => ['decor' + id, 10]),
  ...TOOLS.map(t => ['tool' + t, 10]),
];
const CHECK = 97n;

const clampInt = (v, radix) => Math.max(0, Math.min(radix - 1, Math.floor(Number(v) || 0)));

/** state object -> digit string */
export function encode(state) {
  let v = 0n;
  for (const [key, radix] of FIELDS) v = v * BigInt(radix) + BigInt(clampInt(key === 'version' ? VERSION : state[key], radix));
  return v.toString() + (v % CHECK).toString().padStart(2, '0');
}

/** digit string -> state object, or null when the code is not a valid save code */
export function decode(code) {
  const s = String(code || '').replace(/[^0-9]/g, '');
  if (s.length < 3) return null;
  let v;
  try { v = BigInt(s.slice(0, -2)); } catch (e) { return null; }
  if ((v % CHECK).toString().padStart(2, '0') !== s.slice(-2)) return null;
  const out = {};
  for (let i = FIELDS.length - 1; i >= 0; i--) { const [key, radix] = FIELDS[i]; const r = BigInt(radix); out[key] = Number(v % r); v = v / r; }
  if (v !== 0n || out.version !== VERSION) return null;
  return out;
}

/** what the game looks like right now, as a state object */
export function capture(game) {
  const g = game;
  const st = { credits: g.credits, quota: g.quota, fulfilled: g.quotaFulfilled, daysLeft: g.daysLeft, quotaRound: g.quotaRound, dayCount: g.dayCount, wider: g.shipmods && g.shipmods.owned ? 1 : 0 };
  for (const id of DECOR_IDS) st['decor' + id] = g.decor ? g.decor.placed.filter(e => e.def.id === id).length : 0;
  for (const t of TOOLS) st['tool' + t] = toolCount(g, t);
  return st;
}

function toolCount(g, tool) {
  let n = 0;
  for (const it of g.items.inventory) if (it && it.tool === tool) n++;
  for (const it of g.items.world) if (it && it.tool === tool && (it.onShip || it.area === 'ship')) n++;
  return n;
}

/** apply a decoded state to the running game; returns a short description of what changed */
export async function restore(game, st) {
  const g = game;
  g.credits = st.credits; g.quota = st.quota; g.quotaFulfilled = st.fulfilled; g.daysLeft = Math.max(1, st.daysLeft); g.quotaRound = Math.max(1, st.quotaRound); g.dayCount = st.dayCount;
  const notes = [];
  // ship upgrade
  if (g.shipmods) {
    if (st.wider && !g.shipmods.owned) { await g.shipmods.buy(); notes.push('wider ship installed'); }
    else if (!st.wider && g.shipmods.owned) { g.shipmods.owned = false; g.shipmods.save(); notes.push('wider ship removed (takes effect after a reload)'); }
  }
  // furniture: the code says how many of each; they come back on free deck spots
  if (g.decor) {
    g.decor.clear();
    let pieces = 0;
    for (const id of DECOR_IDS) {
      const def = g.decor.catalog.find(d => d.id === id); if (!def) continue;
      for (let i = 0; i < st['decor' + id]; i++) { await g.decor.buy(def); pieces++; }
    }
    if (pieces) notes.push(pieces + ' furniture piece' + (pieces === 1 ? '' : 's'));
  }
  // tools: top up to the counts in the code
  let tools = 0;
  for (const t of TOOLS) {
    const want = st['tool' + t], have = toolCount(g, t);
    for (let i = have; i < want; i++) {
      const it = await g.items.makeTool(t, t === 'BBFlashlight' ? 'Flashlight' : t === 'WalkieTalkie' ? 'Walkie-talkie' : 'Shovel');
      if (it && g.items.addToInventory(it)) tools++;
      else { g.items.queueDelivery(t, t === 'BBFlashlight' ? 'Flashlight' : t === 'WalkieTalkie' ? 'Walkie-talkie' : 'Shovel'); tools++; }
    }
  }
  if (tools) notes.push(tools + ' tool' + (tools === 1 ? '' : 's'));
  if (g.hud && g.hud.setQuota) g.hud.setQuota(g.quotaFulfilled, g.quota, g.daysLeft, g.credits, g.items.scrapValueOnShip());
  return notes;
}

/** one-line summary of a state, for the terminal */
export function describe(st) {
  const pieces = DECOR_IDS.reduce((a, id) => a + st['decor' + id], 0);
  const tools = TOOLS.reduce((a, t) => a + st['tool' + t], 0);
  return `$${st.credits} credits, quota $${st.fulfilled} / $${st.quota} with ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left, day ${st.dayCount}, ${st.wider ? 'wider ship, ' : ''}${pieces} furniture piece${pieces === 1 ? '' : 's'}, ${tools} tool${tools === 1 ? '' : 's'}`;
}
