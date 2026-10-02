// Shared "extra choices" of feats (spells, languages, weapons, damage type,
// maneuvers) used by the level-up modal and the creation wizard, so a feat
// taken there asks for exactly what the «Черты» tab asks for.
import { on, escapeHtml } from "./dom.js";
import { SPELLS, MANEUVERS, WEAPONS, LANGUAGE_GROUPS, SKILLS, TOOLS, TOOL_GROUPS, ABILITIES, FEATS, FEAT_SOURCE_ORDER, METAMAGIC_OPTIONS, ELDRITCH_INVOCATIONS, getClass } from "./data/dnd5e-data.js";
import { spellHoverNameHtml } from "./spellCard.js";

export const FEAT_SPELL_CLASS_OPTIONS = [
  { id: "bard", label: "Бард" }, { id: "cleric", label: "Жрец" }, { id: "druid", label: "Друид" },
  { id: "sorcerer", label: "Чародей" }, { id: "warlock", label: "Колдун" }, { id: "wizard", label: "Волшебник" },
];
export const ELEMENTAL_ADEPT_DAMAGE_TYPES = [
  { id: "acid", label: "Кислота" }, { id: "cold", label: "Холод" }, { id: "fire", label: "Огонь" },
  { id: "lightning", label: "Электричество" }, { id: "thunder", label: "Звук" },
];
export const MARTIAL_ADEPT_POOL_NAME = "Боевое превосходство (Воинский адепт)";

export function newFeatSel() {
  return { weapons: [], languages: [], element: "fire", spellClass: "wizard", cantrips: [], spell: "", maneuvers: [], picks: {} };
}

function has(feat) {
  return !!(feat && (featHasNew(feat) || feat.weaponChoice || feat.languageChoice || feat.damageTypeChoice || feat.magicInitiateChoice || feat.spellSniperChoice || feat.id === "martial-adept"));
}
export function featHasExtras(feat) { return has(feat); }

function cantripCountOf(feat) { return feat.magicInitiateChoice ? 2 : 1; }

export function featExtrasIncomplete(feat, sel, data) {
  if (!feat || !sel) return false;
  if (featPicksIncomplete(feat, sel, data)) return true;
  if (feat.weaponChoice && sel.weapons.length < feat.weaponChoice.count) return true;
  if (feat.languageChoice && sel.languages.length < feat.languageChoice.count) return true;
  if ((feat.magicInitiateChoice || feat.spellSniperChoice) && sel.cantrips.length < cantripCountOf(feat)) return true;
  if (feat.magicInitiateChoice && !sel.spell) return true;
  if (feat.id === "martial-adept" && sel.maneuvers.length < 2) return true;
  return false;
}

