// Client-side dice roller + roll log (no server round-trip needed).

export function rollDie(sides) {
  return 1 + Math.floor(Math.random() * sides);
}

export function rollDice(count, sides) {
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(rollDie(sides));
  return rolls;
}

// e.g. rollExpr("2d6+3") -> { rolls:[4,2], sides:6, count:2, modifier:3, total:9, label:"2d6+3" }
export function rollExpr(expr) {
  const m = String(expr).trim().match(/^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i);
  if (!m) throw new Error(`Некорректное выражение кубика: ${expr}`);
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  const modifier = m[3] ? parseInt(m[3].replace(/\s+/g, ""), 10) : 0;
  const rolls = rollDice(count, sides);
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { rolls, sides, count, modifier, total, label: expr };
}

// A d20 check/save/attack roll with an optional flat modifier and advantage/disadvantage.
// `critMin` widens what counts as a critical hit (Champion's "Улучшенные
// критические попадания"/"Превосходные критические попадания": 19-20 or
// 18-20 instead of the plain natural-20) -- callers that don't pass it get
// the normal rules.
export function rollD20({ modifier = 0, mode = "normal", label = "", critMin = 20 } = {}) {
  const first = rollDie(20);
  let second = null;
  let picked = first;
  if (mode === "advantage" || mode === "disadvantage") {
    second = rollDie(20);
    picked = mode === "advantage" ? Math.max(first, second) : Math.min(first, second);
  }
  const total = picked + modifier;
  const isCrit = picked >= critMin;
  const isFumble = picked === 1;
  return { first, second, picked, modifier, mode, total, isCrit, isFumble, label };
}

const LOG_KEY = "dnd5e_roll_log";
const LOG_LIMIT = 50;

// The roll log used to be one flat sessionStorage key shared by every
// character sheet in the browser. renderSheet() (sheet.js) calls
// setRollLogCharacter(id) as soon as a sheet is opened, so every roll made
// while that sheet is showing is filed under that character's own key
// instead -- each sheet gets its own independent log. With no character set
// (shouldn't normally happen once a sheet has been opened) rolls fall back
// to the old shared key rather than being lost.
let currentCharacterId = null;

export function setRollLogCharacter(id) {
  currentCharacterId = id || null;
}

function rollLogKey() {
  return currentCharacterId ? `${LOG_KEY}_${currentCharacterId}` : LOG_KEY;
}

export function getRollLog() {
  try {
    return JSON.parse(sessionStorage.getItem(rollLogKey()) || "[]");
  } catch {
    return [];
  }
}

let rollSink = null;
export function setRollSink(fn) { rollSink = typeof fn === "function" ? fn : null; }

export function pushRollLog(entry) {
  try { if (rollSink) rollSink(entry); } catch { /* sink errors never break rolling */ }
  const log = getRollLog();
  log.unshift({ ...entry, at: new Date().toISOString() });
  sessionStorage.setItem(rollLogKey(), JSON.stringify(log.slice(0, LOG_LIMIT)));
  return log;
}

export function clearRollLog() {
  sessionStorage.removeItem(rollLogKey());
}

export function formatModifier(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}
