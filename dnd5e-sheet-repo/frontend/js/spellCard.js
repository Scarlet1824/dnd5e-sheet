// Shared "ornate card" renderer for a spell/cantrip, used both on the
// character sheet (known/prepared spells + a browsable add-list) and in the
// creation wizard (picking cantrips/1st-level spells for a new caster).
import { escapeHtml } from "./dom.js";
import { getClass } from "./data/dnd5e-data.js";

// Short glyphs used in the spell-card icon circle, keyed by school (Russian
// name as stored on each spell). Falls back to a generic sparkle.
const SCHOOL_ICONS = {
  "Вызов": "✦", "Иллюзия": "◈", "Некромантия": "☠", "Ограждение": "🛡",
  "Очарование": "❦", "Преобразование": "🌀", "Прорицание": "👁", "Воплощение": "☄",
};
export function schoolIcon(school) {
  return SCHOOL_ICONS[school] || "✳";
}

// Russian display name for a class id, used on spell cards.
export function classLabel(id) {
  const cls = getClass(id);
  return cls ? cls.name : id;
}

// Renders one spell/cantrip as an ornate card: icon + title + subtitle, a
// property grid (casting time / range / components / duration / classes),
// then the description paragraphs. `desc` is stored as an array of
// paragraphs (the last is usually the "At Higher Levels" note).
// `checkboxHtml` is the caller's own <input>/markup for the top-right
// toggle (each caller wires its own selection logic and limits), and
// `known` just controls the card's gold-highlight border.
export function spellCardHtml(sp, checkboxHtml, { known = false, domain = false } = {}) {
  const descParagraphs = Array.isArray(sp.desc) ? sp.desc : [sp.desc].filter(Boolean);
  const subtitle = `${sp.level === 0 ? "Заговор" : `${sp.level}-й круг`}, ${escapeHtml(sp.school || "")}` +
    (sp.ritual ? " (ритуал)" : "");
  // Пометка «даётся умением/расой/…» — отдельной строкой НАД названием, чтобы не сжимала заголовок.
  const badgeAbove = typeof checkboxHtml === "string" && /spell-card-badge-domain/.test(checkboxHtml);
  return `
    <div class="spell-card ${known ? "known" : ""} ${domain ? "domain-spell" : ""}" data-spell-id="${sp.id}">
      ${badgeAbove ? `<div class="spell-card-grant-row">${checkboxHtml}</div>` : ""}
      <div class="spell-card-header">
        <div class="spell-card-icon" title="${escapeHtml(sp.school || "")}">${schoolIcon(sp.school)}</div>
        <div class="spell-card-title-group">
          <h4 class="spell-card-title">${escapeHtml(sp.name)}</h4>
          <p class="spell-card-subtitle">${subtitle}</p>
        </div>
        ${badgeAbove ? "" : `<label class="spell-card-toggle" title="Известно / подготовлено">${checkboxHtml}</label>`}
      </div>
      <div class="spell-card-props">
        <div class="spell-card-prop"><span class="prop-label">Время накладывания</span><span>${escapeHtml(sp.castingTime || "—")}</span></div>
        <div class="spell-card-prop"><span class="prop-label">Дистанция</span><span>${escapeHtml(sp.range || "—")}</span></div>
        <div class="spell-card-prop"><span class="prop-label">Компоненты</span><span>${escapeHtml(sp.components || "—")}</span></div>
        <div class="spell-card-prop"><span class="prop-label">Длительность</span><span>${escapeHtml(sp.duration || "—")}${sp.concentration ? " (конц.)" : ""}</span></div>
        <div class="spell-card-prop spell-card-classes"><span class="prop-label">Классы</span><span>${(sp.classes || []).map(classLabel).join(", ") || "—"}</span></div>
      </div>
      <div class="spell-card-desc">
        ${descParagraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}
      </div>
    </div>`;
}

// A spell/cantrip's plain name, wrapped so hovering (or, via tabindex,
// focusing) it pops up its full card -- for read-only mentions of a spell
// elsewhere in the app (e.g. the level-up modal's Eldritch Knight chooser)
// where showing the full ornate card inline isn't practical. Pure CSS
// (.spell-hover-name/.spell-hover-card in style.css), no extra JS wiring.
export function spellHoverNameHtml(sp) {
  return `<span class="spell-hover-name" tabindex="0">${escapeHtml(sp.name)}<span class="spell-hover-card">${spellCardHtml(sp, "")}</span></span>`;
}