export function featExtrasHtml(feat, sel, data) {
  if (!has(feat)) return "";
  const prof = (data && data.proficiencies) || {};
  let html = "";
  if (feat.weaponChoice) {
    html += `<p class="muted" style="margin:6px 0 2px;">Выберите ${feat.weaponChoice.count} вид(а) оружия (${sel.weapons.length}/${feat.weaponChoice.count}):</p>
      <div class="grid cols-3">${WEAPONS.filter((w) => w.id !== "custom" && !(prof.weapons || []).includes(w.name)).map((w) =>
        `<label style="font-weight:normal;"><input type="checkbox" data-fx-weapon value="${escapeHtml(w.name)}" ${sel.weapons.includes(w.name) ? "checked" : ""}
          ${!sel.weapons.includes(w.name) && sel.weapons.length >= feat.weaponChoice.count ? "disabled" : ""} /> ${escapeHtml(w.name)}</label>`).join("")}</div>`;
  }
  if (feat.languageChoice) {
    html += `<p class="muted" style="margin:6px 0 2px;">Выберите ${feat.languageChoice.count} языка(ов) (${sel.languages.length}/${feat.languageChoice.count}):</p>
      <div class="grid cols-3">${LANGUAGE_GROUPS.flatMap((g) => g.items).filter((l) => !(prof.languages || []).includes(l)).map((l) =>
        `<label style="font-weight:normal;"><input type="checkbox" data-fx-language value="${escapeHtml(l)}" ${sel.languages.includes(l) ? "checked" : ""}
          ${!sel.languages.includes(l) && sel.languages.length >= feat.languageChoice.count ? "disabled" : ""} /> ${escapeHtml(l)}</label>`).join("")}</div>`;
  }
  if (feat.damageTypeChoice) {
    html += `<div class="row" style="align-items:center;margin-top:6px;"><label style="margin-right:8px;">Вид урона:</label>
      <select data-fx-element>${ELEMENTAL_ADEPT_DAMAGE_TYPES.map((d) => `<option value="${d.id}" ${d.id === sel.element ? "selected" : ""}>${d.label}</option>`).join("")}</select></div>`;
  }
  if (feat.magicInitiateChoice || feat.spellSniperChoice) {
    const n = cantripCountOf(feat);
    const sc = (data && data.spellcasting) || {};
    const known = new Set([...(sc.cantrips || []), ...(sc.known || [])]);
    let cantrips = SPELLS.filter((s) => s.level === 0 && s.classes.includes(sel.spellClass) && !known.has(s.id));
    if (feat.spellSniperChoice) cantrips = cantrips.filter((s) => /атаку заклинанием/i.test((s.desc || []).join(" ")));
    const spells1 = SPELLS.filter((s) => s.level === 1 && s.classes.includes(sel.spellClass) && !known.has(s.id));
    html += `<div class="row" style="align-items:center;margin-top:6px;"><label style="margin-right:8px;">Класс:</label>
      <select data-fx-spell-class>${FEAT_SPELL_CLASS_OPTIONS.map((c) => `<option value="${c.id}" ${c.id === sel.spellClass ? "selected" : ""}>${c.label}</option>`).join("")}</select></div>
      <p class="muted" style="margin:6px 0 2px;">Выберите ${n} заговор(а)${feat.spellSniperChoice ? " (требующий броска атаки)" : ""} (${sel.cantrips.length}/${n}):</p>
      <div class="grid cols-2">${cantrips.map((s) => `<label class="row" style="gap:6px;font-weight:normal;">
        <input type="checkbox" data-fx-cantrip value="${s.id}" ${sel.cantrips.includes(s.id) ? "checked" : ""} ${!sel.cantrips.includes(s.id) && sel.cantrips.length >= n ? "disabled" : ""} />
        ${spellHoverNameHtml(s)}</label>`).join("")}</div>`;
    if (feat.magicInitiateChoice) {
      html += `<p class="muted" style="margin:6px 0 2px;">Выберите заклинание 1-го уровня:</p>
      <div class="grid cols-2">${spells1.map((s) => `<label class="row" style="gap:6px;font-weight:normal;">
        <input type="radio" name="fx-spell1" data-fx-spell1 value="${s.id}" ${s.id === sel.spell ? "checked" : ""} />${spellHoverNameHtml(s)}</label>`).join("")}</div>`;
    }
  }
  if (feat.id === "martial-adept") {
    html += `<p class="muted" style="margin:6px 0 2px;">Выберите 2 приёма (${sel.maneuvers.length}/2):</p>
      <div class="grid cols-2">${MANEUVERS.map((m) => `<label class="row" style="gap:6px;align-items:flex-start;font-weight:normal;">
        <input type="checkbox" data-fx-maneuver value="${m.id}" ${sel.maneuvers.includes(m.id) ? "checked" : ""} ${!sel.maneuvers.includes(m.id) && sel.maneuvers.length >= 2 ? "disabled" : ""} />
        <span><strong>${escapeHtml(m.name)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(m.desc)}</span></span></label>`).join("")}</div>`;
  }
  html += featPicksHtml(feat, sel, data);
  return `<div class="feat-extras" style="margin-top:6px;">${html}</div>`;
}

function toggle(list, v, checked, max) {
  const i = list.indexOf(v);
  if (checked && i < 0 && list.length < max) list.push(v);
  if (!checked && i >= 0) list.splice(i, 1);
}

// getFeat() returns the currently chosen feat; rerender() re-draws the host UI.
export function wireFeatExtras(root, getSel, getFeat, rerender) {
  const S = () => (typeof getSel === "function" ? getSel() : getSel);
  on(root, "change", "[data-fx-weapon]", (e, el) => { const f = getFeat(); toggle(S().weapons, el.value, el.checked, (f && f.weaponChoice ? f.weaponChoice.count : 9)); rerender(); });
  on(root, "change", "[data-fx-language]", (e, el) => { const f = getFeat(); toggle(S().languages, el.value, el.checked, (f && f.languageChoice ? f.languageChoice.count : 9)); rerender(); });
  on(root, "change", "[data-fx-element]", (e, el) => { S().element = el.value; });
  on(root, "change", "[data-fx-spell-class]", (e, el) => { const s = S(); s.spellClass = el.value; s.cantrips = []; s.spell = ""; rerender(); });
  on(root, "change", "[data-fx-cantrip]", (e, el) => { const f = getFeat(); toggle(S().cantrips, el.value, el.checked, f ? cantripCountOf(f) : 2); rerender(); });
  on(root, "change", "[data-fx-spell1]", (e, el) => { S().spell = el.value; rerender(); });
  on(root, "change", "[data-fx-maneuver]", (e, el) => { toggle(S().maneuvers, el.value, el.checked, 2); rerender(); });
  wireFeatPicks(root, getSel, getFeat, rerender);
}

function addUnique(list, v) { if (Array.isArray(list) && v && !list.includes(v)) list.push(v); }

