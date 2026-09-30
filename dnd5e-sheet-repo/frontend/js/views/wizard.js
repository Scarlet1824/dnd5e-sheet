import { mount, on, $, $all, freshApp, escapeHtml } from "../dom.js";
import { api } from "../api.js";
import { navigate } from "../router.js";
import {
  ABILITIES, RACES, CLASSES, BACKGROUNDS, SPELLS, SKILLS,
  STANDARD_ARRAY, POINT_BUY_COSTS, POINT_BUY_BUDGET, abilityMod,
  detectArmorIdFromText, textMentionsShield, detectWeaponsInText, weaponRangeType,
  WEAPONS, ARMORS, CLASS_STARTING_GOLD, EQUIPMENT_PACK_DESCRIPTIONS, extractStartingGold,
  equipmentNameMatches, expandPackContents, detectAmmoInText, stripStartingGoldMention, splitFeatureText,
  parseProficiencyGrantsFromText, TRAIT_NAMED_WEAPON_GRANTS, LANGUAGES, LANGUAGE_GROUPS, TOOLS, TOOL_GROUPS, GAMING_SETS, VEHICLE_GROUPS, FEATS,
} from "../data/dnd5e-data.js";
import { blankCharacter } from "../character.js";
import { rollExpr, formatModifier } from "../dice.js";
import { spellCardHtml } from "../spellCard.js";
import { newFeatSel, featExtrasHtml, featExtrasIncomplete, wireFeatExtras, applyFeatExtras } from "../featChoices.js";

// Следопыт's own 1st-level choices (Избранный враг / Природный следопыт):
// not a subclass and not shaped like Воин's level1Choice (a single named
// option with one line of flavor each) -- Избранный враг needs a free-text
// sub-pick when "Гуманоиды" is chosen (two specific species) plus an
// optional language, so it gets its own step and its own state instead of
// being forced through the generic level1Choice mechanism.
const RANGER_FAVORED_ENEMY_TYPES = [
  "Аберрации", "Зверолюды", "Звери", "Драконы", "Элементали", "Феи",
  "Нежить", "Великаны", "Гуманоиды", "Монстры", "Растения", "Порождения",
];
const RANGER_FAVORED_TERRAIN_TYPES = [
  "Арктика", "Горы", "Леса", "Побережье", "Пустоши", "Пустыня", "Равнины", "Подземье", "Болота",
];

const STEPS = [
  { id: "edition", label: "Редакция" },
  { id: "race", label: "Раса" },
  { id: "class", label: "Класс" },
  { id: "rangerFavored", label: "Следопыт" },
  { id: "equipment", label: "Снаряжение" },
  { id: "background", label: "Предыстория" },
  { id: "abilities", label: "Характеристики" },
  { id: "skills", label: "Навыки" },
  { id: "spells", label: "Заклинания" },
  { id: "summary", label: "Итог" },
];

