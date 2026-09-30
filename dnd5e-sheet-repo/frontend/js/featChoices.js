// Shared "extra choices" of feats (spells, languages, weapons, damage type,
// maneuvers) used by the level-up modal and the creation wizard, so a feat
// taken there asks for exactly what the «Черты» tab asks for.
import { on, escapeHtml } from "./dom.js";
import { SPELLS, MANEUVERS, WEAPONS, LANGUAGE_GROUPS } from "./data/dnd5e-data.js";
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
  return { weapons: [], languages: [], element: "fire", spellClass: "wizard", cantrips: [], spell: "", maneuvers: [] };
}

function has(feat) {
  return !!(feat && (feat.weaponChoice || feat.languageChoice || feat.damageTypeChoice || feat.magicInitiateChoice || feat.spellSniperChoice || feat.id === "martial-adept"));
}
export function featHasExtras(feat) { return has(feat); }

function cantripCountOf(feat) { return feat.magicInitiateChoice ? 2 : 1; }

export function featExtrasIncomplete(feat, sel) {
  if (!feat || !sel) return false;
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
}

function addUnique(list, v) { if (Array.isArray(list) && v && !list.includes(v)) list.push(v); }

// Applies the chosen extras: mutates `entry` (name/desc/granted*) and `data`.
export function applyFeatExtras(data, feat, entry, sel) {
  if (!has(feat) || !sel) return;
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