// Applies the chosen extras: mutates `entry` (name/desc/granted*) and `data`.
export function applyFeatExtras(data, feat, entry, sel) {
  if (!has(feat) || !sel) return;
  applyFeatPicks(data, feat, entry, sel);
  data.proficiencies = data.proficiencies || {};
  if (feat.damageTypeChoice) {
    const label = (ELEMENTAL_ADEPT_DAMAGE_TYPES.find((d) => d.id === sel.element) || {}).label;
    if (label) {
      entry.name = `${feat.name} (${label})`;
      entry.desc = feat.desc.replace(/^Когда вы получаете это умение, выберите[^.]*\./, `Выбранный вид урона: ${label}.`);
    }
  }
  if (feat.weaponChoice) {
    data.proficiencies.weapons = data.proficiencies.weapons || [];
    const ws = sel.weapons.slice(0, feat.weaponChoice.count);
    ws.forEach((w) => addUnique(data.proficiencies.weapons, w));
    entry.grantedWeapons = ws;
  }
  if (feat.languageChoice) {
    data.proficiencies.languages = data.proficiencies.languages || [];
    const ls = sel.languages.slice(0, feat.languageChoice.count);
    ls.forEach((l) => addUnique(data.proficiencies.languages, l));
    entry.grantedLanguages = ls;
  }
  if (feat.magicInitiateChoice || feat.spellSniperChoice) {
    const n = cantripCountOf(feat);
    const cantrips = sel.cantrips.slice(0, n);
    if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
    data.spellcasting.cantrips = data.spellcasting.cantrips || [];
    data.spellcasting.known = data.spellcasting.known || [];
    if (!data.spellcasting.ability) {
      data.spellcasting.ability = { bard: "cha", warlock: "cha", sorcerer: "cha", wizard: "int", cleric: "wis", druid: "wis" }[sel.spellClass] || "int";
    }
    cantrips.forEach((id) => addUnique(data.spellcasting.cantrips, id));
    entry.grantedCantrips = cantrips;
    if (feat.magicInitiateChoice && sel.spell) {
      addUnique(data.spellcasting.known, sel.spell);
      entry.grantedSpell = sel.spell;
    }
  }
  if (feat.id === "martial-adept") {
    data.features = data.features || [];
    const source = `Черта (${feat.name})`;
    sel.maneuvers.slice(0, 2).forEach((id) => {
      const m = MANEUVERS.find((mm) => mm.id === id);
      if (!m || data.features.some((f) => f.name === m.name && f.source === source)) return;
      data.features.push({ name: m.name, source, desc: m.desc });
    });
    data.features.push({
      name: MARTIAL_ADEPT_POOL_NAME,
      source,
      desc: "Даёт одну кость превосходства к6, используемую для выбранных приёмов. Тратится при использовании, восстанавливается после окончания короткого или продолжительного отдыха.",
    });
  }
}


// =====================================================================
// Раунд 60: данные-управляемые черты (picks / grant / cards) из всех источников.
//   feat.picks  — выборы при взятии черты (характеристика, заклинания, навыки, …);
//   feat.grant  — фиксированные выдачи (заговоры, бесплатные заклинания, владения, …);
//   feat.cards  — карточки умений, добавляемые в «Умения» (cards[i].rider — кубик в окне урона).
// =====================================================================
export function featHasPicks(f) { return !!(f && f.picks && f.picks.length); }
export function featHasNew(f) { return !!(f && ((f.picks && f.picks.length) || f.grant || (f.cards && f.cards.length))); }

// Единое оформление шапки черты (название, источник, требование, описание) —
// одинаково на вкладке «Черты», в мастере создания и в окне повышения уровня.
export function featInfoHtml(feat, opts = {}) {
  if (!feat) return "";
  const src = feat.source || "Книга игрока";
  return `
    <h4 style="margin:0 0 4px;">${escapeHtml(feat.name)}${feat.nameEn ? ` <span class="muted" style="font-weight:normal;font-size:0.8rem;">[${escapeHtml(feat.nameEn)}]</span>` : ""}</h4>
    <p class="muted" style="margin:0 0 4px;font-size:0.8rem;">${escapeHtml(src)}</p>
    ${opts.takenHtml || ""}
    ${feat.prereq ? `<p class="muted" style="margin:0 0 4px;">Требование: ${escapeHtml(feat.prereq)}</p>` : ""}
    <p style="margin:0 0 8px;white-space:pre-line;">${escapeHtml(feat.desc || "")}</p>`;
}

// <optgroup> по источникам для всех выпадающих списков черт.
export function featSelectOptionsHtml(selectedId, filterFn) {
  const groups = new Map();
  FEATS.forEach((f) => {
    if (filterFn && !filterFn(f)) return;
    const src = f.source || "Книга игрока";
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src).push(f);
  });
  const order = [...(FEAT_SOURCE_ORDER || [])];
  [...groups.keys()].forEach((k) => { if (!order.includes(k)) order.push(k); });
  return order
    .filter((src) => groups.has(src))
    .map((src) => `<optgroup label="${escapeHtml(src)}">${groups.get(src).slice().sort((a, b) => a.name.localeCompare(b.name, "ru"))
      .map((f) => `<option value="${f.id}" ${f.id === selectedId ? "selected" : ""}>${escapeHtml(f.name)}</option>`).join("")}</optgroup>`)
    .join("");
}