export function renderWizard() {
  // See dom.js freshApp(): clears listeners left over from a previous visit
  // to this view (#app itself is never removed by mount(), only its
  // innerHTML), so wire()'s delegated handlers below don't stack.
  freshApp();
  const state = {
    step: 0,
    edition: "2014",
    raceId: null,
    subraceId: null, // chosen variety (e.g. High Elf) for races that offer subraces
    classId: null,
    backgroundId: null,
    abilityMethod: "standard",
    abilities: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
    standardAssignment: {}, // ability -> array value used
    diceRolls: [], // six rolled values (4к6, drop lowest die, sum top 3)
    diceRerollUsed: false, // only one of the six rolls may be rerolled
    diceAssignment: {}, // ability -> index into diceRolls
    raceChoiceAbilities: [], // abilities chosen for a race's "choice" bonus (e.g. Half-Elf)
    raceFlexibleAlloc: {}, // ability -> points, for a race's "flexible" bonus (Tasha's-style)
    raceSourceFilter: "", // source book selected in the race step's filter row ("" = all)
    backgroundSourceFilter: "", // source book selected in the background step's filter row ("" = all)
    chosenSkills: [],
    chosenExpertise: [], // Rogue's "Компетентность": up to 2 already-proficient skills picked for doubled proficiency bonus
    chosenClassTools: [], // a class's own toolChoice (e.g. Bard's "3 музыкальных инструмента на выбор") -- tool/instrument names picked
    chosenSubclassSkills: [], // skills picked for a level-1 subclass's own skill-choice grant (e.g. Cleric Knowledge Domain's "Благословение знаний")
    chosenRaceSkills: [], // skills picked for a race/subrace's free-choice skill grant (Half-Elf's "Универсальность навыков")
    chosenSubclassLanguages: [], // index -> a LANGUAGES entry, or "custom", for that same kind of subclass grant ("два языка на свой выбор")
    subclassLanguageCustom: {}, // index -> free-text language name, when chosenSubclassLanguages[index] === "custom"
    chosenRaceLanguages: [], // index -> a LANGUAGES entry, or "custom", for a race/subrace's own "N на выбор" languages entry (e.g. Human's "1 на выбор")
    raceLanguageCustom: {}, // index -> free-text language name, when chosenRaceLanguages[index] === "custom"
    chosenRaceFeatId: "", // FEATS id picked for a race/subrace's own feat-choice grant (Human (альтернативный)'s "Черта")
    raceFeatAbility: "", // ability chosen for that feat, when it's a multi-choice abilityIncrease feat
    raceFeatSel: newFeatSel(), // extra choices (spells, languages, weapons, element, maneuvers) of that feat
    raceFeatSkills: [], // skills chosen for that feat, when it's a skillChoice feat (Одарённый)
    chosenCantrips: [],
    chosenSpells: [],
    customBackground: { name: "", skills: [], tools: "", equipment: "", featureName: "", featureDesc: "" },
    chosenBgLanguages: [], // index -> a LANGUAGES entry, or "custom", for the background's "N языков на выбор"
    bgLanguageCustom: {}, // index -> free-text language name, when chosenBgLanguages[index] === "custom"
    chosenBgTools: {}, // toolProficiencies-entry index -> a TOOLS entry, or "custom", for a background's tool-choice entries
    bgToolCustom: {}, // toolProficiencies-entry index -> free-text tool name, when chosenBgTools[index] === "custom"
    equipmentSelections: {}, // group index -> chosen option index, for the current class's startEquipment
    weaponCategoryChoices: {}, // "gi:oi:mi:pi" -> WEAPONS id, for a "воинское оружие"/"простое оружие" category mention
    classEquipmentDeclined: false, // player chose starting gold instead of the class equipment package
    classGoldRoll: 0, // rolled amount when classEquipmentDeclined is true
    level1ChoiceIndex: null, // chosen index into the class's level1Choice.options (fighting style / subclass picked at level 1)
    favoredEnemy: "", // Следопыт: one of RANGER_FAVORED_ENEMY_TYPES
    favoredEnemyHumanoid1: "", // when favoredEnemy === "Гуманоиды": first chosen species (e.g. "гноллы")
    favoredEnemyHumanoid2: "", // ...and the second (e.g. "орки")
    favoredEnemyLanguage: "", // a LANGUAGES entry, or "custom", or "" (no language / skip)
    favoredEnemyLanguageCustom: "", // free-text language name, when favoredEnemyLanguage === "custom"
    favoredTerrain: "", // Следопыт: one of RANGER_FAVORED_TERRAIN_TYPES
    name: "",
  };

  function relevantSteps() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    const hasLevel1Spells = cls && cls.spellcasting && cls.spellcasting.startsAtLevel !== 2;
    return STEPS.filter((s) => s.id !== "spells" || hasLevel1Spells).filter((s) => s.id !== "rangerFavored" || (cls && cls.id === "ranger"));
  }

  // Guards the "Далее"/"Создать персонажа" button against a choice the
  // current step still requires but the player hasn't made yet -- a
  // subrace's ability-score "choice"/"flexible" bonus (Half-Elf, Warforged,
  // most MPMM races, ...) on the "Характеристики" step, and a level-1
  // subclass's own skill-choice grant (Cleric Knowledge Domain's
  // "Благословение знаний") or a race's free-choice skill grant (Half-Elf's
  // "Универсальность навыков") on the "Навыки" step. Anything else is left
  // alone -- e.g. the class's own skillChoice or Компетентность were never
  // gated before this, and background language/tool choices fall back to a
  // "N на выбор" placeholder by design (see resolvedBackgroundLanguages()).
  function canAdvance() {
    const steps = relevantSteps();
    const stepId = steps[state.step] && steps[state.step].id;
    if (stepId === "abilities") {
      const race = RACES.find((r) => r.id === state.raceId);
      if (race && state.edition === "2014") {
        const subrace = (race.subraces || []).find((s) => s.id === state.subraceId);
        const b = subrace && subrace.abilityBonuses && (subrace.abilityBonuses.choice || subrace.abilityBonuses.flexible) ? subrace.abilityBonuses : race.abilityBonuses || {};
        if (b.choice && state.raceChoiceAbilities.length < b.choice.count) return false;
        if (b.flexible) {
          const used = Object.values(state.raceFlexibleAlloc).reduce((s, v) => s + (v || 0), 0);
          if (used < b.flexible.total) return false;
        }
      }
    }
    if (stepId === "skills") {
      const grant = chosenLevel1SubclassSkillGrant();
      if (grant && state.chosenSubclassSkills.length < grant.count) return false;
      const raceGrant = raceFreeSkillChoiceGrant();
      if (raceGrant && state.chosenRaceSkills.length < raceGrant.count) return false;
      const featGrant = raceFeatChoiceGrant();
      if (featGrant && !state.chosenRaceFeatId) return false;
      if (featGrant) {
        const rf = FEATS.find((f) => f.id === state.chosenRaceFeatId);
        if (rf && featExtrasIncomplete(rf, state.raceFeatSel)) return false;
      }
      const cls = CLASSES.find((c) => c.id === state.classId);
      if (cls && cls.toolChoice && state.chosenClassTools.length < cls.toolChoice.count) return false;
    }
    if (stepId === "rangerFavored") {
      if (!state.favoredEnemy || !state.favoredTerrain) return false;
      if (state.favoredEnemy === "Гуманоиды" && (!state.favoredEnemyHumanoid1.trim() || !state.favoredEnemyHumanoid2.trim())) return false;
      if (state.favoredEnemyLanguage === "custom" && !state.favoredEnemyLanguageCustom.trim()) return false;
    }
    return true;
  }

  function render() {
    const steps = relevantSteps();
    const current = steps[state.step];
    const atLastStep = state.step === steps.length - 1;
    const advanceOk = canAdvance();
    mount(`
      <div class="top-bar">
        <a href="#/characters" class="brand">← ⚔ D&D 5e</a>
      </div>
      <h1>Создание персонажа</h1>
      <div class="wizard-steps">
        ${steps.map((s, i) => `<button type="button" class="step ${i === state.step ? "active" : i < state.step ? "done" : ""}" data-goto-step="${i}" ${i > (state.maxStep || 0) ? "disabled" : ""}>${i + 1}. ${s.label}</button>`).join("")}
      </div>
      <div class="row between" style="margin-bottom:14px;">
        <button data-action="back" ${state.step === 0 ? "disabled" : ""}>← Назад</button>
        ${
          atLastStep
            ? `<button data-action="finish" class="primary" ${advanceOk ? "" : "disabled"}>Создать персонажа</button>`
            : `<button data-action="next" class="primary" ${advanceOk ? "" : "disabled"}>Далее →</button>`
        }
      </div>
      <div data-step-content>${renderStep(current.id)}</div>
    `);
  }

  function renderStep(id) {
    switch (id) {
      case "edition": return stepEdition();
      case "race": return stepRace();
      case "class": return stepClass();
      case "rangerFavored": return stepRangerFavored();
      case "equipment": return stepEquipment();
      case "background": return stepBackground();
      case "abilities": return stepAbilities();
      case "skills": return stepSkills();
      case "spells": return stepSpells();
      case "summary": return stepSummary();
      default: return "";
    }
  }

  function stepEdition() {
    return `
      <div class="panel">
        <p class="muted">💡 Если сомневаетесь — выбирайте D&D 5e (2014): именно эта редакция обычно используется за столом, в ней бонусы характеристик дают раса и подраса. Переключить редакцию можно позже прямо в листе.</p>
        <div class="grid cols-2">
          <div class="card selectable ${state.edition === "2014" ? "selected" : ""}" data-edition="2014">
            <h4>D&D 5e (2014)</h4><p>Классические правила из базовых книг 2014 года.</p>
          </div>
          <div class="card selectable ${state.edition === "2024" ? "selected" : ""}" data-edition="2024">
            <h4>D&D 2024</h4><p>Обновлённые правила: бонусы характеристик из предыстории, мастерство оружия.</p>
          </div>
        </div>
      </div>`;
  }

  // Russian short abbreviation for an ability id (str -> СИЛ, dex -> ЛОВ, ...).
  function abilityShort(id) {
    const a = ABILITIES.find((x) => x.id === id);
    return a ? a.short : id.toUpperCase();
  }

  // Renders a human-readable summary of a race's ability-bonus shape,
  // handling every schema variant: fixed keys, `all`, `choice`, `flexible`.
  // Portrait banners for race cards on the "Раса" step: a waist-cropped
  // portrait on the left, faded out from its own vertical center, with a
  // short flavor line over the fade (see assets/races/*.png and the
  // .race-portrait-banner rules in style.css). Only races with an image
  // here get a banner; everything else keeps the plain text card.
  const RACE_PORTRAITS = {
    gnome: {
      img: "assets/races/gnome.png",
      caption: "В среднем гномы чуть выше 3 футов (90 сантиметров), и весят от 40 до 45 фунтов (от 18 до 20 килограмм)",
    },
    dwarf: {
      img: "assets/races/dwarf.png",
      caption: "Рост дварфов находится между 4 и 5 футами (122 и 152 сантиметрами), и весят они около 150 фунтов (68 килограмм)",
    },
    dragonborn: {
      img: "assets/races/dragonborn.png",
      caption: "Рост больше 6 футов (1,8 метра) и вес около 250 фунтов (115 килограмм).",
    },
    // Fizban's Treasury of Dragons' Драконорождённый is a separate RACES
    // entry (different draconic-ancestry list/traits) but the same species
    // physically -- same portrait and blurb as the Player's Handbook one.
    "dragonborn-fizban": {
      img: "assets/races/dragonborn.png",
      caption: "Рост больше 6 футов (1,8 метра) и вес около 250 фунтов (115 килограмм).",
    },
    "half-orc": {
      img: "assets/races/half-orc.png",
      caption: "Полуорки несколько выше и массивнее людей. Их рост находится в промежутке от 5 до сильно выше 6 футов",
    },
    halfling: {
      img: "assets/races/halfling.png",
      caption: "В среднем примерно 3 фута (90 сантиметров) ростом и весят около 40 фунтов (18 килограмм).",
    },
    "half-elf": {
      img: "assets/races/half-elf.png",
      caption: "Почти такого же размера, как и люди. Их рост колеблется от 5 до 6 футов (от 155 до 183 сантиметров).",
    },
    tiefling: {
      img: "assets/races/tiefling.png",
      caption: "Тифлинги по росту и телосложению схожи с людьми.",
    },
    human: {
      img: "assets/races/human.png",
      caption: "Люди различаются по размерам. Некоторые едва 5 футов (152 сантиметров) ростом, тогда как другие имеют рост, превосходящий 6 футов (183 сантиметра).",
    },
    elf: {
      img: "assets/races/elf.png",
      caption: "Рост эльфов колеблется между 5 и 6 футами (152 и 183 сантиметрами), у них стройное телосложение.",
    },
  };

  function racePortraitBannerHtml(raceId) {
    const p = RACE_PORTRAITS[raceId];
    if (!p) return "";
    return `
      <div class="race-portrait-banner">
        <div class="race-portrait-img" style="background-image:url('${escapeHtml(p.img)}')"></div>
        <div class="race-portrait-caption">${escapeHtml(p.caption)}</div>
      </div>`;
  }

  function raceBonusSummary(race) {
    const b = race.abilityBonuses || {};
    const parts = [];
    Object.entries(b).forEach(([k, v]) => {
      if (k === "all") parts.push(`все характеристики +${v}`);
      else if (k === "choice") parts.push(`+${v.amount} к ${v.count} характеристикам на выбор`);
      else if (k === "flexible") parts.push(`${v.total} очк. на распределение (макс +${v.max} на характеристику)`);
      else parts.push(`${abilityShort(k)} +${v}`);
    });
    return parts.join(", ") || "—";
  }

  // Sorted, alphabetized race list, distinct source books (for the filter row),
  // and the race list narrowed to the currently selected source (or all).
  function sortedRaces() {
    return [...RACES].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }
  function raceSources() {
    return [...new Set(RACES.map((r) => r.source))].sort((a, b) => a.localeCompare(b, "ru"));
  }
  function visibleRaces() {
    const list = sortedRaces();
    return state.raceSourceFilter ? list.filter((r) => r.source === state.raceSourceFilter) : list;
  }

  function stepRace() {
    const race = RACES.find((r) => r.id === state.raceId);

    // A race with subraces: hide the full race list once chosen and show only
    // that race's varieties, front and center, so the player doesn't have to
    // scroll back down through 80+ other races to find them.
    if (race && race.subraces && race.subraces.length) {
      return `
        <div class="panel">
          <p class="muted">💡 Выбери расу и подрасу существа.</p>
          ${racePortraitBannerHtml(race.id)}
          <div class="row between" style="align-items:center;">
            <h3 style="margin:0;">${escapeHtml(race.name)} — выберите разновидность</h3>
            <button data-action="change-race" class="small">← Изменить расу</button>
          </div>
          <p class="muted" style="font-size:0.8rem;">Источник: ${escapeHtml(race.source || "—")}</p>
          <div class="grid cols-2" style="margin-top:8px;">
            ${race.subraces.map((sr) => `
              <div class="card selectable ${state.subraceId === sr.id ? "selected" : ""}" data-subrace="${sr.id}">
                <h4>${escapeHtml(sr.name)}</h4>
                ${state.edition === "2014" && sr.abilityBonuses ? `<p>Бонусы: ${raceBonusSummary(sr)}</p>` : ""}
                ${sr.speed ? `<p>Скорость: ${sr.speed} фт</p>` : ""}
                ${((sr.traits && sr.traits.length ? sr.traits : race.traits) || []).map((t) => `<p><strong>${escapeHtml(t.name)}:</strong> ${escapeHtml(t.desc)}</p>`).join("")}
              </div>`).join("")}
          </div>
        </div>`;
    }

    const sources = raceSources();
    return `
      <div class="panel">
        <p class="muted">💡 Выбери расу и подрасу существа.</p>
        <div class="tabs">
          <button data-race-source="" class="${!state.raceSourceFilter ? "active" : ""}">Все источники</button>
          ${sources.map((s) => `<button data-race-source="${escapeHtml(s)}" class="${state.raceSourceFilter === s ? "active" : ""}">${escapeHtml(s)}</button>`).join("")}
        </div>
        <div class="grid cols-2">
          ${visibleRaces().map(
            (r) => `
            <div class="card selectable ${state.raceId === r.id ? "selected" : ""}" data-race="${r.id}">
              ${racePortraitBannerHtml(r.id)}
              <h4>${escapeHtml(r.name)}</h4>
              <p class="muted" style="font-size:0.8rem;">Источник: ${escapeHtml(r.source || "—")}</p>
              <p>Скорость ${r.speed} фт · Размер: ${r.size}</p>
              ${state.edition === "2014" ? `<p>Бонусы: ${raceBonusSummary(r)}</p>` : ""}
              ${r.traits.map((t) => `<p><strong>${escapeHtml(t.name)}:</strong> ${escapeHtml(t.desc)}</p>`).join("")}
              ${r.languages ? `<p class="muted" style="font-size:0.85rem;">Языки: ${r.languages.map(escapeHtml).join(", ")}</p>` : ""}
              ${r.subraces && r.subraces.length ? `<p class="muted" style="font-size:0.85rem;">Есть разновидности — откроются после выбора.</p>` : ""}
            </div>`
          ).join("")}
        </div>
      </div>`;
  }

  function stepClass() {
    const cls = CLASSES.find((c) => c.id === state.classId);

    // A class with a level-1 choice (Воин's Боевой стиль, or a subclass for
    // Жрец/Чародей/Колдун): hide the full class list once chosen and show
    // only that choice, front and center -- the same reveal pattern
    // stepRace() uses for a race's subraces, so the player doesn't have to
    // scroll back down through the whole class list to find it.
    if (cls && cls.level1Choice) {
      const choice = cls.level1Choice;
      return `
        <div class="panel">
          <p class="muted">💡 Выбери класс, за который тебе будет интересно играть. От него зависят твои способности и умения.</p>
          <div class="row between" style="align-items:center;">
            <h3 style="margin:0;">${escapeHtml(cls.name)} — ${escapeHtml(choice.label)}</h3>
            <button data-action="change-class" class="small">← Изменить класс</button>
          </div>
          <p class="muted" style="font-size:0.85rem;">${choice.type === "fightingStyle" ? "Воин выбирает боевой стиль на 1 уровне (это не подкласс — подкласс «Боевой архетип» выбирается на 3 уровне)." : `${escapeHtml(cls.name)} выбирает подкласс уже на 1 уровне.`}</p>
          <div class="grid cols-2" style="margin-top:8px;">
            ${choice.options
              .map(
                (o, i) => `
              <div class="card selectable ${state.level1ChoiceIndex === i ? "selected" : ""}" data-level1-choice="${i}">
                <h4>${escapeHtml(o.name)}</h4>
                <p>${escapeHtml(o.desc)}</p>
              </div>`
              )
              .join("")}
          </div>
        </div>`;
    }

    return `
      <div class="panel">
        <p class="muted">💡 Выбери класс, за который тебе будет интересно играть. От него зависят твои способности и умения.</p>
      </div>
      <div class="panel">
        <div class="grid cols-2">
          ${CLASSES.map(
            (c) => `
            <div class="card selectable ${state.classId === c.id ? "selected" : ""}" data-class="${c.id}">
              <h4>${escapeHtml(c.name)}</h4>
              <p class="muted" style="font-size:0.8rem;">Источник: ${escapeHtml(c.source || "—")}</p>
              <p>Кость хитов: к${c.hitDie} · Основная характеристика: ${escapeHtml(c.primaryAbility)}</p>
              <p>${escapeHtml(c.flavor || "")}</p>
            </div>`
          ).join("")}
        </div>
      </div>`;
  }

  // Следопыт's 1st-level Избранный враг + Природный следопыт picks -- see
  // RANGER_FAVORED_ENEMY_TYPES/RANGER_FAVORED_TERRAIN_TYPES above for why
  // this doesn't reuse the generic level1Choice mechanism.
  function stepRangerFavored() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    return `
      <div class="panel">
        <p class="muted">💡 На 1 уровне следопыт выбирает тип избранного врага и тип избранной местности (не подкласс — «Архетип следопыта» выбирается на 3 уровне).</p>
      </div>
      <div class="panel">
        <h3 style="margin-top:0;">Избранный враг</h3>
        <div class="grid cols-3">
          ${RANGER_FAVORED_ENEMY_TYPES.map(
            (t) => `
            <div class="card selectable ${state.favoredEnemy === t ? "selected" : ""}" data-favored-enemy="${escapeHtml(t)}">
              <h4 style="margin:0;">${escapeHtml(t)}</h4>
            </div>`
          ).join("")}
        </div>
        ${
          state.favoredEnemy === "Гуманоиды"
            ? `
        <div class="row" style="gap:10px;margin-top:10px;">
          <div class="col" style="flex:1;">
            <label>Первый вид</label>
            <input type="text" data-favored-enemy-humanoid="1" value="${escapeHtml(state.favoredEnemyHumanoid1)}" placeholder="например, гноллы" />
          </div>
          <div class="col" style="flex:1;">
            <label>Второй вид</label>
            <input type="text" data-favored-enemy-humanoid="2" value="${escapeHtml(state.favoredEnemyHumanoid2)}" placeholder="например, орки" />
          </div>
        </div>`
            : ""
        }
        ${
          state.favoredEnemy
            ? `
        <div class="col" style="margin-top:10px;max-width:280px;">
          <label>Язык избранного врага (если есть)</label>
          <select data-favored-enemy-language>
            <option value="">—</option>
            ${LANGUAGE_GROUPS.map((g) => `<optgroup label="${escapeHtml(g.label)}">${g.items.map((l) => `<option value="${escapeHtml(l)}" ${state.favoredEnemyLanguage === l ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</optgroup>`).join("")}
            <option value="custom" ${state.favoredEnemyLanguage === "custom" ? "selected" : ""}>Другой…</option>
          </select>
          ${state.favoredEnemyLanguage === "custom" ? `<input type="text" data-favored-enemy-language-custom value="${escapeHtml(state.favoredEnemyLanguageCustom)}" placeholder="свой язык" style="margin-top:6px;" />` : ""}
        </div>`
            : ""
        }
      </div>
      <div class="panel">
        <h3 style="margin-top:0;">Природный следопыт (местность)</h3>
        <div class="grid cols-3">
          ${RANGER_FAVORED_TERRAIN_TYPES.map(
            (t) => `
            <div class="card selectable ${state.favoredTerrain === t ? "selected" : ""}" data-favored-terrain="${escapeHtml(t)}">
              <h4 style="margin:0;">${escapeHtml(t)}</h4>
            </div>`
          ).join("")}
        </div>
      </div>`;
  }

  // Splits a class's free-text startEquipment string into groups (separated
  // by ";"), and each group into alternative options (separated by "или"),
  // so the player can pick their starting gear with buttons instead of just
  // reading a paragraph.
  function parseEquipmentGroups(text) {
    if (!text) return [];
    return text.split(";").map((s) => s.trim()).filter(Boolean).map((group) => {
      const options = group.split(/\sили\s/i).map((o) => o.trim()).filter(Boolean);
      return { options };
    });
  }

  // Builds a hover-tooltip description for one equipment option by
  // recognizing known pack names, weapons, armor and tools mentioned in its
  // text — matched loosely (equipmentNameMatches) so Russian case endings
  // ("два коротких мечей", "пять метательных копий") don't hide the match.
  function describeEquipmentOption(text) {
    const lower = text.toLowerCase();
    const lines = [];
    Object.entries(EQUIPMENT_PACK_DESCRIPTIONS).forEach(([key, desc]) => {
      if (lower.includes(key)) lines.push(`${key[0].toUpperCase()}${key.slice(1)}: ${desc}`);
    });
    WEAPONS.forEach((w) => {
      if (w.id === "unarmed" || w.id === "custom" || !w.damage) return;
      if (equipmentNameMatches(lower, w.name)) {
        const props = w.properties && w.properties !== "—" ? `, ${w.properties}` : "";
        lines.push(`${w.name}: ${w.damage} (${w.type})${props}`);
      }
    });
    ARMORS.forEach((a) => {
      if (equipmentNameMatches(lower, a.name)) {
        const dex = a.dexMode === "full" ? "+Лов" : a.dexMode === "capped" ? `+Лов (макс ${a.dexCap})` : "";
        lines.push(`${a.name}: КД ${a.baseAC}${dex}`);
      }
    });
    const toolNotes = [
      ["воровской инструмент", "Проверки на снятие ловушек и замков, открытие врезных замков."],
      ["инструмент ремесленника", "Набор для одного из ремёсел (кузнец, плотник, ювелир и т.п.) — на выбор игрока."],
      ["музыкальный инструмент", "Один музыкальный инструмент на выбор (лютня, флейта, барабан и т.п.)."],
      ["игровой набор", "Набор для одной из игр на выбор (карты, кости и т.п.)."],
    ];
    toolNotes.forEach(([kw, desc]) => {
      if (lower.includes(kw)) lines.push(`${kw[0].toUpperCase()}${kw.slice(1)}: ${desc}`);
    });
    return lines.join("\n");
  }

  // Wraps an equipment option's label in a small styled hover tooltip (CSS
  // :hover, not the native title=""), showing describeEquipmentOption()'s
  // text — more reliably visible than the browser's default tooltip.
  // Starting-equipment strings in CLASSES data are written as one flowing
  // sentence per option ("кожаная броня, длинный лук и колчан из 20 стрел")
  // with only the very first item capitalized. The equipment-selection step
  // should show every item name capitalized, so this uppercases the first
  // letter right after each list separator (a comma or " и ") as well as at
  // the very start of the option text.
  function capitalizeEquipmentItems(text) {
    return text.replace(/(^|,\s+|\s+и\s+)([a-zа-яё])/gi, (m, sep, ch) => sep + ch.toUpperCase());
  }
  function equipmentOptionLabel(text) {
    const desc = describeEquipmentOption(text);
    if (!desc) return escapeHtml(text);
    return `<span class="eq-tip">${escapeHtml(text)}<span class="eq-tip-bubble">${escapeHtml(desc).replace(/\n/g, "<br>")}</span></span>`;
  }

  // Some classes' equipment options name a whole weapon CATEGORY instead of
  // a specific weapon ("воинское оружие", "два воинских оружия", "простое
  // оружие дальнего боя"…) — this finds every such mention in an option's
  // text, so a dropdown of the matching WEAPONS entries can be shown in its
  // place instead of leaving the player to guess/type an actual weapon.
  const CATEGORY_NUM_WORDS = { два: 2, две: 2, три: 3, четыре: 4 };
  const CATEGORY_RE = /(два|две|три|четыре)?\s*(воинск[а-яё]*|прост[а-яё]*)\s+оруж[а-яё]*(?:\s+(ближнего|дальнего)\s+боя)?/gi;
  function findWeaponCategoryMentions(text) {
    const mentions = [];
    let m;
    CATEGORY_RE.lastIndex = 0;
    while ((m = CATEGORY_RE.exec(text))) {
      const tier = m[2].toLowerCase().startsWith("прост") ? "simple" : "martial";
      // Only an explicit "...дальнего боя" pulls in ranged weapons. A bare
      // "воинское оружие"/"простое оружие" (no range word at all) is treated
      // as melee-only, same as an explicit "...ближнего боя" — ranged never
      // shows up unless the text actually asked for it.
      const range = m[3] && m[3].toLowerCase() === "дальнего" ? "ranged" : "melee";
      const categories = [`${tier}-${range}`];
      const count = m[1] ? CATEGORY_NUM_WORDS[m[1].toLowerCase()] || 1 : 1;
      mentions.push({ start: m.index, end: m.index + m[0].length, text: m[0], categories, count });
    }
    return mentions;
  }
  function weaponsInCategories(categories) {
    return WEAPONS.filter((w) => categories.includes(w.category));
  }
  // One-line stat summary for a weapon-choice <option>'s title="" attribute,
  // so hovering an option in the class-equipment weapon dropdown shows its
  // damage/type/properties before picking it — native <option title> tooltips
  // work in every major browser, no custom hover widget needed here (unlike
  // equipmentOptionLabel's CSS-hover bubble, which can't attach to <option>
  // elements inside a native <select> popup).
  function weaponOptionTitle(w) {
    const props = w.properties && w.properties !== "—" ? `, ${w.properties}` : "";
    return `${w.damage} (${w.type})${props}`;
  }
  function categoryChoiceKey(gi, oi, mi, pi) {
    return `${gi}:${oi}:${mi}:${pi}`;
  }
  function chosenCategoryWeapon(gi, oi, mi, pi, categories) {
    const key = categoryChoiceKey(gi, oi, mi, pi);
    const options = weaponsInCategories(categories);
    const picked = state.weaponCategoryChoices[key];
    return options.find((w) => w.id === picked) || options[0] || null;
  }

  // Renders an option's text for display, replacing each weapon-category
  // mention with a real <select> of matching weapons (a separate select per
  // "count" — e.g. "два воинских оружия" gets two dropdowns), and wrapping
  // the surrounding plain text with the usual hover-tooltip description.
  function renderEquipmentOptionText(text, gi, oi) {
    text = capitalizeEquipmentItems(text);
    const mentions = findWeaponCategoryMentions(text);
    if (!mentions.length) return equipmentOptionLabel(text);
    let html = "";
    let cursor = 0;
    let hasTwoWeaponPick = false;
    mentions.forEach((mention, mi) => {
      if (mention.start > cursor) html += equipmentOptionLabel(text.slice(cursor, mention.start));
      const weaponOptions = weaponsInCategories(mention.categories);
      if (mention.count >= 2) hasTwoWeaponPick = true;
      for (let pi = 0; pi < mention.count; pi++) {
        if (pi > 0) html += ` и `;
        const key = categoryChoiceKey(gi, oi, mi, pi);
        const chosen = chosenCategoryWeapon(gi, oi, mi, pi, mention.categories);
        html += `
          <select data-weapon-category-choice="${key}" style="margin:0 4px;">
            ${weaponOptions.map((w) => `<option value="${w.id}" title="${escapeHtml(weaponOptionTitle(w))}" ${chosen && chosen.id === w.id ? "selected" : ""}>${escapeHtml(w.name)}</option>`).join("")}
          </select>`;
      }
      cursor = mention.end;
    });
    if (cursor < text.length) html += equipmentOptionLabel(text.slice(cursor));
    // "два воинских/простых оружия" lets the player pick any two weapons
    // from the category, including two-handed ones that don't actually
    // work together (you can't wield two greatswords) -- a small nudge
    // toward a combo that does.
    if (hasTwoWeaponPick) {
      html += `<span class="muted" style="font-size:0.78rem;flex-basis:100%;">рекомендуем два одноручных, либо одноручное и универсальное</span>`;
    }
    return html;
  }

  // Same substitution, but for the FINAL resolved text (used once an option
  // is actually chosen): category mentions become the chosen weapon's name,
  // in plain text, so downstream weapon/armor/pack detection sees real names.
  function resolveEquipmentOptionText(text, gi, oi) {
    const mentions = findWeaponCategoryMentions(text);
    if (!mentions.length) return text;
    let result = "";
    let cursor = 0;
    mentions.forEach((mention, mi) => {
      result += text.slice(cursor, mention.start);
      const names = [];
      for (let pi = 0; pi < mention.count; pi++) {
        const chosen = chosenCategoryWeapon(gi, oi, mi, pi, mention.categories);
        if (chosen) names.push(chosen.name);
      }
      result += names.join(" и ") || mention.text;
      cursor = mention.end;
    });
    result += text.slice(cursor);
    return result;
  }

  function stepEquipment() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    if (!cls) return `<div class="panel"><p class="muted">Сначала выберите класс.</p></div>`;
    const groups = parseEquipmentGroups(cls.startEquipment);
    const goldSpec = CLASS_STARTING_GOLD[cls.id];
    const declined = state.classEquipmentDeclined;
    return `
      <div class="panel">
        <p class="muted">💡 Выберите стартовое снаряжение своего класса — для каждой группы нужно выбрать один вариант. Всё выбранное автоматически попадёт в снаряжение персонажа. Наведите курсор на пункт, чтобы увидеть его описание.</p>
        ${goldSpec ? `
        <div class="row" style="align-items:center;gap:10px;margin-top:8px;">
          <button class="small ${declined ? "primary" : ""}" data-action="toggle-decline-equipment">
            ${declined ? "↩ Вернуть снаряжение класса" : `Отказаться от снаряжения и взять золото (${goldSpec.dice}${goldSpec.mult > 1 ? `×${goldSpec.mult}` : ""})`}
          </button>
          ${declined ? `<span class="num" style="font-size:1.1rem;">${state.classGoldRoll} зм</span><button class="small" data-action="reroll-decline-gold">🎲 Перебросить</button>` : ""}
        </div>
        ${declined ? `<p class="muted" style="font-size:0.8rem;margin-top:6px;">Это золото попадёт в «Деньги» на листе персонажа вместо снаряжения класса.</p>` : ""}` : ""}
      </div>
      <div class="panel" ${declined ? 'style="opacity:0.4;pointer-events:none;"' : ""}>
        ${groups.map((g, gi) => {
          if (g.options.length === 1) {
            return `<p>${renderEquipmentOptionText(g.options[0], gi, 0)}</p>`;
          }
          const chosen = state.equipmentSelections[gi] ?? 0;
          return `
          <div class="col" style="margin-bottom:10px;">
            ${g.options.map((opt, oi) => `
              <label class="row" style="gap:6px;flex-wrap:wrap;">
                <input type="radio" name="equip-group-${gi}" data-equip-group="${gi}" data-equip-option="${oi}" ${chosen === oi ? "checked" : ""} ${declined ? "disabled" : ""} />
                ${renderEquipmentOptionText(opt, gi, oi)}
              </label>`).join("")}
          </div>`;
        }).join("")}
      </div>`;
  }

  // Resolves the player's equipment picks for the current class into a
  // single human-readable string (one chosen option per group), with any
  // weapon-category mention ("воинское оружие"…) replaced by the weapon the
  // player actually picked from its dropdown.
  function resolvedClassEquipment() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    if (!cls) return "";
    const groups = parseEquipmentGroups(cls.startEquipment);
    return groups
      .map((g, gi) => {
        const oi = state.equipmentSelections[gi] ?? 0;
        return resolveEquipmentOptionText(g.options[oi], gi, oi);
      })
      .join("; ");
  }

  function rollClassStartingGold() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    const spec = cls && CLASS_STARTING_GOLD[cls.id];
    if (!spec) return 0;
    return rollExpr(spec.dice).total * spec.mult;
  }

  function sortedBackgrounds() {
    return [...BACKGROUNDS].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }
  function backgroundSources() {
    return [...new Set(BACKGROUNDS.map((b) => b.source).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  }
  function visibleBackgrounds() {
    const list = sortedBackgrounds();
    return state.backgroundSourceFilter ? list.filter((b) => b.source === state.backgroundSourceFilter) : list;
  }

  function stepBackground() {
    const customSelected = state.backgroundId === "custom";
    const sources = backgroundSources();
    return `
      <div class="panel">
        <p class="muted">💡 Предыстория даёт владения навыками и стартовое снаряжение — они автоматически отметятся на листе (владения навыком отмечаются точкой на шаге «Навыки»).</p>
        <div class="tabs">
          <button data-background-source="" class="${!state.backgroundSourceFilter ? "active" : ""}">Все источники</button>
          ${sources.map((s) => `<button data-background-source="${escapeHtml(s)}" class="${state.backgroundSourceFilter === s ? "active" : ""}">${escapeHtml(s)}</button>`).join("")}
        </div>
      </div>
      ${customSelected ? "" : backgroundChoicesUI()}
      <div class="panel">
        <div class="grid cols-2">
          ${visibleBackgrounds().map(
            (b) => `
            <div class="card selectable ${state.backgroundId === b.id ? "selected" : ""}" data-background="${b.id}">
              <h4>${escapeHtml(b.name)}</h4>
              <p class="muted" style="font-size:0.8rem;">Источник: ${escapeHtml(b.source || "—")}</p>
              ${b.flavor ? `<p>${escapeHtml(b.flavor)}</p>` : ""}
              <p>Навыки: ${(b.skillProficiencies || []).map(skillLabel).join(", ")}${b.skillsNote ? ` (${escapeHtml(b.skillsNote)})` : ""}</p>
              <p><strong>${escapeHtml((b.feature && b.feature.name) || b.feature || "")}</strong></p>
              <p>${escapeHtml(b.equipment)}</p>
            </div>`
          ).join("")}
          <div class="card selectable ${customSelected ? "selected" : ""}" data-background="custom">
            <h4>Своя предыстория</h4>
            <p class="muted">Выберите навыки, инструменты и впишите своё снаряжение вручную.</p>
          </div>
        </div>
      </div>
      ${customSelected ? customBackgroundUI() : ""}`;
  }

  function customBackgroundUI() {
    const cb = state.customBackground;
    return `
      <div class="panel">
        <h4>Своя предыстория</h4>
        <div class="col" style="margin-bottom:10px;">
          <label>Название предыстории</label>
          <input type="text" data-custom-bg-name value="${escapeHtml(cb.name)}" placeholder="Например, Странник" />
        </div>
        <p class="muted">Выберите 2 навыка:</p>
        <div class="grid cols-3" style="margin-bottom:10px;">
          ${SKILLS.map((s) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-custom-bg-skill="${s.id}" ${cb.skills.includes(s.id) ? "checked" : ""}
                ${!cb.skills.includes(s.id) && cb.skills.length >= 2 ? "disabled" : ""} />
              ${skillChoiceLabel(s.id)}
            </label>`).join("")}
        </div>
        <div class="col" style="margin-bottom:10px;">
          <label>Владение инструментами (необязательно)</label>
          <input type="text" data-custom-bg-tools value="${escapeHtml(cb.tools)}" placeholder="Например, Инструменты плотника" />
        </div>
        <div class="col" style="margin-bottom:10px;">
          <label>Снаряжение</label>
          <textarea data-custom-bg-equipment rows="2" placeholder="Впишите стартовое снаряжение">${escapeHtml(cb.equipment)}</textarea>
        </div>
        <div class="col">
          <label>Особенность предыстории (название и описание)</label>
          <input type="text" data-custom-bg-feature-name value="${escapeHtml(cb.featureName)}" placeholder="Название особенности" style="margin-bottom:6px;" />
          <textarea data-custom-bg-feature-desc rows="2" placeholder="Описание особенности">${escapeHtml(cb.featureDesc)}</textarea>
        </div>
      </div>`;
  }

  // Merges one abilityBonuses schema into a running { abilityId: bonus } map.
  function applyBonusSchema(map, b) {
    Object.entries(b || {}).forEach(([k, v]) => {
      if (k === "all") {
        ABILITIES.forEach((a) => { map[a.id] = (map[a.id] || 0) + v; });
      } else if (k === "choice") {
        state.raceChoiceAbilities.forEach((abilId) => {
          map[abilId] = (map[abilId] || 0) + v.amount;
        });
      } else if (k === "flexible") {
        Object.entries(state.raceFlexibleAlloc).forEach(([abilId, pts]) => {
          if (pts) map[abilId] = (map[abilId] || 0) + pts;
        });
      } else {
        map[k] = (map[k] || 0) + v;
      }
    });
    return map;
  }

  // Resolves the selected race + subrace's ability-bonus schema into a flat
  // { abilityId: totalBonus } map, taking the player's `choice`/`flexible`
  // picks (state.raceChoiceAbilities / state.raceFlexibleAlloc) into account.
  // Race bonuses only apply under the 2014 edition (2024 moves them to Background).
  function getRaceBonuses() {
    const race = RACES.find((r) => r.id === state.raceId);
    const map = {};
    if (!race || state.edition !== "2014") return map;
    const subrace = (race.subraces || []).find((s) => s.id === state.subraceId);
    // Most subraces ADD their bonus on top of the race's own (a Hill Dwarf
    // is still +2 Con from being a Dwarf, plus its own +1 Wis). A few
    // (Tiefling's SCAG/MTF variants) instead REPLACE the race's bonus
    // outright -- subrace.replacesAbilityBonuses opts into that.
    if (!(subrace && subrace.replacesAbilityBonuses)) {
      applyBonusSchema(map, race.abilityBonuses);
    }
    if (subrace) applyBonusSchema(map, subrace.abilityBonuses);
    return map;
  }

  // Badge shown next to an ability's label when the chosen race grants it a bonus.
  function raceBadge(bonus) {
    return bonus ? `<span class="badge" style="margin-left:6px;color:var(--gold-bright);border-color:var(--gold);">+${bonus} раса</span>` : "";
  }

  // Picker UI for races whose ability bonus needs a player choice: `choice`
  // (fixed amount, pick N abilities) or `flexible` (distribute a point pool,
  // capped per ability) — e.g. Half-Elf, Custom Lineage, most MPMM races.
  function raceBonusPickerUI() {
    const race = RACES.find((r) => r.id === state.raceId);
    if (!race || state.edition !== "2014") return "";
    const subrace = (race.subraces || []).find((s) => s.id === state.subraceId);
    // A subrace with a choice/flexible bonus of its own (Alternate Human's
    // "two different abilities +1" in place of the standard human's flat +1
    // all) needs its picker shown here too -- getRaceBonuses() above already
    // resolves the final bonus map from whichever schema applies, so this
    // just has to look at the same source it does.
    const b = subrace && subrace.abilityBonuses && (subrace.abilityBonuses.choice || subrace.abilityBonuses.flexible) ? subrace.abilityBonuses : race.abilityBonuses || {};
    let html = "";
    if (b.choice) {
      const fixedKeys = Object.keys(b).filter((k) => k !== "choice");
      const available = ABILITIES.filter((a) => !fixedKeys.includes(a.id));
      html += `
        <div class="panel" style="margin-bottom:10px;">
          <p class="muted">Раса «${escapeHtml(race.name)}»: выберите ${b.choice.count} характеристик(и) для бонуса +${b.choice.amount}:</p>
          <div class="grid cols-3">
            ${available.map((a) => `
              <label class="row" style="gap:6px;">
                <input type="checkbox" data-race-choice-ability="${a.id}" ${state.raceChoiceAbilities.includes(a.id) ? "checked" : ""}
                  ${!state.raceChoiceAbilities.includes(a.id) && state.raceChoiceAbilities.length >= b.choice.count ? "disabled" : ""} />
                ${a.label}
              </label>`).join("")}
          </div>
        </div>`;
    }
    if (b.flexible) {
      const total = b.flexible.total;
      const max = b.flexible.max;
      const used = Object.values(state.raceFlexibleAlloc).reduce((s, v) => s + (v || 0), 0);
      html += `
        <div class="panel" style="margin-bottom:10px;">
          <p class="muted">Раса «${escapeHtml(race.name)}»: распределите ${total} очк. бонуса (макс +${max} на характеристику). Использовано: ${used}/${total}</p>
          <div class="grid cols-3">
            ${ABILITIES.map((a) => {
              const val = state.raceFlexibleAlloc[a.id] || 0;
              const options = [];
              for (let i = 0; i <= max; i++) {
                if (i === val || used - val + i <= total) options.push(i);
              }
              return `
              <div class="col">
                <label>${a.label}</label>
                <select data-race-flex-ability="${a.id}">
                  ${options.map((v) => `<option value="${v}" ${v === val ? "selected" : ""}>+${v}</option>`).join("")}
                </select>
              </div>`;
            }).join("")}
          </div>
        </div>`;
    }
    return html;
  }

  function stepAbilities() {
    const method = state.abilityMethod;
    const bonusMap = getRaceBonuses();
    return `
      <div class="panel">
        <p class="muted">💡 Впишите базовое значение характеристики (для проверок, спасбросков и навыков) лист посчитает сам. Кроме стандартного массива и покупки очков можно бросить 4к6 (отбросив наименьший кубик) шесть раз. У каждого класса есть рекомендуемая ключевая характеристика — посмотрите её на шаге «Класс».</p>
      </div>
      ${raceBonusPickerUI()}
      <div class="panel">
        <div class="row">
          <button data-method="standard" class="${method === "standard" ? "primary" : ""}">Стандартный массив</button>
          <button data-method="pointbuy" class="${method === "pointbuy" ? "primary" : ""}">Покупка очков</button>
          <button data-method="diceroll" class="${method === "diceroll" ? "primary" : ""}">Проброс кубиков</button>
          <button data-method="manual" class="${method === "manual" ? "primary" : ""}">Вручную</button>
        </div>
        ${method === "standard" ? standardArrayUI(bonusMap) : ""}
        ${method === "pointbuy" ? pointBuyUI(bonusMap) : ""}
        ${method === "diceroll" ? diceRollUI(bonusMap) : ""}
        ${method === "manual" ? manualUI(bonusMap) : ""}
      </div>`;
  }

  function rollAbilityScore() {
    const dice = Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 6));
    dice.sort((a, b) => b - a);
    return dice[0] + dice[1] + dice[2];
  }

  function rollSixAbilityScores() {
    return Array.from({ length: 6 }, rollAbilityScore);
  }

  function diceRollUI(bonusMap) {
    if (!state.diceRolls.length) {
      return `
        <div class="panel">
          <p class="muted">Бросьте 4к6 (отбросив наименьший кубик) шесть раз, затем распределите результаты по характеристикам вручную.</p>
          <button data-action="roll-dice">Бросить кубики</button>
        </div>`;
    }
    const used = Object.values(state.diceAssignment);
    return `
      <div class="panel">
        <p class="muted">Ваши броски (один можно перебросить — выберите какой):</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          ${state.diceRolls.map((v, i) => `
            <span class="badge">${v}${!state.diceRerollUsed ? ` <button data-action="reroll-dice" data-index="${i}" title="Перебросить этот кубик" style="margin-left:4px;">↻</button>` : ""}</span>
          `).join("")}
        </div>
      </div>
      <div class="grid cols-3">
        ${ABILITIES.map((a) => {
          const assignedIdx = state.diceAssignment[a.id];
          const bonus = bonusMap[a.id] || 0;
          const options = state.diceRolls
            .map((v, i) => ({ v, i }))
            .filter(({ i }) => !used.includes(i) || i === assignedIdx);
          return `
          <div class="col">
            <label>${a.label}${raceBadge(bonus)}</label>
            <select data-dice-ability="${a.id}">
              <option value="">—</option>
              ${options.map(({ v, i }) => `<option value="${i}" ${i === assignedIdx ? "selected" : ""}>${v}</option>`).join("")}
            </select>
            ${assignedIdx !== undefined ? `<span class="muted" style="font-size:0.8rem;">Итог: ${state.diceRolls[assignedIdx] + bonus}</span>` : ""}
          </div>`;
        }).join("")}
      </div>`;
  }

  function standardArrayUI(bonusMap) {
    const used = Object.values(state.standardAssignment);
    return `
      <p class="muted">Массив: ${STANDARD_ARRAY.join(", ")}. Назначьте каждое значение ровно одной характеристике.</p>
      <div class="grid cols-3">
        ${ABILITIES.map((a) => {
          const val = state.standardAssignment[a.id];
          const options = STANDARD_ARRAY.filter((v) => !used.includes(v) || v === val);
          const bonus = bonusMap[a.id] || 0;
          return `
          <div class="col">
            <label>${a.label}${raceBadge(bonus)}</label>
            <select data-standard-ability="${a.id}">
              <option value="">—</option>
              ${options.map((v) => `<option value="${v}" ${v === val ? "selected" : ""}>${v}</option>`).join("")}
            </select>
            ${val ? `<span class="muted" style="font-size:0.8rem;">Итог: ${val + bonus}</span>` : ""}
          </div>`;
        }).join("")}
      </div>`;
  }

  function pointBuyUI(bonusMap) {
    const spent = ABILITIES.reduce((sum, a) => sum + (POINT_BUY_COSTS[state.abilities[a.id]] ?? 0), 0);
    const remaining = POINT_BUY_BUDGET - spent;
    return `
      <p class="muted">Бюджет: ${POINT_BUY_BUDGET} очков. Потрачено: ${spent}. Осталось: ${remaining}</p>
      <div class="grid cols-3">
        ${ABILITIES.map((a) => {
          const bonus = bonusMap[a.id] || 0;
          const current = state.abilities[a.id];
          const currentCost = POINT_BUY_COSTS[current] ?? 0;
          return `
          <div class="col">
            <label>${a.label}${raceBadge(bonus)}</label>
            <select data-pointbuy-ability="${a.id}">
              ${Object.keys(POINT_BUY_COSTS).map((vStr) => {
                const v = Number(vStr);
                const cost = POINT_BUY_COSTS[v];
                // Selecting this value would change the total spend by
                // (its own cost minus what this ability is currently
                // costing) -- disable it when that would blow the budget,
                // so the player can never buy their way into negative
                // points remaining. The ability's own current value stays
                // selectable (and shown) even if an earlier, since-fixed
                // save had somehow gone over budget.
                const wouldSpend = spent - currentCost + cost;
                const disabled = v !== current && wouldSpend > POINT_BUY_BUDGET;
                return `<option value="${v}" ${v === current ? "selected" : ""} ${disabled ? "disabled" : ""}>${v} (${cost} очк.)</option>`;
              }).join("")}
            </select>
            <span class="muted" style="font-size:0.8rem;">Итог: ${current + bonus}</span>
          </div>`;
        }).join("")}
      </div>`;
  }

  function manualUI(bonusMap) {
    return `
      <div class="grid cols-3">
        ${ABILITIES.map((a) => {
          const bonus = bonusMap[a.id] || 0;
          return `
          <div class="col">
            <label>${a.label}${raceBadge(bonus)}</label>
            <input type="number" min="1" max="20" data-manual-ability="${a.id}" value="${state.abilities[a.id]}" />
            <span class="muted" style="font-size:0.8rem;">Итог: ${state.abilities[a.id] + bonus}</span>
          </div>`;
        }).join("")}
      </div>`;
  }

  function currentAbilities() {
    if (state.abilityMethod === "standard") {
      const out = {};
      ABILITIES.forEach((a) => (out[a.id] = state.standardAssignment[a.id] || 8));
      return out;
    }
    if (state.abilityMethod === "diceroll") {
      const out = {};
      ABILITIES.forEach((a) => {
        const idx = state.diceAssignment[a.id];
        out[a.id] = idx !== undefined ? state.diceRolls[idx] : 8;
      });
      return out;
    }
    return state.abilities;
  }

  // Full official text for Rogue's "Компетентность" (Expertise), shown on
  // the skills step so the player understands what they're picking before
  // doFinish() writes the choice into data.proficiencies.expertise.
  const EXPERTISE_TEXT = "Выберите два своих навыка, в которых у вас есть владение (либо один навык и владение воровскими инструментами). Ваш бонус мастерства удваивается для любой проверки характеристики, которую вы совершаете с использованием любого из выбранных владений.";
  const EXPERTISE_COUNT = { rogue: 2 };

  function stepSkills() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    const bg = getSelectedBackground();
    const fromBg = bg ? bg.skillProficiencies : [];
    const fromRace = raceGrantedSkillIds();
    const fromClassFeatures = classGrantedSkillIds();
    const fromAuto = [...new Set([...fromRace, ...fromClassFeatures])];
    if (!cls) return `<div class="panel"><p class="muted">Сначала выберите класс.</p></div>`;
    const choices = cls.skillChoice.from.filter((id) => !fromBg.includes(id) && !fromAuto.includes(id));
    const expertiseCount = EXPERTISE_COUNT[cls.id] || 0;
    // Компетентность can only land on a skill the character is actually
    // proficient in -- from the background, race/умения, or just picked above.
    const proficientSkillIds = [...new Set([...fromBg, ...fromAuto, ...state.chosenSkills])];
    return `
      <div class="panel">
        <p class="muted">Из предыстории уже даны: ${fromBg.map((id) => skillChoiceLabel(id)).join(", ") || "—"}</p>
        ${fromRace.length ? `<p class="muted">Из расы уже даны: ${fromRace.map((id) => skillChoiceLabel(id)).join(", ")}</p>` : ""}
        ${fromClassFeatures.length ? `<p class="muted">Из умений класса уже даны: ${fromClassFeatures.map((id) => skillChoiceLabel(id)).join(", ")}</p>` : ""}
        <p>Выберите ${cls.skillChoice.count} навыков класса «${cls.name}»:</p>
        <div class="grid cols-2">
          ${choices
            .map(
              (id) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-skill-choice="${id}" ${state.chosenSkills.includes(id) ? "checked" : ""}
                ${!state.chosenSkills.includes(id) && state.chosenSkills.length >= cls.skillChoice.count ? "disabled" : ""} />
              ${skillChoiceLabel(id)}
            </label>`
            )
            .join("")}
        </div>
      </div>
      ${
        expertiseCount
          ? `
      <div class="panel">
        <h3 style="margin-top:0;">Компетентность</h3>
        <p class="muted">${EXPERTISE_TEXT}</p>
        <p>Выберите ${expertiseCount} навыка из тех, в которых у вас уже есть владение:</p>
        <div class="grid cols-2">
          ${
            proficientSkillIds.length
              ? proficientSkillIds
                  .map(
                    (id) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-expertise-choice="${id}" ${state.chosenExpertise.includes(id) ? "checked" : ""}
                ${!state.chosenExpertise.includes(id) && state.chosenExpertise.length >= expertiseCount ? "disabled" : ""} />
              ${skillChoiceLabel(id)}
            </label>`
                  )
                  .join("")
              : '<p class="muted">Сначала выберите навыки выше или предысторию, дающую владение навыком.</p>'
          }
        </div>
      </div>`
          : ""
      }
      ${classToolChoiceUI(cls)}
      ${raceSkillChoiceUI()}
      ${raceLanguageChoiceUI()}
      ${raceFeatChoiceUI()}
      ${subclassSkillLanguageChoicesUI()}`;
  }

  // A class-level tool/instrument choice (cls.toolChoice, e.g. Bard's "3
  // музыкальных инструмента на выбор") -- shown as a checkbox grid right
  // alongside the class's skill picker above, same idea as the expertise
  // panel just above it. Only rendered for a class that actually has one
  // (just Bard on file today).
  function classToolChoiceUI(cls) {
    if (!cls || !cls.toolChoice) return "";
    const { count, kind } = cls.toolChoice;
    const options = kind === "instrument" ? (TOOL_GROUPS.find((g) => /музыкальн/i.test(g.label))?.items || []) : TOOLS;
    return `
      <div class="panel">
        <h3 style="margin-top:0;">${TOOL_CHOICE_KIND_LABEL[kind] || "Инструменты"}</h3>
        <p>Выберите ${count} инструмента(ов) класса «${cls.name}»:</p>
        <div class="grid cols-2">
          ${options
            .map(
              (name) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-class-tool-choice="${escapeHtml(name)}" ${state.chosenClassTools.includes(name) ? "checked" : ""}
                ${!state.chosenClassTools.includes(name) && state.chosenClassTools.length >= count ? "disabled" : ""} />
              ${escapeHtml(name)}
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }

  // A level-1 subclass grant like Cleric's Knowledge Domain "Благословение
  // знаний" (2 skills from a fixed list, doubled proficiency bonus on them,
  // plus 2 free-choice languages) shown right under the class's own skill
  // picker, since it's still part of "choosing skills" from the player's
  // perspective even though it comes from the subclass card, not
  // cls.skillChoice. Gated by canAdvance() below so "Далее" stays disabled
  // until both picks are made.
  function subclassSkillLanguageChoicesUI() {
    const skillGrant = chosenLevel1SubclassSkillGrant();
    const langGrant = chosenLevel1SubclassLanguageGrant();
    if (!skillGrant && !langGrant) return "";
    let html = "";
    if (skillGrant) {
      html += `
      <div class="panel">
        <h3 style="margin-top:0;">${escapeHtml(skillGrant.featureName)}</h3>
        <p class="muted">Выберите ${skillGrant.count} навык${skillGrant.count > 1 ? "а" : ""} из списка${skillGrant.expertise ? " — бонус мастерства для них будет удвоен" : ""}:</p>
        <div class="grid cols-2">
          ${skillGrant.optionIds
            .map(
              (id) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-subclass-skill-choice="${id}" ${state.chosenSubclassSkills.includes(id) ? "checked" : ""}
                ${!state.chosenSubclassSkills.includes(id) && state.chosenSubclassSkills.length >= skillGrant.count ? "disabled" : ""} />
              ${skillChoiceLabel(id)}
            </label>`
            )
            .join("")}
        </div>
      </div>`;
    }
    if (langGrant) {
      html += `
      <div class="panel">
        <h4 style="margin-top:0;">${escapeHtml(langGrant.featureName)}: языки (${langGrant.count} на выбор)</h4>
        <div class="grid cols-2">
          ${Array.from({ length: langGrant.count })
            .map((_, i) => {
              const picked = state.chosenSubclassLanguages[i] || "";
              return `
            <div class="col">
              <select data-subclass-language-choice="${i}">
                <option value="">— выберите язык —</option>
                ${languageSelectOptionsHtml(picked, raceGrantedLanguageNames())}
                <option value="custom" ${picked === "custom" ? "selected" : ""}>Своё…</option>
              </select>
              ${picked === "custom" ? `<input type="text" data-subclass-language-custom="${i}" value="${escapeHtml(state.subclassLanguageCustom[i] || "")}" placeholder="Впишите язык" style="margin-top:4px;" />` : ""}
            </div>`;
            })
            .join("")}
        </div>
      </div>`;
    }
    return html;
  }

  // A race/subrace's free-choice skill grant (Half-Elf's "Универсальность
  // навыков": 2 skills of any kind, not restricted to a fixed list like the
  // subclass grants above) -- shown as its own panel right under the
  // class's skill picker, same place the flavor-only feature card used to
  // sit before this became an actual choice. Already-granted skills
  // (background, race's own named grants, the class's own picks) are left
  // out of the list so the player isn't tempted to "spend" this on a skill
  // they already have.
  function raceSkillChoiceUI() {
    const grant = raceFreeSkillChoiceGrant();
    if (!grant) return "";
    const bg = getSelectedBackground();
    const fromBg = bg ? bg.skillProficiencies : [];
    const fromAuto = [...new Set([...raceGrantedSkillIds(), ...classGrantedSkillIds()])];
    const taken = new Set([...fromBg, ...fromAuto, ...state.chosenSkills, ...state.chosenSubclassSkills]);
    const options = SKILLS.filter((s) => !taken.has(s.id));
    return `
      <div class="panel">
        <h3 style="margin-top:0;">${escapeHtml(grant.featureName)}</h3>
        <p class="muted">Выберите ${grant.count} навык${grant.count > 1 ? "а" : ""} на выбор (кроме уже имеющихся):</p>
        <div class="grid cols-2">
          ${options
            .map(
              (s) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-race-skill-choice="${s.id}" ${state.chosenRaceSkills.includes(s.id) ? "checked" : ""}
                ${!state.chosenRaceSkills.includes(s.id) && state.chosenRaceSkills.length >= grant.count ? "disabled" : ""} />
              ${skillChoiceLabel(s.id)}
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }

  // A race/subrace's own "N на выбор" languages placeholder (Human's "1 на
  // выбор", most base PHB races), shown the same way the class's tool
  // choice and the subclass's language grant already are on this step --
  // same select-with-"Своё…" pattern as subclassSkillLanguageChoicesUI's
  // langGrant block just above, but for raceLanguageChoiceGrant() instead.
  function raceLanguageChoiceUI() {
    const grant = raceLanguageChoiceGrant();
    if (!grant) return "";
    return `
      <div class="panel">
        <h3 style="margin-top:0;">Языки расы (${grant.count} на выбор)</h3>
        <div class="grid cols-2">
          ${Array.from({ length: grant.count })
            .map((_, i) => {
              const picked = state.chosenRaceLanguages[i] || "";
              return `
            <div class="col">
              <select data-race-language-choice="${i}">
                <option value="">— выберите язык —</option>
                ${languageSelectOptionsHtml(picked, raceGrantedLanguageNames())}
                <option value="custom" ${picked === "custom" ? "selected" : ""}>Своё…</option>
              </select>
              ${picked === "custom" ? `<input type="text" data-race-language-custom="${i}" value="${escapeHtml(state.raceLanguageCustom[i] || "")}" placeholder="Впишите язык" style="margin-top:4px;" />` : ""}
            </div>`;
            })
            .join("")}
        </div>
      </div>`;
  }

  // Alternate Human's "Черта" grant (raceFeatChoiceGrant() above) as an
  // actual pick during creation, instead of a "add it yourself later on
  // the Черты tab" placeholder -- same select + preview-card pattern as
  // the sheet's own featsTab()/add-feat flow, just filed into state until
  // doFinish() turns it into a real data.feats entry.
  function raceFeatChoiceUI() {
    const grant = raceFeatChoiceGrant();
    if (!grant) return "";
    const feat = FEATS.find((f) => f.id === state.chosenRaceFeatId) || null;
    return `
      <div class="panel">
        <h3 style="margin-top:0;">${escapeHtml(grant.featureName)}: выбор черты</h3>
        <div class="row" style="margin-bottom:10px;">
          <select data-race-feat-select style="flex:1;min-width:200px;">
            <option value="">Выберите черту…</option>
            ${FEATS.map((f) => `<option value="${f.id}" ${f.id === state.chosenRaceFeatId ? "selected" : ""}>${escapeHtml(f.name)}</option>`).join("")}
          </select>
        </div>
        ${
          feat
            ? `
          <div class="card" style="margin-bottom:10px;border-color:var(--gold-dim);">
            <h4 style="margin:0 0 4px;">${escapeHtml(feat.name)}</h4>
            ${feat.prereq ? `<p class="muted" style="margin:0 0 4px;">Требование: ${escapeHtml(feat.prereq)}</p>` : ""}
            <p style="margin:0 0 8px;">${escapeHtml(feat.desc)}</p>
            ${
              feat.abilityIncrease && feat.abilityIncrease.choices.length > 1
                ? `
              <div class="row" style="align-items:center;">
                <label style="margin-right:8px;">Повысить характеристику:</label>
                <select data-race-feat-ability-choice>
                  ${feat.abilityIncrease.choices.map((a) => `<option value="${a}" ${a === state.raceFeatAbility ? "selected" : ""}>${ABILITIES.find((x) => x.id === a)?.label || a}</option>`).join("")}
                </select>
              </div>`
                : ""
            }
            ${
              feat.skillChoice
                ? (() => {
                    const bg = getSelectedBackground();
                    const taken = new Set([
                      ...(bg ? bg.skillProficiencies : []),
                      ...raceGrantedSkillIds(),
                      ...classGrantedSkillIds(),
                      ...state.chosenSkills,
                      ...state.chosenSubclassSkills,
                      ...state.chosenRaceSkills,
                    ]);
                    return `
              <p class="muted" style="margin:6px 0 2px;">Выберите ${feat.skillChoice.count} навыка(ов):</p>
              <div class="grid cols-3">
                ${SKILLS.filter((s) => !taken.has(s.id)).map(
                  (s) => `
                  <label style="font-weight:normal;"><input type="checkbox" data-race-feat-skill-choice value="${s.id}" ${state.raceFeatSkills.includes(s.id) ? "checked" : ""} /> ${escapeHtml(s.label)}</label>`
                ).join("")}
              </div>`;
                  })()
                : ""
            }
            ${featExtrasHtml(feat, state.raceFeatSel, { proficiencies: { weapons: [], languages: [] }, spellcasting: { cantrips: [], known: [] } })}
          </div>`
            : ""
        }
      </div>`;
  }

  function skillLabel(id) {
    return { acrobatics: "Акробатика", animalHandling: "Уход за животными", arcana: "Магия", athletics: "Атлетика", deception: "Обман", history: "История", insight: "Проницательность", intimidation: "Запугивание", investigation: "Расследование", medicine: "Медицина", nature: "Природа", perception: "Восприятие", performance: "Выступление", persuasion: "Убеждение", religion: "Религия", sleightOfHand: "Ловкость рук", stealth: "Скрытность", survival: "Выживание" }[id] || id;
  }
  // The modifier a skill will actually give once the character is
  // proficient in it -- ability modifier (using the FINAL score, race
  // bonus included) plus the level-1 proficiency bonus (+2, always, since
  // the wizard only ever creates a level-1 character). Shown in parens next
  // to each pickable skill so the choice isn't just a bare list of names.
  function skillProficientModifier(id) {
    const sk = SKILLS.find((s) => s.id === id);
    if (!sk) return 0;
    return abilityMod(finalAbilityScore(sk.ability)) + 2;
  }
  // A skill checkbox's label, wrapped in the same CSS-hover tooltip pattern
  // as equipmentOptionLabel() (see .eq-tip/.eq-tip-bubble in style.css),
  // showing what the skill is actually used for, plus the modifier it will
  // give once proficient in parentheses.
  function skillChoiceLabel(id) {
    const sk = SKILLS.find((s) => s.id === id);
    const modifier = formatModifier(skillProficientModifier(id));
    const label = `${skillLabel(id)} (${modifier})`;
    if (!sk || !sk.desc) return escapeHtml(label);
    return `<span class="eq-tip">${escapeHtml(label)}<span class="eq-tip-bubble">${escapeHtml(sk.desc)}</span></span>`;
  }

  // A trait like the Elf's "Обострённые чувства" or the Half-Orc's
  // "Угрожающий вид" ("Владение навыком Восприятие."/"...Запугивание.")
  // grants a skill proficiency outright through its text. Shared between
  // stepSkills() (so a race-granted skill isn't offered as if it still needs
  // picking) and doFinish() (which actually folds it into the character).
  function extractSkillProficiencyIds(desc) {
    const m = /Владение\s+навык(?:ом|ами)\s+([^.]+)\.?/i.exec(desc || "");
    if (!m) return [];
    return m[1]
      .split(/,| и /i)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((nm) => SKILLS.find((s) => s.label.toLowerCase() === nm.toLowerCase()))
      .filter(Boolean)
      .map((s) => s.id);
  }
  // Every skill proficiency the currently-chosen race/subrace grants outright
  // through trait text -- these are free, so stepSkills() excludes them from
  // the class's pickable list instead of making the player choose them (and
  // risk thinking they need to, or that skipping them loses the race's grant).
  function raceGrantedSkillIds() {
    const race = RACES.find((r) => r.id === state.raceId);
    if (!race) return [];
    const subrace = (race.subraces || []).find((s) => s.id === state.subraceId);
    const ids = new Set();
    (race.traits || []).forEach((t) => extractSkillProficiencyIds(t.desc).forEach((id) => ids.add(id)));
    if (subrace) (subrace.traits || []).forEach((t) => extractSkillProficiencyIds(t.desc).forEach((id) => ids.add(id)));
    return [...ids];
  }
  // Same idea as raceGrantedSkillIds(), but for a class's own fixed level-1
  // features (not the count-limited skillChoice pick handled separately) --
  // a feature like a subclass's "Владение навыком X" grants a skill outright
  // through its text, so it shouldn't also sit in the class's pickable list
  // and cost the player one of their skillChoice.count picks for nothing.
  function classGrantedSkillIds() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    const ids = new Set();
    if (cls && cls.features && cls.features[1]) {
      cls.features[1].forEach((f) => {
        const split = splitFeatureText(f);
        const fullText = cls.classFeatureText && cls.classFeatureText[split.name];
        extractSkillProficiencyIds(fullText || split.desc).forEach((id) => ids.add(id));
      });
    }
    return [...ids];
  }

  // The player's base score lives in different state fields depending on the
  // chosen ability-assignment method (state.abilities for point-buy/manual,
  // state.standardAssignment for the standard array, state.diceRolls/diceAssignment
  // for rolled scores) -- currentAbilities() already resolves that. Racial
  // bonuses (fixed, "choice", or "flexible", per getRaceBonuses() above) are
  // applied on top only for display ("Итог: X" on the Abilities step). The
  // prepared-caster spell-count formula below needs that same final score,
  // not the bare base one, or a race's ability bonus silently gets dropped
  // from the count, and reading state.abilities directly (rather than
  // currentAbilities()) silently drops the whole base score for the
  // standard-array/dice-roll methods.
  function finalAbilityScore(id) {
    return (currentAbilities()[id] ?? 10) + (getRaceBonuses()[id] || 0);
  }

  // The number of 1st-level spells the player may pick at creation, per the
  // rules encoded on the class: either a flat count (known casters like
  // Bard/Sorcerer/Warlock, or a Wizard's starting spellbook) or a formula
  // computed from the spellcasting ability modifier (prepared casters like
  // Cleric/Druid/Artificer).
  function level1SpellLimit(cls) {
    const sc = cls.spellcasting;
    if (!sc) return 0;
    if (sc.preparedFormula) {
      const mod = abilityMod(finalAbilityScore(sc.ability));
      if (sc.preparedFormula === "mod+halflevel") return Math.max(1, mod + Math.floor(1 / 2));
      return Math.max(1, mod + 1); // "mod+level" at character level 1
    }
    return sc.level1SpellCount || 0;
  }

  // A Cleric has no personal spellbook and no fixed "known spells" list --
  // it can prepare any spell off the entire Cleric list once it has slots,
  // choosing which ones fresh every day. So at creation there's nothing to
  // pick beyond cantrips; actual spell preparation happens later on the
  // sheet's "Подготовить заклинания" flow (Task #109/#111).
  function skipsLevel1SpellChoice(cls) {
    return cls.id === "cleric";
  }

  // The subclass picked at level 1 (Колдун покровитель, etc.) can widen the
  // pool of pickable spells beyond the class's own list (e.g. a Warlock's
  // Otherworldly Patron "Расширенный список заклинаний") -- read straight
  // off state.level1ChoiceIndex, same lookup doFinish() uses to attach the
  // subclass's own features.
  function chosenLevel1Subclass(cls) {
    if (!cls || !cls.level1Choice || cls.level1Choice.type !== "subclass" || state.level1ChoiceIndex == null) return null;
    const pick = cls.level1Choice.options[state.level1ChoiceIndex];
    if (!pick) return null;
    return (cls.subclasses || []).find((s) => s.name.toLowerCase() === pick.name.toLowerCase()) || null;
  }

  const SKILL_CHOICE_COUNT_WORDS = { "одним": 1, "одна": 1, "одно": 1, "двумя": 2 };
  // A subclass level-1 feature that grants proficiency in N skills picked
  // from a fixed short list, worded either "владение двумя навыками ... из
  // следующего списка: A, B, C, D." (Cleric's Knowledge Domain "Благословение
  // знаний") or "владение одним из следующих навыков[ по вашему выбору]: A,
  // B, C." (Nature Domain, Cavalier, Samurai, ...). Returns
  // { count, optionIds, expertise } or null when the text doesn't match --
  // expertise is true when the same feature also doubles proficiency bonus
  // for those skills (Knowledge Domain only, so far).
  function parseSkillChoiceGrant(desc) {
    const text = String(desc || "");
    const m = /владение\s+(одним|одна|одно|двумя)\s+(?:навык(?:ом|ами)\s+)?(?:по\s+вашему\s+выбору\s+)?из\s+(?:следующего\s+списка|следующих\s+навыков)(?:\s+по\s+вашему\s+выбору)?:\s*([^.]+)\./i.exec(text);
    if (!m) return null;
    const count = SKILL_CHOICE_COUNT_WORDS[m[1].toLowerCase()] || 1;
    // \b is useless as a delimiter here -- JS regex treats Cyrillic letters
    // as non-word characters, so \bили\b/\bи\b never actually matches mid-
    // string; splitting on the surrounding whitespace instead avoids both
    // that and false-splitting inside a word that merely contains "и".
    const optionIds = m[2]
      .split(/\s*,\s*|\s+или\s+|\s+и\s+/i)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((nm) => SKILLS.find((s) => s.label.toLowerCase() === nm.toLowerCase()))
      .filter(Boolean)
      .map((s) => s.id);
    if (!optionIds.length) return null;
    const expertise = /бонус мастерства удваивается/i.test(text);
    return { count, optionIds, expertise };
  }
  // A race/subrace trait that grants proficiency in N skills of the
  // player's choice from the ENTIRE skill list, not a fixed short list --
  // Half-Elf's "Универсальность навыков": "Владение двумя навыками на
  // выбор." (no "из следующего списка" for parseSkillChoiceGrant above to
  // match). Anchored to the end of the sentence so a trait that *does* name
  // a restricted list right after "на выбор" (e.g. "...на выбор из пяти" /
  // "...на выбор: А, Б, В") is correctly left to parseSkillChoiceGrant or,
  // for a list this app can't yet resolve, left as inert flavor text rather
  // than guessed at. Returns { count } or null.
  function parseFreeSkillChoiceGrant(desc) {
    const text = String(desc || "");
    const m = /владение\s+(одним|одна|одно|двумя|тремя|четырьмя|пятью)\s+навык(?:ом|ами|а)\s+на\s+выбор\.?\s*$/i.exec(text.trim());
    if (!m) return null;
    const words = { ...SKILL_CHOICE_COUNT_WORDS, "тремя": 3, "четырьмя": 4, "пятью": 5 };
    return { count: words[m[1].toLowerCase()] || 1 };
  }
  // Languages already granted by the chosen race/subrace (e.g. "Общий",
  // "Эльфийский") shouldn't be offered again in the subclass/background
  // language-choice dropdowns. Race `languages` entries mix concrete names
  // with choice-count placeholders ("1 на выбор") and "X или Y" alternative
  // strings -- placeholders are skipped, alternatives are split so both
  // options are excluded.
  function raceGrantedLanguageNames() {
    const race = RACES.find((r) => r.id === state.raceId);
    if (!race) return [];
    const subrace = (race.subraces || []).find((s) => s.id === state.subraceId);
    // Mirrors the same replacesLanguages opt-out used when resolving the
    // character's final language list (doFinish) -- a subrace that swaps
    // out the race's languages entirely (Tiefling Bездны) shouldn't still
    // count the race's own (no-longer-known) languages as "already granted".
    const raceLangs = subrace && subrace.replacesLanguages ? [] : (race.languages || []);
    const langs = [...raceLangs, ...((subrace && subrace.languages) || [])];
    const names = new Set();
    langs.forEach((l) => {
      if (/на\s+выбор/i.test(l)) return;
      l.split(/\s+или\s+/i).forEach((part) => names.add(part.trim()));
    });
    return [...names];
  }
  // A race/subrace's own languages list can carry a "N на выбор" placeholder
  // entry directly (Human's ["Общий", "1 на выбор"]) rather than burying the
  // grant inside a trait's prose like the subclass/background versions do --
  // this sums up every such placeholder into one pickable count, the same
  // way chosenLevel1SubclassLanguageGrant() does for a subclass feature.
  // A race/subrace can grant an actual feat pick instead of just a fixed
  // trait -- so far only Human (альтернативный)'s "Черта" ("Вы получаете
  // одну черту на ваш выбор"). Detected generically off the trait's own
  // text (rather than hardcoded to that one subrace id) so any future
  // race/subrace with the same wording gets the same wizard-time picker.
  function raceFeatChoiceGrant() {
    const race = RACES.find((r) => r.id === state.raceId);
    if (!race) return null;
    const subrace = (race.subraces || []).find((s) => s.id === state.subraceId);
    const sources = [...(race.traits || []), ...((subrace && subrace.traits) || [])];
    const t = sources.find((t) => /черту\s+на\s+(ваш|свой)\s+выбор/i.test(t.desc || ""));
    return t ? { featureName: t.name } : null;
  }
  function raceLanguageChoiceGrant() {
    const race = RACES.find((r) => r.id === state.raceId);
    if (!race) return null;
    const subrace = (race.subraces || []).find((s) => s.id === state.subraceId);
    const raceLangs = subrace && subrace.replacesLanguages ? [] : (race.languages || []);
    const langs = [...raceLangs, ...((subrace && subrace.languages) || [])];
    let count = 0;
    langs.forEach((l) => {
      const m = /^(\d+)\s*на\s+выбор$/i.exec(String(l).trim());
      if (m) count += Number(m[1]);
    });
    return count ? { count } : null;
  }
  // Renders <option>s for a language-choice <select>, grouped into
  // "Распространённые" / "Экзотические" optgroups (LANGUAGE_GROUPS), with
  // any already race-granted languages left out so they aren't offered twice.
  function languageSelectOptionsHtml(picked, exclude) {
    const excludeSet = new Set(exclude || []);
    return LANGUAGE_GROUPS.map((g) => {
      const items = g.items.filter((l) => !excludeSet.has(l));
      if (!items.length) return "";
      return `<optgroup label="${escapeHtml(g.label)}">${items.map((l) => `<option value="${escapeHtml(l)}" ${picked === l ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</optgroup>`;
    }).join("");
  }
  // Same idea as chosenLevel1SubclassSkillGrant(), but for a race/subrace
  // trait's free-choice skill grant (parseFreeSkillChoiceGrant above)
  // instead of a subclass's list-restricted one.
  function raceFreeSkillChoiceGrant() {
    const race = RACES.find((r) => r.id === state.raceId);
    if (!race) return null;
    const subrace = (race.subraces || []).find((s) => s.id === state.subraceId);
    for (const t of [...(race.traits || []), ...((subrace && subrace.traits) || [])]) {
      const grant = parseFreeSkillChoiceGrant(t.desc);
      if (grant) return { featureName: t.name, ...grant };
    }
    return null;
  }
  // Same feature card can also grant a fixed number of free-choice languages
  // ("Вы можете выучить два языка на свой выбор.") -- Cleric's Knowledge
  // Domain does both in the same "Благословение знаний" feature, so this is
  // checked on the same text rather than folded into parseSkillChoiceGrant.
  const LANGUAGE_COUNT_WORDS = { "один": 1, "одно": 1, "два": 2, "две": 2, "три": 3 };
  function parseLanguageChoiceGrant(desc) {
    const m = /выучить\s+(\d+|один|одно|два|две|три)\s+язы[кав]+\s+на\s+свой\s+выбор/i.exec(String(desc || ""));
    if (!m) return 0;
    return Number.isFinite(Number(m[1])) && m[1].match(/^\d+$/) ? Number(m[1]) : LANGUAGE_COUNT_WORDS[m[1].toLowerCase()] || 0;
  }
  // Looks across every level-1 feature of the character's chosen level-1
  // subclass (Cleric/Sorcerer/Warlock only -- the only classes the wizard
  // lets a player pick a subclass for at creation) for a skill-choice grant
  // like the above. Only ever one match expected in practice.
  function chosenLevel1SubclassSkillGrant() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    const sub = chosenLevel1Subclass(cls);
    if (!sub) return null;
    for (const sf of sub.features || []) {
      if (sf.level !== 1) continue;
      const grant = parseSkillChoiceGrant((sf.desc || []).join(" "));
      if (grant) return { featureName: sf.name, ...grant };
    }
    return null;
  }
  function chosenLevel1SubclassLanguageGrant() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    const sub = chosenLevel1Subclass(cls);
    if (!sub) return null;
    for (const sf of sub.features || []) {
      if (sf.level !== 1) continue;
      const count = parseLanguageChoiceGrant((sf.desc || []).join(" "));
      if (count) return { featureName: sf.name, count };
    }
    return null;
  }
  function stepSpells() {
    const cls = CLASSES.find((c) => c.id === state.classId);
    if (!cls || !cls.spellcasting) return `<div class="panel"><p class="muted">Этот класс не владеет заклинаниями на 1 уровне.</p></div>`;
    const expandedIds = new Set((chosenLevel1Subclass(cls) || {}).expandedSpells || []);
    const cantrips = SPELLS.filter((s) => s.level === 0 && s.classes.includes(cls.id));
    const cantripLimit = cls.spellcasting.cantripsKnown || 0;
    const skipSpellChoice = skipsLevel1SpellChoice(cls);
    const cantripsHtml = `
        <p>Заговоры (выберите до ${cantripLimit}):</p>
        <div class="spell-cards">
          ${cantrips
            .map((s) => {
              const checked = state.chosenCantrips.includes(s.id);
              const disabled = !checked && state.chosenCantrips.length >= cantripLimit;
              return spellCardHtml(
                s,
                `<input type="checkbox" data-cantrip-choice="${s.id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />`,
                { known: checked }
              );
            })
            .join("")}
        </div>`;
    if (skipSpellChoice) {
      return `
      <div class="panel">
        <p style="font-weight:600;margin-top:0;">Выберите заговоры и заклинания для вашего класса</p>
        <p class="muted">💡 ${cls.name} не ведёт книгу заклинаний и не имеет фиксированного списка известных заклинаний — доступны все заклинания класса. Какие из них подготовлены на день, выбирается позже на вкладке «Заклинания» в листе персонажа.</p>
        ${cantripsHtml}
      </div>`;
    }
    const firstLevel = SPELLS.filter((s) => s.level === 1 && (s.classes.includes(cls.id) || expandedIds.has(s.id)));
    const spellLimit = level1SpellLimit(cls);
    const spellLimitNote = cls.spellcasting.preparedFormula
      ? `по формуле класса: модификатор характеристики${cls.spellcasting.preparedFormula === "mod+halflevel" ? " + пол. уровня" : " + уровень"}, минимум 1`
      : "фиксированное число для класса на 1 уровне";
    return `
      <div class="panel">
        <p style="font-weight:600;margin-top:0;">Выберите заговоры и заклинания для вашего класса</p>
        <p class="muted">💡 Число ячеек заклинаний зависит от класса — уточните на вкладке заклинаний в листе персонажа и укажите там же характеристику заклинаний и количество ячеек.</p>
        ${cantripsHtml}
        <hr style="border:none;border-top:2px solid var(--gold);margin:18px 0;opacity:0.8;" />
        <p id="level1-spells-section" style="margin-top:0;">Заклинания 1-го круга (выберите до ${spellLimit} — ${spellLimitNote}):</p>
        <div class="spell-cards">
          ${firstLevel
            .map((s) => {
              const checked = state.chosenSpells.includes(s.id);
              const disabled = !checked && state.chosenSpells.length >= spellLimit;
              return spellCardHtml(
                s,
                `<input type="checkbox" data-spell-choice="${s.id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />`,
                { known: checked }
              );
            })
            .join("")}
        </div>
      </div>`;
  }

  // Returns the selected background, either from BACKGROUNDS or synthesized
  // from the player's custom-background inputs, in the same shape.
  function getSelectedBackground() {
    if (state.backgroundId === "custom") {
      const cb = state.customBackground;
      return {
        id: "custom",
        name: cb.name || "Своя предыстория",
        source: "",
        skillProficiencies: cb.skills,
        toolProficiencies: cb.tools ? [cb.tools] : [],
        languages: 0,
        equipment: cb.equipment,
        feature: { name: cb.featureName || "Особенность предыстории", desc: cb.featureDesc || "" },
      };
    }
    return BACKGROUNDS.find((b) => b.id === state.backgroundId) || null;
  }

  // A background's toolProficiencies entry is either a fixed proficiency
  // ("Воровские инструменты") or a descriptive stand-in for a choice the
  // player has to make ("Инструменты ремесленника (один вид на ваш выбор)",
  // "Выберите два: игровой набор, музыкальный инструмент, воровские
  // инструменты"…). This flags the latter so it gets its own dropdown
  // instead of being saved as inert placeholder text.
  function isToolChoiceEntry(text) {
    return /выбор|выберите|любой|один\s+(вид|тип|набор|инструмент)/i.test(text || "");
  }
  function backgroundToolChoiceIndices(bg) {
    return (bg && bg.toolProficiencies ? bg.toolProficiencies : [])
      .map((t, i) => (isToolChoiceEntry(t) ? i : -1))
      .filter((i) => i >= 0);
  }
  // Which of the several separate dropdown lists a choice-entry actually
  // needs -- read straight from its own wording, so Моряк/Пират's "Транспорт
  // (водный, один вид)" gets vehicle options instead of the unrelated
  // craftsman's-tools list it used to fall into, Дворянин/Преступник's
  // "Игровой набор" gets actual game sets, and so on.
  function toolChoiceKind(text) {
    const t = text || "";
    if (/транспорт/i.test(t)) return "vehicle";
    if (/игровой\s+набор/i.test(t)) return "gamingSet";
    if (/музыкальн/i.test(t)) return "instrument";
    return "tool";
  }
  const TOOL_CHOICE_KIND_LABEL = { tool: "Инструменты", instrument: "Музыкальные инструменты", vehicle: "Транспорт", gamingSet: "Игровой набор" };
  function toolChoiceOptionsHtml(kind, picked) {
    const opt = (t) => `<option value="${escapeHtml(t)}" ${picked === t ? "selected" : ""}>${escapeHtml(t)}</option>`;
    const grouped = (groups) => groups.map((g) => `<optgroup label="${escapeHtml(g.label)}">${g.items.map(opt).join("")}</optgroup>`).join("");
    if (kind === "vehicle") return grouped(VEHICLE_GROUPS);
    if (kind === "gamingSet") return GAMING_SETS.map(opt).join("");
    if (kind === "instrument") {
      const group = TOOL_GROUPS.find((g) => /музыкальн/i.test(g.label));
      return (group ? group.items : []).map(opt).join("");
    }
    return grouped(TOOL_GROUPS);
  }
  // Resolves the background's languages/tools into the actual strings to
  // save on the character, using the player's dropdown picks where a choice
  // was needed and falling back to the original text for anything not yet
  // picked (so an unfinished wizard doesn't silently lose the grant).
  function resolvedBackgroundLanguages(bg) {
    if (!bg || !bg.languages) return [];
    const out = [];
    for (let i = 0; i < bg.languages; i++) {
      const picked = state.chosenBgLanguages[i];
      if (picked === "custom") out.push(state.bgLanguageCustom[i] || "1 на выбор (предыстория)");
      else if (picked) out.push(picked);
      else out.push("1 на выбор (предыстория)");
    }
    return out;
  }
  function resolvedBackgroundTools(bg) {
    if (!bg || !bg.toolProficiencies) return [];
    return bg.toolProficiencies.map((entry, i) => {
      if (!isToolChoiceEntry(entry)) return entry;
      const picked = state.chosenBgTools[i];
      if (picked === "custom") return state.bgToolCustom[i] || entry;
      if (picked) return picked;
      return entry;
    });
  }

  // Dropdown pickers for a chosen background's language(s) and choice-based
  // tool proficiencies, each with a "своё" free-text fallback -- shown right
  // under the background cards so the choice is made (and immediately
  // reflected on the sheet) at creation time instead of being left as
  // placeholder text like "+1 на выбор (предыстория)".
  function backgroundChoicesUI() {
    const bg = getSelectedBackground();
    if (!bg) return "";
    const toolIdxs = backgroundToolChoiceIndices(bg);
    if (!bg.languages && !toolIdxs.length) return "";
    let html = `<div class="panel"><h4>Языки и инструменты предыстории</h4>`;
    if (bg.languages) {
      html += `<p class="muted">Языки (${bg.languages} на выбор):</p><div class="grid cols-2" style="margin-bottom:10px;">`;
      for (let i = 0; i < bg.languages; i++) {
        const picked = state.chosenBgLanguages[i] || "";
        html += `
          <div class="col">
            <select data-bg-language-choice="${i}">
              <option value="">— выберите язык —</option>
              ${languageSelectOptionsHtml(picked, raceGrantedLanguageNames())}
              <option value="custom" ${picked === "custom" ? "selected" : ""}>Своё…</option>
            </select>
            ${picked === "custom" ? `<input type="text" data-bg-language-custom="${i}" value="${escapeHtml(state.bgLanguageCustom[i] || "")}" placeholder="Впишите язык" style="margin-top:4px;" />` : ""}
          </div>`;
      }
      html += `</div>`;
    }
    if (toolIdxs.length) {
      // Grouped by kind (tool/instrument/vehicle/gamingSet) so each gets its
      // own labeled dropdown list, in a fixed order, instead of lumping
      // every choice-entry under one generic "Инструменты" heading.
      const byKind = {};
      toolIdxs.forEach((i) => {
        const kind = toolChoiceKind(bg.toolProficiencies[i]);
        (byKind[kind] = byKind[kind] || []).push(i);
      });
      ["tool", "instrument", "vehicle", "gamingSet"].forEach((kind) => {
        const idxs = byKind[kind];
        if (!idxs || !idxs.length) return;
        html += `<p class="muted">${TOOL_CHOICE_KIND_LABEL[kind]}:</p><div class="grid cols-2" style="margin-bottom:10px;">`;
        idxs.forEach((i) => {
          const entry = bg.toolProficiencies[i];
          const picked = state.chosenBgTools[i] || "";
          html += `
          <div class="col">
            <label class="muted" style="font-size:0.8rem;">${escapeHtml(entry)}</label>
            <select data-bg-tool-choice="${i}">
              <option value="">— выберите —</option>
              ${toolChoiceOptionsHtml(kind, picked)}
              <option value="custom" ${picked === "custom" ? "selected" : ""}>Своё…</option>
            </select>
            ${picked === "custom" ? `<input type="text" data-bg-tool-custom="${i}" value="${escapeHtml(state.bgToolCustom[i] || "")}" placeholder="Впишите вариант" style="margin-top:4px;" />` : ""}
          </div>`;
        });
        html += `</div>`;
      });
    }
    html += `</div>`;
    return html;
  }

  function stepSummary() {
    const race = RACES.find((r) => r.id === state.raceId);
    const subrace = race ? (race.subraces || []).find((s) => s.id === state.subraceId) : null;
    const cls = CLASSES.find((c) => c.id === state.classId);
    const bg = getSelectedBackground();
    const raceLabel = race ? race.name + (subrace ? ` (${subrace.name})` : "") : "—";
    return `
      <div class="panel">
        <p class="muted">💡 Проверьте лист персонажа после создания: КД (10 + модификатор Ловкости, если нет доспеха), формулу атаки и урона оружия (характеристика + куб урона), и подготовленные заклинания — эти шаги можно уточнить прямо на листе.</p>
        <div class="col">
          <label>Имя персонажа</label>
          <input type="text" data-name-input value="${escapeHtml(state.name)}" placeholder="Введите имя" />
        </div>
        <div class="card" style="margin-top:10px;">
          <h4>${escapeHtml(state.name || "Безымянный герой")}</h4>
          <p>${raceLabel} · ${cls ? cls.name + " 1 ур." : "—"} · ${bg ? bg.name : "—"}</p>
          <p>Редакция: D&D ${state.edition}</p>
        </div>
      </div>`;
  }

  function wire() {
    const app = $("#app");
    // The top-left "← ⚔ D&D 5e" home link used to jump straight back to the
    // character list with no warning, silently discarding whatever progress
    // the player had made in the wizard (nothing is saved until "Создать
    // персонажа" on the last step). Any step past the first, or a race/class
    // already picked on that first step, counts as "progress worth losing".
    on(app, "click", "a.brand", (e) => {
      const hasProgress = state.step > 0 || !!state.raceId || !!state.classId;
      if (hasProgress && !confirm("Прервать создание персонажа? Несохранённый прогресс будет потерян.")) {
        e.preventDefault();
      }
    });
    on(app, "click", "[data-goto-step]", (e, el) => {
      const i = Number(el.dataset.gotoStep);
      if (Number.isNaN(i) || i === state.step || i > (state.maxStep || 0)) return;
      state.step = i;
      render();
    });
    on(app, "click", "[data-action=back]", () => { state.step = Math.max(0, state.step - 1); render(); });
    on(app, "click", "[data-action=next]", () => { if (!canAdvance()) return; state.step = Math.min(relevantSteps().length - 1, state.step + 1); state.maxStep = Math.max(state.maxStep || 0, state.step); render(); });
    on(app, "click", "[data-action=finish]", (e, el) => { if (canAdvance()) finish(el); });
    on(app, "click", "[data-action=change-race]", () => {
      state.raceId = null;
      state.maxStep = state.step;
      state.subraceId = null;
      state.raceChoiceAbilities = [];
      state.raceFlexibleAlloc = {};
      state.chosenRaceSkills = [];
      state.chosenRaceLanguages = [];
      state.raceLanguageCustom = {};
      state.chosenRaceFeatId = "";
      state.raceFeatAbility = "";
      state.raceFeatSkills = [];
      state.raceFeatSel = newFeatSel();
      render();
    });

    on(app, "click", "[data-edition]", (e, el) => { state.edition = el.dataset.edition; render(); });
    on(app, "click", "[data-race]", (e, el) => {
      state.raceId = el.dataset.race;
      state.maxStep = state.step;
      state.subraceId = null;
      state.raceChoiceAbilities = [];
      state.raceFlexibleAlloc = {};
      state.chosenRaceSkills = [];
      state.chosenRaceLanguages = [];
      state.raceLanguageCustom = {};
      state.chosenRaceFeatId = "";
      state.raceFeatAbility = "";
      state.raceFeatSkills = [];
      state.raceFeatSel = newFeatSel();
      render();
    });
    on(app, "click", "[data-subrace]", (e, el) => {
      state.subraceId = el.dataset.subrace;
      state.raceChoiceAbilities = [];
      state.raceFlexibleAlloc = {};
      state.chosenRaceSkills = [];
      state.chosenRaceLanguages = [];
      state.raceLanguageCustom = {};
      state.chosenRaceFeatId = "";
      state.raceFeatAbility = "";
      state.raceFeatSkills = [];
      state.raceFeatSel = newFeatSel();
      render();
    });
    on(app, "click", "[data-race-source]", (e, el) => { state.raceSourceFilter = el.dataset.raceSource; render(); });
    on(app, "click", "[data-background-source]", (e, el) => { state.backgroundSourceFilter = el.dataset.backgroundSource; render(); });
    on(app, "click", "[data-class]", (e, el) => {
      state.classId = el.dataset.class;
      state.maxStep = state.step;
      state.chosenSkills = [];
      state.equipmentSelections = {};
      state.classEquipmentDeclined = false;
      state.classGoldRoll = 0;
      state.level1ChoiceIndex = null;
      state.chosenSubclassSkills = [];
      state.chosenSubclassLanguages = [];
      state.subclassLanguageCustom = {};
      state.favoredEnemy = "";
      state.favoredEnemyHumanoid1 = "";
      state.favoredEnemyHumanoid2 = "";
      state.favoredEnemyLanguage = "";
      state.favoredEnemyLanguageCustom = "";
      state.favoredTerrain = "";
      render();
    });
    on(app, "click", "[data-action=change-class]", () => {
      state.classId = null;
      state.maxStep = state.step;
      state.level1ChoiceIndex = null;
      state.chosenSubclassSkills = [];
      state.chosenSubclassLanguages = [];
      state.subclassLanguageCustom = {};
      render();
    });
    on(app, "click", "[data-level1-choice]", (e, el) => {
      state.level1ChoiceIndex = Number(el.dataset.level1Choice);
      // A different subclass pick can grant a different skill-choice list
      // (or none at all) -- clear out any picks that no longer make sense.
      state.chosenSubclassSkills = [];
      state.chosenSubclassLanguages = [];
      state.subclassLanguageCustom = {};
      render();
    });
    on(app, "click", "[data-favored-enemy]", (e, el) => {
      state.favoredEnemy = el.dataset.favoredEnemy;
      state.favoredEnemyHumanoid1 = "";
      state.favoredEnemyHumanoid2 = "";
      render();
    });
    on(app, "input", "[data-favored-enemy-humanoid]", (e, el) => {
      if (el.dataset.favoredEnemyHumanoid === "1") state.favoredEnemyHumanoid1 = el.value;
      else state.favoredEnemyHumanoid2 = el.value;
    });
    on(app, "change", "[data-favored-enemy-language]", (e, el) => {
      state.favoredEnemyLanguage = el.value;
      render();
    });
    on(app, "input", "[data-favored-enemy-language-custom]", (e, el) => {
      state.favoredEnemyLanguageCustom = el.value;
    });
    on(app, "click", "[data-favored-terrain]", (e, el) => {
      state.favoredTerrain = el.dataset.favoredTerrain;
      render();
    });
    on(app, "click", "[data-background]", (e, el) => {
      state.backgroundId = el.dataset.background;
      state.chosenSkills = [];
      state.chosenBgLanguages = [];
      state.bgLanguageCustom = {};
      state.chosenBgTools = {};
      state.bgToolCustom = {};
      render();
    });
    on(app, "input", "[data-custom-bg-name]", (e, el) => { state.customBackground.name = el.value; });
    on(app, "change", "[data-custom-bg-skill]", (e, el) => {
      const id = el.dataset.customBgSkill;
      if (el.checked) state.customBackground.skills.push(id);
      else state.customBackground.skills = state.customBackground.skills.filter((x) => x !== id);
      render();
    });
    on(app, "input", "[data-custom-bg-tools]", (e, el) => { state.customBackground.tools = el.value; });
    on(app, "input", "[data-custom-bg-equipment]", (e, el) => { state.customBackground.equipment = el.value; });
    on(app, "input", "[data-custom-bg-feature-name]", (e, el) => { state.customBackground.featureName = el.value; });
    on(app, "input", "[data-custom-bg-feature-desc]", (e, el) => { state.customBackground.featureDesc = el.value; });
    on(app, "change", "[data-bg-language-choice]", (e, el) => {
      state.chosenBgLanguages[Number(el.dataset.bgLanguageChoice)] = el.value;
      render();
    });
    on(app, "input", "[data-bg-language-custom]", (e, el) => {
      state.bgLanguageCustom[Number(el.dataset.bgLanguageCustom)] = el.value;
    });
    on(app, "change", "[data-bg-tool-choice]", (e, el) => {
      state.chosenBgTools[Number(el.dataset.bgToolChoice)] = el.value;
      render();
    });
    on(app, "input", "[data-bg-tool-custom]", (e, el) => {
      state.bgToolCustom[Number(el.dataset.bgToolCustom)] = el.value;
    });
    on(app, "change", "[data-equip-group]", (e, el) => {
      state.equipmentSelections[Number(el.dataset.equipGroup)] = Number(el.dataset.equipOption);
    });
    on(app, "change", "[data-weapon-category-choice]", (e, el) => {
      state.weaponCategoryChoices[el.dataset.weaponCategoryChoice] = el.value;
      render();
    });
    on(app, "click", "[data-action=toggle-decline-equipment]", () => {
      state.classEquipmentDeclined = !state.classEquipmentDeclined;
      state.classGoldRoll = state.classEquipmentDeclined ? rollClassStartingGold() : 0;
      render();
    });
    on(app, "click", "[data-action=reroll-decline-gold]", () => {
      state.classGoldRoll = rollClassStartingGold();
      render();
    });

    on(app, "click", "[data-method]", (e, el) => { state.abilityMethod = el.dataset.method; render(); });
    on(app, "change", "[data-standard-ability]", (e, el) => {
      state.standardAssignment[el.dataset.standardAbility] = el.value ? Number(el.value) : undefined;
      render();
    });
    on(app, "change", "[data-pointbuy-ability]", (e, el) => {
      state.abilities[el.dataset.pointbuyAbility] = Number(el.value);
      render();
    });
    on(app, "input", "[data-manual-ability]", (e, el) => {
      state.abilities[el.dataset.manualAbility] = Number(el.value) || 1;
    });
    // A base ability score at creation can't be typed above 20 (or below 1)
    // -- clamped on blur/change rather than every keystroke, same reasoning
    // as the sheet's own ability-score clamp: typing a fresh value after
    // clearing the field shouldn't get snapped back mid-edit.
    on(app, "change", "[data-manual-ability]", (e, el) => {
      const clamped = Math.max(1, Math.min(20, Math.round(Number(el.value) || 1)));
      el.value = clamped;
      state.abilities[el.dataset.manualAbility] = clamped;
      render();
    });
    on(app, "click", "[data-action='roll-dice']", () => {
      state.diceRolls = rollSixAbilityScores();
      state.diceRerollUsed = false;
      state.diceAssignment = {};
      render();
    });
    on(app, "click", "[data-action='reroll-dice']", (e, el) => {
      if (state.diceRerollUsed) return;
      const idx = Number(el.dataset.index);
      state.diceRolls[idx] = rollAbilityScore();
      state.diceRerollUsed = true;
      render();
    });
    on(app, "change", "[data-dice-ability]", (e, el) => {
      const abilityId = el.dataset.diceAbility;
      if (el.value === "") delete state.diceAssignment[abilityId];
      else state.diceAssignment[abilityId] = Number(el.value);
      render();
    });

    on(app, "change", "[data-race-choice-ability]", (e, el) => {
      const id = el.dataset.raceChoiceAbility;
      if (el.checked) state.raceChoiceAbilities.push(id);
      else state.raceChoiceAbilities = state.raceChoiceAbilities.filter((x) => x !== id);
      render();
    });
    on(app, "change", "[data-race-flex-ability]", (e, el) => {
      state.raceFlexibleAlloc[el.dataset.raceFlexAbility] = Number(el.value) || 0;
      render();
    });

    on(app, "change", "[data-skill-choice]", (e, el) => {
      const id = el.dataset.skillChoice;
      if (el.checked) state.chosenSkills.push(id);
      else state.chosenSkills = state.chosenSkills.filter((x) => x !== id);
      // A skill dropped from the class picks can't stay picked for
      // Компетентность either -- it wouldn't be a proficient skill anymore.
      if (!el.checked) state.chosenExpertise = state.chosenExpertise.filter((x) => x !== id);
      render();
    });
    on(app, "change", "[data-expertise-choice]", (e, el) => {
      const id = el.dataset.expertiseChoice;
      if (el.checked) state.chosenExpertise.push(id);
      else state.chosenExpertise = state.chosenExpertise.filter((x) => x !== id);
      render();
    });
    on(app, "change", "[data-class-tool-choice]", (e, el) => {
      const name = el.dataset.classToolChoice;
      if (el.checked) state.chosenClassTools.push(name);
      else state.chosenClassTools = state.chosenClassTools.filter((x) => x !== name);
      render();
    });
    on(app, "change", "[data-subclass-skill-choice]", (e, el) => {
      const id = el.dataset.subclassSkillChoice;
      if (el.checked) state.chosenSubclassSkills.push(id);
      else state.chosenSubclassSkills = state.chosenSubclassSkills.filter((x) => x !== id);
      render();
    });
    on(app, "change", "[data-race-skill-choice]", (e, el) => {
      const id = el.dataset.raceSkillChoice;
      if (el.checked) state.chosenRaceSkills.push(id);
      else state.chosenRaceSkills = state.chosenRaceSkills.filter((x) => x !== id);
      render();
    });
    on(app, "change", "[data-subclass-language-choice]", (e, el) => {
      state.chosenSubclassLanguages[Number(el.dataset.subclassLanguageChoice)] = el.value;
      render();
    });
    on(app, "input", "[data-subclass-language-custom]", (e, el) => {
      state.subclassLanguageCustom[Number(el.dataset.subclassLanguageCustom)] = el.value;
    });
    on(app, "change", "[data-race-language-choice]", (e, el) => {
      state.chosenRaceLanguages[Number(el.dataset.raceLanguageChoice)] = el.value;
      render();
    });
    on(app, "input", "[data-race-language-custom]", (e, el) => {
      state.raceLanguageCustom[Number(el.dataset.raceLanguageCustom)] = el.value;
    });
    on(app, "change", "[data-race-feat-select]", (e, el) => {
      state.chosenRaceFeatId = el.value;
      const feat = FEATS.find((f) => f.id === state.chosenRaceFeatId);
      state.raceFeatAbility = feat && feat.abilityIncrease ? feat.abilityIncrease.choices[0] : "";
      state.raceFeatSkills = [];
      state.raceFeatSel = newFeatSel();
      render();
    });
    wireFeatExtras(app, () => state.raceFeatSel, () => FEATS.find((f) => f.id === state.chosenRaceFeatId), render);
    on(app, "change", "[data-race-feat-ability-choice]", (e, el) => {
      state.raceFeatAbility = el.value;
    });
    on(app, "change", "[data-race-feat-skill-choice]", (e, el) => {
      const v = el.value;
      if (el.checked) {
        if (!state.raceFeatSkills.includes(v)) state.raceFeatSkills.push(v);
      } else {
        state.raceFeatSkills = state.raceFeatSkills.filter((s) => s !== v);
      }
    });
    on(app, "change", "[data-cantrip-choice]", (e, el) => {
      const id = el.dataset.cantripChoice;
      if (el.checked) state.chosenCantrips.push(id);
      else state.chosenCantrips = state.chosenCantrips.filter((x) => x !== id);
      render();
      // Once the last cantrip slot is filled, carry the player straight down
      // to the 1st-circle spells instead of leaving them to scroll manually.
      const cls = CLASSES.find((c) => c.id === state.classId);
      const cantripLimit = cls && cls.spellcasting ? cls.spellcasting.cantripsKnown || 0 : 0;
      if (el.checked && cantripLimit && state.chosenCantrips.length === cantripLimit && cls && !skipsLevel1SpellChoice(cls)) {
        const target = document.getElementById("level1-spells-section");
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    on(app, "change", "[data-spell-choice]", (e, el) => {
      const id = el.dataset.spellChoice;
      if (el.checked) state.chosenSpells.push(id);
      else state.chosenSpells = state.chosenSpells.filter((x) => x !== id);
      render();
    });
    on(app, "input", "[data-name-input]", (e, el) => { state.name = el.value; });
  }

  // Guards against the "Создать персонажа" button creating several
  // characters from one click: the button isn't disabled while the POST is
  // in flight, so an impatient extra click (or a click that lands while the
  // network round-trip is still pending) used to fire a second/third
  // createCharacter request before navigate() could leave this view.
  let finishing = false;
  async function finish(buttonEl) {
    if (finishing) return;
    finishing = true;
    if (buttonEl) buttonEl.disabled = true;
    try {
      await doFinish();
    } finally {
      finishing = false;
      if (buttonEl) buttonEl.disabled = false;
    }
  }

  async function doFinish() {
    const race = RACES.find((r) => r.id === state.raceId);
    const subrace = race ? (race.subraces || []).find((s) => s.id === state.subraceId) : null;
    const cls = CLASSES.find((c) => c.id === state.classId);
    const bg = getSelectedBackground();
    const data = blankCharacter(state.edition);
    // A few classes (Жрец/Чародей/Колдун) pick their subclass at level 1
    // instead of 3; Воин's level-1 choice (Боевой стиль) isn't a subclass.
    const level1Choice = cls && cls.level1Choice && state.level1ChoiceIndex != null ? cls.level1Choice.options[state.level1ChoiceIndex] : null;

    data.name = state.name || "Безымянный герой";
    data.raceName = race ? race.name + (subrace ? ` (${subrace.name})` : "") : "";
    data.backgroundName = bg ? bg.name : "";
    data.classes = cls ? [{ id: cls.id, name: cls.name, level: 1, subclass: level1Choice && cls.level1Choice.type === "subclass" ? level1Choice.name : "" }] : [];
    data.speed = subrace && subrace.speed ? subrace.speed : race ? race.speed : 30;

    const abilities = currentAbilities();
    data.abilityBonuses = []; // [{ source, ability, amount }] — feat/racial bonuses, for the "откуда бонус" box
    if (state.edition === "2014" && race) {
      const bonusMap = getRaceBonuses();
      const raceLabel = race.name + (subrace ? ` (${subrace.name})` : "");
      Object.entries(bonusMap).forEach(([k, v]) => {
        if (abilities[k] !== undefined) {
          abilities[k] += v;
          data.abilityBonuses.push({ source: `Раса (${raceLabel})`, ability: k, amount: v });
        }
      });
    }
    data.abilities = abilities;
    data.abilityMethod = state.abilityMethod;

    // A level-1 subclass's own skill-choice grant (e.g. Cleric Knowledge
    // Domain's "Благословение знаний") adds its picks on top of the
    // class/background skills, and -- when that same feature doubles
    // proficiency bonus for them -- folds those same skills into expertise
    // too, same as Rogue's Компетентность below.
    const subclassSkillGrant = chosenLevel1SubclassSkillGrant();
    const subclassSkillIds = subclassSkillGrant ? state.chosenSubclassSkills.filter((id) => subclassSkillGrant.optionIds.includes(id)) : [];
    // A race/subrace's own free-choice skill grant (Half-Elf's
    // "Универсальность навыков") -- same idea as the subclass grant above,
    // folded straight into proficiencies.skills instead of a feature card
    // (see addFeatureOrFold's isFreeSkillChoiceTrait check below).
    const raceSkillGrant = raceFreeSkillChoiceGrant();
    const raceSkillIds = raceSkillGrant ? state.chosenRaceSkills.slice(0, raceSkillGrant.count) : [];
    const skillSet = new Set([...(bg ? bg.skillProficiencies : []), ...state.chosenSkills, ...subclassSkillIds, ...raceSkillIds]);
    data.proficiencies.skills = [...skillSet];
    // Rogue's Компетентность, picked on the skills step -- only skills the
    // character actually ended up proficient in count (guards against a
    // stale pick if a background/skill choice changed after the fact).
    const expertiseSet = new Set(state.chosenExpertise.filter((id) => skillSet.has(id)));
    if (subclassSkillGrant && subclassSkillGrant.expertise) subclassSkillIds.forEach((id) => expertiseSet.add(id));
    data.proficiencies.expertise = [...expertiseSet];
    data.proficiencies.savingThrows = cls ? cls.savingThrows : [];
    data.proficiencies.armor = cls ? [cls.armorProficiency] : [];
    data.proficiencies.weapons = cls ? [cls.weaponProficiency] : [];
    data.proficiencies.tools = [
      ...(cls && cls.toolProficiency ? [cls.toolProficiency] : []),
      ...(cls && cls.toolChoice ? state.chosenClassTools : []),
      ...resolvedBackgroundTools(bg),
    ];
    // Same subclass feature's "N языков на свой выбор" half, resolved the
    // same way resolvedBackgroundLanguages() resolves a background's -- a
    // slot left unpicked falls back to a placeholder instead of silently
    // dropping the grant.
    const subclassLangGrant = chosenLevel1SubclassLanguageGrant();
    const subclassLanguages = [];
    if (subclassLangGrant) {
      for (let i = 0; i < subclassLangGrant.count; i++) {
        const picked = state.chosenSubclassLanguages[i];
        if (picked === "custom") subclassLanguages.push(state.subclassLanguageCustom[i] || `1 на выбор (${subclassLangGrant.featureName})`);
        else if (picked) subclassLanguages.push(picked);
        else subclassLanguages.push(`1 на выбор (${subclassLangGrant.featureName})`);
      }
    }
    // A subrace's own languages normally add to the race's (same idea as
    // abilityBonuses above) -- but the Tiefling Abyssal UA variant REPLACES
    // the base race's languages entirely (its own "Языки" trait explicitly
    // swaps out Инфернальный for the language of the Abyss), hence the same
    // replacesLanguages opt-in used for ability bonuses.
    const raceLanguages = subrace && subrace.replacesLanguages ? [] : (race ? race.languages : []);
    // The race/subrace's own "N на выбор" placeholder entries (Human's "1 на
    // выбор") get swapped for the actual picks made in raceLanguageChoiceUI()
    // above, same fallback-to-placeholder behaviour as the background/
    // subclass language grants when a slot was left unpicked.
    let raceLanguagePickIndex = 0;
    const resolvedRaceLanguages = [...raceLanguages, ...((subrace && subrace.languages) || [])].flatMap((l) => {
      const m = /^(\d+)\s*на\s+выбор$/i.exec(String(l).trim());
      if (!m) return [l];
      const out = [];
      for (let k = 0; k < Number(m[1]); k++) {
        const idx = raceLanguagePickIndex++;
        const picked = state.chosenRaceLanguages[idx];
        if (picked === "custom") out.push(state.raceLanguageCustom[idx] || "1 на выбор");
        else out.push(picked || "1 на выбор");
      }
      return out;
    });
    data.proficiencies.languages = [
      ...resolvedRaceLanguages,
      ...resolvedBackgroundLanguages(bg),
      ...subclassLanguages,
    ];

    data.hitDice = { die: cls ? cls.hitDie : 8, total: 1, current: 1 };
    const conMod = abilityMod(abilities.con);
    data.hp = { max: (cls ? cls.hitDie : 8) + conMod, current: (cls ? cls.hitDie : 8) + conMod, temp: 0 };

    if (cls && cls.spellcasting) {
      // Every leveled spell chosen here (a known caster's learned spells, or
      // a prepared caster's starting spellbook/list) lands in "known" --
      // the sheet's "Подготовить заклинания" flow is what moves spells into
      // "prepared" day to day, so a freshly created character always starts
      // with nothing yet prepared, even for a prepared caster.
      data.spellcasting = {
        ability: cls.spellcasting.ability,
        classFilter: cls.id,
        cantrips: [...state.chosenCantrips],
        known: [...state.chosenSpells],
        prepared: [],
        slots: { 1: 2 },
      };
    }

    // A race OR subrace can grant a cantrip outright (e.g. a Forest Gnome's
    // "Природная иллюзия" giving малая иллюзия, an Aasimar's "Несущий свет"
    // giving свет), independent of the character's class -- so this works
    // even for a non-spellcasting class, which otherwise gets no
    // data.spellcasting object at all above. grantedCantripsAbility names
    // the trait's own casting ability (falls back to "int", historically
    // the only case here -- Forest Gnome's -- so existing race entries that
    // don't set it explicitly keep working the same way).
    [race, subrace].forEach((source) => {
      if (!source || !source.grantedCantrips || !source.grantedCantrips.length) return;
      // A subrace whose heritage trait replaces the race's own (e.g. a
      // Tiefling variant that grants a different cantrip than the base
      // race's "чудотворство") sets overridesRaceCantrips so the race's
      // grant doesn't also get added alongside its replacement.
      if (source === race && subrace && subrace.overridesRaceCantrips) return;
      if (!data.spellcasting) {
        data.spellcasting = { ability: source.grantedCantripsAbility || "int", classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      }
      source.grantedCantrips.forEach((id) => {
        if (!data.spellcasting.cantrips.includes(id)) data.spellcasting.cantrips.push(id);
      });
    });

    data.features = [];
    // A handful of race/class traits don't need their own "Умения" card:
    // they just grant a language (e.g. a High Elf's free extra language, a
    // Druid's Друидический) or an armor proficiency the class already lists
    // in "Владения и языки". Folding those into the proficiencies lists
    // there, instead of also spawning a near-empty card that just restates
    // "you know a language" / "you're proficient in some armor", keeps
    // "Умения" to traits that actually do something.
    const LANGUAGE_TRAIT_NAMES = new Set(["Дополнительный язык", "Друидический"]);
    const isLanguageTrait = (name) => LANGUAGE_TRAIT_NAMES.has(name) || /язык/i.test(name || "");
    const isArmorProficiencyTrait = (name) => /^Владение .*доспех/i.test(name || "");
    // A race/subrace trait resolved by raceFreeSkillChoiceGrant() (Half-Elf's
    // "Универсальность навыков") is now an actual choice made on the
    // "Навыки" step (see raceSkillChoiceUI()/raceSkillIds above) rather than
    // inert flavor text -- so, like the language/armor traits above, it no
    // longer needs its own near-empty feature card once the picks it
    // describes are already reflected in "Владения и языки".
    const isFreeSkillChoiceTrait = (desc) => !!parseFreeSkillChoiceGrant(desc);
    // Same idea, for a race/subrace's feat-choice grant (raceFeatChoiceGrant()
    // above) -- resolved into a real data.feats entry below instead of this
    // trait's own near-empty "add it yourself later" card.
    const isFeatChoiceTraitName = (name) => {
      const grant = raceFeatChoiceGrant();
      return !!(grant && grant.featureName === name);
    };
    // The class-features list also has a "Заклинания <класс>" entry per
    // spellcasting class, announcing that it casts spells -- redundant with
    // the dedicated "Заклинания" tab, so it's dropped rather than folded
    // anywhere.
    const isSpellcastingAnnouncement = (name) => /^Заклинания /i.test(name || "");
    // Folds any armor/weapon proficiency granted by a feature's text straight
    // into "Владения и языки", so a trait like the Dwarf's "Дварфская боевая
    // тренировка" or a subclass's "Бонусное владение" doesn't just sit inert
    // inside its own flavor-text feature card. Named-weapon grants that
    // free-text parsing can't reliably reconstruct (Russian declension) use
    // an explicit lookup by feature name; everything else is parsed from the
    // description text itself.
    function applyProficiencyGrants(name, desc) {
      const namedWeapons = TRAIT_NAMED_WEAPON_GRANTS[name];
      if (namedWeapons) {
        namedWeapons.forEach((w) => {
          if (!data.proficiencies.weapons.includes(w)) data.proficiencies.weapons.push(w);
        });
        return;
      }
      const grants = parseProficiencyGrantsFromText(desc);
      grants.weapons.forEach((w) => {
        if (!data.proficiencies.weapons.includes(w)) data.proficiencies.weapons.push(w);
      });
      grants.armor.forEach((a) => {
        if (!data.proficiencies.armor.includes(a)) data.proficiencies.armor.push(a);
      });
    }
    function addFeatureOrFold(name, desc, source) {
      if (isSpellcastingAnnouncement(name)) return;
      if (isLanguageTrait(name)) {
        data.proficiencies.languages.push(name === "Дополнительный язык" ? `+1 на выбор (${source})` : name);
        return;
      }
      if (isArmorProficiencyTrait(name)) {
        if (!data.proficiencies.armor.includes(desc || name)) data.proficiencies.armor.push(desc || name);
        return;
      }
      if (isFreeSkillChoiceTrait(desc)) return;
      if (isFeatChoiceTraitName(name)) return;
      extractSkillProficiencyIds(desc).forEach((id) => {
        if (!data.proficiencies.skills.includes(id)) data.proficiencies.skills.push(id);
      });
      // Traits that grant armor or weapon proficiency (e.g. Dwarf's
      // "Дварфская боевая тренировка", Mountain Dwarf's "Дварфская броня")
      // still get their own feature card below for the flavor text, but the
      // actual proficiency also gets folded into "Владения и языки"
      // automatically instead of sitting inert in that card.
      applyProficiencyGrants(name, desc);
      data.features.push({ name, source, desc });
    }

    // A subrace can wholesale replace one of the race's own traits instead of
    // just adding to them (e.g. a Tiefling MTF/SCAG variant's own heritage
    // trait replaces the base "Дьявольское наследие" card rather than
    // sitting alongside it) -- subrace.overrideTraitNames lists the race
    // trait names it takes the place of, by name, so those don't also get
    // their own (now-superseded) card.
    const overriddenTraitNames = new Set((subrace && subrace.overrideTraitNames) || []);
    if (race) race.traits.filter((t) => !overriddenTraitNames.has(t.name)).forEach((t) => addFeatureOrFold(t.name, t.desc, race.name));
    if (subrace) (subrace.traits || []).forEach((t) => addFeatureOrFold(t.name, t.desc, subrace.name));
    if (bg && bg.feature) addFeatureOrFold(bg.feature.name, bg.feature.desc, bg.name);
    // Alternate Human's "Черта" grant (or any future race/subrace with the
    // same wording) -- the actual feat picked in raceFeatChoiceUI() above,
    // applied the same way sheet.js's own "Черты" tab add-feat handler
    // applies one, so a feat taken here looks identical to one added later.
    const raceFeatGrant = raceFeatChoiceGrant();
    if (raceFeatGrant && state.chosenRaceFeatId) {
      const feat = FEATS.find((f) => f.id === state.chosenRaceFeatId);
      if (feat && !data.feats.some((ft) => ft.id === feat.id)) {
        const entry = { id: feat.id, name: feat.name, desc: feat.desc, prereq: feat.prereq || "" };
        if (feat.abilityIncrease) {
          const ability = feat.abilityIncrease.choices.length > 1 ? state.raceFeatAbility : feat.abilityIncrease.choices[0];
          const amount = feat.abilityIncrease.amount;
          if (ability) {
            data.abilities[ability] = Math.min(20, (Number(data.abilities[ability]) || 10) + amount);
            data.abilityBonuses.push({ source: `Черта (${feat.name})`, ability, amount });
            entry.grantedAbility = ability;
            entry.grantedAmount = amount;
          }
          if (feat.grantsSaveProficiency && ability && !data.proficiencies.savingThrows.includes(ability)) {
            data.proficiencies.savingThrows.push(ability);
          }
        }
        if (feat.skillChoice) {
          const skills = state.raceFeatSkills.slice(0, feat.skillChoice.count);
          skills.forEach((s) => { if (!data.proficiencies.skills.includes(s)) data.proficiencies.skills.push(s); });
          entry.grantedSkills = skills;
        }
        applyFeatExtras(data, feat, entry, state.raceFeatSel);
        data.feats.push(entry);
      }
    }
    // The raw class-features list has a generic placeholder entry for
    // whichever feature is actually a level-1 choice (e.g. plain "Боевой
    // стиль", with no specifics) -- when the player picked an option for it
    // in stepClass(), that placeholder is swapped for the real pick
    // ("Боевой стиль: Дуэлянт" + its actual description) instead of both
    // showing up side by side.
    const LEVEL1_CHOICE_PLACEHOLDER = { fighter: "Боевой стиль", cleric: "Божественный домен", sorcerer: "Истоки чародейства", warlock: "Потусторонний покровитель" };
    // The level1Choice option itself only carries a short one-line blurb (for
    // the picker UI) -- the full un-abbreviated text lives in cls.subclasses
    // (imported from dnd.su), keyed by name. When the chosen option matches a
    // real subclass there, each of its actual level-1 features becomes its
    // own feature card (rather than one card with everything mashed
    // together), plus one intro card naming the domain/origin/patron itself.
    function subclassMatch(pickName) {
      return (cls.subclasses || []).find((s) => s.name.toLowerCase() === pickName.toLowerCase()) || null;
    }
    if (cls && cls.features && cls.features[1]) {
      cls.features[1].forEach((f) => {
        const split = splitFeatureText(f);
        if (level1Choice && split.name === LEVEL1_CHOICE_PLACEHOLDER[cls.id]) {
          const sub = subclassMatch(level1Choice.name);
          if (sub) {
            data.features.push({ name: `${cls.level1Choice.label}: ${sub.name}`, source: cls.name, desc: sub.intro || level1Choice.desc });
            (sub.features || []).forEach((sf) => {
              if (sf.level === 1 && sf.name) {
                const sfDesc = (sf.desc || []).join("\n\n");
                data.features.push({ name: sf.name, source: `${cls.name} — ${sub.name}`, desc: sfDesc });
                applyProficiencyGrants(sf.name, sfDesc);
              }
            });
          } else {
            data.features.push({ name: `${cls.level1Choice.label}: ${level1Choice.name}`, source: cls.name, desc: level1Choice.desc });
          }
        } else if (cls.id === "ranger" && split.name === "Избранный враг" && state.favoredEnemy) {
          // Personalizes the generic "выберите тип избранного врага" card
          // with the actual pick made in stepRangerFavored(), instead of
          // leaving the raw un-filled-in class text on the sheet.
          const enemyLabel =
            state.favoredEnemy === "Гуманоиды"
              ? `Гуманоиды (${state.favoredEnemyHumanoid1.trim()}, ${state.favoredEnemyHumanoid2.trim()})`
              : state.favoredEnemy;
          const lang =
            state.favoredEnemyLanguage === "custom" ? state.favoredEnemyLanguageCustom.trim() : state.favoredEnemyLanguage;
          const fullText = cls.classFeatureText && cls.classFeatureText[split.name];
          data.features.push({
            name: `Избранный враг: ${enemyLabel}`,
            source: cls.name,
            desc: (fullText || split.desc) + (lang ? `\n\nЯзык избранного врага: ${lang}.` : ""),
          });
          if (lang && !data.proficiencies.languages.includes(lang)) data.proficiencies.languages.push(lang);
        } else if (cls.id === "ranger" && split.name === "Природный следопыт" && state.favoredTerrain) {
          const fullText = cls.classFeatureText && cls.classFeatureText[split.name];
          data.features.push({
            name: `Природный следопыт: ${state.favoredTerrain}`,
            source: cls.name,
            desc: fullText || split.desc,
          });
        } else {
          const fullText = cls.classFeatureText && cls.classFeatureText[split.name];
          addFeatureOrFold(split.name, fullText || split.desc, cls.name);
        }
      });
    }

    const equipLines = [];
    // The coin amount in bg.equipment ("...кошель с 15 зм") already goes into
    // data.money below via extractStartingGold(); stripped here so it isn't
    // shown twice (once as gold, once as leftover text in "прочее снаряжение").
    if (bg) equipLines.push(`Снаряжение предыстории: ${expandPackContents(stripStartingGoldMention(bg.equipment))}`);
    // classEquipText stays raw (used below for armor/weapon auto-detection);
    // the version stored on the sheet gets pack names expanded to their full
    // contents, so "набор исследователя подземелий" shows what's actually in it.
    const classEquipText = cls && !state.classEquipmentDeclined ? resolvedClassEquipment() : "";
    if (cls) {
      if (state.classEquipmentDeclined) equipLines.push(`Снаряжение класса: не взято (получено ${state.classGoldRoll} зм вместо него)`);
      else equipLines.push(`Начальное снаряжение класса: ${expandPackContents(classEquipText)}`);
    }
    data.equipmentText = equipLines.join("\n");

    // Auto-equip armor/shield detected in the chosen starting equipment so
    // AC is computed immediately, without the player having to redo it.
    const armorId = detectArmorIdFromText(classEquipText) || detectArmorIdFromText(bg ? bg.equipment : "");
    data.armorId = armorId;
    data.armorEquipped = !!armorId;
    data.shieldEquipped = textMentionsShield(classEquipText);

    // Weapons named in the chosen class starting-equipment go straight into
    // the structured weapon list (Оружие), not just the free-text summary.
    data.weapons = detectWeaponsInText(classEquipText).map((w) => ({
      name: w.name, damage: w.damage, type: w.type, properties: w.properties, special: "", equipped: true,
      rangeType: weaponRangeType(w),
    }));

    // ...and straight into Атаки too, with the same auto-assigned hand as the
    // "→ Атаки" button on the sheet: two-handed -> both, otherwise right,
    // then left, then "removed" when both hands are already full.
    data.attacks = [];
    const usedHands = [];
    data.weapons.forEach((w) => {
      const pr = String(w.properties || "").toLowerCase();
      let hand;
      if (/двуручное/.test(pr)) hand = "both";
      else if (/универсальное/.test(pr)) hand = "right";
      else hand = !usedHands.includes("right") && !usedHands.includes("both") ? "right" : !usedHands.includes("left") && !usedHands.includes("both") ? "left" : "removed";
      if (hand !== "removed") usedHands.push(hand);
      data.attacks.push({ name: w.name, bonus: "", damage: `${w.damage || ""}${w.type ? " " + w.type : ""}`.trim(), special: "", useSpecial: false, rangeType: w.rangeType || "", hand });
    });

    // Starting ammo counts mentioned in the chosen equipment ("колчан из 20
    // стрел", "20 болтов"…) pre-fill the ammo tracker instead of starting at 0.
    data.ammo = { arrows: 0, bolts: 0, javelins: 0, darts: 0, ...detectAmmoInText(classEquipText) };

    // Starting money: background's coin pouch, plus any gold taken instead
    // of the class equipment package.
    const bgGold = extractStartingGold(bg ? bg.equipment : "");
    data.money = {
      pp: bgGold.pp,
      gp: bgGold.gp + (state.classEquipmentDeclined ? state.classGoldRoll : 0),
      sp: bgGold.sp,
      cp: bgGold.cp,
    };

    try {
      const res = await api.createCharacter({ name: data.name, edition: state.edition, data });
      navigate(`#/characters/${res.character.id}`);
    } catch (err) {
      alert(err.message);
    }
  }

  wire();
  render();
}