const abLabel = (id) => (ABILITIES.find((a) => a.id === id) || {}).label || id;
const skillLabel = (id) => (SKILLS.find((s) => s.id === id) || {}).label || id;
function scOf(data) { return (data && data.spellcasting) || {}; }
function knownSpellSet(data) {
  const sc = scOf(data);
  return new Set([...(sc.cantrips || []), ...(sc.known || []), ...(sc.prepared || [])]);
}
function picksOf(sel) { if (!sel.picks) sel.picks = {}; return sel.picks; }
function ensureDefaults(feat, sel) {
  const pk = picksOf(sel);
  (feat.picks || []).forEach((p) => { if (p.kind === "ability" && !pk[p.key]) pk[p.key] = p.options[0]; });
}
function effParams(p, sel) {
  if (!p.byKey) return p;
  const v = picksOf(sel)[p.byKey];
  if (!v) return null;
  return Object.assign({}, p, (p.map || {})[v] || {});
}
function spellCandidates(p, sel, data) {
  const q = effParams(p, sel);
  if (!q) return [];
  const known = knownSpellSet(data);
  const already = new Set();
  (sel.picks ? Object.values(sel.picks) : []).forEach((v) => { if (Array.isArray(v)) v.forEach((x) => already.add(x)); });
  const mine = new Set(picksOf(sel)[p.key] || []);
  let list = SPELLS.filter((s) => s.level === p.level);
  if (q.ids) list = list.filter((s) => q.ids.includes(s.id));
  if (q.lists) list = list.filter((s) => (s.classes || []).some((c) => q.lists.includes(c)));
  if (q.schools) list = list.filter((s) => q.schools.some((sch) => String(s.school || "").startsWith(sch)));
  list = list.filter((s) => mine.has(s.id) || (!known.has(s.id) && !already.has(s.id)));
  return list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
function skillCandidates(p, sel, data) {
  const prof = new Set((data.proficiencies && data.proficiencies.skills) || []);
  const exp = new Set((data.proficiencies && data.proficiencies.expertise) || []);
  const pk = picksOf(sel);
  const mine = pk[p.key] || [];
  if (p.expertise) {
    Object.keys(pk).forEach((k) => { if (k !== p.key && Array.isArray(pk[k])) pk[k].forEach((x) => { if (SKILLS.some((s) => s.id === x)) prof.add(x); }); });
    return SKILLS.filter((s) => (prof.has(s.id) && !exp.has(s.id)) || mine.includes(s.id));
  }
  const others = new Set();
  Object.keys(pk).forEach((k) => { if (k !== p.key && Array.isArray(pk[k])) pk[k].forEach((x) => others.add(x)); });
  return SKILLS.filter((s) => (!prof.has(s.id) && !others.has(s.id)) || mine.includes(s.id));
}
function toolCandidates(p, sel, data) {
  const have = new Set((data.proficiencies && data.proficiencies.tools) || []);
  const items = p.group === "artisan" ? ((TOOL_GROUPS[0] && TOOL_GROUPS[0].items) || TOOLS) : TOOLS;
  const mine = picksOf(sel)[p.key] || [];
  return items.filter((t) => !have.has(t) || mine.includes(t));
}
function languageCandidates(p, sel, data) {
  const have = new Set((data.proficiencies && data.proficiencies.languages) || []);
  const mine = picksOf(sel)[p.key] || [];
  return LANGUAGE_GROUPS.flatMap((g) => g.items).filter((l) => !have.has(l) || mine.includes(l));
}
function fightStyleCandidates(data) {
  const cls = getClass("fighter");
  const opts = (cls && cls.level1Choice && cls.level1Choice.options) || [];
  const names = new Set((data.features || []).map((f) => f.name));
  return opts.filter((o) => !names.has(o.name));
}
function warlockLevel(data) {
  const w = (data.classes || []).find((c) => c.id === "warlock");
  return w ? Number(w.level) || 0 : 0;
}
function invocationMet(inv, data) {
  const r = inv.req || "";
  if (!r) return true;
  const lv = /(\d+)-й уровень колдуна/.exec(r);
  if (lv && warlockLevel(data) < Number(lv[1])) return false;
  const pact = /умение «([^»]+)»/.exec(r);
  if (pact && !(data.features || []).some((f) => f.name === pact[1] || (f.name || "").startsWith(pact[1]))) return false;
  if (/мистический заряд/.test(r) && !(scOf(data).cantrips || []).includes("eldritch-blast")) return false;
  return true;
}
function countOf(p) { return p.count || 1; }
function candidatesFor(p, sel, data) {
  if (p.kind === "spell") return spellCandidates(p, sel, data).map((s) => s.id);
  if (p.kind === "skill") return skillCandidates(p, sel, data).map((s) => s.id);
  if (p.kind === "tool") return toolCandidates(p, sel, data);
  if (p.kind === "language") return languageCandidates(p, sel, data);
  if (p.kind === "metamagic") return METAMAGIC_OPTIONS.map((m) => m.name);
  return [];
}

export function featPicksIncomplete(feat, sel, data) {
  if (!featHasPicks(feat) || !sel) return false;
  ensureDefaults(feat, sel);
  const pk = picksOf(sel);
  return feat.picks.some((p) => {
    const v = pk[p.key];
    if (p.kind === "ability") return !v;
    if (p.kind === "option" || p.kind === "fightstyle") return !v;
    if (p.kind === "invocation") return !v;
    if (p.byKey && !pk[p.byKey]) return true;
    const need = Math.min(countOf(p), candidatesFor(p, sel, data || {}).length);
    return (Array.isArray(v) ? v.length : 0) < need;
  });
}

function checkGridHtml(attr, key, items, chosen, max, labelFn) {
  return `<div class="grid cols-2">${items.map((it) => {
    const id = it.id || it;
    const on = chosen.includes(id);
    return `<label class="row" style="gap:6px;align-items:flex-start;font-weight:normal;"><input type="checkbox" ${attr}="${escapeHtml(key)}" value="${escapeHtml(id)}" ${on ? "checked" : ""} ${!on && chosen.length >= max ? "disabled" : ""} />${labelFn(it)}</label>`;
  }).join("")}</div>`;
}

// Черта уже есть у персонажа (и её нельзя брать повторно).
export function featAlreadyTaken(feat, data) {
  return !!(feat && !feat.repeatable && ((data && data.feats) || []).some((f) => f.id === feat.id));
}
export const FEAT_TAKEN_MESSAGE = "Вы уже владеете этой чертой.";

// Владение бронёй/оружием по категориям: «Лёгкая броня» уже покрыта строкой класса «Лёгкая, средняя броня, щиты».
const PROF_CATEGORY_RE = { "Лёгкая броня": /легк/, "Средняя броня": /средн/, "Тяжёлая броня": /тяжел/, "Щиты": /щит/, "Воинское оружие": /воинск/, "Простое оружие": /прост/ };
const profNorm = (t) => String(t || "").toLowerCase().replace(/ё/g, "е");
export function proficiencyCovered(list, value) {
  if (!Array.isArray(list)) return false;
  if (list.includes(value)) return true;
  const re = PROF_CATEGORY_RE[value];
  if (!re) return false;
  return list.some((x) => x !== value && re.test(profNorm(x)));
}
// Убирает дубли вида «Лёгкая броня» рядом с «Лёгкая, средняя броня, щиты».
export function dedupeProficiencyCategories(list) {
  if (!Array.isArray(list)) return false;
  let changed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i];
    if (PROF_CATEGORY_RE[v] && list.some((x, j) => j !== i && x !== v && PROF_CATEGORY_RE[v].test(profNorm(x)))) { list.splice(i, 1); changed = true; }
  }
  return changed;
}

// Фиксированные заклинания/заговоры, которые черта даёт сама: имена с всплывающей карточкой при наведении.
const GRANT_USE_LABEL = { atwill: "без ограничений", long: "1 раз за продолжительный отдых", short: "1 раз за короткий/продолжительный отдых", any: "1 раз за любой отдых", ritual: "как ритуал" };
export function featGrantSpellsHtml(feat) {
  const g = (feat && feat.grant) || {};
  const items = [];
  (g.cantrips || []).forEach((id) => { const sp = SPELLS.find((x) => x.id === id); if (sp) items.push(`${spellHoverNameHtml(sp)} <span class="muted">(заговор)</span>`); });
  (g.spells || []).forEach((x) => { const sp = SPELLS.find((y) => y.id === x.id); if (sp) items.push(`${spellHoverNameHtml(sp)} <span class="muted">(${escapeHtml(GRANT_USE_LABEL[x.use] || "")})</span>`); });
  if (!items.length) return "";
  return `<p class="muted" style="margin:8px 0 2px;">Заклинания от черты (наведите, чтобы увидеть карточку):</p><div class="row" style="gap:14px;flex-wrap:wrap;">${items.map((i) => `<span>${i}</span>`).join("")}</div>`;
}

export function featPicksHtml(feat, sel, data) {
  const grantHead = featGrantSpellsHtml(feat);
  if (!featHasPicks(feat)) return grantHead ? `<div class="feat-picks" style="margin-top:6px;">${grantHead}</div>` : "";
  ensureDefaults(feat, sel);
  const pk = picksOf(sel);
  data = data || {};
  const blocks = feat.picks.map((p) => {
    const v = pk[p.key];
    if (p.kind === "ability") {
      return `<div class="row" style="align-items:center;margin-top:6px;"><label style="margin-right:8px;">${escapeHtml(p.label)}:</label>
        <select data-fp-select="${p.key}">${p.options.map((a) => `<option value="${a}" ${a === v ? "selected" : ""}>${escapeHtml(abLabel(a))}</option>`).join("")}</select></div>`;
    }
    if (p.kind === "option") {
      return `<div class="row" style="align-items:center;margin-top:6px;"><label style="margin-right:8px;">${escapeHtml(p.label)}:</label>
        <select data-fp-select="${p.key}"><option value="">— выберите —</option>${p.options.map((o) => `<option value="${escapeHtml(o.id)}" ${o.id === v ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select></div>`;
    }
    if (p.byKey && !pk[p.byKey]) {
      return `<p class="muted" style="margin:6px 0 2px;">${escapeHtml(p.label)}: сначала сделайте предыдущий выбор.</p>`;
    }
    const chosen = Array.isArray(v) ? v : [];
    const n = countOf(p);
    if (p.kind === "spell") {
      const cands = spellCandidates(p, sel, data);
      return `<p class="muted" style="margin:8px 0 2px;">${escapeHtml(p.label)} (${chosen.length}/${Math.min(n, cands.length)}):</p>
        ${cands.length ? checkGridHtml("data-fp-check", p.key, cands, chosen, n, (s) => spellHoverNameHtml(s)) : '<p class="muted">Нет подходящих заклинаний.</p>'}`;
    }
    if (p.kind === "skill") {
      const cands = skillCandidates(p, sel, data);
      return `<p class="muted" style="margin:8px 0 2px;">${escapeHtml(p.label)} (${chosen.length}/${n}):</p>
        ${checkGridHtml("data-fp-check", p.key, cands.map((s) => ({ id: s.id, label: s.label })), chosen, n, (s) => escapeHtml(s.label))}`;
    }
    if (p.kind === "tool" || p.kind === "language") {
      const cands = candidatesFor(p, sel, data);
      return `<p class="muted" style="margin:8px 0 2px;">${escapeHtml(p.label)} (${chosen.length}/${n}):</p>
        ${checkGridHtml("data-fp-check", p.key, cands, chosen, n, (t) => escapeHtml(t))}`;
    }
    if (p.kind === "metamagic") {
      return `<p class="muted" style="margin:8px 0 2px;">${escapeHtml(p.label)} (${chosen.length}/${n}):</p>
        <div class="grid cols-2">${METAMAGIC_OPTIONS.map((m) => {
          const on = chosen.includes(m.name);
          return `<label class="row" style="gap:6px;align-items:flex-start;font-weight:normal;"><input type="checkbox" data-fp-check="${p.key}" value="${escapeHtml(m.name)}" ${on ? "checked" : ""} ${!on && chosen.length >= n ? "disabled" : ""} />
            <span><strong>${escapeHtml(m.name)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(m.desc)}</span></span></label>`;
        }).join("")}</div>`;
    }
    if (p.kind === "fightstyle") {
      const cands = fightStyleCandidates(data);
      return `<p class="muted" style="margin:8px 0 2px;">${escapeHtml(p.label)}:</p>
        <div class="grid cols-2">${cands.map((o) => `<label class="row" style="gap:6px;align-items:flex-start;font-weight:normal;"><input type="radio" name="fp-${p.key}" data-fp-radio="${p.key}" value="${escapeHtml(o.name)}" ${o.name === v ? "checked" : ""} />
          <span><strong>${escapeHtml(o.name)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(o.desc)}</span></span></label>`).join("")}</div>`;
    }
    if (p.kind === "invocation") {
      return `<p class="muted" style="margin:8px 0 2px;">${escapeHtml(p.label)} (требования проверяются по вашему колдуну):</p>
        <div class="grid cols-2">${ELDRITCH_INVOCATIONS.map((o) => {
          const ok = invocationMet(o, data);
          return `<label class="row" style="gap:6px;align-items:flex-start;font-weight:normal;${ok ? "" : "opacity:.5;"}"><input type="radio" name="fp-${p.key}" data-fp-radio="${p.key}" value="${escapeHtml(o.name)}" ${o.name === v ? "checked" : ""} ${ok ? "" : "disabled"} />
            <span><strong>${escapeHtml(o.name)}</strong>${o.req ? ` <span class="muted">(${escapeHtml(o.req)})</span>` : ""}<br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(o.desc)}</span></span></label>`;
        }).join("")}</div>`;
    }
    return "";
  });
  return `<div class="feat-picks" style="margin-top:6px;">${grantHead}${blocks.join("")}</div>`;
}

export function wireFeatPicks(root, getSel, getFeat, rerender) {
  const S = () => (typeof getSel === "function" ? getSel() : getSel);
  const pickDef = (key) => { const f = getFeat(); return f && (f.picks || []).find((p) => p.key === key); };
  const clearDependents = (sel, key) => {
    const f = getFeat();
    ((f && f.picks) || []).forEach((p) => { if (p.byKey === key) delete picksOf(sel)[p.key]; });
  };
  on(root, "change", "[data-fp-select]", (e, el) => { const sel = S(); picksOf(sel)[el.dataset.fpSelect] = el.value; clearDependents(sel, el.dataset.fpSelect); rerender(); });
  on(root, "change", "[data-fp-radio]", (e, el) => { picksOf(S())[el.dataset.fpRadio] = el.value; rerender(); });
  on(root, "change", "[data-fp-check]", (e, el) => {
    const p = pickDef(el.dataset.fpCheck); if (!p) return;
    const pk = picksOf(S()); const arr = Array.isArray(pk[p.key]) ? pk[p.key] : (pk[p.key] = []);
    const i = arr.indexOf(el.value);
    if (el.checked && i < 0 && arr.length < countOf(p)) arr.push(el.value);
    if (!el.checked && i >= 0) arr.splice(i, 1);
    rerender();
  });
}

// ---------------------------------------------------------------------
function addUniq(list, v) { if (Array.isArray(list) && v !== undefined && v !== null && v !== "" && !list.includes(v)) { list.push(v); return true; } return false; }
const RECHARGE_PHRASE = {
  long: "не более одного раза за продолжительный отдых",
  any: "не более одного раза за короткий или продолжительный отдых",
  short: "не более одного раза за короткий отдых",
};
function ensureSpellcasting(data, abilityId) {
  if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
  const sc = data.spellcasting;
  if (!sc.cantrips) sc.cantrips = [];
  if (!sc.known) sc.known = [];
  if (!sc.ability) sc.ability = abilityId || "int";
  return sc;
}
function pushCard(data, entry, card) {
  data.features = data.features || [];
  const source = `Черта (${entry.baseName || entry.name})`;
  if (data.features.some((f) => f.name === card.name && f.source === source)) return;
  const f = { name: card.name, source, desc: card.desc };
  if (card.rider) f.rider = card.rider;
  data.features.push(f);
  entry.fx.cards.push(card.name);
}

// Применяет picks/grant/cards черты. Вызывается после того, как entry.grantedAbility уже выставлен.
export function applyFeatPicks(data, feat, entry, sel) {
  if (!featHasNew(feat)) return;
  sel = sel || newFeatSel();
  ensureDefaults(feat, sel);
  const pk = picksOf(sel);
  const grant = feat.grant || {};
  entry.baseName = feat.name;
  entry.fx = { cards: [], cantrips: [], known: [], skills: [], expertise: [], tools: [], languages: [], weapons: [], attacks: [], weaponItems: [] };
  data.proficiencies = data.proficiencies || {};
  ["skills", "expertise", "tools", "languages", "weapons", "armor"].forEach((k) => { if (!Array.isArray(data.proficiencies[k])) data.proficiencies[k] = []; });
  data.features = data.features || [];

  // базовая характеристика заклинаний/умений черты
  const abPick = (feat.picks || []).find((p) => p.kind === "ability");
  const abilityId = (abPick && pk[abPick.key]) || grant.abilityFixed || entry.grantedAbility || (feat.abilityIncrease && feat.abilityIncrease.choices[0]) || "int";
  const ability = abLabel(abilityId);
  const fill = (t) => String(t || "").replace(/\{ability\}/g, ability);
  const needSpells = (grant.spells && grant.spells.length) || (grant.cantrips && grant.cantrips.length) || (feat.picks || []).some((p) => p.kind === "spell");
  const sc = needSpells ? ensureSpellcasting(data, abilityId) : null;
  const name = feat.name;

  const addCantrip = (id) => { if (!sc) return; if (!knownSpellSet(data).has(id)) { sc.cantrips.push(id); entry.fx.cantrips.push(id); } };
  const addFreeSpell = (id, use) => {
    const sp = SPELLS.find((s) => s.id === id);
    if (!sp || !sc) return;
    if (!knownSpellSet(data).has(id)) { sc.known.push(id); entry.fx.known.push(id); }
    let desc;
    if (use === "atwill") desc = `Вы можете накладывать заклинание «${sp.name}» без ограничений, не тратя ячейку заклинания. Базовая характеристика: ${ability}.`;
    else if (use === "ritual") desc = `Вы можете накладывать заклинание «${sp.name}» как ритуал. Базовая характеристика: ${ability}.`;
    else desc = `Вы можете накладывать заклинание «${sp.name}» без траты ячейки заклинания — ${RECHARGE_PHRASE[use] || RECHARGE_PHRASE.long}. Вы также можете накладывать его, используя имеющиеся ячейки подходящего уровня. Базовая характеристика: ${ability}.`;
    const cardName = `${sp.name} (${name})`;
    pushCard(data, entry, { name: cardName, desc });
    if (!sc.granted) sc.granted = {};
    if (!sc.granted[id]) sc.granted[id] = cardName;
  };

  (grant.cantrips || []).forEach(addCantrip);
  (grant.spells || []).forEach((s) => addFreeSpell(s.id, s.use));
  (grant.tools || []).forEach((t) => { if (addUniq(data.proficiencies.tools, t)) entry.fx.tools.push(t); });
  (grant.weapons || []).forEach((w) => { if (!proficiencyCovered(data.proficiencies.weapons, w) && addUniq(data.proficiencies.weapons, w)) entry.fx.weapons.push(w); });
  (grant.languages || []).forEach((l) => { if (addUniq(data.proficiencies.languages, l)) entry.fx.languages.push(l); });
  (grant.skills || []).forEach((k) => { if (addUniq(data.proficiencies.skills, k)) entry.fx.skills.push(k); });
  if (grant.weaponItem) {
    const w = grant.weaponItem;
    data.weapons = data.weapons || [];
    if (!data.weapons.some((x) => x.name === w.name)) {
      data.weapons.push({ name: w.name, damage: w.damage, type: w.type, properties: w.properties, special: "", equipped: true, rangeType: w.rangeType || "melee" });
      data.attacks = data.attacks || [];
      data.attacks.push({ name: w.name, bonus: "", damage: `${w.damage} ${w.type}`.trim(), special: "", useSpecial: false, rangeType: w.rangeType || "melee", hand: "" });
      entry.fx.weaponItems.push(w.name);
    }
  }
  if (grant.attack) {
    const a = grant.attack;
    data.attacks = data.attacks || [];
    if (!data.attacks.some((x) => x.name === a.name)) {
      data.attacks.push({ name: a.name, bonus: "", damage: a.damage, special: "", useSpecial: false, rangeType: a.rangeType || "melee", ability: a.ability || "str", hand: "" });
      entry.fx.attacks.push(a.name);
    }
  }

  // выборы
  const chosen = (key) => (Array.isArray(pk[key]) ? pk[key] : []);
  (feat.picks || []).forEach((p) => {
    const v = pk[p.key];
    if (p.kind === "spell") {
      const ids = chosen(p.key);
      ids.forEach((id) => {
        if (p.cast === "cantrip") addCantrip(id);
        else if (p.cast === "free-any") addFreeSpell(id, "any");
        else if (p.cast === "free-short") addFreeSpell(id, "short");
        else if (p.cast === "known") { if (sc && !knownSpellSet(data).has(id)) { sc.known.push(id); entry.fx.known.push(id); } }
        else addFreeSpell(id, "long");
      });
    } else if (p.kind === "skill" && !p.expertise) {
      chosen(p.key).forEach((k) => { if (addUniq(data.proficiencies.skills, k)) entry.fx.skills.push(k); });
    } else if (p.kind === "tool") {
      chosen(p.key).forEach((t) => { if (addUniq(data.proficiencies.tools, t)) entry.fx.tools.push(t); });
    } else if (p.kind === "language") {
      chosen(p.key).forEach((l) => { if (addUniq(data.proficiencies.languages, l)) entry.fx.languages.push(l); });
    } else if (p.kind === "option") {
      const o = (p.options || []).find((x) => x.id === v);
      if (!o) return;
      if (o.skill && addUniq(data.proficiencies.skills, o.skill)) entry.fx.skills.push(o.skill);
      if (o.cantrip) addCantrip(o.cantrip);
      if (o.spell) {
        const sp = SPELLS.find((s) => s.id === o.spell);
        pushCard(data, entry, { name: `Руна: ${o.label.split(" — ")[0]}`, desc: `Руна «${o.label.split(" — ")[0]}»: заклинание «${sp ? sp.name : o.spell}» (1-й уровень). Вы знаете это заклинание, пока не окончите продолжительный отдых (затем руну можно нанести заново). Вызвав руну на предмете, вы накладываете это заклинание без ячейки и материальных компонентов — не более одного раза за продолжительный отдых. Базовая характеристика: ${ability}.` });
      }
      if (o.card) pushCard(data, entry, { name: o.card.name, desc: fill(o.card.desc), rider: o.card.rider });
    }
  });
  // компетентность — после остальных навыков
  (feat.picks || []).forEach((p) => {
    if (p.kind === "skill" && p.expertise) chosen(p.key).forEach((k) => { if (addUniq(data.proficiencies.skills, k)) entry.fx.skills.push(k); if (addUniq(data.proficiencies.expertise, k)) entry.fx.expertise.push(k); });
  });
  (feat.picks || []).forEach((p) => {
    const v = pk[p.key];
    if (p.kind === "fightstyle" && v) {
      const o = fightStyleCandidates(data).find((x) => x.name === v) || ((getClass("fighter").level1Choice || {}).options || []).find((x) => x.name === v);
      if (o) pushCard(data, entry, { name: o.name, desc: o.desc });
    } else if (p.kind === "metamagic") {
      chosen(p.key).forEach((nm) => { const m = METAMAGIC_OPTIONS.find((x) => x.name === nm); if (m) pushCard(data, entry, { name: `Метамагия: ${m.name}`, desc: m.desc }); });
    } else if (p.kind === "invocation" && v) {
      const o = ELDRITCH_INVOCATIONS.find((x) => x.name === v);
      if (o) pushCard(data, entry, { name: `Воззвание: ${o.name}`, desc: `${o.desc} Базовая характеристика: ${ability}.` });
    }
  });
  (feat.cards || []).forEach((c) => pushCard(data, entry, { name: c.name, desc: fill(c.desc), rider: c.rider }));
}

// Откат того, что выдала черта (карточки, заклинания, владения). Вызывается при удалении черты.
export function revertFeatExtras(data, entry) {
  const fx = entry && entry.fx;
  if (!fx) return;
  const source = `Черта (${entry.baseName || entry.name})`;
  const gone = new Set();
  data.features = (data.features || []).filter((f) => {
    if (f.source === source && fx.cards.includes(f.name)) { gone.add(f.name); return false; }
    return true;
  });
  const sc = data.spellcasting;
  if (sc) {
    sc.cantrips = (sc.cantrips || []).filter((id) => !fx.cantrips.includes(id));
    sc.known = (sc.known || []).filter((id) => !fx.known.includes(id));
    if (sc.granted) Object.keys(sc.granted).forEach((id) => { if (gone.has(sc.granted[id])) delete sc.granted[id]; });
  }
  const pr = data.proficiencies || {};
  const rm = (key, vals) => { if (Array.isArray(pr[key])) pr[key] = pr[key].filter((x) => !(vals || []).includes(x)); };
  rm("skills", fx.skills); rm("expertise", fx.expertise); rm("tools", fx.tools); rm("languages", fx.languages); rm("weapons", fx.weapons);
  if (fx.attacks && fx.attacks.length) data.attacks = (data.attacks || []).filter((a) => !fx.attacks.includes(a.name));
  if (fx.weaponItems && fx.weaponItems.length) {
    data.weapons = (data.weapons || []).filter((w) => !fx.weaponItems.includes(w.name));
    data.attacks = (data.attacks || []).filter((a) => !fx.weaponItems.includes(a.name));
  }
}
