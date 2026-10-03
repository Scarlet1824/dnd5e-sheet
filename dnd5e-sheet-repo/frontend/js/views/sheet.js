import { mount, on, $, $all, freshApp, escapeHtml, debounce, openModal, closeModal, wireHoverCardPortal } from "../dom.js";
import { api, getUser, clearSession } from "../api.js";
import { navigate } from "../router.js";
import { OPTIONAL_FEATURE_SOURCE, CLASS_GENITIVE, optionalFeaturesForLevelUp, optionalReplaces, additionalSpellIds, ADDITIONAL_SPELLS_NAME } from "../data/optionalFeatures.js";
import { ABILITIES, SKILLS, CLASSES, RACES, BACKGROUNDS, SPELLS, FEATS, MANEUVERS, WEAPONS, ARMORS, GEAR, HEALING_POTIONS, ALIGNMENTS, CONDITIONS, EXHAUSTION_LEVELS, getClass, proficiencyBonusForLevel, splitFeatureText, EQUIPMENT_PACK_DESCRIPTIONS, parseProficiencyGrantsFromText, TRAIT_NAMED_WEAPON_GRANTS, weaponRangeType, WEAPON_RANGE_TYPE_LABELS, TOOL_GROUPS, GAMING_SETS, LANGUAGE_GROUPS, parseSkillChoiceGrant, parseFreeSkillChoiceGrant, parseLanguageChoiceGrant, WILD_MAGIC_SURGE_TABLE , METAMAGIC_OPTIONS, ELDRITCH_INVOCATIONS, SPIRIT_TALES_TABLE, ELEMENTAL_DISCIPLINES, SUBCLASS_BONUS_CANTRIPS, DRUID_LAND_TERRAINS, DRAGON_ANCESTRIES, DIVINE_AFFINITIES, LUNAR_PHASES } from "../data/dnd5e-data.js";
import {
  totalLevel, proficiencyBonus, getAbilityScore, getAbilityMod, abilityCheckBonus,
  isProficientSkill, isExpertSkill, skillBonus, isProficientSave, saveBonus,
  passivePerception, passiveInvestigation, passiveInsight, armorClass, initiativeBonus, spellSaveDC, spellAttackBonus,
  speedBonusSources, totalSpeed, manualOverride, armorClassAuto, initiativeBonusAuto, totalSpeedAuto, exhaustionLevel, effectiveMaxHp, speedBeforeExhaustion, initiativeAdvantageSource,
} from "../character.js";
import { openD20RollModal, showRollResult, d20VectorSvg } from "../diceModal.js";
import { rollExpr, rollDice, rollD20, formatModifier, getRollLog, clearRollLog, setRollLogCharacter, pushRollLog } from "../dice.js";
import { spellCardHtml, spellHoverNameHtml } from "../spellCard.js";
import { featAlreadyTaken, FEAT_TAKEN_MESSAGE, proficiencyCovered, dedupeProficiencyCategories, newFeatSel, featExtrasHtml, featExtrasIncomplete, wireFeatExtras, applyFeatExtras, featSelectOptionsHtml, featInfoHtml, featPicksHtml, featPicksIncomplete, wireFeatPicks, applyFeatPicks, revertFeatExtras, featHasNew } from "../featChoices.js";

// showRollResult() (diceModal.js) fires this on `document` after every roll
// anywhere in the app, so the inline roll-log on the sheet's main tab can
// refresh itself without a full page re-render. Tracked at module scope (not
// #app, which freshApp() resets) so re-visiting a sheet swaps the listener
// instead of stacking a new one on top of the old.
let rollLogRefreshHandler = null;

// Russian plural forms for "кость хитов" (1 кость, 2-4 кости, 5+/11-14 костей).
function pluralizeBones(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "кость";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "кости";
  return "костей";
}

// Russian plural forms for "кубик" (1 кубик, 2-4 кубика, 5+/11-14 кубиков).
function pluralizeDice(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "кубик";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "кубика";
  return "кубиков";
}

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

// Adds a value to a free-text proficiency list (armor/weapons/tools/
// languages -- the four fields backed by the comma-separated textareas on
// the Черты/Умения tab, see traitsTab()'s listField()) the same way every
// automatic grant already does (skip if already present), but first drops
// any lone placeholder entry a player typed by hand into an empty field
// ("нет"/"—"/"-"/"нету"/"отсутствует") -- otherwise a later real grant just
// sat next to that placeholder instead of replacing it.
const PROFICIENCY_PLACEHOLDER_RE = /^(нет|нету|отсутствует|—|-|—)$/i;
function addProficiencyValue(list, value) {
  if (!Array.isArray(list) || !value) return;
  for (let i = list.length - 1; i >= 0; i--) {
    if (PROFICIENCY_PLACEHOLDER_RE.test((list[i] || "").trim())) list.splice(i, 1);
  }
  if (!proficiencyCovered(list, value)) list.push(value);
}

// Clamps a numeric field's raw <input> string to an integer in [min, max],
// falling back to `fallback` for anything blank/non-numeric -- shared by
// every number input that got fixed for allowing negative/unbounded values
// (ability scores, HP, AC-related fields) so they all round the same way.
function clampInt(raw, min, max, fallback) {
  const n = raw === "" || raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function renderSheet(id) {
  const user = getUser();
  // Scopes the roll log (dice.js) to this character -- every roll made
  // while this sheet is open gets filed under its own log instead of one
  // shared across every character sheet in the browser.
  setRollLogCharacter(id);
  // See dom.js freshApp(): drops listeners left over from viewing another
  // (or the same) character earlier, so the ones wired below don't stack.
  freshApp();
  mount(`<div class="panel"><p class="muted">Загрузка персонажа…</p></div>`);

  let character;
  try {
    const res = await api.getCharacter(id);
    character = res.character;
  } catch (err) {
    mount(`<div class="panel"><p class="error-text">${escapeHtml(err.message)}</p><a href="#/characters">← К списку</a></div>`);
    return;
  }

  const data = character.data;
  let activeTab = "main"; // main | attacks | spells | forms | inventory | feats | traits | personality | pets
  let dicePool = []; // [{sides, count}] -- dice queued in the "Кубики" panel, rolled together and cleared on "Бросить"
  let featPreviewId = ""; // currently-highlighted feat in the picker, for description preview before adding
  let featChosenAbility = ""; // ability chosen for a multi-choice abilityIncrease feat, before "Добавить"
  let featChosenSkills = []; // skills chosen for a skillChoice feat (Одарённый), before "Добавить"
  let featChosenManeuvers = []; // maneuvers chosen for «Воинский адепт», before "Добавить"
  let featChosenWeapons = []; // weapons chosen for «Мастер оружия», before "Добавить"
  let featChosenLanguages = []; // languages chosen for «Языковед», before "Добавить"
  let featChosenElement = "fire"; // damage type chosen for «Стихийный адепт», before "Добавить"
  // Both «Посвящённый в магию» and «Меткие заклинания» let the player pick a
  // class (limiting which spell list the rest of the choice comes from) and
  // one or two cantrips from it; Посвящённый в магию also adds one 1st-level
  // spell. Shared state since a character only ever has one of these
  // pending at once (the feat picker only shows one feat's own choice UI at
  // a time already).
  const FEAT_SPELL_CLASS_OPTIONS = [
    { id: "bard", label: "Бард" }, { id: "cleric", label: "Жрец" }, { id: "druid", label: "Друид" },
    { id: "sorcerer", label: "Чародей" }, { id: "warlock", label: "Колдун" }, { id: "wizard", label: "Волшебник" },
  ];
  let featChosenSpellClass = "wizard";
  let featChosenCantrips = [];
  let featChosenSpell = "";
  let featNewSel = newFeatSel(); // выборы черт из data-управляемой системы (featChoices.js: picks/grant/cards)
  const ELEMENTAL_ADEPT_DAMAGE_TYPES = [
    { id: "acid", label: "Кислота" },
    { id: "cold", label: "Холод" },
    { id: "fire", label: "Огонь" },
    { id: "lightning", label: "Электричество" },
    { id: "thunder", label: "Звук" },
  ];
  let spellSearch = ""; // free-text filter in the spells tab's "add spell" browser
  let spellLevelFilter = "all"; // "all" | "0" | "1" in the spells tab's "add spell" browser
  let extraBrowseOpen = false; // spells tab: "any class, over the limit" browse panel
  let extraSpellSearch = "";
  let extraSpellLevel = "all";
  let extraSpellClass = "all";
  let spellBrowseOpen = false; // spells tab: whether the "+ Добавить заклинание" browse panel is open
  let spellPrepMode = false; // spells tab: whether the full prepare-spells picker (all available spells, not just today's prepared ones) is open
  let restState = { tab: "short", message: "", diceCount: 0, pendingDice: 0 }; // rest modal: active tab ("short"|"long") + a transient status line shown after resting
  let restModalEl = null; // the rest modal's root element, once opened -- used to refresh its content in place without closing it
  // "Облики" tab: beast stat blocks (data/beasts.js, loaded on first open).
  let beastsData = null;
  let beastsLoading = false;
  let formBrowseOpen = false;
  let formSearch = "";
  let formCrFilter = "all";
  let formMoveFilter = "all";
  let formOnlyAllowed = false;
  let formShown = 30;
  let exhaustionMenuOpen = false; // header: Истощение level dropdown open?
  // Money calculator (inventory tab): which coin is selected, the typed
  // amount, whether the "exchange into which coin?" picker is showing, and
  // the last result/error line. Ephemeral UI state, not saved on the character.
  let coinCalc = { coin: "gp", amount: "", exchangeOpen: false, msg: "", err: false };
  let abilityBonusesOpen = false; // main tab: whether the "Откуда бонусы к характеристикам" log is expanded
  // Header's Раса/Предыстория fields: once RACES/BACKGROUNDS ship a matching
  // name, most characters just pick one from a dropdown -- but freeform text
  // (a homebrew race, a personal variant) still needs to work, so a "Своё"
  // option reveals a plain text input instead. These track "explicitly
  // switched to custom via the dropdown" so an empty custom field doesn't
  // immediately snap back to the dropdown on the next render; a character
  // whose saved name already doesn't match any known entry starts in custom
  // mode automatically (see raceIsCustom/backgroundIsCustom below).
  let raceCustomOpen = false;
  let backgroundCustomOpen = false;
  let rollLogPanelOpen = false; // main tab: whether the bottom-right "Журнал бросков" list is expanded (the log itself keeps logging either way)

  const saveIndicator = () => $("[data-save-indicator]");
  const doSave = debounce(async () => {
    const el = saveIndicator();
    if (el) { el.textContent = "Сохранение…"; el.className = "save-indicator saving"; }
    try {
      await api.updateCharacter(id, { name: data.name, edition: data.edition, data });
      const el2 = saveIndicator();
      if (el2) { el2.textContent = "Сохранено ✓"; el2.className = "save-indicator saved"; }
    } catch (err) {
      const el2 = saveIndicator();
      if (el2) { el2.textContent = "Ошибка сохранения"; el2.className = "save-indicator error"; }
    }
  }, 700);

  // One-time migration for characters created before class features were
  // split into name+description: back then a class feature like "Второе
  // дыхание (1к10 + уровень хитов, ...)" was saved with its whole
  // parenthetical jammed into the name and an empty desc, so the card
  // showed a long title and no description. Split those the same way new
  // characters are seeded, and save once if anything changed.
  (function migrateFeatureText() {
    let changed = false;
    (data.features || []).forEach((f) => {
      if (!f.desc && /\)\s*$/.test(f.name || "")) {
        const split = splitFeatureText(f.name);
        if (split.desc) {
          f.name = split.name;
          f.desc = split.desc;
          changed = true;
        }
      }
    });
    if (changed) doSave();
  })();

  // One-time migration for Forest Gnome characters created before the
  // racial "малая иллюзия" cantrip and the fuller "Общение с маленькими
  // зверями" trait text existed on file: back-fills the missing cantrip
  // and renames the old short "Разговор с мелкими зверями" card over to
  // the current name+text, the same way a fresh character gets it now.
  (function migrateGnomeTraits() {
    let changed = false;
    const gnome = RACES.find((r) => r.id === "gnome");
    const forestGnome = gnome && (gnome.subraces || []).find((s) => s.id === "forest-gnome");
    if (forestGnome && (data.raceName || "").includes(forestGnome.name)) {
      const oldTrait = (data.features || []).find((f) => f.name === "Разговор с мелкими зверями");
      const newTrait = (forestGnome.traits || []).find((t) => t.name === "Общение с маленькими зверями");
      if (oldTrait && newTrait) {
        oldTrait.name = newTrait.name;
        oldTrait.desc = newTrait.desc;
        changed = true;
      }
      if (forestGnome.grantedCantrips && forestGnome.grantedCantrips.length) {
        if (!data.spellcasting) data.spellcasting = { ability: "int", classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
        if (!data.spellcasting.cantrips) data.spellcasting.cantrips = [];
        forestGnome.grantedCantrips.forEach((cid) => {
          if (!data.spellcasting.cantrips.includes(cid)) {
            data.spellcasting.cantrips.push(cid);
            changed = true;
          }
        });
      }
    }
    if (changed) doSave();
  })();

  // Generic backfill for any race/subrace with `grantedCantrips` (Forest
  // Gnome's малая иллюзия above, Aasimar's свет, ...) on a character
  // created before that race entry had the field, or before the cantrip
  // existed on file at all. Matches by name against data.raceName, so it
  // works whether the race has subraces or not -- entirely additive, never
  // touches an existing pick.
  (function migrateRaceGrantedCantrips() {
    let changed = false;
    const raceName = data.raceName || "";
    if (!raceName) return;
    RACES.forEach((race) => {
      [race, ...(race.subraces || [])].forEach((source) => {
        if (!source.grantedCantrips || !source.grantedCantrips.length) return;
        if (!raceName.includes(source.name)) return;
        if (!data.spellcasting) data.spellcasting = { ability: source.grantedCantripsAbility || "int", classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
        if (!data.spellcasting.cantrips) data.spellcasting.cantrips = [];
        source.grantedCantrips.forEach((cid) => {
          if (!data.spellcasting.cantrips.includes(cid)) {
            data.spellcasting.cantrips.push(cid);
            changed = true;
          }
        });
      });
    });
    if (changed) doSave();
  })();

  // "Небесное сопротивление" is also a level-10 Sorcerer (Divine
  // Soul/Aberrant Mind-adjacent) subclass feature with an entirely
  // different effect (temp HP, not damage resistance) -- so this is scoped
  // to Aasimar characters specifically rather than matched by name alone,
  // and skips anything that already looks like that other feature's text.
  (function migrateAasimarCelestialResistanceText() {
    if (!/Аасимар/i.test(data.raceName || "")) return;
    const correct = "У вас есть сопротивление урону излучением и некротической энергией.";
    let changed = false;
    (data.features || []).forEach((f) => {
      if (f.name === "Небесное сопротивление" && f.desc !== correct && !/временные хиты/i.test(f.desc || "")) {
        f.desc = correct;
        changed = true;
      }
    });
    if (changed) doSave();
  })();

  // One-time migration for characters whose race/subrace grants a skill
  // proficiency through trait text (e.g. Half-Orc "Угрожающий вид": "Владение
  // навыком Запугивание.") -- wizard.js now applies that automatically at
  // creation, but an existing character's card was only ever text, so its
  // skill's proficiency dot was never actually turned on.
  (function migrateTraitSkillProficiencies() {
    let changed = false;
    data.proficiencies = data.proficiencies || {};
    if (!Array.isArray(data.proficiencies.skills)) data.proficiencies.skills = [];
    (data.features || []).forEach((f) => {
      const m = /Владение\s+навык(?:ом|ами)\s+([^.]+)\.?/i.exec(f.desc || "");
      if (!m) return;
      m[1]
        .split(/,| и /i)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((nm) => {
          const skill = SKILLS.find((s) => s.label.toLowerCase() === nm.toLowerCase());
          if (skill && !data.proficiencies.skills.includes(skill.id)) {
            data.proficiencies.skills.push(skill.id);
            changed = true;
          }
        });
    });
    if (changed) doSave();
  })();

  // One-time migration for characters whose race/class feature grants armor
  // or weapon proficiency through its text (e.g. Dwarf's "Дварфская боевая
  // тренировка": "Вы владеете боевым топором, ручным топором, лёгким и
  // боевым молотом.") -- wizard.js now folds that into "Владения и языки"
  // automatically at creation, but an existing character's card was only
  // ever flavor text, so the actual proficiency was never added to the list.
  (function migrateTraitWeaponArmorProficiencies() {
    let changed = false;
    data.proficiencies = data.proficiencies || {};
    if (!Array.isArray(data.proficiencies.armor)) data.proficiencies.armor = [];
    if (!Array.isArray(data.proficiencies.weapons)) data.proficiencies.weapons = [];
    (data.features || []).forEach((f) => {
      const namedWeapons = TRAIT_NAMED_WEAPON_GRANTS[f.name];
      if (namedWeapons) {
        namedWeapons.forEach((w) => {
          if (!proficiencyCovered(data.proficiencies.weapons, w)) changed = true;
          addProficiencyValue(data.proficiencies.weapons, w);
        });
        return;
      }
      const grants = parseProficiencyGrantsFromText(f.desc);
      grants.weapons.forEach((w) => {
        if (!proficiencyCovered(data.proficiencies.weapons, w)) changed = true;
        addProficiencyValue(data.proficiencies.weapons, w);
      });
      grants.armor.forEach((a) => {
        if (!proficiencyCovered(data.proficiencies.armor, a)) changed = true;
        addProficiencyValue(data.proficiencies.armor, a);
      });
    });
    // уже добавленные дубли («Лёгкая броня» рядом с «Лёгкая, средняя броня, щиты»)
    if (dedupeProficiencyCategories(data.proficiencies.armor)) changed = true;
    if (dedupeProficiencyCategories(data.proficiencies.weapons)) changed = true;
    if (changed) doSave();
  })();

  // Пси-воин: у уже созданных персонажей «Псионическая сила» разбивается на отдельные карточки способностей.
  (function migratePsiWarriorPowers() {
    const fighter = CLASSES.find((c) => c.id === "fighter");
    const sub = fighter && (fighter.subclasses || []).find((x) => x.slug === "psi-warrior");
    if (!sub) return;
    const source = `${fighter.name} — ${sub.name}`;
    const idx = (data.features || []).findIndex((f) => f.name === "Псионическая сила" && /Пси-воин/i.test(f.source || "") && /Защитное поле\./.test(f.desc || ""));
    if (idx < 0) return;
    const sf = (sub.features || []).find((x) => x.name === "Псионическая сила");
    const split = sf && splitPsionicPowerCards(sf.desc || []);
    if (!split) return;
    data.features[idx].desc = split.intro;
    const at = idx + 1;
    split.powers.forEach((pw, k) => {
      if (!data.features.some((f) => f.name === pw.name && f.source === data.features[idx].source)) data.features.splice(at + k, 0, { name: pw.name, source: data.features[idx].source, desc: pw.desc });
    });
    doSave();
  })();

  // Жрец: «Направление божества» везде называется «Божественный канал» (названия и тексты карточек).
  (function migrateChannelDivinityName() {
    let changed = false;
    (data.features || []).forEach((f) => {
      if (/Направление божества/.test(f.name || "")) { f.name = f.name.replace(/Направление божества/g, "Божественный канал"); changed = true; }
      if (/Направление божества/.test(f.desc || "")) { f.desc = f.desc.replace(/Направление божества/g, "Божественный канал"); changed = true; }
    });
    if (changed) doSave();
  })();

  // One-time migration for simple feature-name renames (data corrections,
  // not text rewrites) -- e.g. the Noble background's feature was renamed
  // from "Привилегированность" to "Благородный". Old-name -> new-name.
  const RENAMED_FEATURE_NAMES = {
    "Привилегированность": "Благородный",
  };
  (function migrateRenamedFeatureNames() {
    let changed = false;
    (data.features || []).forEach((f) => {
      const renamed = RENAMED_FEATURE_NAMES[f.name];
      if (renamed) {
        f.name = renamed;
        changed = true;
      }
    });
    if (changed) doSave();
  })();

  // One-time migration for a handful of feature texts that were shortened
  // or slightly wrong in the data file and have since been corrected --
  // refreshes an existing character's card ONLY if its saved text still
  // matches the exact old (stale) wording, so a player's own edits to that
  // card are never overwritten. Mapped by exact OLD TEXT (not just feature
  // name) -- several unrelated races/traits happen to share the name
  // "Наследие фей" with genuinely different official wording each (PHB Elf
  // vs. Half-Elf vs. the MPMM-revised Goblin), so a name-only lookup would
  // risk overwriting one race's correct text with another's.
  const STALE_FEATURE_TEXT_FIXES = {
    "Перебрасывает результат 1 на атаках, проверках и спасбросках.":
      "Когда вы совершаете бросок к20 и выпадает 1, вы можете перебросить кубик и должны использовать новый результат.",
    "Преимущество на спасброски против испуга.":
      "Вы получаете преимущество на спасброски против испуга.",
    "Может проходить через клетки более крупных существ.":
      "Вы можете передвигаться через пространство любого существа, чей размер больше вашего.",
    "Сопротивление урону огнём.":
      "Вы обладаете сопротивлением урону огнём.",
    "Знает заговор Чудотворство; с 3 ур. — Адское возмездие, с 5 ур. — Тьма (1/день).":
      "Вы знаете заговор Чудотворство. По достижении 3 уровня вы можете сотворить заклинание Адское возмездие как заклинание 2 уровня один раз с помощью этой черты, восстанавливая возможность делать это после окончания продолжительного отдыха. По достижении 5 уровня вы можете также сотворить заклинание Тьма один раз с помощью этой черты, восстанавливая возможность делать это после окончания продолжительного отдыха. Харизма является вашей базовой характеристикой заклинаний для этих заклинаний.",
    "Преимущество на спасброски против очарования; нельзя усыпить магией.":
      "Вы обладаете преимуществом на спасброски против того, чтобы быть очарованным, и на вас не действует магический сон.",
    "Преимущество на спасброски против магического усыпления и очарования.":
      "Вы обладаете преимуществом на спасброски против того, чтобы быть очарованным, и на вас не действует магический сон.",
    "Преимущество на спасброски против состояния очарован.":
      "Вы обладаете преимуществом на спасброски, совершаемые, чтобы избежать состояния очарования или закончить его действие.",
    "к8, бонусное действие":
      "Вы можете воодушевлять других посредством вдохновляющих слов или музыки. Чтобы сделать это, вы используете бонусное действие в свой ход, чтобы выбрать одно существо, помимо себя, в пределах 60 футов от себя, которое может вас слышать. Это существо получает от вас кость бардовского вдохновения, к6.\n\nОдин раз в течение следующих 10 минут существо может бросить эту кость и прибавить результат к одной проверке характеристики, броску атаки или спасброску, который оно совершает. Существо может подождать с броском кости до после броска к20, но должно решить использовать кость бардовского вдохновения до того, как Мастер объявит, успешен бросок или нет. Как только кость бардовского вдохновения брошена, она теряется. Существо может иметь только одну кость бардовского вдохновения за раз.\n\nВы можете использовать эту способность количество раз, равное модификатору Харизмы (минимум раз в день). Вы восстанавливаете все потраченные использования после продолжительного отдыха.\n\nВаша кость бардовского вдохновения меняется, когда вы достигаете определённых уровней в этом классе: к8 на 5 уровне и к10 на 10 уровне.",
  };
  (function migrateStaleFeatureText() {
    let changed = false;
    (data.features || []).forEach((f) => {
      const fixed = STALE_FEATURE_TEXT_FIXES[f.desc];
      if (fixed) {
        f.desc = fixed;
        changed = true;
      }
    });
    if (changed) doSave();
  })();

  // «Скрыться на виду» was stored with its whole description in the NAME
  // (nested parentheses broke the name/description split) -- fix old cards.
  (function fixLongRangerNames() {
    let changed = false;
    (data.features || []).forEach((f) => {
      if (/^Скрыться на виду\s*\(/.test(f.name || "")) {
        const full = (f.name.match(/\((.*)\)\s*$/) || [])[1] || "";
        const known = findKnownFeatureText("Скрыться на виду", f.source);
        f.name = "Скрыться на виду";
        f.desc = known || full;
        changed = true;
      }
    });
    if (changed) doSave();
  })();

  // Ranger's level-1 features ("Избранный враг"/"Исследователь природы") used to
  // have no description at all (the raw features[1] entry had no parenthetical
  // to split text out of) -- fills in the now-added classFeatureText, but only
  // when the card is still blank, never overwriting anything a player wrote.
  // Раунд 62: заговоры, которые подкласс выдаёт автоматически (Школа Иллюзии — малая иллюзия,
  // Круг спор — леденящее прикосновение, Круг звёзд — указание), раньше не добавлялись в список.
  (function migrateSubclassFixedCantrips() {
    let changed = false;
    (data.classes || []).forEach((c) => {
      const cls = getClass(c.id);
      const sub = cls && (cls.subclasses || []).find((x) => x.name.toLowerCase() === String(c.subclass || "").toLowerCase());
      if (!sub) return;
      (sub.features || []).forEach((sf) => {
        const spec = SUBCLASS_BONUS_CANTRIPS[`${sub.slug}|${sf.name}`];
        if (!spec || !spec.fixed || !(spec.noPick || sub.slug === "illusion") || (Number(c.level) || 1) < sf.level) return;
        if (!data.spellcasting) return;
        if (!Array.isArray(data.spellcasting.cantrips)) data.spellcasting.cantrips = [];
        if (!data.spellcasting.cantrips.includes(spec.fixed)) { data.spellcasting.cantrips.push(spec.fixed); changed = true; }
      });
    });
    if (changed) doSave();
  })();
  // Раунд 63: «Форма зверя» (Путь зверя) — формы отдельными карточками; «Всплеск дикости» — без таблицы в тексте.
  (function migrateBarbarianCards() {
    let changed = false;
    const barb = CLASSES.find((c) => c.id === "barbarian");
    const beast = barb && (barb.subclasses || []).find((x) => x.slug === "beast");
    const idx = (data.features || []).findIndex((f) => f.name === "Форма зверя" && /Путь зверя/i.test(f.source || "") && /Укус\./.test(f.desc || "") && /Когти\./.test(f.desc || ""));
    if (beast && idx >= 0) {
      const sf = (beast.features || []).find((x) => x.name === "Форма зверя");
      const split = splitBeastFormCards((sf && sf.desc) || []);
      if (split) {
        const src = data.features[idx].source;
        data.features[idx].desc = split.intro;
        split.cards.forEach((c, k) => { if (!data.features.some((f) => f.name === c.name && f.source === src)) data.features.splice(idx + 1 + k, 0, { name: c.name, source: src, desc: c.desc }); });
        changed = true;
      }
    }
    (data.features || []).forEach((f) => {
      if (/^Всплеск дикости$/i.test(f.name || "") && /(^|\n)\d+\. /.test(f.desc || "")) {
        f.desc = f.desc.split("\n\n").filter((p) => !/^\d+\. /.test(p) && !/^Таблица «Дикая магия»/.test(p)).join("\n\n");
        changed = true;
      }
    });
    if (changed) doSave();
  })();
  // Раунд 63: Варвар — «Быстрота» → «Быстрое передвижение», «Звериная инстинкция» → «Дикий инстинкт».
  (function migrateBarbarianRenames() {
    let changed = false;
    (data.features || []).forEach((f) => {
      if (/^Быстрота$/i.test(f.name || "") && /Варвар/i.test(f.source || "")) { f.name = "Быстрое передвижение"; changed = true; }
      else if (/^Звериная инстинкция$/i.test(f.name || "")) { f.name = "Дикий инстинкт"; changed = true; }
    });
    if (changed) doSave();
  })();
  // Раунд 62: «Природный следопыт» переименован в «Исследователь природы» —
  // переименовываем уже созданные карточки (и «Природный следопыт: Горы» и т.п.).
  (function migrateNaturalExplorerName() {
    let changed = false;
    (data.features || []).forEach((f) => {
      if (/^Природный следопыт(?![а-яё])/i.test(f.name || "")) {
        f.name = f.name.replace(/^Природный следопыт/i, "Исследователь природы");
        if (f.desc) f.desc = f.desc.replace(/Природного следопыта/g, "Исследователя природы");
        changed = true;
      }
    });
    if (changed) doSave();
  })();
  // Раунд 64: жрец — правки текстов доменов у уже созданных персонажей.
  (function migrateClericDomains() {
    let changed = false;
    const before = (data.features || []).length;
    data.features = (data.features || []).filter((f) => !(/^Заклинания домена$/i.test(f.name || "") && /Домен (мира|порядка|сумерек)/i.test(f.source || "")));
    if (data.features.length !== before) changed = true;
    (data.features || []).forEach((f) => {
      const d = f.desc || "";
      if (/^Божественный домен: Домен смерти$/i.test(f.name || "") && /^Хотя этот подкласс официально опубликован/.test(d)) {
        f.desc = d.replace(/^[^\n]*\n\n/, ""); changed = true;
      }
      if (/^Божественный канал: ограждение магией$/i.test(f.name || "") && /\nОграждения магией\s*$/.test(d) ) {
        f.desc = d.replace(/\n+Ограждения магией\s*$/, "\n\nТаблица «Ограждение магией»\nУровень жреца → изгоняется существо с ПО…\n5 → 1/2 или ниже\n8 → 1 или ниже\n11 → 2 или ниже\n14 → 3 или ниже\n17 → 4 или ниже"); changed = true;
      }
      if (/^Божественный канал: сумеречное святилище$/i.test(f.name || "") && /ниже преимуществ:\s*\n+Даровать временные хиты[^\n]*очарования или испуга\.\s*$/.test(d)) {
        f.desc = d.replace(/(ниже преимуществ:)\s*\n+Даровать временные хиты в количестве, равном 1к6 \+ ваш уровень жреца\.\s*Окончить/, "$1\n\n• Даровать временные хиты в количестве, равном 1к6 + ваш уровень жреца.\n• Окончить"); changed = true;
      }
      if (/^Бонусное владение$/i.test(f.name || "") && /Домен кузни/i.test(f.source || "")) {
        if (!data.proficiencies) data.proficiencies = {};
        if (!Array.isArray(data.proficiencies.tools)) data.proficiencies.tools = [];
        if (!data.proficiencies.tools.includes("Инструменты кузнеца")) { data.proficiencies.tools.push("Инструменты кузнеца"); changed = true; }
      }
    });
    if (changed) doSave();
  })();
  // Раунд 67: переименования барда/паладина, стиль «Сражение вслепую».
  (function migrateRound67() {
    let changed = false;
    const bardData = (CLASSES.find((c) => c.id === "bard") || {}).classFeatureText || {};
    (data.features || []).forEach((f) => {
      const n = f.name || "";
      const isBard = /Бард/i.test(f.source || "");
      if (isBard && /^Разностороннее дарование$/i.test(n)) { f.name = "Мастер на все руки"; if ((f.desc || "").length < 220) f.desc = bardData["Мастер на все руки"]; changed = true; }
      else if (isBard && /^Контрчары$/i.test(n)) { f.name = "Контрочарование"; if ((f.desc || "").length < 260) f.desc = bardData["Контрочарование"]; changed = true; }
      else if (isBard && /^Знаток$/i.test(n)) { f.name = "Компетентность"; changed = true; }
      else if (isBard && /^Песнь отдыха$/i.test(n) && (f.desc || "").length < 200) { f.desc = bardData["Песнь отдыха"]; changed = true; }
      else if (/Паладин/i.test(f.source || "") && /^Праведное восстановление$/i.test(n) && /^Вы можете потратить одно использование/.test(f.desc || "")) { f.name = "Использование божественной силы"; changed = true; }
      else if (/^Истории с того света$/i.test(n) && /\n\nИстории духов/.test(f.desc || "")) { f.desc = f.desc.slice(0, f.desc.indexOf("\n\nИстории духов")); changed = true; }
      else if (/^Боевой стиль: Слепой бой$/i.test(n)) { f.name = "Боевой стиль: Сражение вслепую"; changed = true; }
    });
    if (changed) doSave();
  })();
  // Раунд 73: монах — чистка карточек, обновление текстов, владения инструментами.
  (function migrateRound73() {
    let changed = false;
    const before = (data.features || []).length;
    data.features = (data.features || []).filter((f) => {
      const n = f.name || "";
      if (/Монах/i.test(f.source || "") && (/^Стихийные практики$/i.test(n) || /^(Боевые искусства|Безоружное перемещение) \(\d+ ур\.\)$/i.test(n))) return false;
      return true;
    });
    if (data.features.length !== before) changed = true;
    if (!data.proficiencies) data.proficiencies = {};
    if (!Array.isArray(data.proficiencies.tools)) data.proficiencies.tools = [];
    (data.features || []).forEach((f) => {
      const n = f.name || "";
      if (!/Монах/i.test(f.source || "")) return;
      if (/^(Техники открытой ладони|Адепт стихий|Орудия милосердия)$/i.test(n)) {
        const known = findKnownFeatureText(n, f.source);
        if (known && known !== f.desc) { f.desc = known; changed = true; }
      }
      if (/^Путь восходящего дракона$/i.test(n) && /Таблица «Происхождение восходящего дракона» предлагает некоторые варианты\.\s*$/.test(f.desc || "")) {
        f.desc = f.desc.replace(/\n\n[^\n]*Таблица «Происхождение восходящего дракона»[^\n]*$/, ""); changed = true;
      }
      if (/^(Орудия милосердия|Дополнительные владения)$/i.test(n) && /милосердия|пьяного/i.test(f.source || "")) {
        parseProficiencyGrantsFromText(f.desc).tools.forEach((t) => { if (!data.proficiencies.tools.includes(t)) { data.proficiencies.tools.push(t); changed = true; } });
      }
    });
    if (changed) doSave();
  })();
  (function migrateRound76() {
    let changed = false;
    (data.features || []).forEach((f) => {
      if (/Монах/i.test(f.source || "") || /ци|ки/i.test(f.source || "")) {
        if (f.name === "Удары, усиленные ци") { f.name = "Энергетические удары"; changed = true; }
        if (f.name === "Атака, подпитанная ки") { f.name = "Атака, наделённая ци"; changed = true; }
      }
    });
    if (changed) doSave();
  })();
  (function migrateRound76b() {
    let changed = false;
    if ((data.features || []).some((f) => f.name === "Уста ветра" && /шторм/i.test(f.source || ""))) {
      if (!data.proficiencies) data.proficiencies = {};
      if (!Array.isArray(data.proficiencies.languages)) data.proficiencies.languages = [];
      if (!data.proficiencies.languages.includes("Первичный")) { data.proficiencies.languages.push("Первичный"); changed = true; }
    }
    if (changed) doSave();
  })();
  (function migrateRound75() {
    let changed = false;
    const before = (data.features || []).length;
    data.features = (data.features || []).filter((f) => !(/Чародей/i.test(f.source || "") && /^Метамагия \(\d+ ур\.\)$/.test(f.name || "")));
    if (data.features.length !== before) changed = true;
    if ((data.features || []).some((f) => /^Драконий предок/.test(f.name || "") && /драконьей/i.test(f.source || ""))) {
      if (!data.proficiencies) data.proficiencies = {};
      if (!Array.isArray(data.proficiencies.languages)) data.proficiencies.languages = [];
      if (!data.proficiencies.languages.includes("Драконий")) { data.proficiencies.languages.push("Драконий"); changed = true; }
    }
    if (changed) doSave();
  })();
  const EMPTY_DESC_FEATURE_FIXES = ["Избранный враг", "Исследователь природы"];
  (function migrateEmptyRangerFeatureText() {
    let changed = false;
    (data.features || []).forEach((f) => {
      if (EMPTY_DESC_FEATURE_FIXES.includes(f.name) && !f.desc) {
        const known = findKnownFeatureText(f.name, f.source);
        if (known) {
          f.desc = known;
          changed = true;
        }
      }
    });
    if (changed) doSave();
  })();

  // Hill Dwarf's "Дварфская выносливость" ("Максимум хитов увеличен на 1, и
  // ещё на 1 за каждый следующий уровень") was, like every other trait, just
  // flavor text -- this actually applies it to data.hp.max/.current. Since
  // this app has no automatic level-up flow (hp.max is a plain number the
  // player edits by hand as they level), the bonus is tracked as "already
  // applied through level N" and topped up by the difference whenever the
  // character's current total level has moved past that -- runs every time
  // the sheet loads, so it self-heals after a manual level change instead of
  // needing its own level-up UI, and never re-applies the same level twice.
  (function applyDwarvenToughnessHp() {
    const hasTrait = (data.features || []).some((f) => f.name === "Дварфская выносливость");
    if (!hasTrait) return;
    const lvl = totalLevel(data);
    const appliedThrough = Number(data.dwarvenToughnessAppliedLevel) || 0;
    if (lvl > appliedThrough) {
      const delta = lvl - appliedThrough;
      data.hp.max = (Number(data.hp.max) || 0) + delta;
      data.hp.current = (Number(data.hp.current) || 0) + delta;
      data.dwarvenToughnessAppliedLevel = lvl;
      doSave();
    }
  })();

  // One-time cleanup for characters whose proficiency lists picked up an
  // actual duplicate entry from an earlier version of the app (before the
  // wizard's auto-grant code checked .includes() on every push) -- a skill
  // granted by both a race trait and a class feature/skill pick, say, could
  // end up listed twice. Every current write path already guards against
  // this, but old saves keep whatever got written back then, so this
  // dedupes the arrays once per load rather than needing a manual fix.
  (function migrateDedupeProficiencies() {
    let changed = false;
    const prof = data.proficiencies || {};
    ["skills", "expertise", "savingThrows", "armor", "weapons", "tools", "languages"].forEach((key) => {
      if (!Array.isArray(prof[key])) return;
      const deduped = [...new Set(prof[key])];
      if (deduped.length !== prof[key].length) {
        prof[key] = deduped;
        changed = true;
      }
    });
    if (changed) doSave();
  })();

  // Spells that a class/subclass feature grants outright (ritual casting,
  // free casts, extra cantrips) go straight into the character's spell list
  // so they show up in the Заклинания tab. Idempotent; runs on every render.
  const FEATURE_GRANTED_SPELLS = {
    "Искатель духов": ["beast-sense", "speak-with-animals"],
    "Гуляющий с духами": ["commune-with-nature"],
    "Совет предков": ["augury", "clairvoyance"],
    "Драконий дар": ["thaumaturgy"],
    "Магия хранителя роя": ["mage-hand"],
    "Туманный странник": ["misty-step"],
    "Подкрепление фей": ["summon-fey"],
    "Эфирный шаг": ["etherealness"],
    "Техника тени": ["darkness", "darkvision", "pass-without-trace", "silence"],
    "Среди мёртвых": ["spare-the-dying"],
    "Глаза тьмы": ["darkness"],
    "Договор цепи": ["find-familiar"],
    "Удар пылающей дуги": ["burning-hands"],
  };
  // Расовые умения, открывающие заклинания на определённом уровне персонажа (тифлинги и т.п.).
  // Заклинания добавляются в лист автоматически (без ячейки, раз в долгий отдых), убираются при откате уровня.
  const RACE_LEVEL_SPELLS = {
    "Инфернальное наследие": [{ level: 3, id: "hellish-rebuke", skipIfCard: "Адское пламя" }, { level: 5, id: "darkness" }],
    "Дьявольский язык": [{ level: 3, id: "charm-person" }, { level: 5, id: "enthrall" }],
    "Адское пламя": [{ level: 3, id: "burning-hands" }],
    "Наследие Маладомини": [{ level: 3, id: "ray-of-sickness" }, { level: 5, id: "crown-of-madness" }],
    "Наследие Малболга": [{ level: 3, id: "disguise-self" }, { level: 5, id: "invisibility" }],
    "Наследие Диса": [{ level: 3, id: "disguise-self" }, { level: 5, id: "detect-thoughts" }],
    "Наследие Авернуса": [{ level: 3, id: "searing-smite" }, { level: 5, id: "branding-smite" }],
    "Наследие Стигии": [{ level: 3, id: "armor-of-agathys" }, { level: 5, id: "darkness" }],
    "Наследие Минауроса": [{ level: 3, id: "tensers-floating-disk" }, { level: 5, id: "arcane-lock" }],
    "Наследие Кании": [{ level: 3, id: "burning-hands" }, { level: 5, id: "flame-blade" }],
    "Наследие Флегетоса": [{ level: 3, id: "charm-person" }, { level: 5, id: "suggestion" }],
  };
  function ensureRaceLevelSpells() {
    let changed = false;
    const total = (data.classes || []).reduce((n, c) => n + (Number(c.level) || 0), 0);
    Object.entries(RACE_LEVEL_SPELLS).forEach(([trait, list]) => {
      const has = (data.features || []).some((f) => f.name === trait);
      list.forEach((e) => {
        const sc = data.spellcasting;
        const sp = SPELLS.find((x) => x.id === e.id);
        if (!sp) return;
        const want = has && total >= e.level && !(e.skipIfCard && (data.features || []).some((f) => f.name === e.skipIfCard));
        if (want) {
          if (!data.spellcasting) data.spellcasting = { ability: "cha", classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
          const c = data.spellcasting;
          if (!c.known) c.known = [];
          if (!c.cantrips) c.cantrips = [];
          if (!c.ability) c.ability = "cha";
          if (c.cantrips.includes(e.id) || c.known.includes(e.id) || (c.prepared || []).includes(e.id)) return;
          c.known.push(e.id);
          if (!c.granted) c.granted = {};
          c.granted[e.id] = trait;
          changed = true;
        } else if (sc && sc.granted && sc.granted[e.id] === trait) {
          sc.known = (sc.known || []).filter((x) => x !== e.id);
          sc.prepared = (sc.prepared || []).filter((x) => x !== e.id);
          delete sc.granted[e.id];
          changed = true;
        }
      });
    });
    return changed;
  }
  function ensureFeatureSpells() {
    let changed = ensureRaceLevelSpells();
    (data.features || []).forEach((f) => {
      const ids = FEATURE_GRANTED_SPELLS[f.name];
      if (!ids) return;
      if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      const sc = data.spellcasting;
      if (!sc.cantrips) sc.cantrips = [];
      if (!sc.known) sc.known = [];
      ids.forEach((id) => {
        const sp = SPELLS.find((x) => x.id === id);
        if (!sp) return;
        if (sc.cantrips.includes(id) || sc.known.includes(id) || (sc.prepared || []).includes(id)) return;
        (sp.level === 0 ? sc.cantrips : sc.known).push(id);
        if (!sc.granted) sc.granted = {};
        sc.granted[id] = f.name;
        changed = true;
      });
    });
    return changed;
  }
  function render() {
    if (ensureFeatureSpells()) doSave();
    mount(`
      <div class="top-bar">
        <a href="#/characters" class="brand">← ⚔ D&D 5e</a>
        <div class="row">
          <span class="save-indicator" data-save-indicator></span>
          <span class="muted">${escapeHtml(user?.email || "")}</span>
        </div>
      </div>
      ${headerBlock()}
      <div class="tabs">
        ${tabBtn("main", "Лист")}
        ${tabBtn("attacks", "Атаки")}
        ${tabBtn("spells", "Заклинания")}
        ${tabBtn("forms", data.forms && data.forms.active ? "Облики 🐾" : "Облики")}
        ${tabBtn("inventory", "Инвентарь")}
        ${tabBtn("feats", "Черты")}
        ${tabBtn("traits", "Умения")}
        ${tabBtn("personality", "Личность")}
        ${tabBtn("pets", "Спутники")}
      </div>
      <div data-tab-content>
        ${activeTab === "main" ? mainTab() : ""}
        ${activeTab === "attacks" ? attacksTab() : ""}
        ${activeTab === "spells" ? spellsTab() : ""}
        ${activeTab === "forms" ? formsTab() : ""}
        ${activeTab === "inventory" ? inventoryTab() : ""}
        ${activeTab === "feats" ? featsTab() : ""}
        ${activeTab === "traits" ? traitsTab() : ""}
        ${activeTab === "personality" ? personalityTab() : ""}
        ${activeTab === "pets" ? petsTab() : ""}
      </div>
      <div class="footer-note">Изменения сохраняются автоматически в облако.</div>
    `);
    // Feature-card title is an auto-growing textarea (so a long name wraps
    // onto a second line instead of scrolling sideways) — size it to its
    // content right after mount. The description box is fixed-height with
    // its own internal scrollbar instead (see .feature-card-desc in CSS),
    // so cards stay a uniform size regardless of how much text a feature has.
    $all(".feature-card-header textarea", app).forEach(autoGrowTextarea);
  }

  function autoGrowTextarea(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  function tabBtn(id2, label) {
    return `<button data-tab="${id2}" class="${activeTab === id2 ? "active" : ""}">${label}</button>`;
  }

  // Row of toggleable PHB condition pills across the bottom of the header
  // panel -- click to turn a condition on/off, hover (native title
  // tooltip, same as elsewhere the app keeps a hover explanation lightweight
  // rather than building a custom popover for it) to read its rules text.
  // Purely a tracker: the app doesn't derive advantage/disadvantage or any
  // other mechanical effect from an active condition, the player still
  // applies those manually when rolling.
  // Истощение: a 0-6 level dropdown instead of an on/off pill. Hovering a
  // level shows its rules text (and everything below it, since levels
  // accumulate) in the detail box at the bottom of the menu; the effects
  // themselves are applied by exhaustionLevel() callers: rolls (checks/
  // attacks/saves), speed, max HP -- see character.js.
  function exhaustionMenuHtml() {
    const lvl = exhaustionLevel(data);
    const cur = EXHAUSTION_LEVELS.find((l) => l.level === lvl);
    return `
      <div class="exh-dd" style="position:relative;display:inline-block;">
        <button type="button" class="condition-pill ${lvl > 0 ? "active" : ""}" data-action="toggle-exhaustion-menu" title="${escapeHtml(cur ? cur.short : "Истощение: нет")}">${lvl > 0 ? `Истощение ${lvl}` : "Истощение"} ▾</button>
        ${
          exhaustionMenuOpen
            ? `<div class="exh-menu">
          <button type="button" class="exh-item ${lvl === 0 ? "selected" : ""}" data-exh-level="0" data-exh-desc="Нет истощения.">Нет</button>
          ${EXHAUSTION_LEVELS.map((l) => `<button type="button" class="exh-item ${lvl === l.level ? "selected" : ""}" data-exh-level="${l.level}" data-exh-desc="${escapeHtml(l.desc)}" title="${escapeHtml(l.short)}">${l.name} — ${escapeHtml(l.short)}</button>`).join("")}
          <div class="exh-detail" data-exh-detail>${escapeHtml(cur ? cur.desc : "Наведите на уровень, чтобы увидеть подробности.")}</div>
        </div>`
            : ""
        }
      </div>`;
  }
  function conditionsPanelHtml() {
    const active = new Set(data.conditions || []);
    return `
      <div style="margin-top:4px;border-top:1px solid var(--border);padding-top:6px;">
        <div class="condition-pills">
          ${exhaustionMenuHtml()}
          ${CONDITIONS.filter((c) => c.id !== "exhaustion").map(
            (c) => `<button type="button" class="condition-pill ${active.has(c.id) ? "active" : ""}" data-action="toggle-condition" data-condition="${c.id}" title="${escapeHtml(c.desc)}">${escapeHtml(c.name)}</button>`
          ).join("")}
        </div>
      </div>`;
  }
  // Раса/Предыстория: a dropdown of known RACES/BACKGROUNDS names, plus a
  // "Своё" option that reveals a plain text field for anything homebrew --
  // see raceCustomOpen/backgroundCustomOpen above for why a boolean flag
  // (not just "does the saved name match a known one") decides custom mode.
  function raceFieldHtml() {
    // The wizard saves "Раса (Подраса)", e.g. "Эльф (Высший эльф)" -- not an
    // exact RACES name, but still a known race, so it gets its own option
    // instead of being mistaken for a homebrew one.
    const rn = data.raceName || "";
    const wizardStyle = !!rn && !RACES.some((r) => r.name === rn) && RACES.some((r) => rn.startsWith(r.name + " ("));
    const known = wizardStyle || RACES.some((r) => r.name === rn);
    const custom = raceCustomOpen || (!!rn && !known);
    return `
      <div class="col">
        <label>Раса</label>
        <div style="display:flex;gap:6px;">
          <select data-action="race-select" style="${custom ? "flex:0 0 auto;width:auto;" : "flex:1;min-width:0;"}">
            <option value="">—</option>
            ${wizardStyle ? `<option value="${escapeHtml(rn)}" ${!custom ? "selected" : ""}>${escapeHtml(rn)}</option>` : ""}
            ${RACES.map((r) => `<option value="${escapeHtml(r.name)}" ${!custom && data.raceName === r.name ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}
            <option value="__custom__" ${custom ? "selected" : ""}>Своё…</option>
          </select>
          ${custom ? `<input type="text" data-bind="raceName" maxlength="30" value="${escapeHtml(data.raceName || "")}" placeholder="своя раса" style="flex:1;min-width:0;" />` : ""}
        </div>
      </div>`;
  }
  function backgroundFieldHtml() {
    const known = BACKGROUNDS.some((b) => b.name === data.backgroundName);
    const custom = backgroundCustomOpen || (!!data.backgroundName && !known);
    return `
      <div class="col">
        <label>Предыстория</label>
        <div style="display:flex;gap:6px;">
          <select data-action="background-select" style="${custom ? "flex:0 0 auto;width:auto;" : "flex:1;min-width:0;"}">
            <option value="">—</option>
            ${BACKGROUNDS.map((b) => `<option value="${escapeHtml(b.name)}" ${!custom && data.backgroundName === b.name ? "selected" : ""}>${escapeHtml(b.name)}</option>`).join("")}
            <option value="__custom__" ${custom ? "selected" : ""}>Своё…</option>
          </select>
          ${custom ? `<input type="text" data-bind="backgroundName" maxlength="30" value="${escapeHtml(data.backgroundName || "")}" placeholder="своя предыстория" style="flex:1;min-width:0;" />` : ""}
        </div>
      </div>`;
  }
  function headerBlock() {
    const lvl = totalLevel(data);
    const pb = proficiencyBonus(data);
    return `
      <div class="panel panel-tight">
        <div class="row" style="align-items:flex-start;gap:10px;">
          ${portraitBox()}
          <div style="flex:1;min-width:0;">
            <div class="grid cols-2">
              <div class="col">
                <label>Имя персонажа</label>
                <input type="text" data-bind="name" maxlength="30" value="${escapeHtml(data.name)}" style="font-size:1.05rem;" />
              </div>
              <div class="col">
                <label>Редакция</label>
                <select data-bind="edition">
                  <option value="2014" ${data.edition === "2014" ? "selected" : ""}>2014</option>
                  <option value="2024" ${data.edition === "2024" ? "selected" : ""}>2024</option>
                </select>
              </div>
            </div>
            <div class="grid cols-3" style="margin-top:4px;">
              ${raceFieldHtml()}
              ${backgroundFieldHtml()}
              <div class="col">
                <label>Мировоззрение</label>
                <select data-bind="alignment">
                  <option value="">—</option>
                  ${ALIGNMENTS.map((a) => `<option value="${escapeHtml(a)}" ${data.alignment === a ? "selected" : ""}>${escapeHtml(a)}</option>`).join("")}
                </select>
              </div>
            </div>
          </div>
          ${restButtonHtml()}
        </div>
        ${classesEditor()}
        <p class="muted" style="margin:2px 0 0;font-size:0.76rem;">Суммарный уровень: <strong class="num">${lvl}</strong> · Бонус мастерства: <strong class="num">${formatModifier(pb)}</strong></p>
        <div style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;">
          ${inspirationWidget()}
        </div>
        ${conditionsPanelHtml()}
      </div>`;
  }

  // Rest button, top-right of the header panel: sun/moon icon (no button
  // chrome behind it, just the image), opens the short/long rest modal.
  function restButtonHtml() {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;gap:0;">
        <img class="rest-icon" src="assets/icons/rest.png" data-action="open-rest-modal" width="52" height="52" alt="Отдых" title="Короткий или продолжительный отдых" />
        <span class="muted" style="font-size:0.68rem;margin-top:-2px;">Отдых</span>
      </div>`;
  }

  // ---- Rest (short/long) -----------------------------------------------
  // Hit Dice on this sheet are a single pool ({die,total,current}), not
  // broken out per class -- fine for single-class characters and a
  // reasonable simplification for multiclass ones (the player sets total
  // manually already, same as elsewhere on this sheet).
  // Reason string when exhaustion imposes disadvantage on this kind of roll
  // ("check": ability checks/skills/initiative from level 1; "attack" and
  // "save": from level 3), otherwise "".
  function exhaustionDisadvantage(kind) {
    const lvl = exhaustionLevel(data);
    if (kind === "check" && lvl >= 1) return `Истощение ${lvl}`;
    if ((kind === "attack" || kind === "save") && lvl >= 3) return `Истощение ${lvl}`;
    return "";
  }
  function ensureHitDice() {
    if (!data.hitDice) data.hitDice = { die: 8, total: 1, current: 1 };
  }
  // Keeps the shared Hit Dice pool's total in step with total character
  // level (PHB: you gain a Hit Die every time you gain a level, whichever
  // class it's in), instead of `total` staying frozen at whatever it was
  // set to at character creation. Called with the level BEFORE whatever
  // change (level-up, adding/removing a class, editing a level number by
  // hand) just happened, so it can tell growth from shrinkage: growth also
  // bumps `current` by the same amount (a newly-gained die starts
  // available, same as hp.current growing alongside hp.max on level-up);
  // shrinkage just clamps `current` down to the new total instead of
  // fabricating dice back.
  function syncHitDiceTotalToLevel(beforeLevel) {
    ensureHitDice();
    const afterLevel = totalLevel(data);
    const gained = Math.max(0, afterLevel - beforeLevel);
    data.hitDice.total = afterLevel;
    data.hitDice.current = Math.max(0, Math.min(afterLevel, (Number(data.hitDice.current) || 0) + gained));
  }
  function hitDiceInfo() {
    ensureHitDice();
    return {
      die: Number(data.hitDice.die) || 8,
      total: Number(data.hitDice.total) || 1,
      current: Number(data.hitDice.current) || 0,
    };
  }
  // Resets usesState -> all-available for every feature whose parsed/forced
  // recharge matches one of the given recharge kinds ("short"/"long"/"any").
  // Infinite-use features (Rage at 20) have nothing to reset.
  function restoreArtifactUses(rechargeKinds) {
    (data.artifacts || []).forEach((a) => {
      const u = a.uses;
      if (u && u.enabled && !(u.recharge === "dawn" && parseDiceFromText(u.dawnDice)) && rechargeKinds.includes(u.recharge === "dawn" ? "long" : u.recharge || "long")) a.usesState = Array(Math.max(1, Number(u.max) || 1)).fill(true);
    });
  }
  function restoreFeatureUses(rechargeKinds) {
    restoreArtifactUses(rechargeKinds);
    (data.features || []).forEach((f) => {
      const uses = resolveFeatureUses(f);
      if (!uses || uses.max <= 0 || uses.max === Infinity) return;
      if (!uses.recharge || !rechargeKinds.includes(uses.recharge)) return;
      setFeatureUsesState(f, Array(uses.max).fill(true));
    });
  }
  // Ячейки, созданные «Гибким колдовством», пропадают после продолжительного отдыха.
  function dropCreatedSlots() {
    const sc = data.spellcasting;
    if (!sc || !sc.createdSlots) return;
    Object.keys(sc.createdSlots).forEach((c) => {
      sc.slots[c] = Math.max(0, (Number(sc.slots[c]) || 0) - (sc.createdSlots[c] || 0));
      if (Array.isArray(sc.slotsFilled && sc.slotsFilled[c])) sc.slotsFilled[c] = sc.slotsFilled[c].slice(0, sc.slots[c]);
    });
    sc.createdSlots = {};
  }
  // Refills every spell-slot circle at every level that currently has slots.
  function restoreAllSpellSlots() {
    const sc = data.spellcasting;
    if (!sc || !sc.slots) return;
    if (!sc.slotsFilled) sc.slotsFilled = {};
    Object.keys(sc.slots).forEach((lvl) => {
      const max = Number(sc.slots[lvl]) || 0;
      if (max > 0) sc.slotsFilled[lvl] = Array(max).fill(true);
    });
  }
  // Pact Magic (Warlock): all of that class's spell slots come back on a
  // SHORT rest, not just a long one. This sheet keeps one shared slot pool
  // rather than a separate pact pool, so "has a pact-casting class" is
  // treated as "this character's whole slot pool is pact slots" -- true for
  // a single-classed Warlock, a reasonable simplification for a multiclass
  // one (same simplification the sheet already makes for Hit Dice/slots).
  function isPactCaster() {
    return (data.classes || []).some((c) => getClass(c.id)?.spellcasting?.pact);
  }
  // "Магическое восстановление" (Wizard) / "Естественное восстановление"
  // (Circle of the Land Druid): once per day, during a short rest, recover
  // spell slots whose levels sum to at most half your class level (round
  // up), none 6th level or higher. Both are forced into resolveFeatureUses
  // as {max:1, recharge:"long"} (see there) so they get normal pip tracking
  // and this rest flow can tell whether today's use is still available.
  const ARCANE_RECOVERY_FEATURES = [
    { match: /^Магическое восстановление$/i, classId: "wizard", classLabel: "волшебника" },
    { match: /^Естественное восстановление$/i, classId: "druid", classLabel: "друида" },
  ];
  function findArcaneRecovery() {
    for (const entry of ARCANE_RECOVERY_FEATURES) {
      const feature = (data.features || []).find((f) => entry.match.test(f.name || ""));
      if (!feature) continue;
      const uses = resolveFeatureUses(feature);
      if (!uses) continue;
      const arr = usesArrayFor(feature, uses.max);
      if (arr.some(Boolean)) return { feature, uses, ...entry };
    }
    return null;
  }
  function refreshRestModal() {
    if (restModalEl) restModalEl.innerHTML = restModalBodyHtml();
  }
  function restModalBodyHtml() {
    return `
      <h3 style="margin:0 0 10px;">Отдых</h3>
      <div class="tabs" style="margin:0 0 12px;">
        <button type="button" data-rest-tab="short" class="${restState.tab === "short" ? "active" : ""}">Короткий отдых</button>
        <button type="button" data-rest-tab="long" class="${restState.tab === "long" ? "active" : ""}">Продолжительный отдых</button>
      </div>
      ${restState.tab === "short" ? shortRestTabHtml() : longRestTabHtml()}
      ${restState.message ? `<div class="panel panel-tight" style="margin:12px 0 0;border-color:var(--accent, currentColor);"><p style="margin:0;font-size:0.9rem;">${escapeHtml(restState.message)}</p></div>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:12px;"><button type="button" data-action="close-rest-modal">Закрыть</button></div>
    `;
  }
  function shortRestTabHtml() {
    const hd = hitDiceInfo();
    return `
      <div class="panel panel-tight" style="margin:0;">
        <p style="margin:0 0 8px;">Кости хитов: <strong class="num">${hd.current}</strong> из ${hd.total} (к${hd.die})</p>
        <label class="row" style="gap:8px;align-items:center;">
          <span>Потратить костей хитов:</span>
          <input type="number" min="0" max="${hd.current}" value="${Math.min(restState.diceCount || 0, hd.current)}" data-rest-dice-count style="width:70px;" ${hd.current <= 0 ? "disabled" : ""} />
        </label>
        <p class="muted" style="font-size:0.76rem;margin:6px 0 0;">Каждая кость даёт 1к${hd.die} ${formatModifier(getAbilityMod(data, "con"))} (модификатор Телосложения) хитов.</p>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px;">
        <button type="button" class="primary" data-action="do-short-rest">Отдохнуть (короткий отдых)</button>
      </div>`;
  }
  function longRestTabHtml() {
    const hd = hitDiceInfo();
    const recover = Math.max(1, Math.floor(hd.total / 2));
    return `
      <div class="panel panel-tight" style="margin:0;">
        <p style="margin:0;">Кости хитов: <strong class="num">${hd.current}</strong> из ${hd.total} (к${hd.die})</p>
        <p class="muted" style="font-size:0.76rem;margin:6px 0 0;">Продолжительный отдых восстановит ${recover} ${pluralizeBones(recover)} хитов (половина максимума, минимум 1), все хиты (кроме временных), все ячейки заклинаний и все умения.</p>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px;">
        <button type="button" class="primary" data-action="do-long-rest">Отдохнуть (продолжительный отдых)</button>
      </div>`;
  }
  // Finishes a short rest: restores everything that recharges on a short
  // (or "any") rest, plus Pact Magic slots for a Warlock. Called either
  // directly (no pending Arcane Recovery choice) or after that choice modal
  // confirms/skips.
  // Spends `count` Hit Dice (rolled here, PHB p.186), heals, and returns a
  // human-readable summary line for the rest window ("" when count is 0).
  function spendHitDiceForRest(count) {
    const hd = hitDiceInfo();
    count = Math.max(0, Math.min(hd.current, count));
    if (count <= 0) return "";
    const conMod = getAbilityMod(data, "con");
    // «Стойкий»: each Hit Die spent this way heals at least 2×Con modifier
    // (minimum 2), regardless of what the die itself rolled.
    const durableFloor = hasFeat("durable") ? Math.max(2, 2 * conMod) : 0;
    const rolls = rollDice(count, hd.die).map((r) => Math.max(r, durableFloor));
    const healTotal = Math.max(0, rolls.reduce((a, b) => a + b, 0) + count * conMod);
    data.hitDice.current = hd.current - count;
    const max = effectiveMaxHp(data);
    const before = Number(data.hp.current) || 0;
    const after = Math.min(max, before + healTotal);
    data.hp.current = after;
    return `Потрачено ${count} ${pluralizeBones(count)} хитов (${rolls.map((r) => `${r}`).join(" + ")} ${formatModifier(conMod * count)}): восстановлено ${after - before} хитов (${before} → ${after} из ${max}).`;
  }
  function finishShortRest() {
    const hdSummary = spendHitDiceForRest(restState.pendingDice || 0);
    restState.pendingDice = 0;
    restState.diceCount = 0;
    restoreFeatureUses(["short", "any"]);
    if (isPactCaster()) restoreAllSpellSlots();
    restState.message = (hdSummary ? hdSummary + " " : "") + "Короткий отдых завершён: умения и заклинания, восстанавливающиеся на коротком отдыхе, обновлены.";
    doSave();
    render();
    refreshRestModal();
  }
  function performLongRest() {
    const max = effectiveMaxHp(data);
    const hpBefore = Number(data.hp.current) || 0;
    data.hp.current = max; // temp HP is deliberately left untouched
    const hd = hitDiceInfo();
    const recover = Math.max(1, Math.floor(hd.total / 2));
    const diceAfter = Math.min(hd.total, hd.current + recover);
    const diceGained = diceAfter - hd.current;
    data.hitDice.current = diceAfter;
    restoreFeatureUses(["short", "long", "any"]);
    dropCreatedSlots();
    restoreAllSpellSlots();
    const luckyEntry = (data.feats || []).find((f) => f.id === LUCKY_FEAT_ID);
    if (luckyEntry) luckyEntry.luckyUsed = [false, false, false];
    if (data.deathSaves) { data.deathSaves.successes = 0; data.deathSaves.failures = 0; }
    restState.message = `Продолжительный отдых завершён: хиты восстановлены (${hpBefore} → ${max}), кости хитов: +${diceGained} ${pluralizeBones(diceGained)} (теперь ${diceAfter} из ${hd.total}), умения и ячейки заклинаний обновлены.`;
    doSave();
    render();
    refreshRestModal();
  }
  // Arcane Recovery / Natural Recovery's own slot-selection prompt -- a
  // second modal on top of (replacing) the rest one. Confirming or skipping
  // both fall through to finishShortRest() to complete the rest itself.
  function openArcaneRecoveryModal(recovery) {
    const classLevel = (data.classes || []).find((c) => c.id === recovery.classId)?.level || totalLevel(data);
    const budget = Math.max(1, Math.ceil(classLevel / 2));
    const sc = data.spellcasting || {};
    const levels = [1, 2, 3, 4, 5].filter((lvl) => Number((sc.slots || {})[lvl]) > 0);
    const spentByLevel = {};
    levels.forEach((lvl) => { spentByLevel[lvl] = spellSlotsArrayFor(sc, lvl).filter((f) => !f).length; });
    const html = `
      <h3 style="margin-top:0;">${escapeHtml(recovery.feature.name)}</h3>
      <p class="muted" style="font-size:0.85rem;">Выберите, какие ячейки заклинаний восстановить: суммарный уровень восстановленных ячеек не может превышать ${budget} (половина уровня ${recovery.classLabel}, округляя в большую сторону), и ни одна ячейка не может быть 6-го уровня или выше.</p>
      ${
        levels.some((lvl) => spentByLevel[lvl] > 0)
          ? `<div class="grid cols-2" style="gap:8px;">
        ${levels
          .filter((lvl) => spentByLevel[lvl] > 0)
          .map(
            (lvl) => `
          <div class="col">
            <label>${lvl}-й круг (потрачено: ${spentByLevel[lvl]})</label>
            <input type="number" min="0" max="${spentByLevel[lvl]}" value="0" data-arcane-level="${lvl}" />
          </div>`
          )
          .join("")}
      </div>
      <p class="muted" style="font-size:0.8rem;margin-top:10px;" data-arcane-budget>Использовано: 0 из ${budget}</p>`
          : `<p class="muted">Нет потраченных ячеек заклинаний, восстанавливать нечего.</p>`
      }
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" class="small" data-action="skip-arcane-recovery">Пропустить</button>
        <button type="button" class="primary" data-action="confirm-arcane-recovery" ${levels.some((lvl) => spentByLevel[lvl] > 0) ? "" : "disabled"}>Восстановить</button>
      </div>`;
    const modal = openModal(html);
    const updateBudget = () => {
      let used = 0;
      levels.forEach((lvl) => {
        const el = modal.querySelector(`[data-arcane-level="${lvl}"]`);
        used += lvl * Math.max(0, Number(el?.value) || 0);
      });
      const disp = modal.querySelector("[data-arcane-budget]");
      if (disp) disp.textContent = `Использовано: ${used} из ${budget}`;
      const confirmBtn = modal.querySelector("[data-action=confirm-arcane-recovery]");
      if (confirmBtn) confirmBtn.disabled = used > budget || used === 0;
    };
    updateBudget();
    on(modal, "input", "[data-arcane-level]", updateBudget);
    on(modal, "click", "[data-action=skip-arcane-recovery]", () => {
      restModalEl = openModal(restModalBodyHtml());
      wireRestModal(restModalEl);
      finishShortRest();
    });
    on(modal, "click", "[data-action=confirm-arcane-recovery]", () => {
      let used = 0;
      const chosen = {};
      levels.forEach((lvl) => {
        const el = modal.querySelector(`[data-arcane-level="${lvl}"]`);
        const n = Math.max(0, Math.min(spentByLevel[lvl], Number(el?.value) || 0));
        chosen[lvl] = n;
        used += lvl * n;
      });
      if (used > budget) return;
      if (!sc.slotsFilled) sc.slotsFilled = {};
      levels.forEach((lvl) => {
        let remaining = chosen[lvl];
        if (remaining <= 0) return;
        const arr = spellSlotsArrayFor(sc, lvl);
        for (let i = 0; i < arr.length && remaining > 0; i++) {
          if (!arr[i]) { arr[i] = true; remaining--; }
        }
        sc.slotsFilled[lvl] = arr;
      });
      const featureUses = usesArrayFor(recovery.feature, recovery.uses.max);
      const idx = featureUses.findIndex(Boolean);
      if (idx !== -1) featureUses[idx] = false;
      recovery.feature.usesState = featureUses;
      restModalEl = openModal(restModalBodyHtml());
      wireRestModal(restModalEl);
      finishShortRest();
    });
  }
  // Wires the rest modal's delegated handlers once, on the modal root --
  // since on() delegates from that root, these survive refreshRestModal()
  // replacing the modal's innerHTML on every tab switch / roll / rest.
  function wireRestModal(modal) {
    on(modal, "click", "[data-action=close-rest-modal]", () => { closeModal(); render(); });
    on(modal, "click", "[data-rest-tab]", (e, el) => {
      restState.tab = el.dataset.restTab;
      restState.message = "";
      refreshRestModal();
    });
    on(modal, "input", "[data-rest-dice-count]", (e, el) => {
      restState.diceCount = Math.max(0, Math.floor(Number(el.value) || 0));
    });
    on(modal, "click", "[data-action=do-short-rest]", () => {
      const hdNow = hitDiceInfo();
      const input = modal.querySelector("[data-rest-dice-count]");
      restState.pendingDice = Math.max(0, Math.min(hdNow.current, Math.floor(Number(input?.value) || 0)));
      const recovery = findArcaneRecovery();
      if (recovery) { openArcaneRecoveryModal(recovery); return; }
      finishShortRest();
    });
    on(modal, "click", "[data-action=do-long-rest]", () => {
      performLongRest();
    });
  }
  function openRestModal() {
    restState = { tab: "short", message: "", diceCount: 0, pendingDice: 0 };
    restModalEl = openModal(restModalBodyHtml());
    wireRestModal(restModalEl);
  }

  // ---- Level up -----------------------------------------------------
  // Only a class whose CLASSES entry has real level-by-level data (just
  // Воин 2 уровень today -- see cls.features[N]/cls.classFeatureText) gets
  // its features filled in automatically; any other class/level still lets
  // the player take the level (HP increase included) but shows a note to
  // add its features by hand on the "Умения" tab, rather than blocking the
  // whole mechanic on every class being modeled first.
  let levelUpModalEl = null;
  let levelUpState = null; // { classIndex, hpMethod: "roll"|"average", rolledAmount: number|null, asi: {...} | null }

  function levelUpEligibleClasses() {
    return (data.classes || []).filter((c) => c.id && (c.level || 1) < 20);
  }
  // Turns a class's raw cls.features[newLevel] (short blurbs, e.g. "Всплеск
  // действий (доп. действие в ход, 1/короткий отдых)") into the same
  // {name, desc} shape doFinish() in wizard.js builds feature cards from at
  // character creation -- splitFeatureText() pulls the name out of the short
  // blurb, and cls.classFeatureText's full writeup is preferred over it when
  // on file.
  function levelUpFeaturesFor(cls, newLevel) {
    const raw = cls && cls.features && cls.features[newLevel];
    if (!raw) return [];
    return raw.map((f) => {
      const split = splitFeatureText(f);
      // Если то же умение уже было на более раннем уровне (рост кости и т.п.), показываем только короткое пояснение, а не полный текст ещё раз.
      const repeated = split.desc && Object.keys(cls.features || {}).some((lv) => Number(lv) < newLevel && (cls.features[lv] || []).some((x) => splitFeatureText(x).name === split.name));
      const fullText = !repeated && cls.classFeatureText && cls.classFeatureText[split.name];
      return { name: split.name, desc: fullText || split.desc };
    });
  }
  function levelUpAverageHp(cls) {
    return Math.floor(((cls && cls.hitDie) || 8) / 2) + 1;
  }
  // "Черта или увеличение характеристик" (Воин 4/6/8/12/14/16/19-й уровень,
  // and the same choice under other names for most other classes) isn't a
  // plain feature card -- it's an actual mechanical choice between a feat
  // (reusing the "Черты" tab's own add-feat logic) and raising ability
  // scores, so it gets pulled out of the generic feature list below and
  // given its own chooser UI instead.
  const ASI_FEATURE_NAME = /увеличение характеристик/i;
  // "Заклинания N-го круга" (Wizard/Cleric level-up entries marking that a
  // new spell circle just opened up) isn't a real umение either -- it's a
  // notice, and the actual effect (being able to prepare/cast that circle)
  // already shows up on its own once the player raises the matching number
  // in "Количество ячеек" on the Заклинания tab. So, like ASI/subclass
  // markers above, it's filtered out of the generic feature-card push
  // instead of becoming its own inert card.
  const SPELL_CIRCLE_UNLOCK_FEATURE_NAME = /^Заклинания\s+\d+-(?:го|й)\s+круга$/i;
  // Same idea as the circle-unlock marker above, but for the "you can now
  // cast spells at all" notice a half-caster's OWN level-2 slot uses
  // (Следопыт/Паладин; Волшебник/Жрец/Бард word this as "Заклинания
  // волшебника"/etc at level 1, which is character-creation territory, not
  // level-up, so it never reached this filter before -- but the exact same
  // wording pattern is reused here for consistency, in case a future class's
  // level-up table also opens spellcasting this way at a level other than 1).
  // Casting itself already works once spellcasting.ability is set (done
  // automatically at creation) and the Заклинания tab's own "Количество
  // ячеек" numbers are filled in by applyLevelUpSpellSlots -- this text
  // never had a mechanic of its own to lose by being filtered out.
  const SPELLCASTING_INTRO_FEATURE_NAME = /^Заклинания\s+(волшебника|жреца|следопыта|паладина|барда|друида|чародея|колдуна)$/i;
  function levelHasAsiChoice(cls, newLevel) {
    const raw = cls && cls.features && cls.features[newLevel];
    return !!(raw || []).some((f) => ASI_FEATURE_NAME.test(f));
  }
  function freshAsiState() {
    return { mode: "asi", singleAbility: true, abilities: ["str", ""], featId: "", featAbility: "", featSkills: [], sel: newFeatSel() };
  }
  // "Боевой архетип" (Воин 3-й уровень, and the same idea under other names
  // for most other classes -- Rogue's "Архетип плута", Barbarian's "Путь",
  // etc.) isn't a plain feature card either: it's the character's subclass
  // pick, so it gets its own chooser UI (subclassChoicePanelHtml below) the
  // same way the ASI/feat choice does, instead of a bare card with a
  // "go pick it from the dropdown" note. Only the exact classes/levels with
  // real subclass data on file (just Воин today) actually trigger it --
  // levelHasSubclassChoice() checks the class's OWN raw feature text for
  // this level rather than hardcoding "level 3", so it generalizes to
  // whichever level a future class's data uses for the same choice.
  // Most classes phrase their own "pick a subclass now" slot text with the
  // word "архетип" (Боевой архетип, Архетип плута, Архетип следопыта, ...),
  // but Варвар's is "Путь первобытности" -- matched by the leading "Путь"
  // instead, which is safe here since this regex only ever runs against a
  // class's OWN features[level] slot text (never a subclass's own NAME,
  // which is where wording like "Путь открытой ладони" actually lives), and
  // Варвар is the only class whose slot text starts with that word.
  // NOTE: JS's \b (word boundary) is defined in terms of \w, which only
  // covers [A-Za-z0-9_] -- it never matches next to a Cyrillic letter (every
  // Cyrillic character is "non-word" to the regex engine), so `^путь\b`
  // never matched ANYTHING, ever (not even the exact string "путь"). Use an
  // explicit "next char isn't a letter" lookahead instead everywhere a
  // Cyrillic word needs a real boundary.
  const SUBCLASS_CHOICE_FEATURE_NAME = /архетип|^путь(?![a-zа-яё])|традиция|клятва|колледж|^круг друидов$/i;
  // "Умение архетипа" (Воин 7-й/10-й уровень) is a placeholder marker in
  // cls.features -- the ACTUAL feature at that level comes from whichever
  // subclass the character already picked (see subclassFeaturesAtLevel()),
  // so this text itself is never shown as a card.
  const ARCHETYPE_FEATURE_MARKER = "Умение архетипа";
  function levelHasSubclassChoice(c, cls, newLevel) {
    if (!c || c.subclass) return false;
    if (!cls || !cls.subclasses || !cls.subclasses.length) return false;
    const raw = (cls.features && cls.features[newLevel]) || [];
    return raw.some((f) => SUBCLASS_CHOICE_FEATURE_NAME.test(f));
  }
  function freshSubclassChoiceState() {
    return { name: "", maneuverIds: [], cantripIds: [], spellIds: [], totem: "" };
  }
  // A spellbook caster (Волшебник today -- "prepared" type with no
  // preparedFormula, i.e. the character picks which spells go INTO the book
  // rather than freely preparing off the whole class list like Жрец does)
  // adds 2 new spells to their book on every level-up from 2nd level on
  // (PHB, "Spellcasting" table footnote). Gated to the max spell circle the
  // class table actually grants by that level, using the standard full-caster
  // progression (circle 1 at level 1, +1 circle every 2 levels, capped at 9).
  // Scoped to Волшебник specifically (list === "wizard") rather than the
  // generic "prepared type with no preparedFormula" shape -- Паладин has that
  // same shape in the data (its own preparedFormula just isn't modeled yet)
  // but doesn't grow a permanent spellbook the way Волшебник does; it
  // re-prepares its whole known list each day instead, so forcing a 2-spell
  // pick on it at every level-up would be wrong.
  function isSpellbookCaster(cls) {
    return !!(cls && cls.spellcasting && cls.spellcasting.type === "prepared" && !cls.spellcasting.preparedFormula && cls.spellcasting.list === "wizard");
  }
  function maxSpellCircleForLevel(level) {
    return Math.min(9, Math.ceil(level / 2));
  }
  const SPELLBOOK_GROWTH_PER_LEVEL = 2;
  function levelHasSpellbookGrowth(cls, newLevel) {
    return isSpellbookCaster(cls) && newLevel >= 2;
  }
  function freshSpellbookChoiceState() {
    return { spellIds: [] };
  }
  function spellbookChoicePanelHtml(cls, newLevel) {
    const sc = levelUpState.spellbookChoice;
    const maxCircle = maxSpellCircleForLevel(newLevel);
    const alreadyKnown = new Set([
      ...((data.spellcasting && data.spellcasting.cantrips) || []),
      ...((data.spellcasting && data.spellcasting.known) || []),
      ...((data.spellcasting && data.spellcasting.prepared) || []),
    ]);
    const options = SPELLS.filter(
      (s) => s.level >= 1 && s.level <= maxCircle && s.classes.includes(cls.spellcasting.list) && !alreadyKnown.has(s.id)
    ).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru"));
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Новые заклинания в книгу заклинаний (${sc.spellIds.length}/${SPELLBOOK_GROWTH_PER_LEVEL})</h4>
        <p class="muted" style="font-size:0.82rem;">На этом уровне книга заклинаний пополняется на ${SPELLBOOK_GROWTH_PER_LEVEL} заклинания ${maxCircle}-го круга или ниже.</p>
        <div class="grid cols-2">
          ${options
            .map(
              (s) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-level-up-book-spell="${s.id}" ${sc.spellIds.includes(s.id) ? "checked" : ""}
                ${!sc.spellIds.includes(s.id) && sc.spellIds.length >= SPELLBOOK_GROWTH_PER_LEVEL ? "disabled" : ""} />
              ${spellHoverNameHtml(s)}
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }
  function spellbookChoiceIncomplete() {
    const sc = levelUpState.spellbookChoice;
    return !!(sc && sc.spellIds.length < SPELLBOOK_GROWTH_PER_LEVEL);
  }
  // "Known spells" casters (Бард/Следопыт today -- spellcasting.type ===
  // "known", i.e. a fixed number of spells is chosen once and stays known
  // until swapped out, unlike Волшебник's ever-growing book or Жрец's
  // free daily prepare) learn a specific number of NEW spells at specific
  // levels, per the class's own "Известные заклинания" table column -- these
  // tables encode exactly that column so the level-up modal can offer the
  // right number of picks (often 1, sometimes 2) instead of a fixed 2 like
  // the spellbook mechanic above. Values are the TOTAL known count effective
  // AT that level (every level 1-20 is listed so no threshold lookup is
  // needed); the picker's count is just the difference from the level below.
  const KNOWN_SPELLS_BY_LEVEL = {
    bard: { 1: 4, 2: 5, 3: 6, 4: 7, 5: 8, 6: 9, 7: 10, 8: 11, 9: 12, 10: 14, 11: 15, 12: 15, 13: 16, 14: 18, 15: 19, 16: 19, 17: 20, 18: 22, 19: 22, 20: 22 },
    sorcerer: { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11, 11: 12, 12: 12, 13: 13, 14: 13, 15: 14, 16: 14, 17: 15, 18: 15, 19: 15, 20: 15 },
    warlock: { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 10, 11: 11, 12: 11, 13: 12, 14: 12, 15: 13, 16: 13, 17: 14, 18: 14, 19: 15, 20: 15 },
    ranger: { 1: 0, 2: 2, 3: 3, 4: 3, 5: 4, 6: 4, 7: 5, 8: 5, 9: 6, 10: 6, 11: 7, 12: 7, 13: 8, 14: 8, 15: 9, 16: 9, 17: 10, 18: 10, 19: 11, 20: 11 },
  };
  // Same idea, but for CANTRIPS known -- only Бард grows this count post-1st
  // level today (Following's cantrips are fixed, Колдун/Чародей don't have
  // their own level-up support yet either).
  const KNOWN_CANTRIPS_BY_LEVEL = {
    bard: { 1: 2, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 4, 11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4, 20: 4 },
    cleric: { 1: 3, 2: 3, 3: 3, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 5, 11: 5, 12: 5, 13: 5, 14: 5, 15: 5, 16: 5, 17: 5, 18: 5, 19: 5, 20: 5 },
    druid: { 1: 2, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 4, 11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4, 20: 4 },
    wizard: { 1: 3, 2: 3, 3: 3, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 5, 11: 5, 12: 5, 13: 5, 14: 5, 15: 5, 16: 5, 17: 5, 18: 5, 19: 5, 20: 5 },
    sorcerer: { 1: 4, 2: 4, 3: 4, 4: 5, 5: 5, 6: 5, 7: 5, 8: 5, 9: 5, 10: 6, 11: 6, 12: 6, 13: 6, 14: 6, 15: 6, 16: 6, 17: 6, 18: 6, 19: 6, 20: 6 },
    warlock: { 1: 2, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 4, 11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4, 20: 4 },
    artificer: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 3, 13: 3, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4, 20: 4 },
  };
  // Следопыт is a half-caster with its own (slower) max-circle progression --
  // distinct from maxSpellCircleForLevel()'s full-caster formula used above
  // for Волшебник/Бард.
  const RANGER_MAX_CIRCLE_BY_LEVEL = { 1: 0, 2: 1, 3: 1, 4: 1, 5: 2, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3, 12: 3, 13: 4, 14: 4, 15: 4, 16: 4, 17: 5, 18: 5, 19: 5, 20: 5 };
  function maxKnownSpellCircleForLevel(list, level) {
    if (list === "ranger") return RANGER_MAX_CIRCLE_BY_LEVEL[level] || 0;
    if (list === "warlock") return (pactSlotsAt(level) || { circle: 1 }).circle;
    return maxSpellCircleForLevel(level);
  }
  // «Треть-заклинатели»: Воин — Мистический рыцарь и Плут — Мистический ловкач. Заклинания из списка волшебника,
  // свои таблицы известных заклинаний/заговоров/ячеек (PHB). Выбор на 3 уровне — отдельная панель выбора архетипа.
  const THIRD_KNOWN_SPELLS = { 3: 3, 4: 4, 5: 4, 6: 4, 7: 5, 8: 6, 9: 6, 10: 7, 11: 8, 12: 8, 13: 9, 14: 10, 15: 10, 16: 11, 17: 11, 18: 11, 19: 12, 20: 13 };
  const THIRD_MAX_CIRCLE = (lvl) => (lvl >= 19 ? 4 : lvl >= 13 ? 3 : lvl >= 7 ? 2 : lvl >= 3 ? 1 : 0);
  const THIRD_SLOTS = { 3: [2], 4: [3], 5: [3], 6: [3], 7: [4, 2], 8: [4, 2], 9: [4, 2], 10: [4, 3], 11: [4, 3], 12: [4, 3], 13: [4, 3, 2], 14: [4, 3, 2], 15: [4, 3, 2], 16: [4, 3, 3], 17: [4, 3, 3], 18: [4, 3, 3], 19: [4, 3, 3, 1], 20: [4, 3, 3, 1] };
  function thirdCasterOf(c) {
    if (!c || !c.subclass) return null;
    const sub = String(c.subclass).toLowerCase();
    if (c.id === "fighter" && sub.includes("мистический рыцарь")) return { list: "wizard" };
    if (c.id === "rogue" && sub.includes("мистический ловкач")) return { list: "wizard" };
    return null;
  }
  // Расширенный список заклинаний подкласса (Божественная душа — список жреца и т.п.) для выбора при повышении уровня.
  function subExpandedSpellIds(c) {
    const cls = c && getClass(c.id);
    const sub = cls && c.subclass && (cls.subclasses || []).find((x) => x.name.toLowerCase() === String(c.subclass).toLowerCase());
    return new Set((sub && sub.expandedSpells) || []);
  }
  function spellListFor(cls, c) {
    const t = thirdCasterOf(c);
    return t ? t.list : cls.spellcasting && cls.spellcasting.list;
  }
  function knownSpellGrowthCount(cls, newLevel, c) {
    if (thirdCasterOf(c)) return newLevel >= 4 ? Math.max(0, (THIRD_KNOWN_SPELLS[newLevel] || 0) - (THIRD_KNOWN_SPELLS[newLevel - 1] || 0)) : 0;
    const table = cls && cls.spellcasting && KNOWN_SPELLS_BY_LEVEL[cls.spellcasting.list];
    if (!table) return 0;
    return Math.max(0, (table[newLevel] || 0) - (table[newLevel - 1] || 0));
  }
  function knownCantripGrowthCount(cls, newLevel, c) {
    if (thirdCasterOf(c)) return newLevel === 10 ? 1 : 0;
    const table = cls && cls.spellcasting && KNOWN_CANTRIPS_BY_LEVEL[cls.spellcasting.list];
    if (!table) return 0;
    return Math.max(0, (table[newLevel] || 0) - (table[newLevel - 1] || 0));
  }
  function currentLevelUpEntry() { return levelUpEligibleClasses()[levelUpState.classIndex]; }
  function freshKnownSpellChoiceState() {
    return { spellIds: [] };
  }
  function freshKnownCantripChoiceState() {
    return { cantripIds: [] };
  }
  function knownSpellChoicePanelHtml(cls, newLevel, c) {
    const sc = levelUpState.knownSpellChoice;
    const need = knownSpellGrowthCount(cls, newLevel, c);
    const spellList = spellListFor(cls, c);
    const maxCircle = thirdCasterOf(c) ? THIRD_MAX_CIRCLE(newLevel) : maxKnownSpellCircleForLevel(spellList, newLevel);
    const alreadyKnown = new Set([
      ...((data.spellcasting && data.spellcasting.cantrips) || []),
      ...((data.spellcasting && data.spellcasting.known) || []),
      ...((data.spellcasting && data.spellcasting.prepared) || []),
      ...((levelUpState.magicSecrets && levelUpState.magicSecrets.picked) || []),
      ...(levelUpState.spellSwap && levelUpState.spellSwap.in ? [levelUpState.spellSwap.in] : []),
    ]);
    const options = SPELLS.filter(
      (s) => s.level >= 1 && s.level <= maxCircle && (s.classes.includes(spellList) || (optionalExtraSpellIds(c && c.id).has(s.id) || subExpandedSpellIds(c).has(s.id))) && !alreadyKnown.has(s.id)
    ).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru"));
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Новые известные заклинания (${sc.spellIds.length}/${need})</h4>
        <p class="muted" style="font-size:0.82rem;">На этом уровне становится известно ${need} нов${need === 1 ? "ое заклинание" : "ых заклинания"} ${maxCircle}-го круга или ниже.</p>
        <div class="grid cols-2">
          ${options
            .map(
              (s) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-level-up-known-spell="${s.id}" ${sc.spellIds.includes(s.id) ? "checked" : ""}
                ${!sc.spellIds.includes(s.id) && sc.spellIds.length >= need ? "disabled" : ""} />
              ${spellHoverNameHtml(s)}
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }
  function knownSpellChoiceIncomplete(cls, newLevel, c) {
    const sc = levelUpState.knownSpellChoice;
    return !!(sc && sc.spellIds.length < knownSpellGrowthCount(cls, newLevel, c));
  }
  function knownCantripChoicePanelHtml(cls, newLevel, c) {
    const sc = levelUpState.knownCantripChoice;
    const need = knownCantripGrowthCount(cls, newLevel, c);
    const alreadyKnown = new Set([...((data.spellcasting && data.spellcasting.cantrips) || []), ...((levelUpState.magicSecrets && levelUpState.magicSecrets.picked) || [])]);
    const options = SPELLS.filter((s) => s.level === 0 && (s.classes.includes(spellListFor(cls, c)) || (optionalExtraSpellIds(c && c.id).has(s.id) || subExpandedSpellIds(c).has(s.id))) && !alreadyKnown.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Новые заговоры (${sc.cantripIds.length}/${need})</h4>
        <div class="grid cols-2">
          ${options
            .map(
              (s) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-level-up-known-cantrip="${s.id}" ${sc.cantripIds.includes(s.id) ? "checked" : ""}
                ${!sc.cantripIds.includes(s.id) && sc.cantripIds.length >= need ? "disabled" : ""} />
              ${spellHoverNameHtml(s)}
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }
  function knownCantripChoiceIncomplete(cls, newLevel, c) {
    const sc = levelUpState.knownCantripChoice;
    return !!(sc && sc.cantripIds.length < knownCantripGrowthCount(cls, newLevel, c));
  }
  // Standard 5e spell-slot-by-caster-level table (PHB "Multiclass
  // Spellcaster" table -- identical in shape to each individual full
  // caster's own table, since that table IS this one restricted to a
  // single class). Index 0 unused; each entry is slots per circle 1..9 (a
  // missing trailing index means 0 slots of that circle yet).
  const SPELL_SLOTS_BY_CASTER_LEVEL = {
    1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1],
    8: [4, 3, 3, 2], 9: [4, 3, 3, 3, 1], 10: [4, 3, 3, 3, 2], 11: [4, 3, 3, 3, 2, 1],
    12: [4, 3, 3, 3, 2, 1], 13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1],
    15: [4, 3, 3, 3, 2, 1, 1, 1], 16: [4, 3, 3, 3, 2, 1, 1, 1], 17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
    18: [4, 3, 3, 3, 3, 1, 1, 1, 1], 19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
  };
  // Combined caster level across every class the character has, using the
  // standard multiclassing rule: a full caster (Волшебник/Жрец/Друид/Бард/
  // Чародей) counts its whole level, a half caster (Паладин/Следопыт --
  // spellcasting.startsAtLevel is how this data set already marks that
  // shape) counts half its level rounded down, and a pact-magic caster
  // (Колдун) is excluded entirely since Pact Magic has its own separate,
  // differently-shaped slot table this doesn't model. Warlock aside, this
  // app doesn't track third-casters (Eldritch Knight/Arcane Trickster spell
  // slots are folded into the base Воин/Плут class object, not a separate
  // entry), so those don't need their own branch here.
  // Изобретатель — полузаклинатель с округлением ВВЕРХ (ячейки с 1-го уровня), паладин/следопыт — вниз.
  function casterLevelShare(cls, lvl) {
    if (cls.id === "artificer") return Math.ceil(lvl / 2);
    return cls.spellcasting.startsAtLevel === 2 ? Math.floor(lvl / 2) : lvl;
  }
  function multiclassCasterLevel(data) {
    let level = 0;
    (data.classes || []).forEach((c) => {
      const cls = getClass(c.id);
      const lvl = c.level || 1;
      if (thirdCasterOf(c)) { level += Math.floor(lvl / 3); return; }
      if (!cls || !cls.spellcasting || cls.spellcasting.pact) return;
      level += casterLevelShare(cls, lvl);
    });
    return level;
  }
  // Таблица ячеек (по кругам 1..9) для набора классов: один треть-заклинатель — своя таблица, иначе общая таблица мультикласса.
  function spellSlotsTableFor(classes) {
    const entries = classes || [];
    const thirds = entries.filter((c) => thirdCasterOf(c));
    const others = entries.filter((c) => { const k = getClass(c.id); return !thirdCasterOf(c) && k && k.spellcasting && !k.spellcasting.pact; });
    if (thirds.length === 1 && !others.length) return THIRD_SLOTS[Math.min(20, thirds[0].level || 1)] || [];
    let level = 0;
    entries.forEach((c) => {
      const lvl = c.level || 1;
      if (thirdCasterOf(c)) { level += Math.floor(lvl / 3); return; }
      const k = getClass(c.id);
      if (!k || !k.spellcasting || k.spellcasting.pact) return;
      level += casterLevelShare(k, lvl);
    });
    return SPELL_SLOTS_BY_CASTER_LEVEL[Math.min(20, Math.max(0, level))] || [];
  }
  // Ячейки магии договора колдуна: [число ячеек, круг] по уровню колдуна.
  function pactSlotsAt(level) {
    if (level < 1) return null;
    const count = level >= 17 ? 4 : level >= 11 ? 3 : level >= 2 ? 2 : 1;
    const circle = level >= 9 ? 5 : level >= 7 ? 4 : level >= 5 ? 3 : level >= 3 ? 2 : 1;
    return { count, circle };
  }
  // Уведомление в окне повышения уровня: открывается новый круг ячеек / меняется число ячеек.
  function levelUpSlotNoticeHtml(cls, c, newLevel) {
    const picked = levelUpState.subclassChoice && levelUpState.subclassChoice.name;
    const sim = (lvl) => (data.classes || []).map((x) => (x === c ? { ...x, level: lvl, subclass: x.subclass || picked || "" } : x));
    const lines = [];
    const before = spellSlotsTableFor(sim(newLevel - 1));
    const after = spellSlotsTableFor(sim(newLevel));
    for (let i = 0; i < 9; i++) {
      const b = before[i] || 0, a = after[i] || 0;
      if (a > 0 && b === 0) lines.push(`✨ <strong>Открывается ${i + 1}-й круг заклинаний:</strong> ${a} ${a === 1 ? "ячейка" : a < 5 ? "ячейки" : "ячеек"}.`);
      else if (a !== b) lines.push(`${i + 1}-й круг: ${b} → ${a} ${a < 5 && a > 1 ? "ячейки" : a === 1 ? "ячейка" : "ячеек"}.`);
    }
    if (cls.spellcasting && cls.spellcasting.pact) {
      const pb = pactSlotsAt(newLevel - 1), pa = pactSlotsAt(newLevel);
      if (pa && (!pb || pb.circle !== pa.circle)) lines.push(`✨ <strong>Ячейки магии договора теперь ${pa.circle}-го круга:</strong> ${pa.count} шт. (все накладываются ячейкой этого круга).`);
      else if (pa && pb && pa.count !== pb.count) lines.push(`Ячейки магии договора: ${pb.count} → ${pa.count} (${pa.circle}-го круга).`);
    }
    if (!lines.length) return "";
    return `<div class="panel" style="margin:10px 0;border-color:var(--gold-dim);"><h4 style="margin-top:0;">Ячейки заклинаний</h4>${lines.map((l) => `<p style="margin:2px 0;">${l}</p>`).join("")}</div>`;
  }
  // Подготавливающие заклинатели без книги (Друид/Жрец/Изобретатель): сколько заклинаний можно подготовить.
  function levelUpPrepNoticeHtml(cls, c, newLevel) {
    if (!cls || !cls.spellcasting || !cls.spellcasting.preparedFormula) return "";
    const mod = getAbilityMod(data, (data.spellcasting && data.spellcasting.ability) || cls.spellcasting.ability);
    const calc = (lvl) => Math.max(1, mod + (cls.spellcasting.preparedFormula === "mod+halflevel" ? Math.floor(lvl / 2) : lvl));
    const before = calc(c.level || 1), after = calc(newLevel);
    const maxCircle = Math.min(9, Math.ceil(newLevel / 2));
    return `<div class="panel" style="margin:10px 0;"><h4 style="margin-top:0;">Подготовленные заклинания</h4>
      <p style="margin:2px 0;">Можно подготовить: ${before} → <strong class="num">${after}</strong> (модификатор ${formatModifier(mod)} + уровень ${cls.name.toLowerCase()}).</p>
      <p class="muted" style="margin:2px 0;font-size:0.82rem;">Заклинания выбираются из полного списка класса до ${maxCircle}-го круга — после повышения откройте вкладку «Заклинания» → «Подготовить заклинания».</p></div>`;
  }
  // Recomputes data.spellcasting.slots from the character's current combined
  // caster level, called right after a spellcasting class's level actually
  // changes (see applyLevelUp below).
  function applyLevelUpSpellSlots(cls, c) {
    const isPact = !!(cls.spellcasting && cls.spellcasting.pact);
    if (!(cls.spellcasting && !isPact) && !thirdCasterOf(c) && !isPact) return;
    if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
    if (!data.spellcasting.slots) data.spellcasting.slots = {};
    const table = spellSlotsTableFor(data.classes);
    const pactEntry = (data.classes || []).find((x) => getClass(x.id)?.spellcasting?.pact);
    const pact = pactEntry ? pactSlotsAt(pactEntry.level || 1) : null;
    for (let circle = 1; circle <= 9; circle++) {
      data.spellcasting.slots[circle] = (table[circle - 1] || 0) + (pact && pact.circle === circle ? pact.count : 0) + ((data.spellcasting.createdSlots || {})[circle] || 0);
    }
  }
  // Champion's "Дополнительный боевой стиль" (10th level: pick a SECOND
  // fighting style) is, in the data, just another subclass feature card
  // resolved through the "Умение архетипа" marker like any other -- this
  // turns it into an actual pick in the level-up modal instead of plain
  // descriptive text, the same way levelHasSubclassChoice() above turns the
  // level-3 archetype marker into the subclass picker. Matched by exact
  // feature name (this exact wording only exists on Champion today) rather
  // than a level number, so it keeps working if another subclass later gets
  // its own second-style feature at a different level.
  const SECOND_FIGHTING_STYLE_FEATURE_NAME = "Дополнительный боевой стиль";
  // Подклассы вне воинских классов, дающие боевой стиль из ограниченного списка (Коллегия мечей).
  const SUB_STYLE_FEATURES = { swords: { feature: "Боевой стиль", options: ["Дуэлянт", "Сражение двумя оружиями"] } };
  function subStyleSpec(cls, subName, level) {
    const sub = subName && (cls.subclasses || []).find((s) => s.name.toLowerCase() === String(subName).toLowerCase());
    const spec = sub && SUB_STYLE_FEATURES[sub.slug];
    return spec && (sub.features || []).some((sf) => sf.name === spec.feature && sf.level === level) ? spec : null;
  }
  function levelUpStyleFeatureName(cls, subName, level) {
    const spec = subStyleSpec(cls, subName, level);
    return spec ? spec.feature : SECOND_FIGHTING_STYLE_FEATURE_NAME;
  }
  function levelUpStyleOptions(cls, subName, level) {
    const spec = subStyleSpec(cls, subName, level);
    const all = (getClass("fighter").level1Choice.options || []).filter((o) => !o.only || o.only.includes(cls.id));
    return spec ? all.filter((o) => spec.options.includes(o.name)) : (cls.level1Choice && cls.level1Choice.options) || [];
  }
  function levelHasFightingStyleChoice(c, cls, newLevel) {
    if (!c || !c.subclass) return false;
    if (subStyleSpec(cls, c.subclass, newLevel)) return true;
    if (!cls.level1Choice || cls.level1Choice.type !== "fightingStyle") return false;
    const sub = (cls.subclasses || []).find((s) => s.name.toLowerCase() === c.subclass.toLowerCase());
    if (!sub) return false;
    return (sub.features || []).some((sf) => sf.name === SECOND_FIGHTING_STYLE_FEATURE_NAME && sf.level === newLevel);
  }
  function levelUpActiveSubName(c) {
    return (levelUpState.subclassChoice && levelUpState.subclassChoice.name) || (c && c.subclass) || "";
  }
  function freshFightingStyleChoiceState() {
    return { name: "" };
  }
  function fightingStyleChoicePanelHtml(cls) {
    const sc = levelUpState.fightingStyleChoice;
    const lc = levelUpEligibleClasses()[levelUpState.classIndex];
    const lvl = ((lc && lc.level) || 1) + 1;
    const subName = levelUpActiveSubName(lc);
    const current = cls.level1Choice ? currentFightingStyleName(cls) : "";
    const options = levelUpStyleOptions(cls, subName, lvl).filter((o) => o.name !== current && (!o.only || o.only.includes(cls.id)));
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">${escapeHtml(levelUpStyleFeatureName(cls, subName, lvl))}</h4>
        <div class="grid cols-2">
          ${options
            .map(
              (o) => `
            <label class="card selectable ${sc.name === o.name ? "selected" : ""}" style="cursor:pointer;">
              <input type="radio" name="level-up-fighting-style" data-level-up-fighting-style="${escapeHtml(o.name)}" ${sc.name === o.name ? "checked" : ""} style="margin-right:6px;" />
              <strong>${escapeHtml(o.name)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(o.desc)}</span>
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }
  function fightingStyleChoiceIncomplete() {
    return !!(levelUpState.fightingStyleChoice && !levelUpState.fightingStyleChoice.name);
  }
  // Паладин/Следопыт get a fighting style too, but -- unlike Воин -- only at
  // a level-UP (2nd level), never at creation, and their own class object
  // has no level1Choice for it (that field only ever meant "at level 1").
  // Their features[level] slot just says "Боевой стиль (тот же список, что
  // и у Воина)" in plain text today; this turns THAT into a real first-ever
  // pick, reusing Воин's own option list (exactly what the text promises)
  // since Паладин/Следопыт don't carry a restricted subset of their own in
  // this data set. Distinct from fightingStyleChoice above, which is always
  // a class's OWN second pick (Champion 10th level) gated on cls.level1Choice
  // already existing -- this is the opposite case, a class's first and only
  // pick, gated on cls.level1Choice NOT existing (Воин is excluded since it
  // already resolves its one fighting style at creation).
  const FIRST_FIGHTING_STYLE_FEATURE_NAME = /^Боевой стиль(?![a-zа-яё])/i;
  function levelHasBaseFightingStyleChoice(cls, newLevel) {
    if (!cls || cls.level1Choice) return false;
    const raw = (cls.features && cls.features[newLevel]) || [];
    return raw.some((f) => FIRST_FIGHTING_STYLE_FEATURE_NAME.test(f));
  }
  function freshBaseFightingStyleChoiceState() {
    return { name: "" };
  }
  function baseFightingStyleChoicePanelHtml() {
    const sc = levelUpState.baseFightingStyleChoice;
    const baseCls = levelUpEligibleClasses()[levelUpState.classIndex];
    const options = (getClass("fighter").level1Choice.options || []).filter((o) => !o.only || o.only.includes(baseCls && baseCls.id));
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Боевой стиль</h4>
        <div class="grid cols-2">
          ${options
            .map(
              (o) => `
            <label class="card selectable ${sc.name === o.name ? "selected" : ""}" style="cursor:pointer;">
              <input type="radio" name="level-up-base-fighting-style" data-level-up-base-fighting-style="${escapeHtml(o.name)}" ${sc.name === o.name ? "checked" : ""} style="margin-right:6px;" />
              <strong>${escapeHtml(o.name)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(o.desc)}</span>
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }
  // ---- Компетентность при повышении уровня (Бард 3/10, Плут 6) -----------------------------------------
  function levelExpertiseCount(cls, newLevel) {
    const raw = (cls && cls.features && cls.features[newLevel]) || [];
    return raw.some((f) => /^Компетентность/.test(f)) ? 2 : 0;
  }
  function expertiseOptions() {
    const prof = data.proficiencies.skills || [];
    const already = new Set(data.proficiencies.expertise || []);
    return SKILLS.filter((sk) => prof.includes(sk.id) && !already.has(sk.id));
  }
  function expertisePanelHtml() {
    const ec = levelUpState.expertiseChoice;
    if (!ec) return "";
    const opts = expertiseOptions();
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Компетентность — выберите ${Math.min(ec.count, opts.length)} навыка (${ec.picked.length}/${Math.min(ec.count, opts.length)})</h4>
        <p class="muted" style="margin-top:0;">Бонус мастерства удваивается для проверок выбранных навыков (только навыки, которыми вы владеете).</p>
        <div class="grid cols-3">
          ${opts.map((sk) => `<label class="row" style="gap:6px;"><input type="checkbox" data-level-up-expertise="${sk.id}" ${ec.picked.includes(sk.id) ? "checked" : ""} ${!ec.picked.includes(sk.id) && ec.picked.length >= ec.count ? "disabled" : ""} /> ${escapeHtml(sk.label)}</label>`).join("")}
        </div>
      </div>`;
  }
  function expertiseChoiceIncomplete() {
    const ec = levelUpState.expertiseChoice;
    return !!(ec && ec.picked.length < Math.min(ec.count, expertiseOptions().length));
  }
  // ---- Метамагия чародея (3-й уровень — два варианта, 10-й и 17-й — по одному) ---------------------------------
  function levelMetamagicCount(cls, newLevel) {
    const raw = (cls && cls.features && cls.features[newLevel]) || [];
    if (!cls || cls.id !== "sorcerer" || !raw.some((f) => /^Метамагия/.test(f))) return 0;
    return newLevel === 3 ? 2 : 1;
  }
  function metamagicOptions() {
    const have = new Set((data.features || []).map((f) => f.name));
    return (METAMAGIC_OPTIONS || []).filter((m) => !have.has(`Метамагия: ${m.name}`));
  }
  function metamagicPanelHtml() {
    const mc = levelUpState.metamagicChoice;
    if (!mc) return "";
    const opts = metamagicOptions();
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Метамагия — выберите ${mc.count} (${mc.picked.length}/${mc.count})</h4>
        ${opts.map((m) => `<label class="row" style="gap:8px;align-items:flex-start;margin-top:6px;"><input type="checkbox" data-level-up-metamagic="${escapeHtml(m.name)}" ${mc.picked.includes(m.name) ? "checked" : ""} ${!mc.picked.includes(m.name) && mc.picked.length >= mc.count ? "disabled" : ""} style="margin-top:4px;" /><span><strong>${escapeHtml(m.name)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(m.desc || "")}</span></span></label>`).join("")}
      </div>`;
  }
  function metamagicIncomplete() {
    const mc = levelUpState.metamagicChoice;
    return !!(mc && mc.picked.length < Math.min(mc.count, metamagicOptions().length));
  }
  // ---- Колдун: воззвания, договорный дар, мистический арканум ----------------------------------------------------
  const PACT_BOONS = ["Договор клинка", "Договор цепи", "Договор гримуара", "Договор талисмана"];
  const ARCANUM_CIRCLE_BY_LEVEL = { 11: 6, 13: 7, 15: 8, 17: 9 };
  function warlockRaw(cls, newLevel) { return (cls && cls.id === "warlock" && cls.features && cls.features[newLevel]) || []; }
  function ownedInvocationCards() { return (data.features || []).filter((f) => /^Воззвание: /.test(f.name || "") && f.source === "Колдун"); }
  function freshWarlockStates(cls, newLevel) {
    if (!cls || cls.id !== "warlock") return { pact: null, invocations: null, arcanum: null };
    const raw = warlockRaw(cls, newLevel);
    const count = raw.some((f) => /^Мистические воззвания/.test(f)) ? (newLevel === 2 ? 2 : 1) : 0;
    return {
      pact: raw.some((f) => /^Обряд заключения договора/.test(f)) ? { name: "", cantrips: [] } : null,
      invocations: count || ownedInvocationCards().length ? { count, picked: [], swapOut: "", swapIn: "" } : null,
      arcanum: ARCANUM_CIRCLE_BY_LEVEL[newLevel] || arcanumCards().length ? { circle: ARCANUM_CIRCLE_BY_LEVEL[newLevel] || 0, spellId: "", swapOut: "", swapIn: "" } : null,
    };
  }
  function arcanumCards() { return (data.features || []).filter((f) => f.arcanumSpell && f.source === "Колдун"); }
  function invocationOptions(newLevel) {
    const own = new Set(ownedInvocationCards().map((f) => f.name.replace(/^Воззвание: /, "")));
    const pending = (levelUpState.pact && levelUpState.pact.name) || "";
    const cantrips = new Set([...((data.spellcasting && data.spellcasting.cantrips) || []), ...((levelUpState.knownCantripChoice && levelUpState.knownCantripChoice.cantripIds) || [])]);
    const picked = new Set((levelUpState.invocations && levelUpState.invocations.picked) || []);
    return (ELDRITCH_INVOCATIONS || []).filter((o) => {
      if (own.has(o.name)) return false;
      const r = o.req || "";
      const lv = /(\d+)-й уровень колдуна/.exec(r);
      if (lv && newLevel < Number(lv[1])) return false;
      const pact = /умение «([^»]+)»/.exec(r);
      if (pact && pact[1] !== pending && !(data.features || []).some((f) => (f.name || "").startsWith(pact[1]))) return false;
      if (/мистический заряд/.test(r) && !cantrips.has("eldritch-blast")) return false;
      return true;
    }).map((o) => ({ ...o, _picked: picked.has(o.name) }));
  }
  function invocationsPanelHtml(cls, newLevel) {
    const iv = levelUpState.invocations;
    if (!iv || !cls || cls.id !== "warlock") return "";
    const opts = invocationOptions(newLevel);
    const owned = ownedInvocationCards();
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Мистические воззвания${iv.count ? ` — выберите ${iv.count} (${iv.picked.length}/${iv.count})` : ""}</h4>
        ${opts.map((m) => `<label class="row" style="gap:8px;align-items:flex-start;margin-top:6px;"><input type="checkbox" data-level-up-inv="${escapeHtml(m.name)}" ${m._picked ? "checked" : ""} ${!m._picked && iv.picked.length >= iv.count ? "disabled" : ""} style="margin-top:4px;" /><span><strong>${escapeHtml(m.name)}</strong>${m.req ? ` <span class="muted">(${escapeHtml(m.req)})</span>` : ""}<br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(m.desc || "")}</span></span></label>`).join("")}
        ${owned.length ? `<p class="muted" style="margin:10px 0 4px;font-size:0.82rem;">Можно заменить одно из имеющихся воззваний (необязательно):</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          <select data-level-up-inv-out><option value="">— не заменять —</option>${owned.map((f) => { const n = f.name.replace(/^Воззвание: /, ""); return `<option value="${escapeHtml(n)}" ${iv.swapOut === n ? "selected" : ""}>${escapeHtml(n)}</option>`; }).join("")}</select>
          <span>→</span>
          <select data-level-up-inv-in><option value="">— новое воззвание —</option>${opts.filter((o) => !o._picked).map((o) => `<option value="${escapeHtml(o.name)}" ${iv.swapIn === o.name ? "selected" : ""}>${escapeHtml(o.name)}</option>`).join("")}</select>
        </div>` : ""}
      </div>`;
  }
  function invocationsIncomplete(newLevel) {
    const iv = levelUpState.invocations;
    if (!iv) return false;
    return iv.picked.length < Math.min(iv.count, invocationOptions(newLevel).length) || !!iv.swapOut !== !!iv.swapIn;
  }
  function pactCantripOptions() {
    const have = new Set([...((data.spellcasting && data.spellcasting.cantrips) || []), ...((levelUpState.knownCantripChoice && levelUpState.knownCantripChoice.cantripIds) || [])]);
    return SPELLS.filter((s) => s.level === 0 && !have.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }
  function pactPanelHtml(cls) {
    const pc = levelUpState.pact;
    if (!pc || !cls || cls.id !== "warlock") return "";
    const texts = cls.classFeatureText || {};
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Договорный дар — выберите один</h4>
        <div class="grid cols-2">
          ${PACT_BOONS.map((n) => `<label class="card selectable ${pc.name === n ? "selected" : ""}" style="cursor:pointer;"><input type="radio" name="level-up-pact" data-level-up-pact="${escapeHtml(n)}" ${pc.name === n ? "checked" : ""} style="margin-right:6px;" /><strong>${escapeHtml(n)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(texts[n] || "")}</span></label>`).join("")}
        </div>
        ${pc.name === "Договор гримуара" ? `<h4>Заговоры Книги теней — три любых (${pc.cantrips.length}/3)</h4><div class="grid cols-2">${pactCantripOptions().map((s) => `<label class="row" style="gap:6px;"><input type="checkbox" data-level-up-pact-cantrip="${s.id}" ${pc.cantrips.includes(s.id) ? "checked" : ""} ${!pc.cantrips.includes(s.id) && pc.cantrips.length >= 3 ? "disabled" : ""} /> ${spellHoverNameHtml(s)}</label>`).join("")}</div>` : ""}
      </div>`;
  }
  function pactIncomplete() {
    const pc = levelUpState.pact;
    return !!(pc && (!pc.name || (pc.name === "Договор гримуара" && pc.cantrips.length < 3)));
  }
  function arcanumTakenIds() {
    return new Set([...((data.spellcasting && data.spellcasting.known) || []), ...((data.spellcasting && data.spellcasting.prepared) || [])]);
  }
  function arcanumOptions(circle) {
    const taken = arcanumTakenIds();
    return SPELLS.filter((s) => s.level === circle && (s.classes || []).includes("warlock") && !taken.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }
  function arcanumSwapCircle() {
    const ac = levelUpState.arcanum;
    const f = ac && ac.swapOut && arcanumCards().find((x) => x.arcanumSpell === ac.swapOut);
    return f ? f.arcanumCircle : 0;
  }
  function arcanumPanelHtml(cls) {
    const ac = levelUpState.arcanum;
    if (!ac || !cls || cls.id !== "warlock") return "";
    const cards = arcanumCards();
    const spName = (id) => (SPELLS.find((s) => s.id === id) || {}).name || id;
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Мистический арканум</h4>
        ${ac.circle ? `<p class="muted" style="margin:0 0 6px;font-size:0.82rem;">Выберите заклинание ${ac.circle}-го круга из списка колдуна — его можно наложить один раз за продолжительный отдых без траты ячейки.</p>
        <select data-level-up-arc><option value="">— выберите заклинание —</option>${arcanumOptions(ac.circle).map((s) => `<option value="${s.id}" ${ac.spellId === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}</select>` : ""}
        ${cards.length ? `<p class="muted" style="margin:10px 0 4px;font-size:0.82rem;">Можно заменить одно арканумное заклинание другим того же круга (необязательно):</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          <select data-level-up-arc-out><option value="">— не заменять —</option>${cards.map((f) => `<option value="${f.arcanumSpell}" ${ac.swapOut === f.arcanumSpell ? "selected" : ""}>${escapeHtml(spName(f.arcanumSpell))} (${f.arcanumCircle} кр.)</option>`).join("")}</select>
          <span>→</span>
          <select data-level-up-arc-in><option value="">— новое заклинание —</option>${(ac.swapOut ? arcanumOptions(arcanumSwapCircle()) : []).map((s) => `<option value="${s.id}" ${ac.swapIn === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}</select>
        </div>` : ""}
      </div>`;
  }
  function arcanumIncomplete() {
    const ac = levelUpState.arcanum;
    return !!(ac && ((ac.circle && !ac.spellId) || !!ac.swapOut !== !!ac.swapIn));
  }
  function arcanumCard(id, circle) {
    const sp = SPELLS.find((s) => s.id === id);
    return { name: `Мистический арканум: ${sp ? sp.name : id}`, source: "Колдун", arcanumSpell: id, arcanumCircle: circle, desc: `Вы можете один раз наложить заклинание «${sp ? sp.name : id}» (${circle}-й круг) без траты ячейки. Восстанавливается после продолжительного отдыха.` };
  }
  function addArcanumSpell(id, circle) {
    if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
    const sc = data.spellcasting;
    if (!sc.known) sc.known = [];
    if (!sc.granted) sc.granted = {};
    const card = arcanumCard(id, circle);
    if (!sc.known.includes(id)) sc.known.push(id);
    sc.granted[id] = card.name;
    data.features.push(card);
  }
  function applyWarlockPickers(cls) {
    if (cls.id !== "warlock") return;
    const pc = levelUpState.pact;
    if (pc && pc.name) {
      data.features.push({ name: pc.name, source: "Колдун", desc: (cls.classFeatureText || {})[pc.name] || "" });
      if (pc.name === "Договор гримуара") {
        if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
        if (!data.spellcasting.cantrips) data.spellcasting.cantrips = [];
        if (!data.spellcasting.granted) data.spellcasting.granted = {};
        pc.cantrips.forEach((id) => { if (!data.spellcasting.cantrips.includes(id)) { data.spellcasting.cantrips.push(id); data.spellcasting.granted[id] = "Договор гримуара"; } });
      }
    }
    const iv = levelUpState.invocations;
    if (iv) {
      if (iv.swapOut && iv.swapIn) data.features = data.features.filter((f) => !(f.source === "Колдун" && f.name === `Воззвание: ${iv.swapOut}`));
      [...iv.picked, ...(iv.swapOut && iv.swapIn ? [iv.swapIn] : [])].forEach((n) => {
        const o = (ELDRITCH_INVOCATIONS || []).find((x) => x.name === n);
        if (o && !data.features.some((f) => f.name === `Воззвание: ${n}`)) data.features.push({ name: `Воззвание: ${n}`, source: "Колдун", desc: o.desc || "" });
      });
    }
    const ac = levelUpState.arcanum;
    if (ac) {
      if (ac.swapOut && ac.swapIn) {
        const old = arcanumCards().find((f) => f.arcanumSpell === ac.swapOut);
        const circle = old ? old.arcanumCircle : 0;
        data.features = data.features.filter((f) => f !== old);
        const sc = data.spellcasting;
        if (sc) { sc.known = (sc.known || []).filter((id) => id !== ac.swapOut); if (sc.granted) delete sc.granted[ac.swapOut]; if (sc.prepared) sc.prepared = sc.prepared.filter((id) => id !== ac.swapOut); }
        if (circle) addArcanumSpell(ac.swapIn, circle);
      }
      if (ac.circle && ac.spellId) addArcanumSpell(ac.spellId, ac.circle);
    }
  }
  // ---- Стихийные практики (Монах — Путь четырёх стихий: 3/6/11/17 ур.) -----------------------------------------
  const ELEMENTAL_ATTUNEMENT = "Родство со стихией";
  function disciplineSubName(c) { return levelUpActiveSubName(c); }
  function disciplineActive(cls, newLevel, c) {
    if (!cls || cls.id !== "monk") return false;
    const sub = (cls.subclasses || []).find((x) => x.name.toLowerCase() === String(disciplineSubName(c)).toLowerCase());
    return !!(sub && sub.slug === "four-elements" && [3, 6, 11, 17].includes(newLevel));
  }
  function knownDisciplineNames() {
    return (data.features || []).filter((f) => /^Практика: /.test(f.name || "")).map((f) => f.name.replace(/^Практика: /, ""));
  }
  function disciplineOptions(newLevel) {
    const have = new Set([...knownDisciplineNames(), ELEMENTAL_ATTUNEMENT]);
    return ELEMENTAL_DISCIPLINES.filter((d) => d.level <= newLevel && !have.has(d.name));
  }
  function disciplinesPanelHtml(cls, newLevel, c) {
    const ds = levelUpState.disciplines;
    if (!ds || !disciplineActive(cls, newLevel, c)) return "";
    const opts = disciplineOptions(newLevel);
    const known = knownDisciplineNames();
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Стихийные практики — выберите 1 (${ds.picked.length}/1)</h4>
        ${newLevel === 3 ? `<p class="muted" style="margin-top:0;">«${ELEMENTAL_ATTUNEMENT}» вы знаете всегда — она добавится автоматически.</p>` : ""}
        ${opts.map((d) => `<label class="row" style="gap:8px;align-items:flex-start;margin-top:6px;"><input type="checkbox" data-level-up-discipline="${escapeHtml(d.name)}" ${ds.picked.includes(d.name) ? "checked" : ""} ${!ds.picked.includes(d.name) && ds.picked.length >= 1 ? "disabled" : ""} style="margin-top:4px;" /><span><strong>${escapeHtml(d.name)}</strong>${d.level > 3 ? ` <span class="muted">(${d.level} ур.)</span>` : ""}<br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(d.desc)}</span></span></label>`).join("")}
        ${newLevel > 3 && known.length ? `
        <p style="margin:12px 0 4px;"><strong>Заменить изученную практику</strong> <span class="muted">(необязательно)</span></p>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          <select data-level-up-discipline-out><option value="">— не заменять —</option>${known.map((n) => `<option value="${escapeHtml(n)}" ${ds.swapOut === n ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select>
          <span>→</span>
          <select data-level-up-discipline-in><option value="">— новая практика —</option>${opts.filter((d) => !ds.picked.includes(d.name)).map((d) => `<option value="${escapeHtml(d.name)}" ${ds.swapIn === d.name ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("")}</select>
        </div>` : ""}
      </div>`;
  }
  function disciplinesIncomplete(cls, newLevel, c) {
    const ds = levelUpState.disciplines;
    if (!ds || !disciplineActive(cls, newLevel, c)) return false;
    if (ds.picked.length < Math.min(1, disciplineOptions(newLevel).length)) return true;
    return !!(ds.swapOut && !ds.swapIn) || !!(!ds.swapOut && ds.swapIn);
  }
  // ---- Замена одного известного заклинания (Бард/Чародей/Следопыт/Мистический рыцарь и ловкач) ---------------
  function knownSpellSwapAvailable(cls, c) {
    const list = spellListFor(cls, c);
    return !!(list && (KNOWN_SPELLS_BY_LEVEL[list] || thirdCasterOf(c)) && swappableKnownSpells(cls, c).length);
  }
  function swappableKnownSpells(cls, c) {
    const sc = data.spellcasting || {};
    const list = spellListFor(cls, c);
    const granted = sc.granted || {};
    return (sc.known || []).map((id) => SPELLS.find((x) => x.id === id)).filter((sp) => sp && sp.level >= 1 && !granted[sp.id] && (sp.classes || []).includes(list));
  }
  function spellSwapPanelHtml(cls, newLevel, c) {
    const sw = levelUpState.spellSwap;
    if (!sw || !knownSpellSwapAvailable(cls, c)) return "";
    const list = spellListFor(cls, c);
    const maxCircle = thirdCasterOf(c) ? THIRD_MAX_CIRCLE(newLevel) : maxKnownSpellCircleForLevel(list, newLevel);
    const sc = data.spellcasting || {};
    const taken = new Set([...(sc.cantrips || []), ...(sc.known || []), ...(sc.prepared || []), ...((levelUpState.knownSpellChoice && levelUpState.knownSpellChoice.spellIds) || []), ...((levelUpState.magicSecrets && levelUpState.magicSecrets.picked) || [])]);
    const pool = SPELLS.filter((s) => s.level >= 1 && s.level <= maxCircle && (s.classes || []).includes(list) && !taken.has(s.id)).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru"));
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Заменить известное заклинание <span class="muted" style="font-weight:normal;">(необязательно)</span></h4>
        <p class="muted" style="margin-top:0;font-size:0.82rem;">При повышении уровня можно заменить одно известное заклинание другим из списка класса (круг не выше ${maxCircle}-го).</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          <select data-level-up-swap-out><option value="">— не заменять —</option>${swappableKnownSpells(cls, c).map((sp) => `<option value="${sp.id}" ${sw.out === sp.id ? "selected" : ""}>${escapeHtml(sp.name)} (${sp.level} кр.)</option>`).join("")}</select>
          <span>→</span>
          <select data-level-up-swap-in><option value="">— новое заклинание —</option>${pool.map((sp) => `<option value="${sp.id}" ${sw.in === sp.id ? "selected" : ""}>${escapeHtml(sp.name)} (${sp.level} кр.)</option>`).join("")}</select>
        </div>
      </div>`;
  }
  function spellSwapIncomplete(cls, c) {
    const sw = levelUpState.spellSwap;
    return !!(sw && knownSpellSwapAvailable(cls, c) && (!!sw.out !== !!sw.in));
  }
  // ---- Магические секреты (Бард 10/14/18) и «Дополнительные тайны магии» Коллегии знаний (6) -----------------
  function magicSecretsInfo(cls, newLevel, c) {
    if (!cls || cls.id !== "bard") return { count: 0 };
    const raw = (cls.features && cls.features[newLevel]) || [];
    if (raw.some((f) => /^Магические секреты/.test(f))) return { count: 2, cantrips: false };
    const sub = c && c.subclass && (cls.subclasses || []).find((x) => x.name.toLowerCase() === String(c.subclass).toLowerCase());
    if (sub && (sub.features || []).some((sf) => sf.name === "Дополнительные тайны магии" && sf.level === newLevel)) return { count: 2, cantrips: true };
    return { count: 0 };
  }
  function magicSecretsOptions(newLevel, info) {
    const sp = data.spellcasting || {};
    const known = new Set([...(sp.cantrips || []), ...(sp.known || []), ...(sp.prepared || []), ...((levelUpState.knownSpellChoice && levelUpState.knownSpellChoice.spellIds) || []), ...((levelUpState.knownCantripChoice && levelUpState.knownCantripChoice.cantripIds) || [])]);
    return SPELLS.filter((s) => s.level <= maxSpellCircleForLevel(newLevel) && (s.level >= 1 || info.cantrips) && !known.has(s.id)).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru"));
  }
  function magicSecretsPanelHtml(cls, newLevel, c) {
    const ms = levelUpState.magicSecrets;
    const info = magicSecretsInfo(cls, newLevel, c);
    if (!ms || !info.count) return "";
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">${info.cantrips ? "Дополнительные тайны магии" : "Магические секреты"} — заклинания любого класса (${ms.picked.length}/${info.count})</h4>
        <p class="muted" style="margin-top:0;font-size:0.82rem;">Выберите ${info.count} заклинания из списка любого класса${info.cantrips ? " (можно заговоры)" : ""}, круг не выше ${maxSpellCircleForLevel(newLevel)}-го. Они считаются заклинаниями барда.</p>
        <div class="grid cols-2">
          ${magicSecretsOptions(newLevel, info).map((s) => `<label class="row" style="gap:6px;"><input type="checkbox" data-level-up-magic-secret="${s.id}" ${ms.picked.includes(s.id) ? "checked" : ""} ${!ms.picked.includes(s.id) && ms.picked.length >= info.count ? "disabled" : ""} /> ${spellHoverNameHtml(s)} <span class="muted" style="font-size:0.75rem;">${s.level ? s.level + " кр." : "заговор"}</span></label>`).join("")}
        </div>
      </div>`;
  }
  function magicSecretsIncomplete(cls, newLevel, c) {
    const ms = levelUpState.magicSecrets;
    const info = magicSecretsInfo(cls, newLevel, c);
    return !!(ms && info.count && ms.picked.length < info.count);
  }
  // ---- Универсальность воина: смена боевого стиля на уровне с «Увеличением характеристик» --------------------
  function currentBaseStyleCard(cls) {
    return (data.features || []).find((f) => f.source === cls.name && /^Боевой стиль:/i.test(f.name || ""));
  }
  function canSwapFightingStyle(cls, newLevel) {
    return !!cls && ["fighter", "paladin", "ranger"].includes(cls.id) && levelHasAsiChoice(cls, newLevel) && (data.features || []).some((f) => /^Универсальность воина$/i.test(f.name || "")) && !!currentBaseStyleCard(cls);
  }
  function styleOptionsFor(cls) {
    return (getClass("fighter").level1Choice.options || []).filter((o) => !o.only || o.only.includes(cls.id));
  }
  function styleSwapPanelHtml(cls) {
    const sw = levelUpState.styleSwap;
    if (!sw) return "";
    const cur = currentBaseStyleCard(cls);
    const curName = cur ? cur.name.replace(/^Боевой стиль:\s*/i, "") : "";
    const opts = styleOptionsFor(cls).filter((o) => o.name !== curName);
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Универсальность воина — сменить боевой стиль (необязательно)</h4>
        <p class="muted" style="margin-top:0;">Сейчас: ${escapeHtml(curName || "—")}. Опциональное умение (Tasha's), только с разрешения Мастера.</p>
        <select data-level-up-style-swap>
          <option value="">— оставить текущий —</option>
          ${opts.map((o) => `<option value="${escapeHtml(o.name)}" ${sw.name === o.name ? "selected" : ""}>${escapeHtml(o.name)}</option>`).join("")}
        </select>
        ${sw.name ? `<p class="muted" style="font-size:0.85rem;margin-bottom:0;">${escapeHtml((opts.find((o) => o.name === sw.name) || {}).desc || "")}</p>` : ""}
      </div>`;
  }
  // ---- Заговоры боевых стилей «Друидический воин» / «Благословенный воин» ------------------------------------
  const STYLE_CANTRIP_CLASS = { "Друидический воин": "druid", "Благословенный воин": "cleric" };
  function chosenStyleCantripStyles() {
    const names = [levelUpState.baseFightingStyleChoice && levelUpState.baseFightingStyleChoice.name, levelUpState.fightingStyleChoice && levelUpState.fightingStyleChoice.name, levelUpState.styleSwap && levelUpState.styleSwap.name];
    return [...new Set(names.filter((n) => n && STYLE_CANTRIP_CLASS[n]))];
  }
  function styleCantripsPanelHtml() {
    const styles = chosenStyleCantripStyles();
    if (!styles.length) return "";
    if (!levelUpState.styleCantrips) levelUpState.styleCantrips = {};
    const known = new Set((data.spellcasting && data.spellcasting.cantrips) || []);
    return styles
      .map((st) => {
        const picked = levelUpState.styleCantrips[st] || [];
        const list = SPELLS.filter((sp) => sp.level === 0 && sp.classes.includes(STYLE_CANTRIP_CLASS[st]) && !known.has(sp.id)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
        return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">${escapeHtml(st)} — два заговора ${STYLE_CANTRIP_CLASS[st] === "druid" ? "друида" : "жреца"} (${picked.length}/2)</h4>
        <div class="grid cols-3">
          ${list.map((sp) => `<label class="row" style="gap:6px;"><input type="checkbox" data-level-up-style-cantrip="${sp.id}" data-style="${escapeHtml(st)}" ${picked.includes(sp.id) ? "checked" : ""} ${!picked.includes(sp.id) && picked.length >= 2 ? "disabled" : ""} /> ${escapeHtml(sp.name)}</label>`).join("")}
        </div>
      </div>`;
      })
      .join("");
  }
  function styleCantripsIncomplete() {
    return chosenStyleCantripStyles().some((st) => ((levelUpState.styleCantrips || {})[st] || []).length < 2);
  }
  function baseFightingStyleChoiceIncomplete() {
    return !!(levelUpState.baseFightingStyleChoice && !levelUpState.baseFightingStyleChoice.name);
  }
  // A subclass feature that grants proficiency in ONE tool/kit of the
  // player's choosing, from a specific catalog list -- turns the plain text
  // card into an actual pick in the level-up modal, the same way the second
  // fighting style/subclass choice above do. Keyed by exact feature name
  // (each entry names its own options list) rather than one hardcoded
  // catalog, so this covers both Мастер боевых искусств's "Ученик войны"
  // (a craftsman's tool) and Комбинатор's "Интриган" (a gaming set — its
  // OTHER grants, the fixed disguise/forgery kits and the 2 languages, are
  // handled by the generic proficiency-text parser and subLanguageChoice
  // respectively, since those aren't a catalog-driven choice like this one).
  const TOOL_CHOICE_FEATURE_OPTIONS = {
    "Ученик войны": (TOOL_GROUPS.find((g) => g.label === "Ремесленные инструменты") || {}).items || [],
    "Интриган": GAMING_SETS,
  };
  function levelHasCraftToolChoice(cls, subName, newLevel) {
    if (!subName) return false;
    return subclassFeaturesAtLevel(cls, subName, newLevel).some((f) => Object.prototype.hasOwnProperty.call(TOOL_CHOICE_FEATURE_OPTIONS, f.name));
  }
  function freshToolChoiceState(cls, subName, newLevel) {
    const feature = subName ? subclassFeaturesAtLevel(cls, subName, newLevel).find((f) => Object.prototype.hasOwnProperty.call(TOOL_CHOICE_FEATURE_OPTIONS, f.name)) : null;
    return { name: "", featureName: feature ? feature.name : "" };
  }
  function craftToolChoicePanelHtml() {
    const tc = levelUpState.toolChoice;
    const options = TOOL_CHOICE_FEATURE_OPTIONS[tc.featureName] || [];
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">${escapeHtml(tc.featureName)}: выбор инструмента</h4>
        <select data-level-up-tool-choice>
          <option value="">Выберите инструмент…</option>
          ${options.map((t) => `<option value="${escapeHtml(t)}" ${tc.name === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
        </select>
      </div>`;
  }
  function toolChoiceIncomplete() {
    return !!(levelUpState.toolChoice && !levelUpState.toolChoice.name);
  }
  // The chosen (or, at level 3, still-being-picked) subclass's own features
  // that land at exactly this level -- e.g. Мастер боевых искусств's
  // "Боевое превосходство"+"Ученик войны" at 3, "Познай своего врага" at 7.
  // Текст умения для карточки/окна: у «Резчика рун» список рун вынесен в выбор (каждая руна — своя карточка),
  // так что в самом умении остаётся только вводная часть.
  function subclassFeatureDescText(sub, sf) {
    const paras = sf.desc || [];
    // Путь дикой магии «Всплеск дикости»: таблица выносится в кнопку «Таблица» (и таблицу в окне повышения уровня).
    if (sub && sub.slug === "wild-magic" && sf.name === "Всплеск дикости") return paras.filter((p) => !/^\d+\. /.test(p) && !/^Таблица «Дикая магия»/.test(p)).join("\n\n");
    // Путь буревестника «Аура бури»: окружения (Пустыня/Море/Тундра) выбираются отдельно — каждое своей карточкой.
    if (sub && sub.slug === "storm-herald" && sf.name === "Аура бури") return paras.filter((p) => !/^(Пустыня|Море|Тундра)\. /.test(p)).join("\n\n");
    const spec = SUBCLASS_MULTI_PICKS[sub && sub.slug];
    if (spec && sf.name === spec.optionsFeature && spec.noun === "руна") {
      const opts = parseNamedOptions(paras, spec.noun);
      if (opts.length) {
        const firstIdx = paras.findIndex((p) => p.includes(opts[0].name + "."));
        const intro = paras.slice(0, firstIdx > 0 ? firstIdx : paras.length).filter((p) => !/^Известные руны$/i.test(p) && !/^Сл спасброска/i.test(p));
        return [...intro, spec.note].join("\n\n");
      }
    }
    return paras.join("\n\n");
  }
  function subclassFeaturesAtLevel(cls, subName, level) {
    const sub = (cls.subclasses || []).find((s) => s.name.toLowerCase() === String(subName || "").toLowerCase());
    if (!sub) return [];
    return (sub.features || [])
      .filter((sf) => sf.name && sf.level === level)
      .map((sf) => ({ name: sf.name, desc: subclassFeatureDescText(sub, sf) }));
  }
  // Generic version of chosenLevel1SubclassSkillGrant()/
  // chosenLevel1SubclassLanguageGrant() in wizard.js -- those only ever
  // look at a subclass's LEVEL-1 features, since character creation only
  // ever deals with a level-1 subclass pick. Levelling up can grant the
  // same "владение одним из следующих навыков"/"выучить N языков" wording
  // at any level a subclass has it (Samurai/Cavalier/Rune Knight's
  // "Дополнительные владения"/"Бонусные владения" at level 3, etc.), so
  // this scans whatever level is actually being granted right now instead
  // of hardcoding level 1.
  function subclassSkillChoiceGrant(cls, subName, level) {
    for (const f of subclassFeaturesAtLevel(cls, subName, level)) {
      const listGrant = parseSkillChoiceGrant(f.desc);
      if (listGrant) return { featureName: f.name, ...listGrant };
      const freeGrant = parseFreeSkillChoiceGrant(f.desc);
      if (freeGrant) return { featureName: f.name, ...freeGrant };
    }
    return null;
  }
  function subclassLanguageChoiceGrant(cls, subName, level) {
    for (const f of subclassFeaturesAtLevel(cls, subName, level)) {
      const count = parseLanguageChoiceGrant(f.desc);
      if (count) return { featureName: f.name, count };
    }
    return null;
  }
  // Подклассы, где игрок выбирает несколько вариантов из списка в тексте умения (руны, магические выстрелы):
  // каждый выбранный вариант становится отдельной карточкой умения.
  const SUBCLASS_MULTI_PICKS = {
    "rune-knight": { optionsFeature: "Резчик рун", noun: "руна", title: "Руны", counts: { 3: 2, 7: 1, 10: 1, 15: 1 }, cardPrefix: "", note: "Известные руны: 2 на 3-м уровне, 3 на 7-м, 4 на 10-м, 5 на 15-м." },
    "arcane-archer": { optionsFeature: "Варианты магического выстрела", noun: "стрела", title: "Варианты магического выстрела", counts: { 3: 2, 7: 1, 10: 1, 15: 1, 18: 1 }, cardPrefix: "Магический выстрел: " },
  };
  function parseNamedOptions(paras, noun) {
    const re = new RegExp(`(?:^|[.!?])\\s*([А-ЯЁ][а-яё]+ ${noun})(\\s*\\([^)]*\\))?\\.\\s*([\\s\\S]*)$`);
    const out = [];
    let cur = null;
    (paras || []).forEach((p) => {
      const m = re.exec(p);
      if (m) {
        const lvl = /(\d+)-й уровень/.exec(m[2] || "");
        cur = { name: m[1], minLevel: lvl ? Number(lvl[1]) : 0, paras: [m[3]] };
        out.push(cur);
      } else if (cur && !/^Сл спасброска/i.test(p)) {
        cur.paras.push(p);
      }
    });
    return out.map((o) => ({ name: o.name, minLevel: o.minLevel, text: o.paras.join("\n\n") }));
  }
  // ---- Таблица «Дикая магия» (Путь дикой магии) ---------------------------
  function wildMagicTableHtml(selected = []) {
    return `<table class="sheet-table" style="table-layout:auto;margin:8px 0;"><thead><tr><th style="width:44px;">к8</th><th>Эффект</th></tr></thead><tbody>${WILD_MAGIC_SURGE_TABLE.map((r) => {
      const m = /^([^.]+)\.\s*([\s\S]*)$/.exec(r.text);
      const hit = selected.includes(r.roll);
      return `<tr data-wild-row="${r.roll}" style="${hit ? "background:rgba(212,175,55,0.22);" : ""}"><td style="vertical-align:top;font-weight:700;">${r.roll}</td><td><strong>${escapeHtml(m ? m[1] : "")}.</strong> ${escapeHtml(m ? m[2] : r.text)}</td></tr>`;
    }).join("")}</tbody></table>`;
  }
  // ---- Таблица «Истории духов» (Коллегия духов) ------------------------------
  function bardInspirationSides() {
    const L = ((data.classes || []).find((c) => c.id === "bard") || {}).level || 1;
    return L >= 15 ? 12 : L >= 10 ? 10 : L >= 5 ? 8 : 6;
  }
  function spiritTalesTableHtml(selected = null) {
    return `<table class="sheet-table" style="table-layout:auto;margin:8px 0;"><thead><tr><th style="width:44px;">Кость</th><th>История</th></tr></thead><tbody>${SPIRIT_TALES_TABLE.map((r) => `<tr data-tale-row="${r.roll}" style="${selected === r.roll ? "background:rgba(212,175,55,0.22);" : ""}"><td style="vertical-align:top;font-weight:700;">${r.roll}</td><td><strong>${escapeHtml(r.name)}.</strong> ${escapeHtml(r.text)}</td></tr>`).join("")}</tbody></table>`;
  }
  function openSpiritTalesTable() {
    const sides = bardInspirationSides();
    const modal = openModal(`
      <h3>Таблица «Истории духов»</h3>
      <p class="muted" style="margin:0 0 8px;">Бросьте кость «Бардовского вдохновения» (сейчас к${sides}); история с выпавшим номером остаётся в памяти до использования или отдыха. Сл спасброска = Сл ваших заклинаний.</p>
      <div class="row" style="gap:10px;align-items:center;margin-bottom:6px;">
        <button type="button" class="primary" data-tale-roll>🎲 Бросить к${sides}</button>
        <strong data-tale-result></strong>
      </div>
      <div data-tale-table>${spiritTalesTableHtml()}</div>
      <div class="row" style="justify-content:flex-end;margin-top:10px;"><button type="button" data-action="close-modal">Закрыть</button></div>`, { wide: true });
    on(modal, "click", "[data-action=close-modal]", closeModal);
    on(modal, "click", "[data-tale-roll]", () => {
      const r = rollDice(1, sides)[0];
      modal.querySelector("[data-tale-table]").innerHTML = spiritTalesTableHtml(r);
      const row = SPIRIT_TALES_TABLE.find((x) => x.roll === r);
      modal.querySelector("[data-tale-result]").textContent = `Выпало: ${r}${row ? ` — ${row.name}` : ""}`;
      const hit = modal.querySelector(`[data-tale-row="${r}"]`);
      if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: "nearest" });
      pushRollLog({ label: "Истории духов", detail: `к${sides}: [${r}]${row ? ` — ${row.name}` : ""}`, total: r });
      document.dispatchEvent(new CustomEvent("dnd5e:roll-logged"));
    });
  }
  // Лунное чародейство: фаза луны на сегодня; бесплатное заклинание 1-го круга выбранной фазы раз до окончания отдыха.
  function lunarPhaseControlsHtml() {
    const cur = data.lunarPhase || "";
    const ph = LUNAR_PHASES.find((p) => p.name === cur);
    const spName = ph ? (SPELLS.find((x) => x.id === ph.spell) || {}).name : "";
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">${LUNAR_PHASES.map((p) => `<button type="button" class="small ${p.name === cur ? "primary" : ""}" data-action="set-lunar-phase" data-phase="${p.name}">🌙 ${p.name}</button>`).join("")}${ph ? `<span class="muted" style="font-size:0.85rem;">Бесплатно раз до отдыха: ${escapeHtml(spName)} (1-й круг)</span>` : `<span class="muted" style="font-size:0.85rem;">Выберите фазу после продолжительного отдыха</span>`}</div>`;
  }
  // Теневая магия «Сила могилы»: Сл спасброска Харизмы = 5 + полученный урон.
  let graveDamage = 0;
  function graveControlsHtml() {
    const mod = getAbilityMod(data, "cha");
    return `<label class="muted" style="font-size:0.85rem;">Полученный урон <input type="number" min="0" data-grave-damage value="${graveDamage}" style="width:70px;" /></label><span class="feature-card-dc" data-grave-dc title="Сложность спасброска Харизмы = 5 + полученный урон">Сл ${5 + graveDamage}</span><button class="small feature-card-roll" data-action="roll-grave-save" title="Спасбросок Харизмы">🎲 Спасбросок Хар ${formatModifier(mod)}</button>`;
  }
  // Практики Пути четырёх стихий, накладывающие заклинание: описание заклинания показывается прямо в карточке умения.
  const FEATURE_SPELL_PREVIEW = {
    "Гонг на вершине горы": ["shatter"], "Дыхание зимы": ["cone-of-cold"], "Земляной вал": ["wall-of-stone"],
    "Испепеляющий удар": ["burning-hands"], "Кулак четырёх громов": ["thunderwave"], "Натиск штормовых духов": ["gust-of-wind"],
    "Объятья северного ветра": ["hold-person"], "Осёдланный ветер": ["fly"], "Пламя феникса": ["fireball"],
    "Прочность вечных гор": ["stoneskin"], "Река голодного пламени": ["wall-of-fire"], "Туманная стойка": ["gaseous-form"],
  };
  function featureSpellPreviewHtml(f) {
    const ids = FEATURE_SPELL_PREVIEW[f.name];
    if (!ids || !/стихий/i.test(f.source || "")) return "";
    return ids.map((id) => {
      const sp = SPELLS.find((x) => x.id === id);
      if (!sp) return "";
      const paras = Array.isArray(sp.desc) ? sp.desc : [sp.desc].filter(Boolean);
      return `<details class="feature-spell-preview" style="margin-top:8px;"><summary style="cursor:pointer;font-weight:600;">✨ Заклинание: ${escapeHtml(sp.name)} <span class="muted" style="font-weight:400;">(${sp.level === 0 ? "заговор" : `${sp.level}-й круг`}, ${escapeHtml(sp.school || "")})</span></summary>
        <p class="muted" style="margin:6px 0;font-size:0.85rem;">${escapeHtml(sp.castingTime || "—")} · ${escapeHtml(sp.range || "—")} · ${escapeHtml(sp.components || "—")} · ${escapeHtml(sp.duration || "—")}${sp.concentration ? " (конц.)" : ""}</p>
        ${paras.map((t) => `<p style="margin:4px 0;font-size:0.9rem;">${escapeHtml(t)}</p>`).join("")}</details>`;
    }).join("");
  }
  // Чародей «Гибкое колдовство» (Исток магии): окно обмена очков чародейства на ячейки заклинаний и обратно.
  const FLEX_SLOT_COST = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 7 };
  function sorceryPointsFeature() {
    return (data.features || []).find((x) => /^Исток магии$/i.test(x.name || "") && /Чародей/i.test(x.source || ""));
  }
  function openFlexibleCasting() {
    const f = sorceryPointsFeature();
    if (!f) return;
    const modal = openModal(`<div data-flex-body></div>`, { wide: true });
    const body = modal.querySelector("[data-flex-body]");
    const paint = (msg) => {
      const uses = resolveFeatureUses(f);
      const max = uses ? uses.max : 0;
      const arr = usesArrayFor(f, max);
      const pts = arr.filter(Boolean).length;
      const sc = data.spellcasting || {};
      const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((c) => (Number((sc.slots || {})[c]) || 0) > 0 || FLEX_SLOT_COST[c]).map((c) => {
        const slotMax = Number((sc.slots || {})[c]) || 0;
        const avail = slotMax ? spellSlotsArrayFor(sc, c).filter(Boolean).length : 0;
        const cost = FLEX_SLOT_COST[c];
        return `<tr><td>${c}-й круг</td><td>${avail} / ${slotMax}</td>
          <td>${cost ? `<button type="button" class="small" data-flex-create="${c}" ${pts < cost ? "disabled" : ""}>+ ячейка за ${cost} оч.</button>` : `<span class="muted">—</span>`}</td>
          <td><button type="button" class="small" data-flex-burn="${c}" ${avail < 1 || pts >= max ? "disabled" : ""}>ячейка → +${c} оч.</button></td></tr>`;
      }).join("");
      body.innerHTML = `
        <h3>Гибкое колдовство</h3>
        <p class="muted" style="margin:0 0 8px;">Бонусным действием: потратьте очки чародейства, чтобы создать ячейку (не выше 5-го круга), или потратьте ячейку, чтобы получить очки, равные её кругу. Созданные ячейки исчезают после продолжительного отдыха.</p>
        <p style="margin:0 0 8px;"><strong>Очки чародейства: ${pts} / ${max}</strong></p>
        ${msg ? `<p class="muted" style="margin:0 0 8px;">${escapeHtml(msg)}</p>` : ""}
        <table class="table" style="width:100%;"><thead><tr><th>Круг</th><th>Ячейки (есть / всего)</th><th>Очки → ячейка</th><th>Ячейка → очки</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="row" style="justify-content:flex-end;margin-top:10px;"><button type="button" data-action="close-modal">Закрыть</button></div>`;
    };
    const setPoints = (n) => {
      const uses = resolveFeatureUses(f);
      const max = uses ? uses.max : 0;
      setFeatureUsesState(f, Array.from({ length: max }, (_, i) => i < n));
    };
    const countPoints = () => { const u = resolveFeatureUses(f); return usesArrayFor(f, u ? u.max : 0).filter(Boolean).length; };
    paint();
    on(modal, "click", "[data-action=close-modal]", () => { closeModal(); render(); });
    on(modal, "click", "[data-flex-create]", (e, el) => {
      const c = Number(el.dataset.flexCreate); const cost = FLEX_SLOT_COST[c];
      const pts = countPoints();
      if (!cost || pts < cost) return;
      const sc = data.spellcasting = data.spellcasting || { slots: {} };
      sc.slots = sc.slots || {}; sc.slotsFilled = sc.slotsFilled || {}; sc.createdSlots = sc.createdSlots || {};
      const cur = spellSlotsArrayFor(sc, c);
      sc.slots[c] = (Number(sc.slots[c]) || 0) + 1;
      sc.slotsFilled[c] = [...cur, true];
      sc.createdSlots[c] = (sc.createdSlots[c] || 0) + 1;
      setPoints(pts - cost);
      doSave(); paint(`Создана ячейка ${c}-го круга (−${cost} оч.).`);
    });
    on(modal, "click", "[data-flex-burn]", (e, el) => {
      const c = Number(el.dataset.flexBurn);
      const sc = data.spellcasting || {};
      const arr = spellSlotsArrayFor(sc, c);
      const idx = arr.lastIndexOf(true);
      const uses = resolveFeatureUses(f); const max = uses ? uses.max : 0;
      const pts = countPoints();
      if (idx < 0 || pts >= max) return;
      arr[idx] = false;
      sc.slotsFilled = sc.slotsFilled || {}; sc.slotsFilled[c] = arr;
      const gain = Math.min(c, max - pts);
      setPoints(pts + gain);
      doSave(); paint(`Потрачена ячейка ${c}-го круга: +${gain} оч.`);
    });
  }
  function openWildMagicTable() {
    const controlled = (data.features || []).some((f) => /^Контролируемый всплеск$/i.test(f.name || ""));
    const dc = 8 + proficiencyBonus(data) + getAbilityMod(data, "con");
    const modal = openModal(`
      <h3>Таблица «Дикая магия» (к8)</h3>
      <p class="muted" style="margin:0 0 8px;">Бросается при входе в ярость. Если эффект требует спасброска, Сл = 8 + бонус мастерства + модификатор Телосложения = <strong>${dc}</strong>.${controlled ? " «Контролируемый всплеск»: бросаются два кубика, можно выбрать любой из выпавших эффектов." : ""}</p>
      <div class="row" style="gap:10px;align-items:center;margin-bottom:6px;">
        <button type="button" class="primary" data-wild-roll>🎲 Бросить ${controlled ? "2 × к8" : "к8"}</button>
        <strong data-wild-result></strong>
      </div>
      <div data-wild-table>${wildMagicTableHtml()}</div>
      <div class="row" style="justify-content:flex-end;margin-top:10px;"><button type="button" data-action="close-modal">Закрыть</button></div>`, { wide: true });
    on(modal, "click", "[data-action=close-modal]", closeModal);
    on(modal, "click", "[data-wild-roll]", () => {
      const rolls = rollDice(controlled ? 2 : 1, 8);
      modal.querySelector("[data-wild-table]").innerHTML = wildMagicTableHtml(rolls);
      modal.querySelector("[data-wild-result]").textContent = `Выпало: ${rolls.join(" и ")}`;
      const hit = modal.querySelector(`[data-wild-row="${rolls[0]}"]`);
      if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: "nearest" });
      pushRollLog({ label: "Дикая магия", detail: `к8: [${rolls.join(", ")}]`, total: rolls[0] });
      document.dispatchEvent(new CustomEvent("dnd5e:roll-logged"));
    });
  }
  // ---- Путь буревестника: окружение ауры бури ------------------------------
  const STORM_ENVIRONMENTS = ["Пустыня", "Море", "Тундра"];
  function stormHeraldSub() {
    const cls = getClass("barbarian");
    return cls ? { cls, sub: (cls.subclasses || []).find((x) => x.slug === "storm-herald") } : { cls: null, sub: null };
  }
  function stormEnvText(env) {
    const { sub } = stormHeraldSub();
    const f = sub && (sub.features || []).find((x) => x.name === "Аура бури");
    const par = f && (f.desc || []).find((p) => p.startsWith(env + ". "));
    return par ? par.slice(env.length + 2) : "";
  }
  // Заменяет карточку «Аура бури» на карточку выбранного окружения (Пустыня/Море/Тундра).
  function applyStormEnvironment(env) {
    const { cls, sub } = stormHeraldSub();
    if (!sub || !STORM_ENVIRONMENTS.includes(env)) return;
    const source = subclassFeatureSource(cls, sub.name);
    const card = (data.features || []).find((f) => f.source === source && /^Аура бури(?::|$)/.test(f.name || ""));
    const f = (sub.features || []).find((x) => x.name === "Аура бури");
    if (!card || !f) return;
    card.name = `Аура бури: ${env}`;
    card.desc = [(f.desc || [])[0], `${env}. ${stormEnvText(env)}`].join("\n\n");
    data.stormEnv = env;
  }
  // ---- Заговор/местность от умения подкласса (Раунд 62) -------------------
  // Школа Иллюзии («Улучшенная малая иллюзия»), Круг земли («Дополнительный заговор» и
  // местность для заклинаний круга), Круг спор / Круг звёзд (фиксированный заговор).
  function resolveBonusChoiceState(cls, subName, newLevel) {
    if (!cls || !subName) return null;
    const sub = (cls.subclasses || []).find((x) => x.name.toLowerCase() === String(subName).toLowerCase());
    if (!sub) return null;
    const feats = (sub.features || []).filter((sf) => sf.name && sf.level === newLevel);
    const out = {};
    const bf = feats.find((f) => SUBCLASS_BONUS_CANTRIPS[`${sub.slug}|${f.name}`]);
    if (bf) {
      const spec = SUBCLASS_BONUS_CANTRIPS[`${sub.slug}|${bf.name}`];
      const known = new Set((data.spellcasting && data.spellcasting.cantrips) || []);
      const fixedUnknown = spec.fixed && !known.has(spec.fixed);
      const needPick = !spec.noPick && (!spec.fixed || !fixedUnknown);
      if (fixedUnknown || needPick) out.cantrip = { featureName: bf.name, fixed: fixedUnknown ? spec.fixed : "", list: spec.list, needPick, picked: "" };
    }
    if (sub.terrainSpells && !data.landTerrain && feats.some((f) => f.name === "Заклинания круга")) out.terrain = { picked: "" };
    if (sub.slug === "storm-herald" && newLevel >= 3) {
      const current = data.stormEnv || "";
      out.storm = { current, picked: current, required: !current && newLevel === 3 };
    }
    return out.cantrip || out.terrain || out.storm ? out : null;
  }
  function bonusChoicePanelHtml() {
    const bc = levelUpState.bonusChoice;
    let html = "";
    if (bc.cantrip) {
      const cc = bc.cantrip;
      const known = new Set((data.spellcasting && data.spellcasting.cantrips) || []);
      const fixedSp = cc.fixed ? SPELLS.find((x) => x.id === cc.fixed) : null;
      const options = SPELLS.filter((x) => x.level === 0 && x.classes.includes(cc.list) && !known.has(x.id) && x.id !== cc.fixed).sort((a, b) => a.name.localeCompare(b.name, "ru"));
      html += `<div class="panel" style="margin:10px 0;"><h4 style="margin-top:0;">Заговор от умения «${escapeHtml(cc.featureName)}»</h4>
        ${fixedSp ? `<p style="margin:2px 0;">Вы узнаёте заговор ${spellHoverNameHtml(fixedSp)}. Он не учитывается в общем числе известных заговоров.</p>` : ""}
        ${cc.needPick ? `<p class="muted" style="font-size:0.82rem;margin:4px 0;">Выберите заговор из списка класса — он не учитывается в общем числе известных заговоров.</p>
        <div class="grid cols-2">${options.map((x) => `<label class="row" style="gap:6px;"><input type="radio" name="bonus-cantrip" data-level-up-bonus-cantrip="${x.id}" ${cc.picked === x.id ? "checked" : ""} />${spellHoverNameHtml(x)}</label>`).join("")}</div>` : ""}
      </div>`;
    }
    if (bc.storm) {
      const st = bc.storm;
      html += `<div class="panel" style="margin:10px 0;"><h4 style="margin-top:0;">Аура бури — окружение</h4>
        <p class="muted" style="font-size:0.82rem;margin:2px 0 6px;">Одновременно действует одно окружение, от него зависит эффект ауры. При каждом повышении уровня его можно сменить — карточка ауры заменится на выбранную.${st.current ? ` Сейчас: <strong>${escapeHtml(st.current)}</strong>.` : ""}</p>
        <div class="col" style="gap:6px;">${STORM_ENVIRONMENTS.map((env) => `<label class="card selectable ${st.picked === env ? "selected" : ""}" style="cursor:pointer;">
          <input type="radio" name="level-up-storm" data-level-up-storm="${env}" ${st.picked === env ? "checked" : ""} style="margin-right:6px;" />
          <strong>${env}</strong> <span class="muted">${escapeHtml(stormEnvText(env))}</span>
        </label>`).join("")}</div></div>`;
    }
    if (bc.terrain) {
      const cls = getClass("druid");
      const sub = cls && cls.subclasses.find((x) => x.slug === "land");
      html += `<div class="panel" style="margin:10px 0;"><h4 style="margin-top:0;">Местность Круга земли</h4>
        <p class="muted" style="font-size:0.82rem;margin:2px 0 6px;">Выбранная местность определяет заклинания круга: они всегда подготовлены и не учитываются в лимите.</p>
        <select data-level-up-terrain><option value="">Выберите местность…</option>${DRUID_LAND_TERRAINS.map((t) => `<option value="${escapeHtml(t)}" ${bc.terrain.picked === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select>
        ${bc.terrain.picked && sub ? `<p style="margin:8px 0 0;font-size:0.85rem;">${sub.terrainSpells[bc.terrain.picked].map((t) => `<strong>${t.level}-й ур.:</strong> ${t.spells.map((id) => (SPELLS.find((x) => x.id === id) || {}).name || id).join(", ")}`).join("<br>")}</p>` : ""}
      </div>`;
    }
    return html;
  }
  function bonusChoiceIncomplete() {
    const bc = levelUpState.bonusChoice;
    return !!(bc && ((bc.cantrip && bc.cantrip.needPick && !bc.cantrip.picked) || (bc.terrain && !bc.terrain.picked) || (bc.storm && bc.storm.required && !bc.storm.picked)));
  }
  function applyBonusChoice(cls) {
    const bc = levelUpState.bonusChoice;
    if (!bc) return;
    if (bc.cantrip) {
      if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      if (!Array.isArray(data.spellcasting.cantrips)) data.spellcasting.cantrips = [];
      if (!data.spellcasting.ability && cls.spellcasting) data.spellcasting.ability = cls.spellcasting.ability;
      const id = bc.cantrip.fixed || bc.cantrip.picked;
      if (id && !data.spellcasting.cantrips.includes(id)) data.spellcasting.cantrips.push(id);
    }
    if (bc.storm && bc.storm.picked && bc.storm.picked !== bc.storm.current) applyStormEnvironment(bc.storm.picked);
    if (bc.terrain && bc.terrain.picked) {
      data.landTerrain = bc.terrain.picked;
      applyLandTerrainCard();
    }
  }
  // Карточка «Заклинания круга» Круга земли получает название и список выбранной местности.
  function applyLandTerrainCard() {
    const cls = getClass("druid");
    const sub = cls && cls.subclasses.find((x) => x.slug === "land");
    if (!sub || !data.landTerrain || !sub.terrainSpells[data.landTerrain]) return;
    const source = subclassFeatureSource(cls, sub.name);
    const card = (data.features || []).find((f) => f.source === source && /^Заклинания круга(?::|$)/.test(f.name));
    if (!card) return;
    const spName = (id) => (SPELLS.find((x) => x.id === id) || {}).name || id;
    card.name = `Заклинания круга: ${data.landTerrain}`;
    card.desc = [
      "Заклинания круга всегда подготовлены и не учитываются в лимите подготовленных заклинаний. Если заклинания нет в списке друида, оно становится для вас заклинанием друида.",
      ...sub.terrainSpells[data.landTerrain].map((t) => `${t.level}-й уровень друида: ${t.spells.map(spName).join(", ")}`),
    ].join("\n\n");
  }
  function multiPickOptionsFor(sub) {
    const spec = SUBCLASS_MULTI_PICKS[sub && sub.slug];
    if (!spec) return null;
    const f = (sub.features || []).find((x) => x.name === spec.optionsFeature);
    return f ? { spec, options: parseNamedOptions(f.desc, spec.noun) } : null;
  }
  function multiPickCardName(spec, opt) { return `${spec.cardPrefix}${opt.name}`; }
  function resolveMultiPickState(cls, subName, newLevel) {
    if (!cls || !subName) return null;
    const sub = (cls.subclasses || []).find((x) => x.name.toLowerCase() === String(subName).toLowerCase());
    const info = multiPickOptionsFor(sub);
    if (!info) return null;
    const count = info.spec.counts[newLevel];
    if (!count) return null;
    const source = subclassFeatureSource(cls, sub.name);
    const known = new Set((data.features || []).filter((f) => f.source === source).map((f) => f.name));
    const options = info.options.filter((o) => !known.has(multiPickCardName(info.spec, o)));
    if (!options.length) return null;
    return { slug: sub.slug, subName: sub.name, count: Math.min(count, options.length), ids: [], options, title: info.spec.title, level: newLevel };
  }
  function multiPickPanelHtml() {
    const mp = levelUpState.multiPick;
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">${escapeHtml(mp.title)} (${mp.ids.length}/${mp.count})</h4>
        <p class="muted" style="font-size:0.82rem;margin:2px 0 6px;">Наведите на название, чтобы прочитать описание. Каждый выбранный вариант добавится в лист отдельным умением.</p>
        <div class="grid cols-2">
          ${mp.options
            .map((o) => {
              const locked = o.minLevel && mp.level < o.minLevel;
              const checked = mp.ids.includes(o.name);
              const full = !checked && mp.ids.length >= mp.count;
              return `<label class="row" style="gap:6px;align-items:center;${locked ? "opacity:0.5;" : ""}">
                <input type="checkbox" data-level-up-multi="${escapeHtml(o.name)}" ${checked ? "checked" : ""} ${locked || full ? "disabled" : ""} />
                <span class="subclass-hover-name" tabindex="0">${escapeHtml(o.name)}${o.minLevel ? ` <span class="muted">(${o.minLevel}-й ур.)</span>` : ""}<span class="subclass-hover-card panel">${o.text.split(/\n\n/).map((t) => `<p>${escapeHtml(t)}</p>`).join("")}</span></span>
              </label>`;
            })
            .join("")}
        </div>
      </div>`;
  }
  function multiPickIncomplete() {
    const mp = levelUpState.multiPick;
    return !!(mp && mp.ids.length < mp.count);
  }
  // Умения подклассов с условной выдачей навыка/спасброска — выдача зависит от того, что у персонажа уже есть.
  function specialSubGrantState(featureName) {
    const skills = (data.proficiencies && data.proficiencies.skills) || [];
    const saves = (data.proficiencies && data.proficiencies.savingThrows) || [];
    if (featureName === "Посланник короны") {
      const has = skills.includes("persuasion");
      return { featureName, kind: "skill", count: has ? 1 : 0, optionIds: has ? ["animalHandling", "insight", "intimidation", "performance"] : [], autoSkills: has ? [] : ["persuasion"], expertiseIds: ["persuasion"], picked: [],
        note: has ? "Вы уже владеете Убеждением — выберите другой навык; бонус мастерства удваивается при проверках Убеждения." : "Вы получаете владение навыком Убеждение (бонус мастерства удваивается при проверках Убеждения)." };
    }
    if (featureName === "Элегантный придворный") {
      const has = saves.includes("wis");
      return { featureName, kind: "save", count: has ? 1 : 0, optionIds: has ? ["int", "cha"] : [], autoSaves: has ? [] : ["wis"], picked: [],
        note: has ? "Вы уже владеете спасброском Мудрости — выберите спасбросок Интеллекта или Харизмы. К проверкам Убеждения прибавляется модификатор Мудрости." : "Вы получаете владение спасброском Мудрости. К проверкам Убеждения прибавляется модификатор Мудрости." };
    }
    if (featureName === "Знания мистического лучника") {
      return { featureName, kind: "skill", count: 1, optionIds: ["arcana", "nature"], picked: [], cantripOptions: ["prestidigitation", "druidcraft"], cantripPicked: "" };
    }
    return null;
  }
  const SPECIAL_SUB_GRANT_FEATURES = ["Посланник короны", "Элегантный придворный", "Знания мистического лучника"];
  function resolveSubSkillChoiceState(cls, subName, level) {
    if (!cls || !subName) return null;
    const special = subclassFeaturesAtLevel(cls, subName, level).find((f) => SPECIAL_SUB_GRANT_FEATURES.includes(f.name));
    if (special) return specialSubGrantState(special.name);
    const grant = subclassSkillChoiceGrant(cls, subName, level);
    return grant ? { ...grant, picked: [] } : null;
  }
  function resolveSubLanguageChoiceState(cls, subName, level) {
    if (!cls || !subName) return null;
    const grant = subclassLanguageChoiceGrant(cls, subName, level);
    return grant ? { ...grant, picked: Array(grant.count).fill("") } : null;
  }
  function subSkillChoicePanelHtml() {
    const sc = levelUpState.subSkillChoice;
    const already = new Set(sc.kind === "save" ? data.proficiencies?.savingThrows || [] : data.proficiencies?.skills || []);
    if (sc.kind === "save" || sc.note || sc.cantripOptions) {
      const opts = sc.optionIds || [];
      const labelOf = (id) => (sc.kind === "save" ? (ABILITIES.find((a) => a.id === id) || {}).label : (SKILLS.find((x) => x.id === id) || {}).label) || id;
      const cantrips = (sc.cantripOptions || []).map((id) => SPELLS.find((x) => x.id === id)).filter(Boolean);
      return `
        <div class="panel" style="margin:10px 0;">
          <h4 style="margin-top:0;">${escapeHtml(sc.featureName)}</h4>
          ${sc.note ? `<p class="muted" style="margin:4px 0;">${escapeHtml(sc.note)}</p>` : ""}
          ${opts.length ? `<p style="margin:6px 0 2px;">${sc.kind === "save" ? "Спасбросок" : "Навык"} на выбор:</p><div class="grid cols-2">${opts.map((id) => `<label class="row" style="gap:8px;align-items:center;${already.has(id) ? "opacity:0.5;" : ""}"><input type="radio" name="level-up-sub-skill" data-level-up-sub-skill value="${id}" ${sc.picked.includes(id) ? "checked" : ""} ${already.has(id) ? "disabled" : ""} /><span>${escapeHtml(labelOf(id))}${already.has(id) ? " (уже есть)" : ""}</span></label>`).join("")}</div>` : ""}
          ${cantrips.length ? `<p style="margin:8px 0 2px;">Заговор на выбор:</p><div class="grid cols-2">${cantrips.map((sp) => `<label class="row" style="gap:8px;align-items:center;"><input type="radio" name="level-up-sub-cantrip" data-level-up-sub-cantrip value="${sp.id}" ${sc.cantripPicked === sp.id ? "checked" : ""} />${spellHoverNameHtml(sp)}</label>`).join("")}</div>` : ""}
        </div>`;
    }
    if (sc.optionIds) {
      const options = sc.optionIds.map((id) => SKILLS.find((s) => s.id === id)).filter(Boolean);
      const inputType = sc.count === 1 ? "radio" : "checkbox";
      return `
        <div class="panel" style="margin:10px 0;">
          <h4 style="margin-top:0;">${escapeHtml(sc.featureName)}: выбор навыка${sc.count > 1 ? ` (${sc.count})` : ""}${sc.expertise ? " — с компетентностью" : ""}</h4>
          <div class="grid cols-2">
            ${options
              .map((s) => {
                const disabled = already.has(s.id);
                const checked = sc.picked.includes(s.id);
                return `<label class="row" style="gap:8px;align-items:center;${disabled ? "opacity:0.5;" : ""}">
                  <input type="${inputType}" name="level-up-sub-skill" data-level-up-sub-skill value="${s.id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
                  <span>${escapeHtml(s.label)}${disabled ? " (уже есть)" : ""}</span>
                </label>`;
              })
              .join("")}
          </div>
        </div>`;
    }
    // Free choice (any skill not already known) -- checkboxes (radio for a single pick).
    const pickable = SKILLS.filter((s) => !already.has(s.id));
    const freeType = sc.count === 1 ? "radio" : "checkbox";
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">${escapeHtml(sc.featureName)}: выбор навыка (${sc.picked.filter(Boolean).length}/${sc.count})</h4>
        <div class="grid cols-3">
          ${pickable
            .map((s) => {
              const checked = sc.picked.includes(s.id);
              const blocked = !checked && sc.count > 1 && sc.picked.filter(Boolean).length >= sc.count;
              return `<label class="row" style="gap:6px;align-items:center;${blocked ? "opacity:0.5;" : ""}"><input type="${freeType}" name="level-up-sub-skill" data-level-up-sub-skill value="${s.id}" ${checked ? "checked" : ""} ${blocked ? "disabled" : ""} /> ${escapeHtml(s.label)}</label>`;
            })
            .join("")}
        </div>
      </div>`;
  }
  function subSkillChoiceIncomplete() {
    const sc = levelUpState.subSkillChoice;
    return !!(sc && (sc.picked.filter(Boolean).length < sc.count || (sc.cantripOptions && !sc.cantripPicked)));
  }
  // Same rendering as wizard.js's own languageSelectOptionsHtml (grouped
  // Распространённые/Экзотические optgroups, already-known languages left
  // out) -- kept as a separate copy here for the same reason the choice
  // parsers above are, rather than importing across view modules.
  function languageSelectOptionsHtml(picked, exclude) {
    const excludeSet = new Set(exclude || []);
    return LANGUAGE_GROUPS.map((g) => {
      const items = g.items.filter((l) => !excludeSet.has(l));
      if (!items.length) return "";
      return `<optgroup label="${escapeHtml(g.label)}">${items.map((l) => `<option value="${escapeHtml(l)}" ${picked === l ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</optgroup>`;
    }).join("");
  }
  function subLanguageChoicePanelHtml() {
    const sc = levelUpState.subLanguageChoice;
    const alreadyKnown = data.proficiencies?.languages || [];
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">${escapeHtml(sc.featureName)}: выбор языка${sc.count > 1 ? ` (${sc.count})` : ""}</h4>
        ${Array.from({ length: sc.count })
          .map(
            (_, idx) => `
          <select data-level-up-sub-language data-level-up-sub-language-index="${idx}" style="margin-bottom:6px;">
            <option value="">Выберите язык…</option>
            ${languageSelectOptionsHtml(sc.picked[idx], alreadyKnown)}
          </select>`
          )
          .join("")}
      </div>`;
  }
  function subLanguageChoiceIncomplete() {
    const sc = levelUpState.subLanguageChoice;
    return !!(sc && sc.picked.filter(Boolean).length < sc.count);
  }
  function refreshLevelUpModal() {
    if (levelUpModalEl) levelUpModalEl.innerHTML = levelUpModalBodyHtml();
  }
  function asiChooserHtml() {
    const asi = levelUpState.asi;
    const feat = FEATS.find((f) => f.id === asi.featId) || null;
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Черта или увеличение характеристик</h4>
        <label class="row" style="gap:8px;align-items:center;">
          <input type="radio" name="asi-mode" data-asi-mode="asi" ${asi.mode === "asi" ? "checked" : ""} />
          <span>Увеличить характеристики</span>
        </label>
        ${
          asi.mode === "asi"
            ? `<div style="margin:6px 0 10px 26px;">
          <label class="row" style="gap:8px;align-items:center;">
            <input type="radio" name="asi-split" data-asi-split="single" ${asi.singleAbility ? "checked" : ""} />
            <span>Одна характеристика +2</span>
          </label>
          <label class="row" style="gap:8px;align-items:center;margin-top:2px;">
            <input type="radio" name="asi-split" data-asi-split="double" ${!asi.singleAbility ? "checked" : ""} />
            <span>Две характеристики +1 каждая</span>
          </label>
          <div class="row" style="gap:8px;margin-top:6px;">
            <select data-asi-ability="0">
              ${ABILITIES.map((a) => `<option value="${a.id}" ${asi.abilities[0] === a.id ? "selected" : ""}>${escapeHtml(a.label)} (${data.abilities[a.id] ?? 10} → ${Math.min(20, (Number(data.abilities[a.id]) || 10) + (asi.singleAbility ? 2 : 1))})</option>`).join("")}
            </select>
            ${
              asi.singleAbility
                ? ""
                : `<select data-asi-ability="1">
              <option value="">—</option>
              ${ABILITIES.filter((a) => a.id !== asi.abilities[0]).map((a) => `<option value="${a.id}" ${asi.abilities[1] === a.id ? "selected" : ""}>${escapeHtml(a.label)} (${data.abilities[a.id] ?? 10} → ${Math.min(20, (Number(data.abilities[a.id]) || 10) + 1)})</option>`).join("")}
            </select>`
            }
          </div>
        </div>`
            : ""
        }
        <label class="row" style="gap:8px;align-items:center;margin-top:6px;">
          <input type="radio" name="asi-mode" data-asi-mode="feat" ${asi.mode === "feat" ? "checked" : ""} />
          <span>Взять черту</span>
        </label>
        ${
          asi.mode === "feat"
            ? `<div style="margin:6px 0 0 26px;">
          <select data-asi-feat style="width:auto;min-width:220px;">
            <option value="">Выберите черту…</option>
            ${featSelectOptionsHtml(asi.featId)}
          </select>
          ${
            feat
              ? `<div class="card" style="margin:8px 0 0;border-color:var(--gold-dim);">${featInfoHtml(feat, { takenHtml: featAlreadyTaken(feat, data) ? `<p style="margin:0 0 6px;color:var(--danger, #e57373);font-weight:600;">${FEAT_TAKEN_MESSAGE}</p>` : "" })}
            ${
              feat.abilityIncrease && feat.abilityIncrease.choices.length > 1
                ? `<div class="row" style="align-items:center;margin-top:6px;">
              <label style="margin-right:8px;">Повысить характеристику:</label>
              <select data-asi-feat-ability>
                ${feat.abilityIncrease.choices.map((a) => `<option value="${a}" ${a === asi.featAbility ? "selected" : ""}>${ABILITIES.find((x) => x.id === a)?.label || a}</option>`).join("")}
              </select>
            </div>`
                : ""
            }
            ${
              feat.skillChoice
                ? `<p class="muted" style="margin:8px 0 2px;">Выберите ${feat.skillChoice.count} навыка(ов):</p>
              <div class="grid cols-3">
                ${SKILLS.filter((s) => !(data.proficiencies.skills || []).includes(s.id)).map((s) => `<label style="font-weight:normal;"><input type="checkbox" data-asi-feat-skill value="${s.id}" ${asi.featSkills.includes(s.id) ? "checked" : ""} /> ${escapeHtml(s.label)}</label>`).join("")}
              </div>`
                : ""
            }
            ${featExtrasHtml(feat, asi.sel, data)}</div>`
              : ""
          }
        </div>`
            : ""
        }
      </div>`;
  }
  // Disables "Повысить уровень" until the ASI/feat choice (when this level
  // has one) is actually complete -- otherwise applyLevelUp() would have
  // nothing to apply.
  function asiChoiceIncomplete() {
    if (!levelUpState.asi) return false;
    const asi = levelUpState.asi;
    if (asi.mode === "feat") {
      if (!asi.featId) return true;
      const f = FEATS.find((x) => x.id === asi.featId);
      if (featAlreadyTaken(f, data)) return true;
      if (f && f.skillChoice && asi.featSkills.length < f.skillChoice.count) return true;
      return featExtrasIncomplete(f, asi.sel, data);
    }
    return !asi.abilities[0] || (!asi.singleAbility && !asi.abilities[1]);
  }
  // Мастер боевых искусств picks 3 приёма (maneuvers) the moment the
  // archetype itself is chosen -- MANEUVERS is the full PHB set of 16.
  function maneuverChooserHtml(sc) {
    return `
      <div style="margin-top:10px;">
        <p class="muted">Приёмы (${sc.maneuverIds.length}/3):</p>
        <div class="grid cols-2">
          ${MANEUVERS.map(
            (m) => `
            <label class="row" style="gap:6px;align-items:flex-start;">
              <input type="checkbox" data-level-up-maneuver="${m.id}" ${sc.maneuverIds.includes(m.id) ? "checked" : ""}
                ${!sc.maneuverIds.includes(m.id) && sc.maneuverIds.length >= 3 ? "disabled" : ""} />
              <span><strong>${escapeHtml(m.name)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(m.desc)}</span></span>
            </label>`
          ).join("")}
        </div>
      </div>`;
  }
  // Мистический рыцарь's "Использование заклинаний": 2 wizard cantrips + 3
  // wizard 1st-level spells (RAW: at least 2 of the 3 from Воплощение/
  // Ограждение) -- the spell catalog has no "school" field to filter or
  // enforce that restriction by, so this offers the full wizard 1st-level
  // list with a text reminder instead of a hard filter.
  function eldritchKnightChooserHtml(sc, isTrickster) {
    const cantrips = SPELLS.filter((s) => s.level === 0 && s.classes.includes("wizard") && !(isTrickster && s.id === "mage-hand"));
    const spells1 = SPELLS.filter((s) => s.level === 1 && s.classes.includes("wizard"));
    return `
      <div style="margin-top:10px;">
        <p class="muted">Заговоры волшебника (${sc.cantripIds.length}/2)${isTrickster ? " — «Волшебная рука» вы знаете дополнительно" : ""}:</p>
        <div class="grid cols-2">
          ${cantrips
            .map(
              (s) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-level-up-ek-cantrip="${s.id}" ${sc.cantripIds.includes(s.id) ? "checked" : ""}
                ${!sc.cantripIds.includes(s.id) && sc.cantripIds.length >= 2 ? "disabled" : ""} />
              ${spellHoverNameHtml(s)}
            </label>`
            )
            .join("")}
        </div>
        <p class="muted" style="margin-top:8px;">Заклинания 1-го уровня (${sc.spellIds.length}/3) — ${isTrickster ? "минимум два должны быть школы Очарования или Иллюзии (на 8, 14 и 20 уровнях — любые из списка волшебника)" : "минимум два должны быть школы Воплощения или Ограждения (на 8, 14 и 20 уровнях — любые из списка волшебника)"}:</p>
        <div class="grid cols-2">
          ${spells1
            .map(
              (s) => `
            <label class="row" style="gap:6px;">
              <input type="checkbox" data-level-up-ek-spell="${s.id}" ${sc.spellIds.includes(s.id) ? "checked" : ""}
                ${!sc.spellIds.includes(s.id) && sc.spellIds.length >= 3 ? "disabled" : ""} />
              ${spellHoverNameHtml(s)}
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }
  // The subclass picker shown in place of a bare "Боевой архетип" card --
  // pick a subclass card, see its own this-level feature text right below
  // it, and (for the two archetypes with a level-3 sub-choice of their own)
  // the maneuver/spell chooser under that.
  // Full-description hover card for a subclass/archetype choice -- its
  // intro plus whatever it grants at the earliest level it has any
  // features (so a player can read what picking it actually does before
  // committing, the same way a spell's hover card already works via
  // spellHoverNameHtml). Generic over any class's subclasses, not just the
  // ones this file happened to add a bespoke chooser for.
  function subclassHoverCardHtml(sub) {
    const levels = (sub.features || []).map((f) => f.level).filter((lvl) => typeof lvl === "number");
    const firstLevel = levels.length ? Math.min(...levels) : null;
    const firstFeatures = firstLevel === null ? [] : (sub.features || []).filter((f) => f.level === firstLevel);
    return `<span class="subclass-hover-name" tabindex="0">${escapeHtml(sub.name)}<span class="subclass-hover-card panel">
      ${sub.source ? `<p class="muted" style="margin-top:0;">${escapeHtml(sub.source)}</p>` : ""}
      ${sub.intro ? `<p>${escapeHtml(sub.intro)}</p>` : ""}
      ${firstFeatures
        .map((f) => `<h5>${escapeHtml(f.name)}</h5><p>${escapeHtml((f.desc || [])[0] || "")}</p>`)
        .join("")}
    </span></span>`;
  }
  function subclassChoicePanelHtml(cls) {
    const sc = levelUpState.subclassChoice;
    const picked = (cls.subclasses || []).find((s) => s.name === sc.name);
    let html = `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Подкласс</h4>
        <div class="grid cols-2">
          ${cls.subclasses
            .map(
              (s) => `
            <label class="card selectable ${sc.name === s.name ? "selected" : ""}" style="cursor:pointer;">
              <input type="radio" name="level-up-subclass" data-level-up-subclass="${escapeHtml(s.name)}" ${sc.name === s.name ? "checked" : ""} style="margin-right:6px;" />
              <strong>${subclassHoverCardHtml(s)}</strong>
            </label>`
            )
            .join("")}
        </div>`;
    if (picked) {
      // No feature-text preview here any more -- the picked subclass's
      // level-3 features already show up in the "Умения N уровня" panel
      // above (via levelUpModalBodyHtml's archetypeFeatures, which reads
      // straight off levelUpState.subclassChoice.name the moment a card is
      // picked here), so repeating them in this panel too just duplicated
      // every card.
      if (picked.slug === "battlemaster") html += maneuverChooserHtml(sc);
      else if (picked.slug === "eldritch-knigh" || picked.slug === "arcane-trickster") html += eldritchKnightChooserHtml(sc, picked.slug === "arcane-trickster");
      else if (picked.slug === "totem-warrior") html += totemChooserHtml(sc, picked);
    }
    html += `</div>`;
    return html;
  }
  // «Путь тотемного воина»: the «Тотемный дух» feature lists one paragraph per
  // animal ("Волк. …"); the player picks one when choosing the subclass.
  function totemSpiritOptions(sub) {
    const f = (sub.features || []).find((x) => x.name === "Тотемный дух");
    if (!f) return [];
    return (f.desc || []).slice(1).map((par) => {
      const m = String(par).match(/^([А-Яа-яЁё]+)(?:\s*\([^)]*\))?\.\s*([\s\S]*)$/);
      return m ? { name: m[1], text: m[2] } : null;
    }).filter(Boolean);
  }
  function totemChooserHtml(sc, sub) {
    const opts = totemSpiritOptions(sub);
    return `
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Тотемный дух</h4>
        <div class="col" style="gap:6px;">
          ${opts.map((o) => `<label class="card selectable ${sc.totem === o.name ? "selected" : ""}" style="cursor:pointer;">
            <input type="radio" name="level-up-totem" data-level-up-totem value="${escapeHtml(o.name)}" ${sc.totem === o.name ? "checked" : ""} style="margin-right:6px;" />
            <strong>${escapeHtml(o.name)}</strong> <span class="muted">${escapeHtml(o.text)}</span>
          </label>`).join("")}
        </div>
      </div>`;
  }
  function subclassChoiceIncomplete(cls) {
    const sc = levelUpState.subclassChoice;
    if (!sc) return false;
    if (!sc.name) return true;
    const sub = (cls.subclasses || []).find((s) => s.name === sc.name);
    if (sub && sub.slug === "totem-warrior" && !sc.totem) return true;
    if (sub && sub.slug === "battlemaster" && sc.maneuverIds.length < 3) return true;
    if (sub && (sub.slug === "eldritch-knigh" || sub.slug === "arcane-trickster") && (sc.cantripIds.length < 2 || sc.spellIds.length < 3)) return true;
    return false;
  }
  // ---- Extra level-up picks ---------------------------------------------
  // "Choose one" subclass features (Охотник: Добыча охотника / Оборонительная
  // тактика / Множественная атака / Превосходная защита охотника) and the
  // Следопыт's recurring enemy/terrain choices (levels 6, 10, 14).
  const OPTION_PICK_FEATURES = ["Добыча охотника", "Оборонительная тактика", "Множественная атака", "Превосходная защита охотника"];
  const RANGER_ENEMY_TYPES = ["Аберрации", "Великаны", "Драконы", "Звери", "Исчадия", "Конструкты", "Монстры", "Небожители", "Нежить", "Растения", "Слизи", "Феи", "Элементали"];
  const RANGER_TERRAIN_TYPES = ["Арктика", "Горы", "Леса", "Побережье", "Пустоши", "Пустыня", "Равнины", "Подземье", "Болота"];
  function featureOptionsOf(sub, featureName) {
    const f = (sub.features || []).find((x) => x.name === featureName);
    if (!f) return [];
    return (f.desc || []).slice(1).map((par) => {
      const m = String(par).match(/^([А-Яа-яЁё][А-Яа-яЁё\s]*?)\.\s*([\s\S]*)$/);
      return m ? { name: m[1].trim(), text: m[2] } : null;
    }).filter(Boolean);
  }
  // Опциональные умения следопыта 1 уровня (Tasha's), выбранные при создании: «Избранный противник» заменяет «Избранного врага»
  // (в том числе его улучшения на 6/14), «Ловкий исследователь» — «Исследователя природы» (и его улучшения на 6/10).
  function rangerHasFavoredFoe() { return (data.features || []).some((f) => /^Избранный противник$/i.test(f.name || "")); }
  function rangerHasDeftExplorer() { return (data.features || []).some((f) => /^Ловкий исследователь$/i.test(f.name || "")); }
  function rangerOptionalSkipped(name) {
    return (rangerHasFavoredFoe() && /^Улучшенный избранный враг/.test(name)) || (rangerHasDeftExplorer() && /^Более опытный следопыт/.test(name));
  }
  function currentLevelUpPicks() {
    const c = levelUpEligibleClasses()[levelUpState.classIndex];
    const cls = c && getClass(c.id);
    if (!cls) return [];
    const newLevel = (c.level || 1) + 1;
    const subName = c.subclass || (levelUpState.subclassChoice && levelUpState.subclassChoice.name) || "";
    const sub = subName ? (cls.subclasses || []).find((x) => x.name.toLowerCase() === subName.toLowerCase()) : null;
    const picks = [];
    if (sub) {
      (sub.features || []).filter((f) => f.level === newLevel && OPTION_PICK_FEATURES.includes(f.name)).forEach((f) => {
        picks.push({ id: `opt:${f.name}`, type: "option", featureName: f.name, options: featureOptionsOf(sub, f.name), sub });
      });
    }
    if (cls.id === "ranger") {
      const names = (cls.features?.[newLevel] || []).map((x) => splitFeatureText(x).name);
      if (!rangerHasFavoredFoe() && names.some((n) => /^Улучшенный избранный враг/.test(n))) picks.push({ id: "enemy", type: "enemy" });
      if (!rangerHasDeftExplorer() && names.some((n) => /^Более опытный следопыт/.test(n))) picks.push({ id: "terrain", type: "terrain" });
    }
    return picks;
  }
  function pickVal(id) {
    if (!levelUpState.pickVals) levelUpState.pickVals = {};
    if (!levelUpState.pickVals[id]) levelUpState.pickVals[id] = { value: "", h1: "", h2: "", lang: "", langCustom: "" };
    return levelUpState.pickVals[id];
  }
  function levelUpPicksIncomplete() {
    return currentLevelUpPicks().some((p) => {
      const v = pickVal(p.id);
      if (!v.value) return true;
      if (p.type === "enemy") {
        if (v.value === "Гуманоиды" && (!v.h1.trim() || !v.h2.trim())) return true;
        if (v.lang === "custom" && !v.langCustom.trim()) return true;
      }
      return false;
    });
  }
  function levelUpPicksPanelHtml() {
    return currentLevelUpPicks().map((p) => {
      const v = pickVal(p.id);
      if (p.type === "option") {
        return `<div class="panel" style="margin:10px 0;"><h4 style="margin-top:0;">${escapeHtml(p.featureName)}: выберите один приём</h4>
          <div class="col" style="gap:6px;">${p.options.map((o) => `<label class="card selectable ${v.value === o.name ? "selected" : ""}" style="cursor:pointer;">
            <input type="radio" name="pick-${escapeHtml(p.id)}" data-pick-opt="${escapeHtml(p.id)}" value="${escapeHtml(o.name)}" ${v.value === o.name ? "checked" : ""} style="margin-right:6px;" />
            <strong>${escapeHtml(o.name)}</strong> <span class="muted">${escapeHtml(o.text)}</span></label>`).join("")}</div></div>`;
      }
      if (p.type === "terrain") {
        return `<div class="panel" style="margin:10px 0;"><h4 style="margin-top:0;">Более опытный следопыт: ещё один тип местности</h4>
          <div class="row" style="gap:6px;flex-wrap:wrap;">${RANGER_TERRAIN_TYPES.filter((t) => !chosenRangerTerrains().includes(t)).map((t) => `<label class="card selectable ${v.value === t ? "selected" : ""}" style="cursor:pointer;padding:6px 10px;">
            <input type="radio" name="pick-terrain" data-pick-opt="terrain" value="${escapeHtml(t)}" ${v.value === t ? "checked" : ""} style="margin-right:6px;" />${escapeHtml(t)}</label>`).join("")}</div></div>`;
      }
      return `<div class="panel" style="margin:10px 0;"><h4 style="margin-top:0;">Улучшенный избранный враг: ещё один вид врага</h4>
        <div class="row" style="gap:6px;flex-wrap:wrap;">${RANGER_ENEMY_TYPES.map((t) => `<label class="card selectable ${v.value === t ? "selected" : ""}" style="cursor:pointer;padding:6px 10px;">
          <input type="radio" name="pick-enemy" data-pick-opt="enemy" value="${escapeHtml(t)}" ${v.value === t ? "checked" : ""} style="margin-right:6px;" />${escapeHtml(t)}</label>`).join("")}</div>
        ${v.value === "Гуманоиды" ? `<div class="row" style="gap:8px;margin-top:8px;"><input type="text" data-pick-field="h1" placeholder="первый вид, напр. гноллы" value="${escapeHtml(v.h1)}" /><input type="text" data-pick-field="h2" placeholder="второй вид, напр. орки" value="${escapeHtml(v.h2)}" /></div>` : ""}
        ${v.value ? `<div class="row" style="gap:8px;margin-top:8px;align-items:center;"><span>Язык:</span><select data-pick-lang><option value="">— без языка —</option>${LANGUAGE_GROUPS.map((g) => `<optgroup label="${escapeHtml(g.label)}">${g.items.map((l) => `<option value="${escapeHtml(l)}" ${v.lang === l ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</optgroup>`).join("")}<option value="custom" ${v.lang === "custom" ? "selected" : ""}>Другой…</option></select>
          ${v.lang === "custom" ? `<input type="text" data-pick-field="langCustom" placeholder="язык" value="${escapeHtml(v.langCustom)}" />` : ""}</div>` : ""}</div>`;
    }).join("");
  }
  function applyLevelUpPicks(cls, newLevel, picks) {
    picks.forEach((p) => {
      const v = pickVal(p.id);
      if (!v.value) return;
      if (p.type === "option") {
        const opt = p.options.find((o) => o.name === v.value);
        const card = (data.features || []).find((f) => f.name === p.featureName && f.source === subclassFeatureSource(cls, p.sub.name));
        if (opt && card) { card.name = `${p.featureName}: ${opt.name}`; card.desc = `${opt.name}. ${opt.text}`; }
      } else if (p.type === "terrain") {
        data.features.push({ name: `Более опытный следопыт: ${v.value}`, source: cls.name, desc: `Вы выбрали ещё один тип избранной местности: ${v.value}. В избранной местности вы получаете все преимущества «Исследователя природы».` });
      } else {
        const label = v.value === "Гуманоиды" ? `Гуманоиды (${v.h1.trim()}, ${v.h2.trim()})` : v.value;
        const lang = v.lang === "custom" ? v.langCustom.trim() : v.lang;
        data.features.push({ name: `Избранный враг (${newLevel} ур.): ${label}`, source: cls.name, desc: `Вы выбрали ещё один вид избранного врага: ${label}. Вы получаете преимущество на проверки Мудрости (Выживание) для выслеживания и Интеллекта для вспоминания информации о них${lang ? `.\n\nЯзык избранного врага: ${lang}.` : "."}` });
        if (lang && !(data.proficiencies.languages || []).includes(lang)) data.proficiencies.languages.push(lang);
      }
    });
  }
  // Типы местности, уже выбранные следопытом («Исследователь природы» и прошлые «Более опытный следопыт»).
  function chosenRangerTerrains() {
    const out = [];
    (data.features || []).forEach((f) => {
      const m = /^(?:Исследователь природы|Более опытный следопыт):\s*(.+)$/.exec(f.name || "");
      if (m) out.push(m[1].trim());
    });
    return out;
  }
  function levelUpModalBodyHtml() {
    const classes = levelUpEligibleClasses();
    const c = classes[levelUpState.classIndex];
    const cls = c && getClass(c.id);
    if (!c || !cls) return `<p class="muted">Нет класса, который можно повысить.</p>`;
    const newLevel = (c.level || 1) + 1;
    const conMod = getAbilityMod(data, "con");
    const avg = levelUpAverageHp(cls);
    const features = levelUpFeaturesFor(cls, newLevel).filter(
      (f) =>
        !ASI_FEATURE_NAME.test(f.name) &&
        !SUBCLASS_CHOICE_FEATURE_NAME.test(f.name) &&
        f.name !== ARCHETYPE_FEATURE_MARKER &&
        !SPELL_CIRCLE_UNLOCK_FEATURE_NAME.test(f.name) &&
        !SPELLCASTING_INTRO_FEATURE_NAME.test(f.name) &&
        !rangerOptionalSkipped(f.name) &&
        !(FIRST_FIGHTING_STYLE_FEATURE_NAME.test(f.name) && !cls.level1Choice)
    );
    // Once a subclass is chosen (already, or right here in subclassChoice),
    // its own features at this exact level replace the "Умение архетипа"
    // placeholder that was just filtered out above.
    const archetypeFeaturesRaw = c.subclass
      ? subclassFeaturesAtLevel(cls, c.subclass, newLevel)
      : levelUpState.subclassChoice && levelUpState.subclassChoice.name
        ? subclassFeaturesAtLevel(cls, levelUpState.subclassChoice.name, newLevel)
        : [];
    // Дополнительный боевой стиль gets its own picker below instead of
    // this plain descriptive card, whenever that picker is on offer.
    const archetypeFeatures = archetypeFeaturesRaw.filter((f) => !(levelUpState.fightingStyleChoice && f.name === levelUpStyleFeatureName(cls, levelUpActiveSubName(c), newLevel)));
    const optPicked = levelUpOptionalList(cls, newLevel).filter((o) => (levelUpState.optionalPicked || []).includes(o.name));
    const allFeaturesBeforeOpt = [...features, ...archetypeFeatures];
    const allFeatures = allFeaturesBeforeOpt.filter((f) => !optPicked.some((o) => optionalReplaces(o, f.name)));
    const missingSubclassForArchetypeLevel = !c.subclass && !levelUpState.subclassChoice && (cls.features?.[newLevel] || []).some((f) => f === ARCHETYPE_FEATURE_MARKER);
    // An explicit `N: []` in cls.features (see e.g. Воин 11/13/17/20) means
    // "this level really has nothing new for this class" -- distinct from a
    // level number simply missing from the object, which means "not modeled
    // yet". Object.prototype.hasOwnProperty is the only way to tell those
    // two apart, since `cls.features[newLevel]` reads as falsy either way
    // once mapped through levelUpFeaturesFor.
    const levelHasNoFeaturesByDesign = Object.prototype.hasOwnProperty.call(cls.features || {}, newLevel);
    const hpGain = Math.max(1, (levelUpState.hpMethod === "roll" ? levelUpState.rolledAmount ?? 0 : avg) + conMod);
    return `
      <h3 style="margin-top:0;">Повышение уровня</h3>
      ${
        classes.length > 1
          ? `<div class="col" style="margin-bottom:10px;">
        <label>Класс</label>
        <select data-level-up-class>
          ${classes.map((cc, i) => `<option value="${i}" ${i === levelUpState.classIndex ? "selected" : ""}>${escapeHtml(getClass(cc.id)?.name || cc.id)} (${cc.level || 1} → ${(cc.level || 1) + 1})</option>`).join("")}
        </select>
      </div>`
          : ""
      }
      <p><strong>${escapeHtml(cls.name)}</strong>: ${c.level || 1} → <strong class="num">${newLevel}</strong> уровень</p>
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Хиты</h4>
        <p class="muted" style="font-size:0.82rem;">Кость хитов: к${cls.hitDie} · модификатор Телосложения: ${formatModifier(conMod)}</p>
        <label class="row" style="gap:8px;align-items:center;">
          <input type="radio" name="hp-method" data-level-up-hp-method="roll" ${levelUpState.hpMethod === "roll" ? "checked" : ""} />
          <span>Бросок к${cls.hitDie}${levelUpState.rolledAmount !== null ? ` (выпало ${levelUpState.rolledAmount})` : ""} ${formatModifier(conMod)}</span>
          <button type="button" class="small" data-action="level-up-roll-hp">🎲 Бросить</button>
        </label>
        <label class="row" style="gap:8px;align-items:center;margin-top:4px;">
          <input type="radio" name="hp-method" data-level-up-hp-method="average" ${levelUpState.hpMethod === "average" ? "checked" : ""} />
          <span>Среднее (${avg}) ${formatModifier(conMod)}</span>
        </label>
        <p style="margin:8px 0 0;">Хиты увеличатся на: <strong class="num">${hpGain}</strong></p>
      </div>
      <div class="panel" style="margin:10px 0;">
        <h4 style="margin-top:0;">Умения ${newLevel} уровня</h4>
        ${
          allFeatures.length
            ? allFeatures.map((f) => levelUpFeatureHtml(f, cls)).join("")
            : levelUpState.asi || levelUpState.subclassChoice
              ? `<p class="muted">На этом уровне только выбор ниже — новых карточек умений нет.</p>`
              : missingSubclassForArchetypeLevel
                ? `<p class="muted">У этого персонажа ещё не выбран архетип (боевой архетип выбирается на 3-м уровне) — повысьте сначала до 3-го уровня, чтобы выбрать его, тогда умения архетипа появятся и здесь.</p>`
                : levelHasNoFeaturesByDesign
                  ? cls.scalingNotes && cls.scalingNotes[newLevel]
                    ? `<p class="muted">Новых умений нет, но растут уже имеющиеся: ${escapeHtml(cls.scalingNotes[newLevel])}</p>`
                    : `<p class="muted">Умений на этом уровне нет.</p>`
                  : `<p class="muted">Умений на этом уровне нет.</p>`
        }
        ${cls.scalingNotes && cls.scalingNotes[newLevel] && (allFeatures.length || levelUpState.asi || levelUpState.subclassChoice) ? `<p class="muted" style="margin-top:8px;">Растут уже имеющиеся: ${escapeHtml(cls.scalingNotes[newLevel])}</p>` : ""}
      </div>
      ${optionalFeaturesPanelHtml(cls, newLevel, allFeaturesBeforeOpt)}
      ${levelUpState.subclassChoice ? subclassChoicePanelHtml(cls) : ""}
      ${levelUpState.fightingStyleChoice ? fightingStyleChoicePanelHtml(cls) : ""}
      ${levelUpState.baseFightingStyleChoice ? baseFightingStyleChoicePanelHtml() : ""}
      ${expertisePanelHtml()}
      ${metamagicPanelHtml()}
      ${pactPanelHtml(cls)}
      ${invocationsPanelHtml(cls, newLevel)}
      ${arcanumPanelHtml(cls)}
      ${disciplinesPanelHtml(cls, newLevel, c)}
      ${spellSwapPanelHtml(cls, newLevel, c)}
      ${magicSecretsPanelHtml(cls, newLevel, c)}
      ${styleSwapPanelHtml(cls)}
      ${styleCantripsPanelHtml()}
      ${levelUpPicksPanelHtml()}
      ${levelUpState.toolChoice ? craftToolChoicePanelHtml() : ""}
      ${levelUpState.subSkillChoice ? subSkillChoicePanelHtml() : ""}
      ${levelUpState.multiPick ? multiPickPanelHtml() : ""}
      ${levelUpState.bonusChoice ? bonusChoicePanelHtml() : ""}
      ${levelUpState.subLanguageChoice ? subLanguageChoicePanelHtml() : ""}
      ${levelUpSlotNoticeHtml(cls, c, newLevel)}
      ${levelUpPrepNoticeHtml(cls, c, newLevel)}
      ${levelUpState.spellbookChoice ? spellbookChoicePanelHtml(cls, newLevel) : ""}
      ${levelUpState.knownCantripChoice ? knownCantripChoicePanelHtml(cls, newLevel, c) : ""}
      ${levelUpState.knownSpellChoice ? knownSpellChoicePanelHtml(cls, newLevel, c) : ""}
      ${levelUpState.asi ? asiChooserHtml() : ""}
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" data-action="close-modal">Отмена</button>
        <button type="button" class="primary" ${
          (levelUpState.hpMethod === "roll" && levelUpState.rolledAmount === null) ||
          asiChoiceIncomplete() ||
          subclassChoiceIncomplete(cls) ||
          levelUpPicksIncomplete() ||
          fightingStyleChoiceIncomplete() ||
          baseFightingStyleChoiceIncomplete() ||
          expertiseChoiceIncomplete() ||
          metamagicIncomplete() ||
          pactIncomplete() ||
          invocationsIncomplete(newLevel) ||
          arcanumIncomplete() ||
          disciplinesIncomplete(cls, newLevel, c) ||
          spellSwapIncomplete(cls, c) ||
          magicSecretsIncomplete(cls, newLevel, c) ||
          styleCantripsIncomplete() ||
          toolChoiceIncomplete() ||
          subSkillChoiceIncomplete() ||
          multiPickIncomplete() ||
          bonusChoiceIncomplete() ||
          subLanguageChoiceIncomplete() ||
          spellbookChoiceIncomplete() ||
          knownSpellChoiceIncomplete(cls, newLevel, c) ||
          knownCantripChoiceIncomplete(cls, newLevel, c)
            ? "disabled"
            : ""
        } data-action="confirm-level-up">Повысить уровень</button>
      </div>`;
  }
  // Одно умение в списке «Умения N уровня»: каждый абзац — с новой строки; для некоторых подклассов
  // варианты вынесены в выбор ниже (тотемы, ауры бури) или в таблицу (дикая магия).
  // Опциональные умения Tasha's: выбираются галочкой (только с разрешения Мастера); если умение что-то заменяет —
  // основное умение этого уровня не добавляется.
  function levelUpOptionalList(cls, newLevel) {
    return optionalFeaturesForLevelUp(cls.id, newLevel, (o) => (data.features || []).some((f) => f.name === o.name));
  }
  function optionalFeaturesPanelHtml(cls, newLevel, baseFeatures) {
    const opts = levelUpOptionalList(cls, newLevel);
    if (!opts.length) return "";
    const picked = levelUpState.optionalPicked || [];
    return `
      <div class="panel" style="margin-top:12px;">
        <button type="button" class="small" data-level-up-opt-toggle style="width:100%;text-align:left;display:flex;justify-content:space-between;">
          <strong>${levelUpState.optOpen ? "▾" : "▸"} Опциональные умения (${opts.length})${picked.length ? ` — выбрано: ${picked.length}` : ""}</strong>
          <span class="muted">${levelUpState.optOpen ? "свернуть" : "развернуть"}</span>
        </button>
        ${levelUpState.optOpen ? `<p class="muted" style="margin:8px 0 0;">${escapeHtml(OPTIONAL_FEATURE_SOURCE)} — используются только с разрешения Мастера.</p>` : ""}
        ${!levelUpState.optOpen ? "" : opts
          .map((o) => {
            const repl = (baseFeatures || []).filter((f) => optionalReplaces(o, f.name)).map((f) => `«${f.name}»`);
            return `
          <label class="row" style="gap:10px;align-items:flex-start;margin-top:8px;">
            <input type="checkbox" data-level-up-optional="${escapeHtml(o.name)}" ${picked.includes(o.name) ? "checked" : ""} style="margin-top:4px;" />
            <div>
              <strong>${escapeHtml(o.name)}</strong>
              <div class="muted" style="font-style:italic;">${o.level}-й уровень, опциональное умение ${escapeHtml(CLASS_GENITIVE[cls.id] || "класса")}</div>
              <p style="white-space:pre-line;margin:4px 0;">${escapeHtml(o.desc)}</p>
              <p class="muted" style="margin:0;">${repl.length ? `Заменяет: ${escapeHtml(repl.join(", "))}.` : "Дополняет умения класса, ничего не заменяя."}</p>
            </div>
          </label>`;
          })
          .join("")}
      </div>`;
  }
  function levelUpFeatureHtml(f, cls) {
    let desc = f.desc || "";
    let extra = "";
    if (f.name === "Тотемный дух" && levelUpState.subclassChoice) desc = desc.split("\n\n")[0];
    if (/^Всплеск дикости$/i.test(f.name)) extra = wildMagicTableHtml();
    if (/^Истории с того света$/i.test(f.name)) extra = spiritTalesTableHtml();
    return `<p style="white-space:pre-line;"><strong>${escapeHtml(f.name)}:</strong> ${escapeHtml(desc)}</p>${extra}`;
  }
  function wireLevelUpModal(modal) {
    wireHoverCardPortal(modal);
    on(modal, "change", "[data-level-up-expertise]", (e, el) => {
      const ec = levelUpState.expertiseChoice;
      if (!ec) return;
      const id = el.dataset.levelUpExpertise;
      const cur = new Set(ec.picked);
      if (el.checked) cur.add(id); else cur.delete(id);
      ec.picked = [...cur].slice(0, ec.count);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-discipline]", (e, el) => {
      const ds = levelUpState.disciplines;
      if (!ds) return;
      const n = el.dataset.levelUpDiscipline;
      ds.picked = el.checked ? [n] : [];
      if (ds.swapIn === n) ds.swapIn = "";
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-discipline-out]", (e, el) => { levelUpState.disciplines.swapOut = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-discipline-in]", (e, el) => { levelUpState.disciplines.swapIn = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-swap-out]", (e, el) => { levelUpState.spellSwap.out = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-swap-in]", (e, el) => { levelUpState.spellSwap.in = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-metamagic]", (e, el) => {
      const mc = levelUpState.metamagicChoice;
      if (!mc) return;
      const n = el.dataset.levelUpMetamagic;
      mc.picked = el.checked ? [...new Set([...mc.picked, n])].slice(0, mc.count) : mc.picked.filter((x) => x !== n);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-pact]", (e, el) => { const pc = levelUpState.pact; if (!pc) return; pc.name = el.dataset.levelUpPact; pc.cantrips = []; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-pact-cantrip]", (e, el) => {
      const pc = levelUpState.pact;
      if (!pc) return;
      const id = el.dataset.levelUpPactCantrip;
      pc.cantrips = el.checked ? [...new Set([...pc.cantrips, id])].slice(0, 3) : pc.cantrips.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-inv]", (e, el) => {
      const iv = levelUpState.invocations;
      if (!iv) return;
      const n = el.dataset.levelUpInv;
      iv.picked = el.checked ? [...new Set([...iv.picked, n])].slice(0, iv.count) : iv.picked.filter((x) => x !== n);
      if (iv.swapIn && iv.picked.includes(iv.swapIn)) iv.swapIn = "";
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-inv-out]", (e, el) => { levelUpState.invocations.swapOut = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-inv-in]", (e, el) => { levelUpState.invocations.swapIn = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-arc]", (e, el) => { levelUpState.arcanum.spellId = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-arc-out]", (e, el) => { levelUpState.arcanum.swapOut = el.value; levelUpState.arcanum.swapIn = ""; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-arc-in]", (e, el) => { levelUpState.arcanum.swapIn = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-magic-secret]", (e, el) => {
      const ms = levelUpState.magicSecrets;
      if (!ms) return;
      const id = el.dataset.levelUpMagicSecret;
      ms.picked = el.checked ? [...new Set([...ms.picked, id])] : ms.picked.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-style-swap]", (e, el) => {
      levelUpState.styleSwap.name = el.value;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-style-cantrip]", (e, el) => {
      if (!levelUpState.styleCantrips) levelUpState.styleCantrips = {};
      const st = el.dataset.style;
      const cur = new Set(levelUpState.styleCantrips[st] || []);
      if (el.checked) cur.add(el.dataset.levelUpStyleCantrip); else cur.delete(el.dataset.levelUpStyleCantrip);
      levelUpState.styleCantrips[st] = [...cur].slice(0, 2);
      refreshLevelUpModal();
    });
    on(modal, "click", "[data-level-up-opt-toggle]", () => {
      levelUpState.optOpen = !levelUpState.optOpen;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-optional]", (e, el) => {
      const n = el.dataset.levelUpOptional;
      const cur = new Set(levelUpState.optionalPicked || []);
      if (el.checked) cur.add(n); else cur.delete(n);
      levelUpState.optionalPicked = [...cur];
      refreshLevelUpModal();
    });
    on(modal, "click", "[data-action=close-modal]", closeModal);
    on(modal, "click", "[data-action=level-up-roll-hp]", () => {
      const c = levelUpEligibleClasses()[levelUpState.classIndex];
      const cls = c && getClass(c.id);
      if (!cls) return;
      levelUpState.rolledAmount = rollDice(1, cls.hitDie)[0];
      levelUpState.hpMethod = "roll";
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-hp-method]", (e, el) => {
      levelUpState.hpMethod = el.dataset.levelUpHpMethod;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-class]", (e, el) => {
      levelUpState.classIndex = Number(el.value);
      levelUpState.pickVals = {};
      levelUpState.hpMethod = "average";
      levelUpState.rolledAmount = null;
      const cc = levelUpEligibleClasses()[levelUpState.classIndex];
      const ccls = cc && getClass(cc.id);
      const newLevel = (cc?.level || 1) + 1;
      levelUpState.asi = ccls && levelHasAsiChoice(ccls, newLevel) ? freshAsiState() : null;
      levelUpState.optionalPicked = [];
      levelUpState.expertiseChoice = ccls && levelExpertiseCount(ccls, newLevel) ? { count: levelExpertiseCount(ccls, newLevel), picked: [] } : null;
      levelUpState.metamagicChoice = ccls && levelMetamagicCount(ccls, newLevel) ? { count: levelMetamagicCount(ccls, newLevel), picked: [] } : null;
      Object.assign(levelUpState, freshWarlockStates(ccls, newLevel));
      levelUpState.styleSwap = ccls && canSwapFightingStyle(ccls, newLevel) ? { name: "" } : null;
      levelUpState.styleCantrips = {};
      levelUpState.subclassChoice = ccls && levelHasSubclassChoice(cc, ccls, newLevel) ? freshSubclassChoiceState() : null;
      levelUpState.fightingStyleChoice = ccls && levelHasFightingStyleChoice(cc, ccls, newLevel) ? freshFightingStyleChoiceState() : null;
      levelUpState.baseFightingStyleChoice = ccls && levelHasBaseFightingStyleChoice(ccls, newLevel) ? freshBaseFightingStyleChoiceState() : null;
      levelUpState.toolChoice = ccls && cc.subclass && levelHasCraftToolChoice(ccls, cc.subclass, newLevel) ? freshToolChoiceState(ccls, cc.subclass, newLevel) : null;
      levelUpState.subSkillChoice = resolveSubSkillChoiceState(ccls, cc && cc.subclass, newLevel);
      levelUpState.multiPick = resolveMultiPickState(ccls, cc && cc.subclass, newLevel);
      levelUpState.bonusChoice = resolveBonusChoiceState(ccls, cc && cc.subclass, newLevel);
      levelUpState.subLanguageChoice = resolveSubLanguageChoiceState(ccls, cc && cc.subclass, newLevel);
      levelUpState.spellbookChoice = ccls && levelHasSpellbookGrowth(ccls, newLevel) ? freshSpellbookChoiceState() : null;
      levelUpState.knownSpellChoice = ccls && knownSpellGrowthCount(ccls, newLevel, cc) > 0 ? freshKnownSpellChoiceState() : null;
      levelUpState.knownCantripChoice = ccls && knownCantripGrowthCount(ccls, newLevel, cc) > 0 ? freshKnownCantripChoiceState() : null;
      levelUpState.magicSecrets = { picked: [] };
      levelUpState.disciplines = { picked: [], swapOut: "", swapIn: "" };
      levelUpState.spellSwap = { out: "", in: "" };
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-subclass]", (e, el) => {
      levelUpState.subclassChoice.name = el.dataset.levelUpSubclass;
      levelUpState.subclassChoice.maneuverIds = [];
      levelUpState.subclassChoice.cantripIds = [];
      levelUpState.subclassChoice.spellIds = [];
      levelUpState.subclassChoice.totem = "";
      const c = levelUpEligibleClasses()[levelUpState.classIndex];
      const cls = c && getClass(c.id);
      const newLevel = (c.level || 1) + 1;
      levelUpState.toolChoice = cls && levelHasCraftToolChoice(cls, levelUpState.subclassChoice.name, newLevel) ? freshToolChoiceState(cls, levelUpState.subclassChoice.name, newLevel) : null;
      levelUpState.subSkillChoice = resolveSubSkillChoiceState(cls, levelUpState.subclassChoice.name, newLevel);
      levelUpState.fightingStyleChoice = subStyleSpec(cls, levelUpState.subclassChoice.name, newLevel) ? freshFightingStyleChoiceState() : null;
      levelUpState.multiPick = resolveMultiPickState(cls, levelUpState.subclassChoice.name, newLevel);
      levelUpState.bonusChoice = resolveBonusChoiceState(cls, levelUpState.subclassChoice.name, newLevel);
      levelUpState.subLanguageChoice = resolveSubLanguageChoiceState(cls, levelUpState.subclassChoice.name, newLevel);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-pick-opt]", (e, el) => {
      const v = pickVal(el.dataset.pickOpt);
      v.value = el.value;
      if (el.dataset.pickOpt !== "enemy") { /* keep */ } else if (el.value !== "Гуманоиды") { v.h1 = ""; v.h2 = ""; }
      refreshLevelUpModal();
    });
    on(modal, "input", "[data-pick-field]", (e, el) => {
      const id = currentLevelUpPicks().find((p) => p.type === "enemy");
      if (id) pickVal("enemy")[el.dataset.pickField] = el.value;
    });
    on(modal, "change", "[data-pick-field]", () => refreshLevelUpModal());
    on(modal, "change", "[data-pick-lang]", (e, el) => { pickVal("enemy").lang = el.value; refreshLevelUpModal(); });
    on(modal, "change", "[data-level-up-totem]", (e, el) => {
      levelUpState.subclassChoice.totem = el.value;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-tool-choice]", (e, el) => {
      levelUpState.toolChoice.name = el.value;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-sub-skill]", (e, el) => {
      const sc = levelUpState.subSkillChoice;
      const v = el.value;
      if (sc.count === 1) {
        sc.picked = v ? [v] : [];
      } else if (el.tagName === "SELECT") {
        const idx = Number(el.dataset.levelUpSubSkillIndex) || 0;
        const arr = Array.from({ length: sc.count }, (_, i) => sc.picked[i] || "");
        arr[idx] = v;
        sc.picked = arr.map((x, i) => (x && arr.indexOf(x) !== i ? "" : x));
      } else if (el.checked) {
        if (!sc.picked.includes(v) && sc.picked.length < sc.count) sc.picked.push(v);
      } else {
        sc.picked = sc.picked.filter((id) => id !== v);
      }
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-multi]", (e, el) => {
      const mp = levelUpState.multiPick;
      const id = el.dataset.levelUpMulti;
      if (el.checked) { if (!mp.ids.includes(id) && mp.ids.length < mp.count) mp.ids.push(id); }
      else mp.ids = mp.ids.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-bonus-cantrip]", (e, el) => {
      levelUpState.bonusChoice.cantrip.picked = el.dataset.levelUpBonusCantrip;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-storm]", (e, el) => {
      levelUpState.bonusChoice.storm.picked = el.dataset.levelUpStorm;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-terrain]", (e, el) => {
      levelUpState.bonusChoice.terrain.picked = el.value;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-sub-cantrip]", (e, el) => {
      levelUpState.subSkillChoice.cantripPicked = el.value;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-sub-language]", (e, el) => {
      const idx = Number(el.dataset.levelUpSubLanguageIndex);
      levelUpState.subLanguageChoice.picked[idx] = el.value;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-fighting-style]", (e, el) => {
      levelUpState.fightingStyleChoice.name = el.dataset.levelUpFightingStyle;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-base-fighting-style]", (e, el) => {
      levelUpState.baseFightingStyleChoice.name = el.dataset.levelUpBaseFightingStyle;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-maneuver]", (e, el) => {
      const id = el.dataset.levelUpManeuver;
      const sc = levelUpState.subclassChoice;
      if (el.checked) { if (!sc.maneuverIds.includes(id)) sc.maneuverIds.push(id); }
      else sc.maneuverIds = sc.maneuverIds.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-ek-cantrip]", (e, el) => {
      const id = el.dataset.levelUpEkCantrip;
      const sc = levelUpState.subclassChoice;
      if (el.checked) { if (!sc.cantripIds.includes(id)) sc.cantripIds.push(id); }
      else sc.cantripIds = sc.cantripIds.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-ek-spell]", (e, el) => {
      const id = el.dataset.levelUpEkSpell;
      const sc = levelUpState.subclassChoice;
      if (el.checked) { if (!sc.spellIds.includes(id)) sc.spellIds.push(id); }
      else sc.spellIds = sc.spellIds.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-book-spell]", (e, el) => {
      const id = el.dataset.levelUpBookSpell;
      const sc = levelUpState.spellbookChoice;
      if (el.checked) { if (!sc.spellIds.includes(id)) sc.spellIds.push(id); }
      else sc.spellIds = sc.spellIds.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-known-spell]", (e, el) => {
      const id = el.dataset.levelUpKnownSpell;
      const sc = levelUpState.knownSpellChoice;
      if (el.checked) { if (!sc.spellIds.includes(id)) sc.spellIds.push(id); }
      else sc.spellIds = sc.spellIds.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-level-up-known-cantrip]", (e, el) => {
      const id = el.dataset.levelUpKnownCantrip;
      const sc = levelUpState.knownCantripChoice;
      if (el.checked) { if (!sc.cantripIds.includes(id)) sc.cantripIds.push(id); }
      else sc.cantripIds = sc.cantripIds.filter((x) => x !== id);
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-asi-mode]", (e, el) => {
      levelUpState.asi.mode = el.dataset.asiMode;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-asi-split]", (e, el) => {
      levelUpState.asi.singleAbility = el.dataset.asiSplit === "single";
      levelUpState.asi.abilities = [levelUpState.asi.abilities[0], ""];
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-asi-ability]", (e, el) => {
      levelUpState.asi.abilities[Number(el.dataset.asiAbility)] = el.value;
      refreshLevelUpModal();
    });
    on(modal, "change", "[data-asi-feat]", (e, el) => {
      levelUpState.asi.featId = el.value;
      const feat = FEATS.find((f) => f.id === el.value);
      levelUpState.asi.featAbility = feat && feat.abilityIncrease ? feat.abilityIncrease.choices[0] : "";
      levelUpState.asi.featSkills = [];
      levelUpState.asi.sel = newFeatSel();
      refreshLevelUpModal();
    });
    wireFeatExtras(modal, () => levelUpState.asi.sel, () => FEATS.find((f) => f.id === levelUpState.asi.featId), refreshLevelUpModal);
    on(modal, "change", "[data-asi-feat-ability]", (e, el) => {
      levelUpState.asi.featAbility = el.value;
    });
    on(modal, "change", "[data-asi-feat-skill]", (e, el) => {
      const v = el.value;
      if (el.checked) {
        if (!levelUpState.asi.featSkills.includes(v)) levelUpState.asi.featSkills.push(v);
      } else {
        levelUpState.asi.featSkills = levelUpState.asi.featSkills.filter((s) => s !== v);
      }
    });
    on(modal, "click", "[data-action=confirm-level-up]", () => {
      applyLevelUp();
      closeModal();
    });
  }
  // A Constitution increase (from an ASI or a feat, wherever it happens --
  // the level-up modal's own ASI choice, or the "Черты" tab's add-feat
  // handler below) doesn't just raise HP going forward: every level already
  // gained rolled/averaged its HP using the OLD Con modifier, so raising Con
  // should retroactively add the modifier's increase once per level already
  // held (PHB: your max HP goes up by that amount "for each level you've
  // gained" -- see e.g. the errata note on ability-score increases). Called
  // with the Con modifier from just before and just after the change;
  // totalLevel(data) already reflects any level gained THIS SAME level-up
  // (c.level is bumped before applyAsiChoice runs), which is correct: that
  // level's own HP gain above used the OLD modifier, so it needs the
  // retroactive top-up too, same as every earlier level.
  function applyConHpRetroactive(conModBefore, conModAfter) {
    const delta = conModAfter - conModBefore;
    if (!delta) return;
    const gain = delta * totalLevel(data);
    data.hp.max = Math.max(1, (Number(data.hp.max) || 0) + gain);
    data.hp.current = Math.max(0, (Number(data.hp.current) || 0) + gain);
  }
  // «Крепкий»: "max HP increases by twice your level when you take this
  // feat, and by another 2 every level you gain after that" -- both halves
  // of that wording add up to the same running total as simply "2 × current
  // total level" at every point in time, so granting it retroactively adds
  // 2×totalLevel right away, and applyLevelUp (below) just adds +2 more on
  // every later level-up, exactly like the flat per-level HP gain it sits
  // next to.
  const TOUGH_FEAT_ID = "tough";
  function hasToughFeat() {
    return (data.feats || []).some((f) => f.id === TOUGH_FEAT_ID);
  }
  function applyToughFeatHpGrant() {
    const gain = 2 * totalLevel(data);
    data.hp.max = Math.max(1, (Number(data.hp.max) || 0) + gain);
    data.hp.current = Math.max(0, (Number(data.hp.current) || 0) + gain);
  }
  // Applies the ASI/feat choice made in asiChooserHtml() above -- mirrors
  // the "Черты" tab's own add-feat handler for the feat branch (same
  // data.feats entry shape, same ability/skill-grant bookkeeping) so a feat
  // taken here looks identical to one added from that tab.
  function applyAsiChoice(asi) {
    const conModBefore = getAbilityMod(data, "con");
    if (asi.mode === "asi") {
      const gains = asi.singleAbility ? [[asi.abilities[0], 2]] : [[asi.abilities[0], 1], [asi.abilities[1], 1]];
      gains.forEach(([ability, amount]) => {
        if (!ability) return;
        data.abilities[ability] = Math.min(20, (Number(data.abilities[ability]) || 10) + amount);
      });
      applyConHpRetroactive(conModBefore, getAbilityMod(data, "con"));
      return;
    }
    const feat = FEATS.find((f) => f.id === asi.featId);
    if (!feat) return;
    if ((data.feats || []).some((f) => f.id === feat.id)) return;
    const entry = { id: feat.id, name: feat.name, desc: feat.desc, prereq: feat.prereq || "" };
    if (feat.abilityIncrease) {
      const ability = feat.abilityIncrease.choices.length > 1 ? asi.featAbility : feat.abilityIncrease.choices[0];
      const amount = feat.abilityIncrease.amount;
      if (ability) {
        data.abilities[ability] = Math.min(20, (Number(data.abilities[ability]) || 10) + amount);
        data.abilityBonuses = data.abilityBonuses || [];
        data.abilityBonuses.push({ source: `Черта (${feat.name})`, ability, amount });
        entry.grantedAbility = ability;
        entry.grantedAmount = amount;
      }
      if (feat.grantsSaveProficiency && ability) {
        data.proficiencies.savingThrows = data.proficiencies.savingThrows || [];
        if (!data.proficiencies.savingThrows.includes(ability)) data.proficiencies.savingThrows.push(ability);
      }
    }
    if (feat.skillChoice) {
      const skills = asi.featSkills.slice(0, feat.skillChoice.count);
      data.proficiencies.skills = data.proficiencies.skills || [];
      skills.forEach((s) => { if (!data.proficiencies.skills.includes(s)) data.proficiencies.skills.push(s); });
      entry.grantedSkills = skills;
    }
    applyFeatExtras(data, feat, entry, asi.sel);
    data.feats = data.feats || [];
    data.feats.push(entry);
    applyConHpRetroactive(conModBefore, getAbilityMod(data, "con"));
    if (feat.id === TOUGH_FEAT_ID) applyToughFeatHpGrant();
    data.proficiencies.armor = data.proficiencies.armor || [];
    data.proficiencies.weapons = data.proficiencies.weapons || [];
    const profGrants = parseProficiencyGrantsFromText(feat.desc);
    profGrants.armor.forEach((a) => { addProficiencyValue(data.proficiencies.armor, a); });
    profGrants.weapons.forEach((w) => { addProficiencyValue(data.proficiencies.weapons, w); });
  }
  // Snapshot of the ENTIRE character taken right before a level-up is
  // applied, so "Откатить уровень" can restore it wholesale -- a level-up
  // touches too many independent things (level, HP, feature cards, ability
  // scores, feats, proficiencies, spellcasting) to undo piecemeal, and this
  // character's data is small enough that a full deep clone per level-up is
  // cheap. Every level-up pushes its own snapshot onto a stack (rather than
  // overwriting a single slot) so several consecutive level-ups can each be
  // undone in turn, one at a time, back down toward (but never past) level
  // 1 -- the button simply disappears once the stack empties out. Each
  // snapshot excludes the stack itself (see the replacer below), so the
  // stack stays a flat list instead of nesting a copy of itself inside
  // every entry.
  function applyLevelUp() {
    const picksSnapshot = currentLevelUpPicks();
    const classes = levelUpEligibleClasses();
    const c = classes[levelUpState.classIndex];
    const cls = c && getClass(c.id);
    if (!c || !cls) return;
    const preLevelUpSnapshot = JSON.parse(JSON.stringify(data, (k, v) => (k === "_levelUpUndoStack" ? undefined : v)));
    if (!Array.isArray(data._levelUpUndoStack)) data._levelUpUndoStack = [];
    data._levelUpUndoStack.push(preLevelUpSnapshot);
    const conMod = getAbilityMod(data, "con");
    const avg = levelUpAverageHp(cls);
    const hpGain = Math.max(1, (levelUpState.hpMethod === "roll" ? levelUpState.rolledAmount ?? avg : avg) + conMod);
    const levelBefore = totalLevel(data);
    const newLevel = (c.level || 1) + 1;
    c.level = newLevel;
    syncHitDiceTotalToLevel(levelBefore);
    data.hp.max = (Number(data.hp.max) || 0) + hpGain;
    data.hp.current = (Number(data.hp.current) || 0) + hpGain;
    if (hasToughFeat()) {
      data.hp.max += 2;
      data.hp.current += 2;
    }
    // Варвар «Изначальный чемпион» (20th level): unlike an ASI/feat pick,
    // this ability increase is unconditional and raises the character's
    // Сила/Телосложение max to 24 for these two scores specifically -- not
    // modeled anywhere else on the sheet, so it's applied directly here
    // rather than through the ASI chooser. Con going up needs the same
    // retroactive HP top-up an ASI/feat Con increase gets (see
    // applyConHpRetroactive above).
    if (cls.id === "barbarian" && newLevel === 20) {
      const conModBeforePrimalChampion = getAbilityMod(data, "con");
      data.abilities.str = Math.min(24, (Number(data.abilities.str) || 10) + 4);
      data.abilities.con = Math.min(24, (Number(data.abilities.con) || 10) + 4);
      applyConHpRetroactive(conModBeforePrimalChampion, getAbilityMod(data, "con"));
    }
    // Level-dependent feature TEXT (e.g. Второе дыхание's "1к10 + ваш
    // уровень воина") already reads the class's current level live rather
    // than baking a number in, and its 🎲 roll amount is likewise resolved
    // from the live level (see SECOND_WIND_FEATURE_NAME below) -- so simply
    // bumping c.level here is enough for those to "recalculate themselves";
    // nothing stored on the feature card itself needs updating.
    const optApply = levelUpOptionalList(cls, newLevel).filter((o) => (levelUpState.optionalPicked || []).includes(o.name));
    const optReplacedName = (n) => optApply.some((o) => optionalReplaces(o, n));
    levelUpFeaturesFor(cls, newLevel)
      .filter(
        (f) =>
          !optReplacedName(f.name) &&
          !rangerOptionalSkipped(f.name) &&
          !ASI_FEATURE_NAME.test(f.name) &&
          !SUBCLASS_CHOICE_FEATURE_NAME.test(f.name) &&
          f.name !== ARCHETYPE_FEATURE_MARKER &&
          !SPELL_CIRCLE_UNLOCK_FEATURE_NAME.test(f.name) &&
          !SPELLCASTING_INTRO_FEATURE_NAME.test(f.name) &&
          !(FIRST_FIGHTING_STYLE_FEATURE_NAME.test(f.name) && !cls.level1Choice) &&
          !(picksSnapshot.some((p) => p.type === "enemy") && /^Улучшенный избранный враг/.test(f.name)) &&
          !(picksSnapshot.some((p) => p.type === "terrain") && /^Более опытный следопыт/.test(f.name))
      )
      .forEach((f) => {
        if ((data.features || []).some((existing) => existing.name === f.name && existing.source === cls.name)) {
          // Повтор умения на новом уровне (рост кости, «ещё 2 навыка» и т.п.): короткая отдельная карточка вместо полного текста.
          const repeatedLevels = Object.keys(cls.features || {}).some((lv) => Number(lv) < newLevel && (cls.features[lv] || []).some((x) => splitFeatureText(x).name === f.name));
          if (repeatedLevels && f.desc && f.desc.length < 160 && !/^Метамагия$/.test(f.name)) {
            const nm = `${f.name} (${newLevel} ур.)`;
            if (!(data.features || []).some((existing) => existing.name === nm && existing.source === cls.name)) {
              data.features.push({ name: nm, source: cls.name, desc: `На ${newLevel}-м уровне: ${f.desc.charAt(0).toLowerCase()}${f.desc.slice(1)}${/[.!?]$/.test(f.desc) ? "" : "."}` });
            }
          }
          return;
        }
        data.features.push({ name: f.name, source: cls.name, desc: f.desc || "" });
        applyFeatureProficiencyGrants(f.name, f.desc || "");
        if (cls.id === "monk" && f.name === "Алмазная душа") {
          if (!Array.isArray(data.proficiencies.savingThrows)) data.proficiencies.savingThrows = [];
          ABILITIES.forEach((a) => { if (!data.proficiencies.savingThrows.includes(a.id)) data.proficiencies.savingThrows.push(a.id); });
        }
      });
    if (levelUpState.asi) applyAsiChoice(levelUpState.asi);
    if (levelUpState.subclassChoice && levelUpState.subclassChoice.name) {
      // First-ever pick, made right here (levelHasSubclassChoice() only
      // creates this state when c.subclass was still empty) -- sets the
      // subclass and adds its intro card plus every feature it grants at
      // this level (usually just level 3, the level this choice happens on).
      const sub = (cls.subclasses || []).find((s) => s.name === levelUpState.subclassChoice.name);
      if (sub) {
        c.subclass = sub.name;
        applySubclassFeaturesAtLevel(cls, sub, newLevel, { withIntro: true, excludeNames: [...(levelUpState.fightingStyleChoice && subStyleSpec(cls, sub.name, newLevel) ? [subStyleSpec(cls, sub.name, newLevel).feature] : []), ...(sub.features || []).filter((sf) => sf.level === newLevel && optReplacedName(sf.name)).map((sf) => sf.name)] });
        if (levelUpState.fightingStyleChoice && levelUpState.fightingStyleChoice.name && subStyleSpec(cls, sub.name, newLevel)) {
          const sopt = levelUpStyleOptions(cls, sub.name, newLevel).find((o) => o.name === levelUpState.fightingStyleChoice.name);
          if (sopt) data.features.push({ name: `Боевой стиль: ${sopt.name}`, source: subclassFeatureSource(cls, sub.name), desc: sopt.desc });
        }
        if (sub.slug === "totem-warrior" && levelUpState.subclassChoice.totem) {
          const opt = totemSpiritOptions(sub).find((o) => o.name === levelUpState.subclassChoice.totem);
          const card = (data.features || []).find((f) => f.name === "Тотемный дух" && f.source === subclassFeatureSource(cls, sub.name));
          if (opt && card) {
            card.name = `Тотемный дух: ${opt.name}`;
            card.desc = `${opt.name}. ${opt.text}`;
          }
        }
        if (sub.slug === "battlemaster") {
          // Same source string subclassFeatureSource()/removeSubclassFeatures()
          // use for every other subclass-granted card, so switching away from
          // Battlemaster later via the classesEditor dropdown cleans these up
          // along with everything else instead of leaving them orphaned.
          const source = subclassFeatureSource(cls, sub.name);
          levelUpState.subclassChoice.maneuverIds.forEach((id) => {
            const m = MANEUVERS.find((mm) => mm.id === id);
            if (!m) return;
            if ((data.features || []).some((f) => f.name === m.name && f.source === source)) return;
            data.features.push({ name: m.name, source, desc: m.desc });
          });
        } else if (sub.slug === "eldritch-knigh" || sub.slug === "arcane-trickster") {
          // blankCharacter() always pre-populates data.spellcasting (with
          // ability:null and empty arrays/slots) so every new character has
          // somewhere for the Заклинания tab's fields to bind to -- so
          // `!data.spellcasting` here was never true for a plain Fighter,
          // and the base ability + first spell slot silently stayed unset.
          // Filling in each piece only when it's still missing/blank (never
          // overwriting a caster who already has real spellcasting from
          // another class) fixes that without disturbing multiclassing.
          if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
          if (!data.spellcasting.ability) data.spellcasting.ability = "int";
          if (!data.spellcasting.cantrips) data.spellcasting.cantrips = [];
          if (!data.spellcasting.known) data.spellcasting.known = [];
          if (!data.spellcasting.prepared) data.spellcasting.prepared = [];
          if (!data.spellcasting.slots) data.spellcasting.slots = {};
          if (!data.spellcasting.slots[1]) data.spellcasting.slots[1] = 2;
          if (sub.slug === "arcane-trickster" && !data.spellcasting.cantrips.includes("mage-hand")) data.spellcasting.cantrips.push("mage-hand");
          levelUpState.subclassChoice.cantripIds.forEach((id) => {
            if (!data.spellcasting.cantrips.includes(id)) data.spellcasting.cantrips.push(id);
          });
          levelUpState.subclassChoice.spellIds.forEach((id) => {
            if (!data.spellcasting.known.includes(id)) data.spellcasting.known.push(id);
          });
        }
      }
    } else if (c.subclass) {
      // Subclass was already chosen at an earlier level-up (or from the
      // sheet's own subclass dropdown) -- just add whatever it grants at
      // THIS exact level, if anything (e.g. Воин 7/10, marked "Умение
      // архетипа" in cls.features so the generic loop above skips it).
      const sub = (cls.subclasses || []).find((s) => s.name.toLowerCase() === c.subclass.toLowerCase());
      if (sub) {
        applySubclassFeaturesAtLevel(cls, sub, newLevel, {
          withIntro: false,
          // Дополнительный боевой стиль gets its own real style card below
          // instead of this plain descriptive one, when the picker fired.
          excludeNames: [
            ...(levelUpState.fightingStyleChoice ? [levelUpStyleFeatureName(cls, sub.name, newLevel)] : []),
            ...(sub.features || []).filter((sf) => sf.level === newLevel && optReplacedName(sf.name)).map((sf) => sf.name),
          ],
        });
        if (levelUpState.fightingStyleChoice && levelUpState.fightingStyleChoice.name) {
          const opt = levelUpStyleOptions(cls, sub.name, newLevel).find((o) => o.name === levelUpState.fightingStyleChoice.name);
          if (opt) {
            data.features.push({ name: `${subStyleSpec(cls, sub.name, newLevel) ? "Боевой стиль" : SECOND_FIGHTING_STYLE_FEATURE_NAME}: ${opt.name}`, source: subclassFeatureSource(cls, sub.name), desc: opt.desc });
          }
        }
      }
    }
    if (levelUpState.expertiseChoice) {
      if (!Array.isArray(data.proficiencies.expertise)) data.proficiencies.expertise = [];
      levelUpState.expertiseChoice.picked.forEach((id) => { if (!data.proficiencies.expertise.includes(id)) data.proficiencies.expertise.push(id); });
    }
    if (levelUpState.disciplines && disciplineActive(cls, newLevel, c)) {
      const ds = levelUpState.disciplines;
      const sub = (cls.subclasses || []).find((x) => x.name.toLowerCase() === String(c.subclass || "").toLowerCase());
      const src = sub ? subclassFeatureSource(cls, sub.name) : cls.name;
      const addCard = (n) => {
        const d = ELEMENTAL_DISCIPLINES.find((x) => x.name === n);
        const nm = n === ELEMENTAL_ATTUNEMENT ? n : `Практика: ${n}`;
        if (d && !(data.features || []).some((f) => f.name === nm)) data.features.push({ name: nm, source: src, desc: d.desc });
      };
      if (newLevel === 3) addCard(ELEMENTAL_ATTUNEMENT);
      if (ds.swapOut && ds.swapIn) data.features = (data.features || []).filter((f) => f.name !== `Практика: ${ds.swapOut}`);
      if (ds.swapOut && ds.swapIn) addCard(ds.swapIn);
      ds.picked.forEach(addCard);
    }
    if (levelUpState.spellSwap && levelUpState.spellSwap.out && levelUpState.spellSwap.in && data.spellcasting) {
      const sw = levelUpState.spellSwap;
      const sc2 = data.spellcasting;
      sc2.known = (sc2.known || []).map((id) => (id === sw.out ? sw.in : id));
      if ((sc2.prepared || []).includes(sw.out)) sc2.prepared = sc2.prepared.map((id) => (id === sw.out ? sw.in : id));
    }
    if (levelUpState.metamagicChoice) {
      levelUpState.metamagicChoice.picked.forEach((n) => {
        const m = (METAMAGIC_OPTIONS || []).find((x) => x.name === n);
        if (m && !(data.features || []).some((f) => f.name === `Метамагия: ${n}`)) data.features.push({ name: `Метамагия: ${n}`, source: cls.name, desc: m.desc || "" });
      });
    }
    applyWarlockPickers(cls);
    if (levelUpState.styleSwap && levelUpState.styleSwap.name) {
      const opt = styleOptionsFor(cls).find((o) => o.name === levelUpState.styleSwap.name);
      const curCard = currentBaseStyleCard(cls);
      if (opt && curCard) { curCard.name = `Боевой стиль: ${opt.name}`; curCard.desc = opt.desc; }
    }
    Object.entries(levelUpState.styleCantrips || {}).forEach(([st, ids]) => {
      if (!chosenStyleCantripStyles().includes(st)) return;
      if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      if (!Array.isArray(data.spellcasting.cantrips)) data.spellcasting.cantrips = [];
      ids.forEach((id) => { if (!data.spellcasting.cantrips.includes(id)) data.spellcasting.cantrips.push(id); });
    });
    optApply.forEach((o) => {
      const src = `${cls.name} — опциональное (${OPTIONAL_FEATURE_SOURCE})`;
      if ((data.features || []).some((x) => x.name === o.name && x.source === src)) return;
      data.features.push({ name: o.name, source: src, desc: o.desc, optional: true });
    });
    applyLevelUpPicks(cls, newLevel, picksSnapshot);
    if (levelUpState.toolChoice && levelUpState.toolChoice.name) {
      addProficiencyValue(data.proficiencies.tools, levelUpState.toolChoice.name);
    }
    if (levelUpState.baseFightingStyleChoice && levelUpState.baseFightingStyleChoice.name) {
      const opt = (getClass("fighter").level1Choice.options || []).find((o) => o.name === levelUpState.baseFightingStyleChoice.name);
      if (opt) data.features.push({ name: `Боевой стиль: ${opt.name}`, source: cls.name, desc: opt.desc });
    }
    if (levelUpState.subSkillChoice) {
      const sc = levelUpState.subSkillChoice;
      if (!Array.isArray(data.proficiencies.savingThrows)) data.proficiencies.savingThrows = [];
      (sc.autoSkills || []).forEach((id) => { if (!data.proficiencies.skills.includes(id)) data.proficiencies.skills.push(id); });
      (sc.autoSaves || []).forEach((id) => { if (!data.proficiencies.savingThrows.includes(id)) data.proficiencies.savingThrows.push(id); });
      (sc.expertiseIds || []).forEach((id) => { if (!data.proficiencies.expertise.includes(id)) data.proficiencies.expertise.push(id); });
      sc.picked.filter(Boolean).forEach((id) => {
        if (sc.kind === "save") { if (!data.proficiencies.savingThrows.includes(id)) data.proficiencies.savingThrows.push(id); return; }
        if (!data.proficiencies.skills.includes(id)) data.proficiencies.skills.push(id);
        if (sc.expertise && !data.proficiencies.expertise.includes(id)) data.proficiencies.expertise.push(id);
      });
      if (sc.cantripPicked) {
        if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
        if (!data.spellcasting.ability) data.spellcasting.ability = "int";
        if (!Array.isArray(data.spellcasting.cantrips)) data.spellcasting.cantrips = [];
        if (!data.spellcasting.cantrips.includes(sc.cantripPicked)) data.spellcasting.cantrips.push(sc.cantripPicked);
      }
    }
    if (levelUpState.multiPick) {
      const mp = levelUpState.multiPick;
      const sub = (cls.subclasses || []).find((x) => x.name === mp.subName);
      const spec = SUBCLASS_MULTI_PICKS[mp.slug];
      const source = subclassFeatureSource(cls, mp.subName);
      mp.ids.forEach((name) => {
        const opt = mp.options.find((o) => o.name === name);
        if (!opt || !sub) return;
        const cardName = multiPickCardName(spec, opt);
        if ((data.features || []).some((f) => f.source === source && f.name === cardName)) return;
        data.features.push({ name: cardName, source, desc: opt.text });
      });
    }
    applyBonusChoice(cls);
    if (levelUpState.subLanguageChoice) {
      levelUpState.subLanguageChoice.picked.filter(Boolean).forEach((lang) => {
        addProficiencyValue(data.proficiencies.languages, lang);
      });
    }
    if (levelUpState.spellbookChoice) {
      if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      if (!data.spellcasting.known) data.spellcasting.known = [];
      levelUpState.spellbookChoice.spellIds.forEach((id) => {
        if (!data.spellcasting.known.includes(id)) data.spellcasting.known.push(id);
      });
    }
    if (levelUpState.knownSpellChoice) {
      if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      if (!data.spellcasting.known) data.spellcasting.known = [];
      levelUpState.knownSpellChoice.spellIds.forEach((id) => {
        if (!data.spellcasting.known.includes(id)) data.spellcasting.known.push(id);
      });
    }
    if (levelUpState.magicSecrets && magicSecretsInfo(cls, newLevel, c).count) {
      if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      if (!data.spellcasting.known) data.spellcasting.known = [];
      if (!data.spellcasting.cantrips) data.spellcasting.cantrips = [];
      levelUpState.magicSecrets.picked.forEach((id) => {
        const sp = SPELLS.find((x) => x.id === id);
        const arr = sp && sp.level === 0 ? data.spellcasting.cantrips : data.spellcasting.known;
        if (!arr.includes(id)) arr.push(id);
      });
    }
    if (levelUpState.knownCantripChoice) {
      if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      if (!data.spellcasting.cantrips) data.spellcasting.cantrips = [];
      levelUpState.knownCantripChoice.cantripIds.forEach((id) => {
        if (!data.spellcasting.cantrips.includes(id)) data.spellcasting.cantrips.push(id);
      });
    }
    applyLevelUpSpellSlots(cls, c);
    ensureSunBolt();
    doSave();
    render();
  }
  function openLevelUpModal() {
    const classes = levelUpEligibleClasses();
    if (!classes.length) {
      alert("Нет класса, который можно повысить (уровень уже 20, или класс ещё не выбран).");
      return;
    }
    const c = classes[0];
    const cls = c && getClass(c.id);
    const newLevel = (c?.level || 1) + 1;
    levelUpState = {
      classIndex: 0,
      optionalPicked: [],
      expertiseChoice: cls && levelExpertiseCount(cls, newLevel) ? { count: levelExpertiseCount(cls, newLevel), picked: [] } : null,
      metamagicChoice: cls && levelMetamagicCount(cls, newLevel) ? { count: levelMetamagicCount(cls, newLevel), picked: [] } : null,
      ...freshWarlockStates(cls, newLevel),
      styleSwap: cls && canSwapFightingStyle(cls, newLevel) ? { name: "" } : null,
      styleCantrips: {},
      hpMethod: "average",
      rolledAmount: null,
      asi: cls && levelHasAsiChoice(cls, newLevel) ? freshAsiState() : null,
      subclassChoice: cls && levelHasSubclassChoice(c, cls, newLevel) ? freshSubclassChoiceState() : null,
      fightingStyleChoice: cls && levelHasFightingStyleChoice(c, cls, newLevel) ? freshFightingStyleChoiceState() : null,
      baseFightingStyleChoice: cls && levelHasBaseFightingStyleChoice(cls, newLevel) ? freshBaseFightingStyleChoiceState() : null,
      toolChoice: cls && c.subclass && levelHasCraftToolChoice(cls, c.subclass, newLevel) ? freshToolChoiceState(cls, c.subclass, newLevel) : null,
      subSkillChoice: resolveSubSkillChoiceState(cls, c && c.subclass, newLevel),
      multiPick: resolveMultiPickState(cls, c && c.subclass, newLevel),
      bonusChoice: resolveBonusChoiceState(cls, c && c.subclass, newLevel),
      subLanguageChoice: resolveSubLanguageChoiceState(cls, c && c.subclass, newLevel),
      spellbookChoice: cls && levelHasSpellbookGrowth(cls, newLevel) ? freshSpellbookChoiceState() : null,
      knownSpellChoice: cls && knownSpellGrowthCount(cls, newLevel, c) > 0 ? freshKnownSpellChoiceState() : null,
      knownCantripChoice: cls && knownCantripGrowthCount(cls, newLevel, c) > 0 ? freshKnownCantripChoiceState() : null,
      magicSecrets: { picked: [] },
      disciplines: { picked: [], swapOut: "", swapIn: "" },
      spellSwap: { out: "", in: "" },
    };
    levelUpModalEl = openModal(levelUpModalBodyHtml(), { wide: true });
    wireLevelUpModal(levelUpModalEl);
  }

  // Portrait box, top-left of the sheet: click to upload, stored as a
  // resized data URL on the character so it travels with the JSON blob.
  function portraitBox() {
    const src = data.portraitDataUrl || "";
    return `
      <div class="portrait-box" data-action="pick-portrait" title="Изображение персонажа" style="flex:none;width:128px;height:128px;border:1px solid var(--gold-dim);border-radius:6px;cursor:pointer;overflow:hidden;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.15);">
        ${src ? `<img src="${src}" alt="Портрет" style="width:100%;height:100%;object-fit:cover;" />` : `<span class="muted" style="font-size:0.72rem;text-align:center;padding:2px;">+ фото</span>`}
        <input type="file" accept="image/*" data-portrait-input style="display:none;" />
      </div>`;
  }

  function classesEditor() {
    const classes = data.classes || [];
    // XP lives in its own column, in line with "Подкласс" (the row
    // where a player's eye is already resting), rather than floating in a
    // separate header row above the table -- it's shown once, on the first
    // class row, since it's a property of the character as a whole, not of
    // any one class entry.
    return `
      <div>
        <table class="sheet-table">
          <thead><tr><th style="width:170px;">Класс</th><th style="width:92px;">Уровень</th><th style="width:100px;">Подкласс</th><th style="width:110px;">Опыт (ОП)</th><th style="width:34px;"></th></tr></thead>
          <tbody>
            ${
              classes.length
                ? classes
                    .map((c, i) => {
                      const cls = getClass(c.id);
                      const subclasses = (cls && cls.subclasses) || [];
                      // A dropdown when the class's subclass catalog is on
                      // file (all 13 classes have one) -- picking a different
                      // option swaps the character's features and available
                      // subclass spells for it (see the dedicated "change"
                      // listener below). Falls back to the old free-text box
                      // only if a class somehow has no catalog entries.
                      const subclassField = subclasses.length
                        ? `<select data-class-field="subclass" data-class-index="${i}">
                             <option value="">—</option>
                             ${subclasses.map((s) => `<option value="${escapeHtml(s.name)}" ${(c.subclass || "").toLowerCase() === s.name.toLowerCase() ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
                           </select>`
                        : `<input type="text" data-class-field="subclass" data-class-index="${i}" value="${escapeHtml(c.subclass || "")}" placeholder="—" />`;
                      return `
              <tr>
                <td>
                  <select data-class-field="id" data-class-index="${i}">
                    <option value="">—</option>
                    ${CLASSES.map((cl) => `<option value="${cl.id}" ${c.id === cl.id ? "selected" : ""}>${cl.name}</option>`).join("")}
                  </select>
                </td>
                <td><input type="number" min="1" max="20" data-class-field="level" data-class-index="${i}" value="${c.level || 1}" /></td>
                <td>${subclassField}</td>
                <td>${i === 0 ? `<input type="number" min="0" data-bind="xp" value="${data.xp ?? 0}" />` : ""}</td>
                <td><button type="button" class="small danger" data-action="remove-class" data-index="${i}" title="Удалить класс">✕</button></td>
              </tr>`;
                    })
                    .join("")
                : `<tr><td colspan="3" class="muted">Класс пока не выбран.</td><td><input type="number" min="0" data-bind="xp" value="${data.xp ?? 0}" /></td><td></td></tr>`
            }
          </tbody>
        </table>
        <button class="small" data-action="add-class" style="margin-top:4px;">+ Добавить класс</button>
      </div>`;
  }

  // -- Subclass switcher (dropdown in classesEditor above) --------------
  // Swapping a class's subclass pick removes every feature the OLD
  // subclass granted and adds every feature the NEW one grants, up to the
  // character's current level in that class -- generalizing the "one
  // feature card per named subclass feature" convention doFinish() in
  // wizard.js already uses at character creation (source "<class> —
  // <subclass>"), so it also covers classes that pick their subclass at
  // 3rd level or later (creation only ever seeds the level-1 casters:
  // Cleric/Sorcerer/Warlock).
  function subclassFeatureSource(cls, subName) {
    return `${cls.name} — ${subName}`;
  }
  // The level-1 "intro" card doFinish() files under the class's own name
  // uses "<label>: <subclass>" for Cleric/Sorcerer/Warlock (their
  // level1Choice label, e.g. "Божественный домен: Домен войны"); every
  // other class gets a plain "<subclass name>" intro card here, since it
  // never had an existing convention to match.
  function subclassIntroName(cls, subName) {
    return cls.level1Choice && cls.level1Choice.type === "subclass" ? `${cls.level1Choice.label}: ${subName}` : subName;
  }
  // Class features that grant a saving-throw proficiency outright (not a
  // choice, unlike a feat's grantsSaveProficiency) are rare enough to just
  // special-case by name here, same convention as the many other exact-name
  // special cases in this file (e.g. GENIE_VESSEL_FEATURE_NAME).
  const SAVE_PROFICIENCY_GRANTS = { "Стойкий разум": "wis" };
  function applyFeatureProficiencyGrants(name, desc) {
    data.proficiencies = data.proficiencies || {};
    if (!Array.isArray(data.proficiencies.skills)) data.proficiencies.skills = [];
    if (!Array.isArray(data.proficiencies.armor)) data.proficiencies.armor = [];
    if (!Array.isArray(data.proficiencies.weapons)) data.proficiencies.weapons = [];
    if (!Array.isArray(data.proficiencies.tools)) data.proficiencies.tools = [];
    if (!Array.isArray(data.proficiencies.savingThrows)) data.proficiencies.savingThrows = [];
    const savingThrowGrant = SAVE_PROFICIENCY_GRANTS[name];
    if (savingThrowGrant && !data.proficiencies.savingThrows.includes(savingThrowGrant)) {
      data.proficiencies.savingThrows.push(savingThrowGrant);
    }
    const skillMatch = /Владение\s+навык(?:ом|ами)\s+([^.]+)\.?/i.exec(desc || "");
    if (skillMatch) {
      skillMatch[1]
        .split(/,| и /i)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((nm) => {
          const skill = SKILLS.find((s) => s.label.toLowerCase() === nm.toLowerCase());
          if (skill && !data.proficiencies.skills.includes(skill.id)) data.proficiencies.skills.push(skill.id);
        });
    }
    const namedWeapons = TRAIT_NAMED_WEAPON_GRANTS[name];
    if (namedWeapons) {
      namedWeapons.forEach((w) => {
        addProficiencyValue(data.proficiencies.weapons, w);
      });
    } else {
      const grants = parseProficiencyGrantsFromText(desc);
      grants.weapons.forEach((w) => {
        addProficiencyValue(data.proficiencies.weapons, w);
      });
      grants.armor.forEach((a) => {
        addProficiencyValue(data.proficiencies.armor, a);
      });
      grants.tools.forEach((t) => {
        addProficiencyValue(data.proficiencies.tools, t);
      });
    }
  }
  // -- Fighting-style switcher (dropdown in classesEditor above) --------
  // A level-1 "pick one and it's yours for good" combat style
  // (level1Choice.type "fightingStyle", e.g. Fighter's Боевой стиль) is
  // stored the same way doFinish() in wizard.js files it at creation: one
  // feature card named "<label>: <style name>" (e.g. "Боевой стиль:
  // Дуэлянт"), source = the class's own name. Swapping it here removes
  // that card and adds the new one, same idea as the subclass switcher
  // above but for a choice that isn't a subclass at all.
  // A character who skipped the choice at creation (or was created before
  // the wizard offered one) has a bare "Боевой стиль" placeholder card
  // instead -- no colon, empty desc (see the class's raw features list vs.
  // LEVEL1_CHOICE_PLACEHOLDER handling in wizard.js's doFinish()). Both that
  // placeholder and the real "<label>: <style>" card occupy the same
  // "slot", so both are recognized here and replaced as one when the player
  // finally picks (or changes) a style from the sheet.
  function isFightingStyleCard(cls, f) {
    if (f.source !== cls.name) return false;
    const label = cls.level1Choice.label.toLowerCase();
    const name = (f.name || "").toLowerCase();
    return name === label || name.startsWith(`${label}:`);
  }
  function currentFightingStyleName(cls) {
    const prefix = `${cls.level1Choice.label}:`.toLowerCase();
    const f = (data.features || []).find((f) => isFightingStyleCard(cls, f) && (f.name || "").toLowerCase().startsWith(prefix));
    return f ? f.name.slice(prefix.length).trim() : "";
  }
  function applyFightingStyleChange(cls, newStyleName) {
    data.features = (data.features || []).filter((f) => !isFightingStyleCard(cls, f));
    if (!newStyleName) return;
    const opt = (cls.level1Choice.options || []).find((o) => o.name === newStyleName);
    if (!opt) return;
    data.features.push({ name: `${cls.level1Choice.label}: ${opt.name}`, source: cls.name, desc: opt.desc });
  }
  // «Броня бушующего в бою» (Путь бушующего в бою): the spikes of the armour
  // are a weapon -- 1к4 колющего, Сила -- so they go into Оружие and Атаки.
  const SPIKES_NAME = "Шипы доспеха";
  function ensureBattleragerSpikes() {
    if (!(data.features || []).some((f) => f.name === "Броня бушующего в бою")) return false;
    let changed = false;
    if (!data.weapons) data.weapons = [];
    if (!data.attacks) data.attacks = [];
    if (!data.weapons.some((w) => w.name === SPIKES_NAME)) {
      data.weapons.push({ name: SPIKES_NAME, damage: "1к4", type: "колющий", properties: "Бонусное действие, в ярости и в шипованном доспехе", special: "", equipped: true, rangeType: "melee" });
      changed = true;
    }
    if (!data.attacks.some((a) => a.name === SPIKES_NAME)) {
      data.attacks.push({ name: SPIKES_NAME, bonus: "", damage: "1к4 колющий", special: "", useSpecial: false, rangeType: "melee", ability: "str", hand: "" });
      changed = true;
    }
    return changed;
  }
  function removeSubclassFeatures(cls, subName) {
    if (!subName) return;
    const source = subclassFeatureSource(cls, subName);
    const introName = subclassIntroName(cls, subName);
    data.features = (data.features || []).filter((f) => f.source !== source && !(f.source === cls.name && f.name === introName));
    if (!(data.features || []).some((f) => f.name === "Броня бушующего в бою")) {
      data.weapons = (data.weapons || []).filter((w) => w.name !== SPIKES_NAME);
      data.attacks = (data.attacks || []).filter((a) => a.name !== SPIKES_NAME);
    }
  }
  function applySubclassFeatures(cls, sub, uptoLevel) {
    if (!sub) return;
    data.features.push({ name: subclassIntroName(cls, sub.name), source: cls.name, desc: sub.intro || "" });
    const source = subclassFeatureSource(cls, sub.name);
    (sub.features || []).forEach((sf) => {
      if (!sf.name) return;
      if (sf.level !== null && sf.level !== undefined && sf.level > uptoLevel) return;
      const desc = subclassFeatureDescText(sub, sf);
      // Пси-воин «Псионическая сила»: способности (Защитное поле, Псионический удар, Телекинетическое передвижение) — отдельные карточки.
      const psi = splitSubFeatureCards(sub, sf);
      if (psi) {
        data.features.push({ name: sf.name, source, desc: psi.intro });
        psi.cards.forEach((pw) => { if (!(data.features || []).some((f) => f.source === source && f.name === pw.name)) data.features.push({ name: pw.name, source, desc: pw.desc }); });
        return;
      }
      data.features.push({ name: sf.name, source, desc });
      applyFeatureProficiencyGrants(sf.name, desc);
    });
    ensureBattleragerSpikes();
    ensureSunBolt();
  }
  // Level-up-specific sibling of applySubclassFeatures() above: that one is
  // built for the classesEditor dropdown (wholesale swap — remove everything
  // the old subclass granted, add everything the new one grants up to the
  // current level), which would re-add every earlier level's cards (and a
  // duplicate intro card) if it were reused for an incremental level-up.
  // This instead adds only the features at exactly `level`, with the same
  // dedup guard the plain class-feature loop in applyLevelUp() uses, and
  // only pushes the intro card when explicitly asked to (the first time the
  // player picks this subclass, at whichever level that happens to be).
  function splitPsionicPowerCards(paras) {
    const idx = paras.findIndex((p) => /расходуются на следующие способности/i.test(p));
    if (idx < 0) return null;
    const powers = [];
    paras.slice(idx + 1).forEach((p) => {
      const m = /^([А-ЯЁ][^.]{2,40})\.\s+([\s\S]+)$/.exec(p);
      if (m) powers.push({ name: m[1], desc: m[2] });
      else if (powers.length) powers[powers.length - 1].desc += "\n\n" + p;
    });
    if (!powers.length) return null;
    return { intro: paras.slice(0, idx + 1).join("\n\n"), powers };
  }
  // Путь зверя «Форма зверя»: Укус / Когти / Хвост — отдельные карточки умений.
  function splitBeastFormCards(paras) {
    const idx = paras.findIndex((p) => /Вы выбираете форму оружия/i.test(p));
    if (idx < 0) return null;
    const cards = [];
    paras.slice(idx + 1).forEach((p) => {
      const m = /^([А-ЯЁ][а-яё]+)\.\s+([\s\S]+)$/.exec(p);
      if (m) cards.push({ name: `Форма зверя: ${m[1]}`, desc: m[2] });
      else if (cards.length) cards[cards.length - 1].desc += "\n\n" + p;
    });
    if (!cards.length) return null;
    return { intro: paras.slice(0, idx + 1).join("\n\n"), cards };
  }
  // Умения подкласса, которые разбиваются на несколько карточек: { intro, cards: [{name, desc}] } или null.
  function splitSubFeatureCards(sub, sf) {
    if (!sub || !sf) return null;
    if (sub.slug === "psi-warrior" && sf.name === "Псионическая сила") {
      const r = splitPsionicPowerCards(sf.desc || []);
      return r ? { intro: r.intro, cards: r.powers } : null;
    }
    if (sub.slug === "beast" && sf.name === "Форма зверя") return splitBeastFormCards(sf.desc || []);
    return null;
  }
  function applySubclassFeaturesAtLevel(cls, sub, level, { withIntro, excludeNames } = {}) {
    if (!sub) return;
    const introName = subclassIntroName(cls, sub.name);
    if (withIntro && !(data.features || []).some((f) => f.source === cls.name && f.name === introName)) {
      data.features.push({ name: introName, source: cls.name, desc: sub.intro || "" });
    }
    const source = subclassFeatureSource(cls, sub.name);
    (sub.features || []).forEach((sf) => {
      if (!sf.name || sf.level !== level) return;
      if (excludeNames && excludeNames.includes(sf.name)) return;
      if ((data.features || []).some((f) => f.source === source && f.name === sf.name)) return;
      const desc = subclassFeatureDescText(sub, sf);
      const psi = splitSubFeatureCards(sub, sf);
      if (psi) {
        data.features.push({ name: sf.name, source, desc: psi.intro });
        psi.cards.forEach((pw) => { if (!(data.features || []).some((f) => f.source === source && f.name === pw.name)) data.features.push({ name: pw.name, source, desc: pw.desc }); });
        return;
      }
      data.features.push({ name: sf.name, source, desc });
      applyFeatureProficiencyGrants(sf.name, desc);
    });
    ensureBattleragerSpikes();
    ensureSunBolt();
  }
  // A subclass can widen the pool of pickable spells beyond its class's own
  // list (characterExpandedSpellIds() below reads this live off
  // data.classes[i].subclass, so newly-widened picks need no extra code
  // here) -- but a spell the player already added to Известные/Подготовленные
  // *because* the old subclass expanded the pool, and that isn't covered by
  // the class's own list or the new subclass, would otherwise be left
  // stranded on the sheet with no source granting it anymore. Drop those;
  // leave anything the class itself grants, or that the new subclass still
  // covers, alone.
  function pruneStaleSubclassSpells(oldSub, newSub) {
    const oldIds = new Set(oldSub && oldSub.expandedSpells || []);
    if (!oldIds.size) return;
    const newIds = new Set(newSub && newSub.expandedSpells || []);
    const classIds = new Set((data.classes || []).map((c) => c.id).filter(Boolean));
    const stillGranted = (id) => {
      if (newIds.has(id)) return true;
      const sp = SPELLS.find((s) => s.id === id);
      return !!(sp && sp.classes.some((cid) => classIds.has(cid)));
    };
    const sc = data.spellcasting || {};
    ["cantrips", "known", "prepared"].forEach((key) => {
      if (Array.isArray(sc[key])) sc[key] = sc[key].filter((id) => !oldIds.has(id) || stillGranted(id));
    });
  }

  // Number of times per day a Bard can grant Bardic Inspiration -- Charisma
  // modifier, minimum one (2014 PHB). Not level-dependent (only the die size
  // scales with level, via inspiration.bardDie). Used by the "Бардовское
  // вдохновение" feature card's own uses tracker (featureResourceHtml
  // below), NOT by this widget -- this widget tracks a die this character
  // was personally GIVEN by a bard (any class can receive one), which is a
  // different resource entirely.
  function maxBardInspirationUses() {
    return Math.max(1, getAbilityMod(data, "cha"));
  }
  // Top-of-sheet inspiration row: DM inspiration (0-5 stars, any character)
  // and a single "Вдохновение барда" die this character is currently
  // holding after a bard granted it to them -- die size to match what was
  // received, a star marking it as unused, and a roll button once it is.
  function inspirationWidget() {
    const insp = data.inspiration || { dmStars: 0, bardDie: "d6", bardStar: false, heroic: false };
    const stars = [0, 1, 2, 3, 4]
      .map((i) => `<span class="insp-star ${i < (insp.dmStars || 0) ? "filled" : ""}" data-action="toggle-dm-star" data-index="${i}" title="Вдохновение мастера">${i < (insp.dmStars || 0) ? "★" : "☆"}</span>`)
      .join("");
    return `
      <div class="row" style="gap:18px;flex-wrap:wrap;align-items:center;">
        <div class="row" style="gap:4px;align-items:center;">
          <span class="muted" style="font-size:0.78rem;">Вдохновение мастера</span>
          <span class="row" style="gap:1px;">${stars}</span>
        </div>
        <div class="row" style="gap:6px;align-items:center;">
          <span class="muted" style="font-size:0.78rem;">Вдохновение барда</span>
          <select data-bind="inspiration.bardDie" style="width:60px;padding:2px 4px;">
            <option value="d6" ${insp.bardDie === "d6" ? "selected" : ""}>к6</option>
            <option value="d8" ${insp.bardDie === "d8" ? "selected" : ""}>к8</option>
            <option value="d10" ${insp.bardDie === "d10" ? "selected" : ""}>к10</option>
            <option value="d12" ${insp.bardDie === "d12" ? "selected" : ""}>к12</option>
          </select>
          <span class="insp-star ${insp.bardStar ? "filled" : ""}" data-action="toggle-bard-star" title="Получена кость вдохновения барда, ещё не потрачена">${insp.bardStar ? "★" : "☆"}</span>
          <button type="button" class="small" data-action="roll-bard-inspiration" ${insp.bardStar ? "" : "disabled"}>🎲 Бросить</button>
        </div>
        ${
          barbarianLevel(data) > 0
            ? (() => {
                const left = rageUsesLeft();
                const noUses = !data.rageActive && left <= 0;
                const tip = noUses
                  ? "Использования «Ярости» закончились — восстановятся после продолжительного отдыха"
                  : `Пока включено, к урону оружием ближнего боя в силовых атаках (Сила) добавляется бонус Ярости (+${rageDamageBonus(data)} на этом уровне). Включение тратит одно использование «Ярости»${left === Infinity ? "" : ` (осталось: ${left})`}.`;
                return `<button type="button" class="small ${data.rageActive ? "primary" : ""}" data-action="toggle-rage" ${noUses ? "disabled" : ""} title="${escapeHtml(tip)}">${data.rageActive ? "✔ Ярость" : "Ярость"}${!data.rageActive && left !== Infinity ? ` (${left})` : ""}</button>`;
              })()
            : ""
        }
        <button type="button" class="small ${data.blessingActive ? "primary" : ""}" data-action="toggle-blessing" title="Пока включено, ко всем броскам атаки, спасброскам и проверкам характеристик автоматически добавляется к4 (эффект заклинания благословение)">${data.blessingActive ? "✔ Благословение" : "Благословение"}</button>
        <button type="button" class="small primary" data-action="open-level-up-modal">⬆ Повысить уровень</button>
        ${Array.isArray(data._levelUpUndoStack) && data._levelUpUndoStack.length ? `<button type="button" class="small" data-action="revert-level-up" title="Отменить последнее повышение уровня">↺ Откатить уровень</button>` : ""}
        ${data.edition === "2024" ? `
        <label class="row" style="gap:6px;align-items:center;">
          <input type="checkbox" data-bind-checkbox="inspiration.heroic" ${insp.heroic ? "checked" : ""} />
          <span class="muted" style="font-size:0.78rem;">Героическое вдохновение</span>
        </label>` : ""}
      </div>`;
  }

  function customArmorFields() {
    const c = data.customArmor || {};
    return `
      <div class="panel" style="margin-top:8px;background:var(--bg-panel-2);">
        <p class="muted" style="font-size:0.8rem;margin-top:0;">Своя броня — для особых или магических доспехов.</p>
        <div class="grid cols-2">
          <div class="col">
            <label>Название</label>
            <input type="text" data-bind="customArmor.name" value="${escapeHtml(c.name || "")}" placeholder="напр. Доспех +1" />
          </div>
          <div class="col">
            <label>Базовый КД</label>
            <input type="number" min="1" max="35" data-bind="customArmor.baseAC" data-clamp="1:35" value="${c.baseAC ?? 10}" />
          </div>
        </div>
        <div class="grid cols-2" style="margin-top:8px;">
          <div class="col">
            <label>Модификатор Ловкости</label>
            <select data-bind="customArmor.dexMode">
              <option value="full" ${c.dexMode === "full" ? "selected" : ""}>Полностью (как лёгкая)</option>
              <option value="capped" ${c.dexMode === "capped" ? "selected" : ""}>Ограничен (как средняя)</option>
              <option value="none" ${c.dexMode === "none" ? "selected" : ""}>Не действует (как тяжёлая)</option>
            </select>
          </div>
          <div class="col">
            <label>Максимум Ловкости</label>
            <input type="number" min="0" max="35" data-bind="customArmor.dexCap" data-clamp="0:35" value="${c.dexCap ?? 2}" />
          </div>
        </div>
        <div class="col" style="margin-top:8px;">
          <label>Особые свойства</label>
          <textarea data-bind="customArmor.note" rows="2" placeholder="напр. +1, сопротивление урону огнём">${escapeHtml(c.note || "")}</textarea>
        </div>
      </div>`;
  }

  function mainTab() {
    return `
      <div class="grid cols-2">
        <div>
          <div class="panel panel-tight">
            <h2>Характеристики</h2>
            <div class="grid cols-3 abilities-grid">
              ${ABILITIES.map((a) => abilityBox(a)).join("")}
            </div>
            ${luckyPointsWidgetHtml()}
            ${abilityBonusSourcesBox()}
          </div>
          <div class="panel panel-tight">
            <h2>Спасброски</h2>
            <div class="saves-compact">
              ${ABILITIES.map((a) => saveRow(a)).join("")}
            </div>
          </div>
          <div class="panel panel-tight">
            <h2>Навыки</h2>
            <div class="skills-grid">
              ${SKILLS.map((s) => skillRow(s)).join("")}
            </div>
            <p class="row" style="margin-top:8px;align-items:center;gap:6px;">
              <span class="prof-dot prof" style="cursor:default;"></span> владение
              &nbsp;
              <span class="prof-dot expert" style="cursor:default;"></span> компетентность
            </p>
          </div>
          <div class="panel panel-tight">
            <h2>Пассивные чувства</h2>
            <div class="passive-grid">
              <div class="passive-item"><span class="name">Восприятие</span><span class="bonus">${passivePerception(data)}</span></div>
              <div class="passive-item"><span class="name">Анализ</span><span class="bonus">${passiveInvestigation(data)}</span></div>
              <div class="passive-item"><span class="name">Проницательность</span><span class="bonus">${passiveInsight(data)}</span></div>
            </div>
          </div>
        </div>
        <div>
          <div class="panel">
            <h2>Боевые параметры</h2>
            <div class="grid cols-3 combat-stats">
              ${combatStatBox("ac", "КД", armorClass(data), armorClassAuto(data), "")}
              ${combatStatBox("init", "Инициатива", initiativeBonus(data), initiativeBonusAuto(data), "roll-initiative")}
              ${combatStatBox("speed", "Скорость, фт", totalSpeed(data), totalSpeedAuto(data), "")}
            </div>
            <div class="grid" style="grid-template-columns: 3fr 1fr; gap:10px; margin-top:8px;">
              <div class="col">
                <label>Броня</label>
                <select data-bind="armorId">
                  <option value="">Без брони</option>
                  ${ARMORS.map((a) => `<option value="${a.id}" ${data.armorId === a.id ? "selected" : ""}>${escapeHtml(a.name)} (КД ${a.baseAC}${a.dexMode === "full" ? "+Лов" : a.dexMode === "capped" ? `+Лов, макс ${a.dexCap}` : ""})</option>`).join("")}
                  <option value="custom" ${data.armorId === "custom" ? "selected" : ""}>Своя броня…</option>
                </select>
              </div>
              <div class="col">
                <label>Щит, +КД</label>
                <input type="number" style="width:100%;" min="0" max="35" data-bind="shieldACBonus" data-clamp="0:35" value="${data.shieldACBonus ?? 2}" />
              </div>
            </div>
            ${data.armorId === "custom" ? customArmorFields() : ""}
            <div class="row" style="margin-top:8px;">
              <button class="${data.armorId && data.armorEquipped ? "primary" : ""}" data-action="toggle-armor" ${!data.armorId ? "disabled" : ""}>
                ${data.armorId && data.armorEquipped ? "🛡️ Броня: надета" : "Броня: снята"}
              </button>
              <button class="${data.shieldEquipped ? "primary" : ""}" data-action="toggle-shield">
                ${data.shieldEquipped ? "🛡️ Щит: надет" : "Щит: снят"}
              </button>
            </div>
            <div class="grid cols-3" style="margin-top:10px;">
              <div class="col">
                <label>Хиты максимум</label>
                <input type="number" min="1" max="350" data-bind="hp.max" data-clamp="1:350" value="${data.hp.max}" />
                ${exhaustionLevel(data) >= 4 ? `<div class="muted" style="font-size:0.68rem;color:var(--red);" title="Истощение ${exhaustionLevel(data)}: максимум хитов уменьшен вдвое">Истощение: макс. ${effectiveMaxHp(data)}</div>` : ""}
              </div>
              <div class="col">
                <label>Хиты текущие</label>
                <input type="number" min="0" max="350" data-bind="hp.current" data-clamp="0:350" value="${data.hp.current}" />
              </div>
              <div class="col">
                <label>Временные хиты</label>
                <input type="number" min="0" max="350" data-bind="hp.temp" data-clamp="0:350" value="${data.hp.temp}" />
              </div>
            </div>
            <div class="row" style="margin-top:8px;gap:8px;align-items:center;">
              <input type="number" min="0" data-hp-delta-input style="width:64px;" value="1" />
              <button class="small danger" data-action="apply-damage">− Урон</button>
              <button class="small primary" data-action="apply-heal">+ Лечение</button>
            </div>
            ${exhaustionLevel(data) >= 6 ? `<div class="death-banner">Истощение 6 — персонаж мёртв</div>` : ""}
            ${Number(data.hp.current) === 0 ? `<div class="death-banner">Вы находитесь при смерти, в свой ход бросайте спасброски от смерти</div>` : ""}
            ${healingPotionsPanel()}
            <div class="grid cols-2" style="margin-top:10px;">
              <div class="col">
                <label>Кости хитов (напр. 3к8)</label>
                <div class="row">
                  <input type="number" style="width:60px;" data-bind="hitDice.current" value="${data.hitDice.current}" />
                  <span>из</span>
                  <input type="number" style="width:60px;" data-bind="hitDice.total" value="${data.hitDice.total}" />
                  <span>к</span>
                  <input type="number" style="width:60px;" data-bind="hitDice.die" value="${data.hitDice.die}" />
                </div>
              </div>
              <div class="row" style="align-items:center;gap:10px;">
                <div class="col" style="flex:1;gap:5px;">
                  <label style="margin:0;">Спасброски от смерти</label>
                  <div class="row">
                    <span class="muted">Успех</span>
                    <div class="dot-track">${[0, 1, 2].map((i) => `<div class="circle ${i < data.deathSaves.successes ? "filled" : ""}" data-action="death-success" data-index="${i}"></div>`).join("")}</div>
                  </div>
                  <div class="row">
                    <span class="muted">Провал</span>
                    <div class="dot-track">${[0, 1, 2].map((i) => `<div class="circle ${i < data.deathSaves.failures ? "filled" : ""}" data-action="death-failure" data-index="${i}"></div>`).join("")}</div>
                  </div>
                </div>
                ${d20Icon()}
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="row between"><h2 style="margin:0;">Кубики</h2></div>
            <div class="dice-panel-body">
              <div class="dice-panel-icon" title="к20">
                ${d20VectorSvg(56, "dice-panel-spinner")}
              </div>
              <div class="col" style="flex:1;gap:6px;">
                <div class="row" style="gap:6px;flex-wrap:nowrap;">
                  <select data-pool-die style="flex:1;">
                    ${[4, 6, 8, 10, 12, 20, 100].map((d) => `<option value="${d}" ${d === 20 ? "selected" : ""}>к${d}</option>`).join("")}
                  </select>
                  <span class="muted">×</span>
                  <input type="number" data-pool-count min="1" max="99" value="1" style="width:52px;text-align:center;flex:none;" title="Количество кубиков" />
                  <button class="small" data-action="add-to-pool" style="flex:none;">+ Добавить</button>
                </div>
              </div>
            </div>
            <div class="dice-pool-list">
              ${
                dicePool.length
                  ? dicePool.map((p, i) => `<span class="dice-pool-chip">${p.count}к${p.sides}<button data-action="remove-pool-die" data-index="${i}" title="Убрать">✕</button></span>`).join("")
                  : '<p class="muted" style="margin:6px 0;">Кубики пока не добавлены.</p>'
              }
            </div>
            <button data-action="roll-pool" class="primary" style="width:100%;margin-top:8px;" ${dicePool.length ? "" : "disabled"}>Бросить${dicePool.length ? ` (${dicePool.reduce((s, p) => s + p.count, 0)})` : ""}</button>
            <div class="dice-panel-log">
              <div class="row between" style="margin-top:10px;align-items:center;">
                <button type="button" class="small" data-action="toggle-roll-log-panel">${rollLogPanelOpen ? "▾" : "▸"} Журнал бросков</button>
                ${rollLogPanelOpen ? `<button class="small" data-action="clear-log" title="Очистить журнал">Очистить</button>` : ""}
              </div>
              ${rollLogPanelOpen ? `<div class="roll-log roll-log-inline" data-roll-log>${rollLogEntriesHtml()}</div>` : ""}
            </div>
          </div>
        </div>
      </div>`;
  }

  // Renders the roll-log entries markup shared by the inline panel on the
  // main tab; kept as its own function so it can be re-rendered in place
  // (via the dnd5e:roll-logged event) without re-rendering the whole page,
  // which would disrupt whatever the player is doing elsewhere on screen.
  function rollLogEntriesHtml() {
    const log = getRollLog();
    if (!log.length) return '<p class="muted" style="margin:6px 0;">Пока пусто — сделайте бросок.</p>';
    return log
      .map(
        (e) => `
      <div class="entry">
        <div>
          <div>${escapeHtml(e.label)}</div>
          <div class="muted">${escapeHtml(e.detail || "")}</div>
        </div>
        <div class="total ${e.isCrit ? "crit" : ""} ${e.isFumble ? "fumble" : ""}">${e.total}</div>
      </div>`
      )
      .join("");
  }

  function d20Icon() {
    return `<img class="d20-icon" src="assets/icons/d20-red.png" data-action="roll-death-save" width="90" height="90" alt="к20" title="Бросить спасбросок от смерти (к20)" />`;
  }

  function potionIcon(tierId) {
    const shapes = {
      common: `<path d="M10 2h6v4l4 7a7 7 0 1 1-14 0l4-7V2z" fill="#c0392b" stroke="#7a2015" stroke-width="1.2"/><rect x="9" y="1" width="8" height="2.2" rx="0.6" fill="#7a2015"/>`,
      greater: `<path d="M11 2h4v6c2 1 5 4 5 8a7 7 0 0 1-14 0c0-4 3-7 5-8V2z" fill="#c0392b" stroke="#7a2015" stroke-width="1.2"/><rect x="10" y="1" width="6" height="2.2" rx="0.6" fill="#7a2015"/><ellipse cx="13" cy="15" rx="2" ry="1.4" fill="#e0574a" opacity="0.8"/>`,
      superior: `<path d="M10 2h6v5l6 11a2.2 2.2 0 0 1-2 3.2H6a2.2 2.2 0 0 1-2-3.2l6-11V2z" fill="#c0392b" stroke="#7a2015" stroke-width="1.2"/><rect x="9" y="1" width="8" height="2.2" rx="0.6" fill="#7a2015"/>`,
      supreme: `<rect x="10" y="2" width="6" height="18" rx="3" fill="none" stroke="#7a2015" stroke-width="1.4"/><path d="M10.7 12a2.3 2.3 0 0 0 4.6 0v7a2.3 2.3 0 0 1-4.6 0v-7z" fill="#c0392b"/>`,
    };
    return `<svg class="potion-svg-icon" viewBox="0 0 26 26" width="28" height="28">${shapes[tierId] || shapes.common}</svg>`;
  }

  function healingPotionsPanel() {
    const potions = data.healingPotions || {};
    return `
      <div class="panel" style="margin-top:10px;background:var(--bg-panel-2);">
        <h3 style="margin-top:0;">Зелья лечения</h3>
        <div class="potion-list">
          ${HEALING_POTIONS.map((tier) => {
            const count = potions[tier.id] || 0;
            return `
            <div class="potion-row">
              ${potionIcon(tier.id)}
              <div class="potion-info">
                <div class="potion-name">${escapeHtml(tier.name)}</div>
                <div class="potion-dice muted">${tier.dice} хитов</div>
              </div>
              <div class="potion-controls">
                <button class="small" data-action="remove-potion" data-tier="${tier.id}" ${!count ? "disabled" : ""}>−</button>
                <span class="num">${count}</span>
                <button class="small" data-action="add-potion" data-tier="${tier.id}">+</button>
                <button class="small primary" data-action="drink-potion" data-tier="${tier.id}" ${!count ? "disabled" : ""}>Выпить</button>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }

  const AMMO_TYPES = [
    { id: "arrows", name: "Стрелы" },
    { id: "bolts", name: "Болты" },
    { id: "javelins", name: "Мет. копья" },
    { id: "darts", name: "Дротики" },
  ];

  // ---- Money calculator ---------------------------------------------
  // 10 copper = 1 silver, 10 silver = 1 gold, 10 gold = 1 platinum. Every
  // operation works on data.money directly (the same cells the inputs above
  // are bound to), so the cells always reflect the result.
  const COINS = [
    { id: "cp", name: "медная", nameGen: "медных", label: "М", fill: "#b87333", ring: "#7a4a1d", text: "#3b210a", value: 1 },
    { id: "sp", name: "серебряная", nameGen: "серебряных", label: "С", fill: "#c9ced4", ring: "#7c838c", text: "#3a4048", value: 10 },
    { id: "gp", name: "золотая", nameGen: "золотых", label: "З", fill: "#e2b93b", ring: "#9a7414", text: "#4a3608", value: 100 },
    { id: "pp", name: "платиновая", nameGen: "платиновых", label: "П", fill: "#e8f0f6", ring: "#6f95b3", text: "#2c4a63", value: 1000 },
  ];
  function coinSvg(c) {
    return `<svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">
      <circle cx="20" cy="20" r="18" fill="${c.fill}" stroke="${c.ring}" stroke-width="2"/>
      <circle cx="20" cy="20" r="13.5" fill="none" stroke="${c.ring}" stroke-width="1" stroke-dasharray="2 2"/>
      <text x="20" y="25.5" text-anchor="middle" font-size="15" font-weight="700" font-family="Manrope, sans-serif" fill="${c.text}">${c.label}</text>
    </svg>`;
  }
  function moneyCalculatorHtml() {
    const src = COINS.find((c) => c.id === coinCalc.coin) || COINS[2];
    return `
      <div class="coin-calc">
        <div class="coin-calc-coins">
          ${COINS.map((c) => `
            <button type="button" class="coin-btn ${c.id === coinCalc.coin ? "selected" : ""}" data-coin-pick="${c.id}" title="${c.name[0].toUpperCase() + c.name.slice(1)} монета">
              ${coinSvg(c)}
              <span class="num">${Number(data.money[c.id]) || 0}</span>
            </button>`).join("")}
        </div>
        <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="number" min="1" step="1" placeholder="Сколько" data-coin-amount value="${escapeHtml(coinCalc.amount)}" style="width:96px;" />
          <button type="button" class="small ${coinCalc.exchangeOpen ? "primary" : ""}" data-coin-op="exchange">Размен</button>
          <button type="button" class="small" data-coin-op="spend">Потратить</button>
          <button type="button" class="small" data-coin-op="gain">Получить</button>
        </div>
        ${coinCalc.exchangeOpen ? `
          <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;">
            <span class="muted" style="font-size:0.85rem;">Разменять ${escapeHtml(src.nameGen)} на:</span>
            ${COINS.filter((c) => c.id !== src.id).map((c) => `
              <button type="button" class="coin-btn small-coin" data-coin-exchange-to="${c.id}" title="Получить ${c.nameGen} монеты">${coinSvg(c)}</button>`).join("")}
          </div>` : ""}
        ${coinCalc.msg ? `<p class="coin-calc-msg ${coinCalc.err ? "err" : ""}">${escapeHtml(coinCalc.msg)}</p>` : ""}
      </div>`;
  }
  function coinCalcAmount() {
    const n = Math.floor(Number(coinCalc.amount));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function coinCalcFinish(msg, err) {
    coinCalc.msg = msg;
    coinCalc.err = !!err;
    if (!err) { coinCalc.amount = ""; coinCalc.exchangeOpen = false; }
    doSave();
    render();
  }
  function coinCalcSpend() {
    const c = COINS.find((x) => x.id === coinCalc.coin);
    const n = coinCalcAmount();
    if (!n) return coinCalcFinish("Введите число монет (от 1).", true);
    const have = Number(data.money[c.id]) || 0;
    if (n > have) return coinCalcFinish(`Недостаточно: в кошельке ${have} ${c.nameGen}, а нужно ${n}. Сначала разменяйте другие монеты.`, true);
    data.money[c.id] = have - n;
    coinCalcFinish(`Потрачено: ${n} ${c.nameGen}.`);
  }
  function coinCalcGain() {
    const c = COINS.find((x) => x.id === coinCalc.coin);
    const n = coinCalcAmount();
    if (!n) return coinCalcFinish("Введите число монет (от 1).", true);
    data.money[c.id] = (Number(data.money[c.id]) || 0) + n;
    coinCalcFinish(`Получено: ${n} ${c.nameGen}.`);
  }
  function coinCalcExchange(toId) {
    const from = COINS.find((x) => x.id === coinCalc.coin);
    const to = COINS.find((x) => x.id === toId);
    const n = coinCalcAmount();
    if (!n) return coinCalcFinish("Введите число монет (от 1).", true);
    const have = Number(data.money[from.id]) || 0;
    if (n > have) return coinCalcFinish(`Недостаточно: в кошельке ${have} ${from.nameGen}, а нужно разменять ${n}.`, true);
    if (from.value > to.value) {
      const gained = n * (from.value / to.value);
      data.money[from.id] = have - n;
      data.money[to.id] = (Number(data.money[to.id]) || 0) + gained;
      return coinCalcFinish(`Разменяно ${n} ${from.nameGen} на ${gained} ${to.nameGen}.`);
    }
    const ratio = to.value / from.value;
    const gained = Math.floor(n / ratio);
    if (gained < 1) return coinCalcFinish(`Чтобы получить 1 ${to.name} монету, нужно ${ratio} ${from.nameGen}.`, true);
    const used = gained * ratio;
    data.money[from.id] = have - used;
    data.money[to.id] = (Number(data.money[to.id]) || 0) + gained;
    coinCalcFinish(`Разменяно ${used} ${from.nameGen} на ${gained} ${to.nameGen}${used < n ? ` (остаток ${n - used} не хватает на целую монету и остаётся у вас)` : ""}.`);
  }

  function ammoPanel() {
    const ammo = data.ammo || {};
    return `
      <div class="panel panel-tight ammo-panel">
        <h2 style="font-size:1.05rem;">Боеприпасы</h2>
        <div class="money-row" style="gap:8px;">
          ${AMMO_TYPES.map((t) => `
            <div class="money-box" style="width:68px;gap:1px;">
              <label style="white-space:nowrap;">${t.name}</label>
              <input type="number" min="0" data-bind="ammo.${t.id}" value="${ammo[t.id] || 0}" />
            </div>`).join("")}
        </div>
        <p class="muted" style="font-size:0.82rem;margin-top:4px;margin-bottom:0;">Тратятся автоматически при броске дальнобойной атаки: лук → стрелы, арбалет → болты, метательное копьё → копья, дротик → дротики.</p>
      </div>`;
  }

  // Maps a weapon/attack name to the ammo type it consumes on a ranged
  // attack roll (лук → стрелы, арбалет → болты, копьё → копья, дротик → дротики).
  function ammoTypeForWeapon(name) {
    const n = (name || "").toLowerCase();
    if (n.includes("арбалет")) return "bolts";
    if (n.includes("лук")) return "arrows";
    if (n.includes("дротик")) return "darts";
    if (n.includes("копь")) return "javelins";
    return null;
  }

  function attacksTab() {
    return `
      <div class="panel attacks-panel">
        <div class="row between"><h2 style="margin:0;">Атаки</h2><button class="small" data-action="add-attack">+ Атака</button></div>
        <p class="muted" style="font-size:0.85rem;margin:-6px 0 10px;">Дальнобойное оружие всегда атакует от ловкости, ближнего боя — от силы, кроме метательного и фехтовального.</p>
        <table class="sheet-table attacks-table">
          <thead><tr><th style="width:96px;">Название</th><th style="width:50px;">Хар-ка</th><th style="width:38px;">Бонус</th><th style="width:68px;">Урон/тип</th><th style="width:86px;">Дальность</th><th style="width:64px;">Рука</th><th style="width:16%;">Особые свойства</th><th style="width:150px;"></th></tr></thead>
          <tbody>
            ${(data.attacks || [])
              .map(
                (a, i) => `
              <tr>
                <td><input type="text" data-attack-field="name" data-attack-index="${i}" value="${escapeHtml(a.name)}" /></td>
                <td>
                  <select data-attack-ability data-attack-index="${i}">
                    <option value="">—</option>
                    ${ABILITIES.map((ab) => `<option value="${ab.id}" ${a.ability === ab.id ? "selected" : ""}>${ab.short || ab.label}</option>`).join("")}
                  </select>
                </td>
                <td><input type="text" data-attack-field="bonus" data-attack-index="${i}" value="${a.ability ? formatModifier(attackBonusValue(a)) : escapeHtml(a.bonus ?? "")}" placeholder="+5" ${a.ability ? "readonly title=\"Считается автоматически: модификатор характеристики + бонус мастерства, растёт вместе с уровнем\"" : ""} /></td>
                <td><input type="text" data-attack-field="damage" data-attack-index="${i}" value="${escapeHtml(a.damage ?? "")}" placeholder="1к8+3 рубящий" /></td>
                <td>
                  <select data-attack-range-type data-attack-index="${i}" title="Ближний бой / дальнобойное / метательное — используется боевыми стилями (напр. «Стрельба из лука», «Дуэлянт»)">
                    <option value="">—</option>
                    ${Object.entries(WEAPON_RANGE_TYPE_LABELS).map(([id, label]) => `<option value="${id}" ${a.rangeType === id ? "selected" : ""}>${label}</option>`).join("")}
                  </select>
                </td>
                <td>
                  <button type="button" class="small" style="width:100%;" data-action="cycle-attack-hand" data-index="${i}" title="В какой руке оружие — влияет на «Использование двух оружий» и другие подобные умения">${escapeHtml(ATTACK_HAND_LABELS[a.hand] || "—")}</button>
                </td>
                <td><input type="text" data-attack-field="special" data-attack-index="${i}" value="${escapeHtml(a.special ?? "")}" placeholder="напр. +1к6 огонь" /></td>
                <td class="row attack-actions" style="gap:3px;">
                  <button class="small" data-action="roll-attack" data-index="${i}" title="Бросок атаки">🎲 Атака</button>
                  <button class="small" data-action="roll-attack-damage" data-index="${i}" title="Бросок урона">🎲 Урон</button>
                  <button class="small" data-action="roll-attack-crit" data-index="${i}" title="Критический успех: все кубы урона удваиваются">💥 Крит</button>
                  <button class="small danger" data-action="remove-attack" data-index="${i}">✕</button>
                </td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        ${(data.attacks || []).length === 0 ? '<p class="muted">Атак пока нет — добавьте первую.</p>' : ""}
      </div>`;
  }

  // Extracts the first dice expression from free text (supports both "к" and
  // "d" die notation), for auto-including a weapon's "особые свойства" bonus
  // dice in damage rolls, and for rolling a weapon's base damage.
  function parseDiceFromText(text) {
    if (!text) return null;
    const m = String(text).match(/(\d*)\s*[dк](\d+)\s*([+-]\s*\d+)?/i);
    if (!m) return null;
    const count = m[1] || "1";
    const sides = m[2];
    const mod = m[3] ? m[3].replace(/\s+/g, "") : "";
    return { expr: `${count}d${sides}${mod}`, raw: m[0].trim() };
  }

  // A "универсальное (1кX)" weapon can be swung one- or two-handed, each
  // with its own damage die (e.g. Секира: 1к8 one-handed, 1к10 two-handed
  // via "универсальное"). Attacks don't store the weapon's own `properties`
  // text the way inventory weapons do (see WEAPONS catalog), so this looks
  // the attack's own name up against the catalog by name to find it --
  // works for the common case of an attack added via "→ Атаки" from a
  // matching inventory weapon, or just named the same as a catalog weapon.
  // "В какой руке оружие" — a manual-override tracker (see the "Рука" column
  // in attacksTab and the auto-assignment on add-weapon-to-attacks below),
  // used by Использование двух оружий's AC bonus and available for any
  // future one-hand/two-hand-dependent mechanic. `a.hand` is one of these
  // keys, or unset/"" for an attack that was never assigned one (e.g. an
  // attack typed in by hand rather than added from a weapon).
  const ATTACK_HAND_CYCLE = ["right", "left", "both", "removed"];
  const ATTACK_HAND_LABELS = { right: "Правая", left: "Левая", both: "Две руки", removed: "Снято" };
  // Classifies a weapon's "properties" text into how many hands it needs --
  // twёручное wins over универсальное (a weapon is never both), and
  // anything else (including ranged weapons like longbows, which are
  // themselves двуручное and already caught by the first check) defaults to
  // one-handed.
  function weaponHandCategoryFromProperties(properties) {
    const p = String(properties || "").toLowerCase();
    if (/двуручное/.test(p)) return "two-handed";
    if (/универсальное/.test(p)) return "versatile";
    return "one-handed";
  }
  // Auto-assigned hand for a newly-added weapon attack, per the rule the
  // user asked for: two-handed → both hands; versatile → right hand (it CAN
  // be wielded two-handed, but defaults to the more common one-handed use);
  // one-handed → right hand for the first one, left for a second, and
  // "removed" (nowhere left to hold it) for a third. Looks at whichever
  // hand slots are already occupied across ALL existing attacks (not just
  // other one-handed ones), so a versatile/two-handed weapon already
  // sitting in a hand is correctly treated as "taken".
  function autoAssignAttackHand(properties) {
    const category = weaponHandCategoryFromProperties(properties);
    if (category === "two-handed") return "both";
    if (category === "versatile") return "right";
    const takenHands = new Set((data.attacks || []).map((at) => at.hand).filter(Boolean));
    if (takenHands.has("both")) return "removed";
    if (!takenHands.has("right")) return "right";
    if (!takenHands.has("left")) return "left";
    return "removed";
  }
  // «Мастер большого оружия»'s -5/+10 only applies to a "тяжёлое" melee
  // weapon the character is making a Ближний бой attack with -- looked up
  // by name against the catalog, same "attacks don't store the weapon's own
  // properties text" approach versatileDieSidesForAttack uses right below.
  function weaponIsHeavyMelee(a) {
    if (!a || !a.name || a.rangeType === "ranged") return false;
    const w = WEAPONS.find((ww) => ww.name.toLowerCase() === a.name.trim().toLowerCase());
    return !!(w && /тяжёлое|тяжелое/i.test(w.properties || ""));
  }
  function versatileDieSidesForAttack(a) {
    if (!a || !a.name) return null;
    const w = WEAPONS.find((w) => w.name.toLowerCase() === a.name.trim().toLowerCase());
    const props = w && w.properties;
    if (!props) return null;
    const m = /универсальное\s*\(\s*\d*к(\d+)\s*\)/i.exec(props);
    return m ? m[1] : null;
  }
  // Swaps only the die SIDES in an already-parsed dice expression (keeping
  // the die count and any flat modifier untouched) -- used to turn a
  // versatile weapon's one-handed base damage into its two-handed one right
  // before the usual crit-doubling/Savage-Attacks/etc. logic runs on it.
  function applyVersatileDie(base, sides) {
    return {
      expr: base.expr.replace(/^(\d*)d\d+/i, `$1d${sides}`),
      raw: base.raw.replace(/(\d*)\s*[dк]\d+/i, (m, count) => `${count}к${sides}`),
    };
  }

  // Characters created before a given data-file fix keep whatever short (or
  // even empty) description was baked in at creation time -- new characters
  // get the full text, but existing ones don't retroactively change. This
  // looks up the current canonical text for a feature by name, so an
  // already-created character can pull in whatever fuller text is now on
  // file for a feature of that name.
  //
  // `source` (the feature card's own "Источник" field, e.g. "Дварф",
  // "Воин", or "Жрец — Домен войны" for a subclass feature -- see
  // addFeatureOrFold()/applySubclassFeatures() and subclassFeatureSource())
  // is used FIRST to scope the search to the one race/class/subclass that
  // actually granted this feature. Several unrelated entries across the
  // whole data file can share the exact same feature name -- e.g. every
  // Artificer subclass has its own level-3 "Владение инструментами" with
  // completely different text -- so a bare name-only search (the old
  // behaviour, still used below as a last-resort fallback for source-less
  // or edited data) can silently offer to overwrite a card with some
  // unrelated entity's text of the same name.
  function findKnownFeatureText(name, source) {
    if (!name) return null;
    const n = name.trim().toLowerCase();
    const src = (source || "").trim().toLowerCase();
    if (src) {
      const dashIdx = src.indexOf(" — ");
      if (dashIdx !== -1) {
        // "<Class> — <Subclass>": an actual subclass feature card.
        const clsPart = src.slice(0, dashIdx);
        const subPart = src.slice(dashIdx + 3);
        const cls = CLASSES.find((c) => c.name.toLowerCase() === clsPart);
        const sub = cls && (cls.subclasses || []).find((s) => s.name.toLowerCase() === subPart);
        const sf = sub && (sub.features || []).find((f) => (f.name || "").toLowerCase() === n);
        if (sf) { const psiSplit = splitSubFeatureCards(sub, sf); return psiSplit ? psiSplit.intro : subclassFeatureDescText(sub, sf); }
      } else {
        // Source is a bare class name: either that class's own
        // classFeatureText, or the "intro" card for one of its subclasses
        // (filed under the class's name, not "<Class> — <Subclass>" --
        // see applySubclassFeatures()/doFinish()).
        const cls = CLASSES.find((c) => c.name.toLowerCase() === src);
        if (cls) {
          if (cls.classFeatureText) {
            const key = Object.keys(cls.classFeatureText).find((k) => k.toLowerCase() === n);
            if (key) return cls.classFeatureText[key];
          }
          const sub = (cls.subclasses || []).find((s) => s.name.toLowerCase() === n || n.endsWith(`: ${s.name.toLowerCase()}`));
          if (sub && sub.intro) return sub.intro;
        } else {
          // Source is a race or subrace name.
          for (const race of RACES) {
            if (race.name.toLowerCase() === src) {
              const t = (race.traits || []).find((t) => (t.name || "").toLowerCase() === n);
              if (t && t.desc) return t.desc;
            }
            const subrace = (race.subraces || []).find((s) => s.name.toLowerCase() === src);
            if (subrace) {
              const st = (subrace.traits || []).find((t) => (t.name || "").toLowerCase() === n);
              if (st && st.desc) return st.desc;
            }
          }
        }
      }
    }
    // Fallback: no source on file, or the scoped search above found
    // nothing under it (e.g. a hand-edited source) -- best-effort global
    // search by name alone, same as before this function took a source.
    for (const cls of CLASSES) {
      if (cls.classFeatureText) {
        const key = Object.keys(cls.classFeatureText).find((k) => k.toLowerCase() === n);
        if (key) return cls.classFeatureText[key];
      }
      for (const sub of cls.subclasses || []) {
        if ((sub.name || "").toLowerCase() === n && sub.intro) return sub.intro;
        const sf = (sub.features || []).find((f) => (f.name || "").toLowerCase() === n);
        if (sf) { const psiSplit = splitSubFeatureCards(sub, sf); return psiSplit ? psiSplit.intro : subclassFeatureDescText(sub, sf); }
      }
    }
    for (const race of RACES) {
      const t = (race.traits || []).find((t) => (t.name || "").toLowerCase() === n);
      if (t && t.desc) return t.desc;
      // Most of a race's actual trait text lives on its subraces (e.g. a
      // Gnome's "Умелец" is only on rock-gnome, never on the base Gnome) --
      // without this, "↻ Обновить описание из базы" never finds anything
      // for a subrace trait, no matter how much fuller the data-file text is.
      for (const sub of race.subraces || []) {
        const st = (sub.traits || []).find((t) => (t.name || "").toLowerCase() === n);
        if (st && st.desc) return st.desc;
      }
    }
    return null;
  }

  // A handful of features roll a *variable* number of dice tied to the
  // character's current proficiency bonus (e.g. the Mordenkainen Presents
  // Aasimar's "Исцеляющие руки": "бросить количество к4, равное вашему
  // бонусу мастерства" -- roll a number of d4s equal to proficiency bonus).
  // plain parseDiceFromText would grab just the bare "к4" and silently roll
  // only 1d4, dropping the scaling -- this catches that phrasing first and
  // computes the real die count from the character's current level.
  function parseProficiencyScaledDice(text) {
    if (!text) return null;
    const m = String(text).match(/количество\s+[dк](\d+)[^.]{0,40}?равн\S*\s+(?:вашему\s+)?бонусу мастерства/i);
    if (!m) return null;
    const pb = proficiencyBonus(data);
    return { expr: `${pb}d${m[1]}`, raw: `${pb}к${m[1]} (бонус мастерства)` };
  }
  // The single entry point for "does this feature have a die roll, and what
  // is it" -- used both to decide whether the 🎲 button shows on a feature
  // card and to actually roll when it's clicked, so the two can't disagree.
  function featureDiceInfo(desc) {
    return parseProficiencyScaledDice(desc) || parseDiceFromText(desc);
  }

  // Many racial/class features that force a saving throw spell out their DC
  // formula right in the description text -- always "8 + бонус мастерства +
  // модификатор <характеристика>", but scraped from different sourcebooks in
  // either order ("Сл = 8 + модификатор Телосложения + бонус мастерства)"
  // for Дыхание дракона, "Сл 8 + ваш бонус мастерства + ваш модификатор
  // Харизмы" elsewhere). Rather than hardcode this per feature, pull the
  // ability out of whichever order it appears in and compute the DC live
  // from the character's current stats, so it stays right next to the 🎲
  // roll button instead of making the player do 8 + mod + PB by hand.
  function featureSaveDCInfo(desc) {
    if (!desc) return null;
    const text = String(desc);
    const abilityRe = "(Силы|Ловкости|Телосложения|Интеллекта|Мудрости|Харизмы)";
    let m = text.match(new RegExp(`Сл[^.]{0,15}?8\\s*\\+[^.]{0,60}?модификатор[а-я]*\\s+${abilityRe}[^.]{0,40}?бонус мастерства`, "i"));
    let abilityName = m && m[1];
    if (!abilityName) {
      m = text.match(new RegExp(`Сл[^.]{0,15}?8\\s*\\+[^.]{0,40}?бонус мастерства[^.]{0,60}?модификатор[а-я]*\\s+${abilityRe}`, "i"));
      abilityName = m && m[1];
    }
    if (!abilityName) return null;
    const abilityId = USES_ABILITY_WORDS[abilityName.toLowerCase()];
    const dc = 8 + proficiencyBonus(data) + getAbilityMod(data, abilityId);
    return { dc, abilityId };
  }

  // Some race/class features come with a limited number of uses that
  // refresh on a rest -- either a flat number ("не более одного раза за
  // короткий или продолжительный отдых") or a formula tied to an ability
  // modifier ("количество раз, равное вашему модификатору Мудрости, минимум
  // один"). Scanned straight from the feature's own description text (the
  // scraped dnd.su wording), rather than a separate structured field, since
  // that's the only place this information lives for now.
  const USES_ABILITY_WORDS = { "силы": "str", "ловкости": "dex", "телосложения": "con", "интеллекта": "int", "мудрости": "wis", "харизмы": "cha" };
  const RU_NUMBER_WORDS = { "один": 1, "одна": 1, "одно": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6 };
  function ruNumberToInt(raw) {
    const w = raw.toLowerCase();
    return RU_NUMBER_WORDS[w] ?? parseInt(raw, 10);
  }
  function parseUsesFromText(desc) {
    if (!desc) return null;
    const text = String(desc);
    // Recharge wording varies a lot across scraped trait text: "короткого
    // отдыха" (short), "продолжительного отдыха" (long, PHB phrasing) but
    // also "долгий отдых" / "длинный отдых" (long, shorthand phrasing used
    // by several abridged supplement-book traits below).
    const rechargeOf = (span) => {
      const shortMatch = /коротк(ого|ий)/i.test(span);
      const longMatch = /(продолжительн(ого|ый)|долг(ого|ий)|длинн(ого|ый))/i.test(span);
      if (shortMatch && longMatch) return "any";
      if (shortMatch) return "short";
      if (longMatch) return "long";
      return null;
    };
    // "...количество раз, равное вашему бонусу мастерства" (Fizban's
    // Дыхание дракона, and any future feature phrased the same way).
    const pbMatch = text.match(/равн[а-я]*\s+(?:ваш[а-я]*\s+)?бонус[а-я]*\s+мастерства/i);
    if (pbMatch) {
      return { max: Math.max(1, proficiencyBonus(data)), recharge: rechargeOf(text) };
    }
    // "...равное 1 + модификатор Харизмы" (Паладин: Чувство божественного)
    const plusMatch = text.match(/равн[а-я]*\s+(\d+)\s*\+\s*модификатор[а-я]*\s+(Силы|Ловкости|Телосложения|Интеллекта|Мудрости|Харизмы)/i);
    if (plusMatch) {
      const abilityId = USES_ABILITY_WORDS[plusMatch[2].toLowerCase()];
      const base = parseInt(plusMatch[1], 10);
      const mod = getAbilityMod(data, abilityId);
      return { max: Math.max(0, base + mod), recharge: rechargeOf(text) };
    }
    // "...модификатору Мудрости... минимум 1 раз" / "минимум один"
    // "модификатору вашей Мудрости" (Сыщик «Безошибочный взгляд») has a
    // possessive word between "модификатор..." and the ability name that
    // "равн[а-я]* ... модификатор Х" phrasing elsewhere doesn't -- optional
    // so it still matches text without it.
    const modMatch = text.match(/модификатор[а-я]*\s+(?:ваш(?:ей|его)?|сво(?:ей|его))?\s*(Силы|Ловкости|Телосложения|Интеллекта|Мудрости|Харизмы)[^.]{0,60}?минимум\s+(\d+|один|одна|одно|два|три|четыре|пять)/i);
    if (modMatch) {
      const abilityId = USES_ABILITY_WORDS[modMatch[1].toLowerCase()];
      const min = ruNumberToInt(modMatch[2]);
      const mod = getAbilityMod(data, abilityId);
      return { max: Math.max(min, mod), recharge: rechargeOf(text) };
    }
    // «Вы можете использовать это умение три раза» / «У вас есть два использования этой способности» + восстановление после отдыха
    const wordCount = text.match(/(?:использовать[^.]{0,40}\s|(?:у вас )?есть\s+)(один|одно|два|две|три|четыре|пять|шесть)\s+(?:раза?|использовани[яй])/i);
    if (wordCount && rechargeOf(text)) {
      return { max: ruNumberToInt(wordCount[1]), recharge: rechargeOf(text) };
    }
    // "N/короткий отдых" style shorthand
    // \w doesn't match Cyrillic letters in JS regex, so the word endings
    // ("...ий отдых" vs "...ого отдыха") are spelled out with a Cyrillic
    // class instead of \w*.
    const shorthand = text.match(/(\d+)\s*\/\s*(коротк[а-яё]*|продолжительн[а-яё]*|долг[а-яё]*|длинн[а-яё]*)\s*отдых/i);
    if (shorthand) return { max: parseInt(shorthand[1], 10), recharge: rechargeOf(shorthand[2]) || "short" };
    // "не более одного раза за короткий/продолжительный отдых" / "не можете
    // использовать это умение снова, не завершив короткого...отдыха" / "не
    // можете применить его снова, пока не завершите короткий или
    // продолжительный отдых" (PHB Дыхание дракона phrasing) / "не можете
    // использовать её снова, пока не закончите продолжительный отдых"
    // (Aasimar phrasing -- "закончите" instead of "завершите") / "не
    // сможете вновь воспользоваться этой способностью, пока не закончите
    // продолжительный отдых" (Volo's Aasimar phrasing -- "сможете" instead
    // of "можете", "воспользоваться" instead of "использовать/применить").
    // The bit between the verb and the comma is left as a generic
    // [^,.]* rather than an enumerated word list, since it varies with the
    // grammatical case of whatever noun phrase names the feature.
    if (
      /не более (одного|1) раза за/i.test(text) ||
      // "до окончания короткого/продолжительного отдыха" covers the
      // "...повторно до окончания X отдыха" phrasing used across dozens of
      // features in this data set (e.g. Плут «Вор заклинаний») -- it's its
      // own branch here rather than folded into the catch-all below since
      // it needs to win even when the text ALSO contains "снова"/"повторно"
      // nowhere near "отдых" (the catch-all's proximity window is narrower).
      /не (можете|сможете)(\s+вновь)?\s+(использовать|применить|воспользоваться)[^,.]*,?\s*(не завершив|пока не (завершите|закончите)|до окончания)/i.test(text)
    ) {
      return { max: 1, recharge: rechargeOf(text) || "short" };
    }
    // Abridged/shorthand trait summaries (several supplement-book races are
    // stored as a compressed one-liner rather than the full PHB-style
    // paragraph): "раз за отдых", "раз в долгий отдых", "раз до короткого
    // отдыха", "восстанавливается после отдыха", "перезарядка после отдыха".
    // The recharge-word group is followed by \s* (not appended directly),
    // since it's normally a declined adjective separated from "отдых" by a
    // space ("короткого отдыха"), not a prefix glued onto it.
    if (
      /раз\s+(в|за|до)\s+(коротк[а-яё]*|продолжительн[а-яё]*|долг[а-яё]*|длинн[а-яё]*)?\s*отдых/i.test(text) ||
      /(восстанавливается|перезарядка)\s+(после|за)\s+(коротк[а-яё]*|продолжительн[а-яё]*|долг[а-яё]*|длинн[а-яё]*)?\s*отдых/i.test(text)
    ) {
      return { max: 1, recharge: rechargeOf(text) || "any" };
    }
    // Catch-all: any feature whose text says, in whatever grammatical
    // construction, that using it again requires a rest first ("...чтобы
    // использовать его снова", "...прежде чем сможете использовать это
    // умение снова", "...не можете сделать это снова, пока не закончите
    // отдых", etc.) -- the specific patterns above only cover a handful of
    // the many phrasings actually used across the data file (e.g. "Второе
    // дыхание"'s own "Использовав это умение, вы должны закончить
    // короткий или продолжительный отдых, чтобы использовать его снова"
    // isn't "не можете...", so it slips past every earlier check). Every
    // one-use-per-rest feature mentions both "отдых" and "снова" close
    // together, regardless of exact wording, so this is a safe general
    // fallback rather than a name-specific special case.
    if (/((снова|повторно)[^.]{0,100}отдых|отдых[а-яё]*[^.]{0,100}(снова|повторно))/i.test(text)) {
      return { max: 1, recharge: rechargeOf(text) || "any" };
    }
    return null;
  }
  // Renders the little pip row for a feature's uses, if its text describes
  // any -- filled pip = an available use, empty = already spent. State is
  // an array of booleans on the feature itself (data.features[i].usesState),
  // resized on the fly to whatever the formula currently computes to (an
  // ability-mod-based max can change as the sheet's abilities change).
  // «Божественный канал»: every card of a class (the class's own plus each
  // domain/oath option) shares ONE pool of charges, kept on
  // data.channelUses[class] instead of on each card.
  function channelPoolKey(f) {
    if (!/^(Божественный канал|Направление божества)/i.test(f.name || "")) return null;
    const src = f.source || "";
    if (/^Жрец/i.test(src)) return "cleric";
    if (/^Паладин/i.test(src)) return "paladin";
    return null;
  }
  function channelPoolMax(key) {
    const e = (data.classes || []).find((c) => c.id === key);
    const lvl = e && e.level ? Number(e.level) : 0;
    if (key === "cleric") return lvl >= 18 ? 3 : lvl >= 6 ? 2 : lvl >= 2 ? 1 : 0;
    if (key === "paladin") return lvl >= 3 ? 1 : 0;
    return 0;
  }
  function setFeatureUsesState(f, arr) {
    const key = channelPoolKey(f);
    if (key) { data.channelUses = data.channelUses || {}; data.channelUses[key] = arr; }
    else f.usesState = arr;
  }
  function usesArrayFor(f, max) {
    const key = channelPoolKey(f);
    const src = key ? (data.channelUses || {})[key] : f.usesState;
    const arr = Array.isArray(src) ? src.slice(0, max) : [];
    while (arr.length < max) arr.push(true);
    return arr;
  }
  const RECHARGE_LABEL = { short: "восст.: короткий отдых", long: "восст.: продолжительный отдых", any: "восст.: отдых" };
  // "Бардовское вдохновение"'s own text states its use count as "равное
  // модификатору Харизмы (минимум раз в день)" -- no numeral for
  // parseUsesFromText's "минимум N" pattern to catch (it's "минимум раз",
  // not "минимум 1 раз"), so this feature gets an explicit forced count via
  // maxBardInspirationUses() instead of relying on the generic text parser.
  const BARD_INSPIRATION_FEATURE_NAME = /^Бардовское вдохновение/i;
  // Rage's own text points at a level table ("смотрите колонку «ярость»
  // таблицы «Варвар»") instead of spelling out a number, so parseUsesFromText
  // has nothing to parse -- forced count by Barbarian level instead (PHB
  // table: 2 at 1-2, 3 at 3-5, 4 at 6-11, 5 at 12-16, 6 at 17-19, unlimited
  // at 20). Matched by exact name so "Ярость мелкого"/"Ярость шторма"/
  // "Ярость превыше смерти" (other features that just start with the same
  // word) aren't caught too.
  const RAGE_FEATURE_NAME = /^Ярость$/i;
  // Второе дыхание's own text spells out its scaling in words ("1к10 + ваш
  // уровень воина") rather than a number parseDiceFromText/featureDiceInfo
  // could pick up -- so its 🎲 button (wired below) adds the Fighter class's
  // CURRENT level as a flat bonus on top of the parsed "1к10" itself,
  // instead of baking a number in at creation time. That means it stays
  // correct after a level-up with no extra bookkeeping (see applyLevelUp
  // above), the same way Ярость's use count already does for level.
  const SECOND_WIND_FEATURE_NAME = /^Второе дыхание/i;
  // Клинок души «Псионическая сила»'s own die grows with Rogue level (к6 at
  // 3rd, к8 at 5th, к10 at 11th, к12 at 17th) -- same idea as
  // SECOND_WIND_FEATURE_NAME's level-dependent bonus above, just a die SIZE
  // instead of a flat add-on, so it's substituted into both the roll button
  // (see the noRollButton/dice override in the feature-card render loop)
  // and the actual roll (below) instead of relying on the static "к6" baked
  // into the card's stored desc text.
  const PSIONIC_POWER_FEATURE_NAME = /^Псионическая сила$/i;
  function rogueLevel(data) {
    const r = (data.classes || []).find((c) => c.id === "rogue");
    return r && r.level ? r.level : 0;
  }
  // Фантом «Могильные вопли»: "половина костей «Скрытой атаки» на вашем
  // уровне (с округлением в большую сторону)" -- no literal "Nк6" anywhere
  // in the text for featureDiceInfo's generic dice-in-text scan to find, so
  // this computes it straight from the same sneak-attack-dice formula
  // sneakAttackDice() already uses.
  const GRAVE_MIGHT_FEATURE_NAME = /^Могильные вопли$/i;
  function graveyardShriekDice() {
    const sneak = sneakAttackDice();
    if (!sneak) return null;
    const sneakCount = Number(/^(\d+)/.exec(sneak.raw)?.[1] || 0);
    if (!sneakCount) return null;
    const count = Math.max(1, Math.ceil(sneakCount / 2));
    return { expr: `${count}d6`, raw: `${count}к6` };
  }
  // Пси-воин: «Защитное поле» / «Псионический удар» — кость псионической энергии + модификатор Интеллекта
  const PSI_WARRIOR_POWER_CARD = /^(Защитное поле|Псионический удар)$/i;
  function psiWarriorPowerDice() {
    const mod = getAbilityMod(data, "int");
    const sides = psionicDieSides(data);
    return { expr: `1d${sides}${mod ? (mod > 0 ? "+" : "") + mod : ""}`, raw: `1к${sides}${mod ? formatModifier(mod) : ""}` };
  }
  function psionicDieSides(data) {
    const lvl = Math.max(rogueLevel(data), fighterLevel(data));
    if (lvl >= 17) return 12;
    if (lvl >= 11) return 10;
    if (lvl >= 5) return 8;
    return 6;
  }
  function fighterLevel(data) {
    const f = (data.classes || []).find((c) => c.id === "fighter");
    return f && f.level ? f.level : 0;
  }
  // Всплеск действий/Неутомимость scale with Fighter level (2 uses of
  // Action Surge from 17, 2/3 uses of Indomitable from 13/17) but their own
  // текст spells this out in words ("дважды", "смотрите уровень") rather
  // than a bare numeral parseUsesFromText could catch -- forced count by
  // level, same pattern as Ярость above.
  const ACTION_SURGE_FEATURE_NAME = /^Всплеск действий$/i;
  const INDOMITABLE_FEATURE_NAME = /^Неутомимость$/i;
  function maxActionSurgeUses(data) {
    return fighterLevel(data) >= 17 ? 2 : 1;
  }
  function maxIndomitableUses(data) {
    const lvl = fighterLevel(data);
    if (lvl >= 17) return 3;
    if (lvl >= 13) return 2;
    return 1;
  }
  function warlockLevel(data) {
    const w = (data.classes || []).find((c) => c.id === "warlock");
    return w && w.level ? w.level : 0;
  }
  // Genie patron's "Сосуд гения" card describes several sub-abilities in one
  // block of prose, one of which ("Гнев гения") happens to say "...равный
  // вашему бонусу мастерства" -- parseUsesFromText's generic "N = proficiency
  // bonus" pattern latches onto THAT unrelated damage-bonus phrase and
  // reports 2 uses/long rest, when the feature's actual limited resource
  // ("Передышка на дне бутылки": can't re-enter the vessel again until a
  // long rest) is a flat one-per-long-rest. Forced count, same as the
  // Arcane Recovery-style special cases above.
  const GENIE_VESSEL_FEATURE_NAME = /^Сосуд гения$/i;
  // Celestial patron's "Лечащий свет": a pool of d6s (1 + warlock level, not
  // a flat "1 use") spent in a player-chosen amount per use (up to the
  // Charisma modifier) -- resolveFeatureUses() is bypassed for this one
  // entirely in favour of the dedicated dice-pool tracker below (see
  // featureResourceHtml), same idea as "Возложение рук"'s point pool.
  const HEALING_LIGHT_FEATURE_NAME = /^Лечащий свет$/i;
  function healingLightPoolMax(data) {
    return 1 + warlockLevel(data);
  }
  function healingLightMaxDicePerUse(data) {
    return Math.max(1, getAbilityMod(data, "cha"));
  }
  function maxRageUses(data) {
    const barb = (data.classes || []).find((c) => c.id === "barbarian");
    const lvl = barb && barb.level ? barb.level : totalLevel(data);
    if (lvl >= 20) return Infinity;
    if (lvl >= 17) return 6;
    if (lvl >= 12) return 5;
    if (lvl >= 6) return 4;
    if (lvl >= 3) return 3;
    return 2;
  }
  // Battle Master's superiority dice: "У вас есть четыре кости
  // превосходства... Вы получаете ещё по одной кости превосходства на 7-м
  // и 15-м уровнях" (count, tied to Fighter level, not parseable from a
  // fixed number) and "Ваша кость превосходства увеличивается до к10. На
  // 18-м уровне — до к12" (die size, a separate feature card entirely) --
  // both forced from the live Fighter level rather than parsed, same as
  // Ярость's count above.
  const BATTLEMASTER_SUPERIORITY_FEATURE_NAME = /^Боевое превосходство$/i;
  // «Воинский адепт»'s own superiority-die pool card, deliberately named and
  // tracked separately from BATTLEMASTER_SUPERIORITY_FEATURE_NAME above --
  // it's a fixed к6/1-die pool that never scales with Fighter level (its own
  // text: "кость превосходства останется у вас даже если позже вы получите
  // новые кости из другого источника"), so merging it into the same card
  // name would have it wrongly inherit a Battle Master Fighter's bigger die
  // and level-scaled pool size.
  const MARTIAL_ADEPT_SUPERIORITY_FEATURE_NAME_TEXT = "Боевое превосходство (Воинский адепт)";
  const MARTIAL_ADEPT_SUPERIORITY_FEATURE_NAME = /^Боевое превосходство \(Воинский адепт\)$/i;
  function hasBattlemaster() {
    return (data.features || []).some((f) => BATTLEMASTER_SUPERIORITY_FEATURE_NAME.test(f.name || ""));
  }
  function superiorityDieSides(data) {
    const lvl = fighterLevel(data);
    if (lvl >= 18) return 12;
    if (lvl >= 10) return 10;
    return 8;
  }
  function superiorityDieMax(data) {
    if (!hasBattlemaster()) return 0;
    const lvl = fighterLevel(data);
    let max = 4;
    if (lvl >= 7) max += 1;
    if (lvl >= 15) max += 1;
    return max;
  }
  function superiorityFeatureIndex() {
    return (data.features || []).findIndex((f) => BATTLEMASTER_SUPERIORITY_FEATURE_NAME.test(f.name || ""));
  }
  function superiorityDiceAvailable() {
    const i = superiorityFeatureIndex();
    if (i === -1) return 0;
    const arr = usesArrayFor(data.features[i], superiorityDieMax(data));
    return arr.filter(Boolean).length;
  }
  // Spends one superiority die from the pool -- used both by the pip row's
  // own 🎲 roll button (below) and by the "добавить кость превосходства"
  // checkbox on the attack-roll and damage-roll modals, so all three ways
  // of using one stay in sync with the same pip state.
  function consumeSuperiorityDie() {
    const i = superiorityFeatureIndex();
    if (i === -1) return false;
    const arr = usesArrayFor(data.features[i], superiorityDieMax(data));
    const idx = arr.findIndex(Boolean);
    if (idx === -1) return false;
    arr[idx] = false;
    data.features[i].usesState = arr;
    doSave();
    return true;
  }
  // ---- Стихийные практики монаха: применение с дополнительными очками ци ------------------------------------
  // ki — базовая стоимость; spell — заклинание (level — его базовый круг, upcast — усиливается очками ци);
  // dmg — практика с уроном, растущим на 1к10 за каждое дополнительное очко ци.
  const DISCIPLINE_META = {
    "Водяной кнут": { ki: 2, dmg: { base: "3d10", add: "1d10", type: "дробящий" } },
    "Несокрушимый воздушный кулак": { ki: 2, dmg: { base: "3d10", add: "1d10", type: "дробящий" } },
    "Зубы огненной змеи": { ki: 1, dmg: { base: "", add: "1d10", type: "огнём (за каждое доп. очко — +1к10 к одному попаданию)" } },
    "Испепеляющий удар": { ki: 2, spell: { name: "огненные ладони", level: 1, upcast: true } },
    "Кулак четырёх громов": { ki: 2, spell: { name: "волна грома", level: 1, upcast: true } },
    "Натиск штормовых духов": { ki: 2, spell: { name: "порыв ветра", level: 2, upcast: false } },
    "Гонг на вершине горы": { ki: 3, spell: { name: "дребезги", level: 2, upcast: true } },
    "Объятья северного ветра": { ki: 3, spell: { name: "удержание личности", level: 2, upcast: true } },
    "Осёдланный ветер": { ki: 4, spell: { name: "полёт", level: 3, upcast: true } },
    "Пламя феникса": { ki: 4, spell: { name: "огненный шар", level: 3, upcast: true } },
    "Туманная стойка": { ki: 4, spell: { name: "газообразная форма", level: 3, upcast: false } },
    "Прочность вечных гор": { ki: 5, spell: { name: "каменная кожа", level: 4, upcast: false } },
    "Река голодного пламени": { ki: 5, spell: { name: "огненная стена", level: 4, upcast: true } },
    "Дыхание зимы": { ki: 6, spell: { name: "конус холода", level: 5, upcast: true } },
    "Земляной вал": { ki: 6, spell: { name: "каменная стена", level: 5, upcast: false } },
    "Формирование текущей реки": { ki: 1 },
  };
  function disciplineMetaFor(f) {
    const m = /^Практика: (.+)$/.exec((f && f.name) || "");
    return m ? DISCIPLINE_META[m[1]] || null : null;
  }
  function monkLevelNow() { return ((data.classes || []).find((c) => c.id === "monk") || {}).level || 0; }
  function disciplineKiCap() { const L = monkLevelNow(); return L >= 17 ? 6 : L >= 13 ? 5 : L >= 9 ? 4 : 3; }
  function disciplineMaxExtra(meta) {
    const canExtra = !!(meta.dmg || (meta.spell && meta.spell.upcast));
    return canExtra ? Math.max(0, disciplineKiCap() - meta.ki) : 0;
  }
  function kiCard() { return (data.features || []).find((x) => /^Ци$/i.test(x.name || "") && /Монах/i.test(x.source || "")) || null; }
  function martialArtsSides() { const L = monkLevelNow(); return L >= 17 ? 10 : L >= 11 ? 8 : L >= 5 ? 6 : 4; }
  function kiPointsLeft() {
    const k = kiCard(); const u = k && resolveFeatureUses(k);
    if (!u || !(u.max > 0)) return 0;
    return usesArrayFor(k, u.max).filter(Boolean).length;
  }
  function spendKi(n) {
    if (kiPointsLeft() < n) { alert(`Не хватает очков ци (нужно ${n}, осталось ${kiPointsLeft()}).`); return false; }
    for (let i = 0; i < n; i++) spendFeatureUse(kiCard());
    return true;
  }
  // Карточки подпутей монаха с кубом боевых искусств (Путь милосердия: Исцеляющая/Повреждающая рука): кнопка 🎲 = кость + Мудрость.
  function monkFeatureDice(f) {
    if (!/^(Исцеляющая рука|Повреждающая рука)$/i.test(f.name || "") || !/милосердия/i.test(f.source || "")) return null;
    const s = martialArtsSides(), w = getAbilityMod(data, "wis");
    const sfx = w ? (w > 0 ? `+${w}` : `${w}`) : "";
    return { expr: `1d${s}${sfx}`, raw: `1к${s}${sfx}` };
  }
  const SHARP_BLADE_NAME = /^Заостр[её]нный клинок$/i;
  function sharpBladeControlsHtml() {
    const n = Number(data.sharpBlade) || 0;
    if (n) return `<span class="muted">Активно: +${n} к атаке и урону оружием кэнсэя</span><button type="button" class="small" data-action="sharp-off">Снять</button>`;
    return [1, 2, 3].map((k) => `<button type="button" class="small" data-action="sharp-on" data-n="${k}" title="Потратить ${k} очк. ци">+${k} (${k} ци)</button>`).join("");
  }
  // Путь солнечной души: «Луч сияющего солнца» — постоянная атака в списке Атак, кость растёт с боевыми искусствами.
  const SUN_BOLT_NAME = "Солнечный луч";
  // Монах «Боевые искусства»: «Безоружный удар» всегда есть в Атаках, кость растёт с уровнем монаха.
  function ensureMonkUnarmed() {
    if (!monkLevelNow()) return false;
    if (!data.attacks) data.attacks = [];
    const dmg = `1к${martialArtsSides()} дробящий`;
    const a = data.attacks.find((x) => /^Безоружный удар$/i.test(x.name || ""));
    if (a) {
      if ((/^1к\d+ дробящий$/.test(a.damage || "") || /^1(\s|$)/.test(a.damage || "") || !a.damage) && a.damage !== dmg) { a.damage = dmg; return true; }
      return false;
    }
    const ability = getAbilityMod(data, "dex") >= getAbilityMod(data, "str") ? "dex" : "str";
    data.attacks.push({ name: "Безоружный удар", bonus: "", damage: dmg, special: "", useSpecial: false, rangeType: "melee", ability, hand: "" });
    return true;
  }
  function ensureSunBolt() {
    const u = ensureMonkUnarmed();
    return ensureSunBoltOnly() || u;
  }
  function ensureSunBoltOnly() {
    const has = (data.features || []).some((f) => /^Луч сияющего солнца$/i.test(f.name || ""));
    if (!data.weapons) data.weapons = [];
    if (!data.attacks) data.attacks = [];
    if (!has) {
      const n = data.weapons.length + data.attacks.length;
      data.weapons = data.weapons.filter((w) => w.name !== SUN_BOLT_NAME);
      data.attacks = data.attacks.filter((a) => a.name !== SUN_BOLT_NAME);
      return data.weapons.length + data.attacks.length !== n;
    }
    const dmg = `1к${martialArtsSides()}`;
    let changed = false;
    const w = data.weapons.find((x) => x.name === SUN_BOLT_NAME);
    if (!w) { data.weapons.push({ name: SUN_BOLT_NAME, damage: dmg, type: "излучение", properties: "Дальнобойная атака заклинанием, 30 фт., Ловкость", special: "", equipped: true, rangeType: "ranged" }); changed = true; }
    else if (w.damage !== dmg) { w.damage = dmg; changed = true; }
    const a = data.attacks.find((x) => x.name === SUN_BOLT_NAME);
    if (!a) { data.attacks.push({ name: SUN_BOLT_NAME, bonus: "", damage: `${dmg} излучение`, special: "", useSpecial: false, rangeType: "ranged", ability: "dex", hand: "" }); changed = true; }
    else if (a.damage !== `${dmg} излучение`) { a.damage = `${dmg} излучение`; changed = true; }
    return changed;
  }
  function disciplineControlsHtml(f, i) {
    const meta = disciplineMetaFor(f);
    if (!meta) return "";
    const maxExtra = disciplineMaxExtra(meta);
    const extra = Math.min(Number(f.discExtra) || 0, maxExtra);
    const total = meta.ki + extra;
    const eff = meta.spell && meta.spell.upcast && extra ? ` — как заклинание ${meta.spell.level + extra}-го круга` : "";
    return `${maxExtra ? `<label class="muted" style="font-size:0.82rem;">Доп. очки ци: <select data-action="discipline-extra" data-index="${i}" style="width:auto;">${Array.from({ length: maxExtra + 1 }, (_, n) => `<option value="${n}" ${n === extra ? "selected" : ""}>${n}</option>`).join("")}</select></label>` : ""}<button class="small feature-card-roll" data-action="cast-discipline" data-index="${i}" title="Списывает очки ци с карточки «Ци»">✨ Применить: ${total} ци${escapeHtml(eff)}</button>`;
  }
  function resolveFeatureUses(f) {
    if (/^(Касание смерти|Торс астрального тела)$/i.test(f.name || "")) return null;
    if (/^Метамагия: /.test(f.name || "")) return null;
    // Способности Пси-воина (отдельные карточки) тратят кости «Псионической силы», своих счётчиков у них нет.
    if (/^(Защитное поле|Псионический удар|Телекинетическое передвижение)$/i.test(f.name || "") && /Пси-воин/i.test(f.source || "")) return null;
    const chKey = channelPoolKey(f);
    if (chKey) return { max: channelPoolMax(chKey), recharge: "any" };
    if (BARD_INSPIRATION_FEATURE_NAME.test(f.name || "")) return { max: maxBardInspirationUses(), recharge: "long" };
    if (RAGE_FEATURE_NAME.test(f.name || "")) return { max: maxRageUses(data), recharge: "long" };
    if (ACTION_SURGE_FEATURE_NAME.test(f.name || "")) return { max: maxActionSurgeUses(data), recharge: "short" };
    if (INDOMITABLE_FEATURE_NAME.test(f.name || "")) return { max: maxIndomitableUses(data), recharge: "long" };
    // Arcane/Natural Recovery's own text describes a once-a-day use spent
    // during a short rest, phrased in a way parseUsesFromText's regexes
    // don't catch -- forced count so it gets normal pip tracking and the
    // rest modal can tell whether today's use is still available.
    if (ARCANE_RECOVERY_FEATURES.some((entry) => entry.match.test(f.name || ""))) return { max: 1, recharge: "long" };
    if (GENIE_VESSEL_FEATURE_NAME.test(f.name || "")) return { max: 1, recharge: "long" };
    // Домен упокоения «Хранитель душ»: раз до начала вашего следующего хода — ручной счётчик (восстанавливается вручную / на отдыхе).
    if (/^Хранитель душ$/i.test(f.name || "") && /упокоения/i.test(f.source || "")) return { max: 1, recharge: "any" };
    // Опциональные «Праведное восстановление» (паладин: 3/7/15 ур.) и «Использование божественной силы» (жрец: 2/6/18 ур.): 1/2/3 использования, продолжительный отдых.
    if (/^Праведное восстановление$/i.test(f.name || "")) { const L = ((data.classes || []).find((c) => c.id === "paladin") || {}).level || 3; return { max: L >= 15 ? 3 : L >= 7 ? 2 : 1, recharge: "long" }; }
    if (/^Использование божественной силы$/i.test(f.name || "")) { const isPal = /Паладин/i.test(f.source || ""); const L = ((data.classes || []).find((c) => c.id === (isPal ? "paladin" : "cleric")) || {}).level || (isPal ? 3 : 2); return { max: isPal ? (L >= 15 ? 3 : L >= 7 ? 2 : 1) : (L >= 18 ? 3 : L >= 6 ? 2 : 1), recharge: "long" }; }
    // Монах «Ци» (очков = уровень монаха, короткий отдых) и чародей «Исток магии» (очков = уровень чародея, продолжительный отдых).
    if (/^Ци$/i.test(f.name || "") && /Монах/i.test(f.source || "")) return { max: ((data.classes || []).find((c) => c.id === "monk") || {}).level || 2, recharge: "short" };
    if (f.name === "Лунное воплощение" && /лун/i.test(f.source || "")) return { max: 1, recharge: "long" };
    if (/^Исток магии$/i.test(f.name || "") && /Чародей/i.test(f.source || "")) return { max: ((data.classes || []).find((c) => c.id === "sorcerer") || {}).level || 2, recharge: "long" };
    if (/^Мистический арканум: /.test(f.name || "")) return { max: 1, recharge: "long" };
    if (/^Мистический мастер$/i.test(f.name || "")) return { max: 1, recharge: "long" };
    if (/^Вспышка гениальности$/i.test(f.name || "")) return { max: Math.max(1, getAbilityMod(data, "int")), recharge: "long" };
    if (/^Хранилище заклинаний$/i.test(f.name || "")) return { max: Math.max(1, 2 * getAbilityMod(data, "int")), recharge: "long" };
    if (/^Договор талисмана$/i.test(f.name || "")) return { max: proficiencyBonus(data), recharge: "long" };
    if (BATTLEMASTER_SUPERIORITY_FEATURE_NAME.test(f.name || "")) return { max: superiorityDieMax(data), recharge: "any" };
    if (MARTIAL_ADEPT_SUPERIORITY_FEATURE_NAME.test(f.name || "")) return { max: 1, recharge: "any" };
    // Клинок души «Псионическая сила»: "количество... равно вашему
    // удвоенному бонусу мастерства" -- the generic "равно ... бонус
    // мастерства" parser below only handles a PLAIN bonus, not a doubled
    // one, so this needs its own branch.
    if (PSIONIC_POWER_FEATURE_NAME.test(f.name || "")) return { max: 2 * proficiencyBonus(data), recharge: "long" };
    return parseUsesFromText(f.desc);
  }
  // Списывает одно использование карточки умения (если у неё есть счётчик).
  // Ярость на панели: вход в ярость списывает одно использование карточки «Ярость»;
  // когда использований не осталось, включить ярость нельзя (выключить — можно).
  function rageFeatureCard() {
    return (data.features || []).find((f) => RAGE_FEATURE_NAME.test(f.name || "")) || null;
  }
  function rageUsesLeft() {
    const f = rageFeatureCard();
    if (!f) return Infinity;
    const uses = resolveFeatureUses(f);
    if (!uses || uses.max === Infinity || !(uses.max > 0)) return Infinity;
    return usesArrayFor(f, uses.max).filter(Boolean).length;
  }
  function spendFeatureUse(f) {
    if (!f) return;
    const uses = resolveFeatureUses(f);
    if (!uses || !(uses.max > 0) || uses.max === Infinity) return;
    const arr = usesArrayFor(f, uses.max);
    const j = arr.lastIndexOf(true);
    if (j < 0) return;
    arr[j] = false;
    setFeatureUsesState(f, arr);
    doSave();
  }
  function featureUsesHtml(f, i) {
    const uses = resolveFeatureUses(f);
    if (!uses || uses.max <= 0) return "";
    if (uses.max === Infinity) {
      return `
      <div class="feature-card-uses">
        <span class="pip-label">Неограниченно (20 уровень)</span>
      </div>`;
    }
    const arr = usesArrayFor(f, uses.max);
    const pips = arr
      .map((filled, j) => `<button type="button" class="pip ${filled ? "filled" : ""}" data-action="toggle-feature-use" data-index="${i}" data-use-index="${j}" title="${filled ? "Отметить как потраченное" : "Восстановить использование"}"></button>`)
      .join("");
    return `
      <div class="feature-card-uses">
        <span class="pip-label">${uses.recharge ? RECHARGE_LABEL[uses.recharge] : "Использ."}</span>
        ${pips}
      </div>`;
  }

  // "Возложение рук" (Lay on Hands) isn't a fixed number of discrete uses --
  // it's a point pool (paladin level × 5) spent in variable amounts per
  // touch, so it gets its own current/max tracker instead of the pip row.
  const POOL_FEATURE_NAMES = /^(Возложение рук|Наложение рук)/i;
  function layOnHandsPoolMax() {
    const p = (data.classes || []).find((c) => c.id === "paladin");
    return (p && p.level ? p.level : totalLevel(data)) * 5;
  }
  function featureResourceHtml(f, i) {
    if (POOL_FEATURE_NAMES.test(f.name || "")) {
      const max = layOnHandsPoolMax();
      const current = Math.max(0, Math.min(typeof f.poolCurrent === "number" ? f.poolCurrent : max, max));
      return `
        <div class="feature-card-uses">
          <span class="pip-label">Пул исцеления</span>
          <input type="number" min="0" max="${max}" class="feature-pool-input" data-action="lay-on-hands-pool" data-index="${i}" value="${current}" style="width:52px;" />
          <span class="pip-label">/ ${max}</span>
          <button type="button" class="small" data-action="lay-on-hands-reset" data-index="${i}" title="Восстановить весь запас">↺</button>
        </div>`;
    }
    if (HEALING_LIGHT_FEATURE_NAME.test(f.name || "")) {
      const max = healingLightPoolMax(data);
      const current = Math.max(0, Math.min(typeof f.poolCurrent === "number" ? f.poolCurrent : max, max));
      const maxPerUse = Math.min(healingLightMaxDicePerUse(data), max || 1);
      const spend = Math.max(1, Math.min(typeof f.healSpend === "number" ? f.healSpend : maxPerUse, maxPerUse));
      return `
        <div class="feature-card-uses">
          <span class="pip-label">Кости к6</span>
          <input type="number" min="0" max="${max}" class="feature-pool-input" data-action="healing-light-pool" data-index="${i}" value="${current}" style="width:52px;" />
          <span class="pip-label">/ ${max}</span>
          <button type="button" class="small" data-action="healing-light-reset" data-index="${i}" title="Восстановить весь запас">↺</button>
        </div>
        <div class="feature-card-uses" style="justify-content:flex-start;gap:10px;">
          <span class="pip-label">Потратить костей (макс ${maxPerUse}):</span>
          <input type="number" min="1" max="${maxPerUse}" class="feature-pool-input" data-action="healing-light-spend" data-index="${i}" value="${spend}" style="width:46px;" />
          <button type="button" class="small feature-card-roll" data-action="roll-healing-light" data-index="${i}" ${current > 0 ? "" : "disabled"}>🎲 Лечение</button>
        </div>`;
    }
    return featureUsesHtml(f, i);
  }

  function abilityBox(a) {
    const score = getAbilityScore(data, a.id);
    const mod = getAbilityMod(data, a.id);
    return `
      <div class="ability-box" data-action="roll-ability" data-ability="${a.id}">
        <div class="label">${a.label}</div>
        <input type="number" class="score-input" min="1" max="30" data-ability-score="${a.id}" value="${score}" />
        <div class="mod" data-derived="mod-${a.id}">${formatModifier(mod)}</div>
      </div>`;
  }

  // Small box under Характеристики listing where each ability-score bonus
  // came from (race, feats…) — data.abilityBonuses is a log of already-baked
  // bonuses (see wizard.js finish() and the add-feat handler above).
  const LUCKY_FEAT_ID = "lucky";
  // «Везунчик»: 3 luck points, spent to reroll a d20 (or force an
  // attacker to reroll one against you), restored on a long rest. Shown
  // right under the ability boxes only while the character actually has
  // this feat -- state lives on the feat's own data.feats entry
  // (luckyUsed[i] = true means that point is SPENT), the same "array of
  // booleans on the entry itself" shape featureResourceHtml's pip trackers
  // already use for feature cards, just on a feat instead.
  function luckyPointsWidgetHtml() {
    const entry = (data.feats || []).find((f) => f.id === LUCKY_FEAT_ID);
    if (!entry) return "";
    const used = Array.isArray(entry.luckyUsed) ? entry.luckyUsed.slice(0, 3) : [];
    while (used.length < 3) used.push(false);
    const stars = used
      .map(
        (spent, i) =>
          `<span class="insp-star ${spent ? "" : "filled"}" data-action="toggle-lucky-point" data-index="${i}" title="${spent ? "Восстановить единицу удачи" : "Отметить единицу удачи потраченной"}">${spent ? "☆" : "★"}</span>`
      )
      .join("");
    return `
      <div class="row" style="gap:6px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
        <span class="muted" style="font-size:0.8rem;">Везунчик, единицы удачи</span>
        <span class="row" style="gap:1px;">${stars}</span>
      </div>`;
  }
  function abilityBonusSourcesBox() {
    const bonuses = data.abilityBonuses || [];
    if (!bonuses.length) return "";
    return `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:0.8rem;">
        <button type="button" class="small" data-action="toggle-ability-bonuses" style="width:100%;text-align:left;">${abilityBonusesOpen ? "▾" : "▸"} Откуда бонусы к характеристикам (${bonuses.length})</button>
        ${
          abilityBonusesOpen
            ? `<div style="margin-top:4px;">
          ${bonuses
            .map(
              (b) => `<div>${escapeHtml(b.source)}: +${b.amount} ${ABILITIES.find((a) => a.id === b.ability)?.label || b.ability}</div>`
            )
            .join("")}
        </div>`
            : ""
        }
      </div>`;
  }

  function saveRow(a) {
    const prof = isProficientSave(data, a.id);
    const bonus = saveBonus(data, a.id);
    return `
      <div class="skill-row">
        <div class="prof-dot ${prof ? "prof" : ""}" data-action="toggle-save-prof" data-ability="${a.id}"></div>
        <div class="name">${a.label}</div>
        <div class="bonus" data-derived="save-${a.id}" data-action="roll-save" data-ability="${a.id}">${formatModifier(bonus)}</div>
      </div>`;
  }

  function skillRow(s) {
    const prof = isProficientSkill(data, s.id);
    const expert = isExpertSkill(data, s.id);
    const bonus = skillBonus(data, s.id);
    return `
      <div class="skill-row">
        <div class="prof-dot ${expert ? "expert" : prof ? "prof" : ""}" data-action="cycle-skill-prof" data-skill="${s.id}"></div>
        <div class="ability-tag">${(ABILITIES.find((a) => a.id === s.ability) || {}).short || s.ability.toUpperCase()}</div>
        <div class="name">${s.label}</div>
        <div class="bonus" data-derived="skill-${s.id}" data-action="roll-skill" data-skill="${s.id}">${formatModifier(bonus)}</div>
      </div>`;
  }

  // Classes whose players choose a limited number of spells to prepare each
  // day on the sheet itself (Task #109), rather than treating every learned
  // spell as simultaneously "active". Paladin is also a "prepared" caster by
  // data.spellcasting.type but isn't part of this flow -- it keeps the
  // older behavior of everything added being usable straight away.
  const PREP_UI_CLASSES = new Set(["wizard", "druid", "cleric", "artificer"]);

  // Cleric/Druid/Artificer prepare from their whole class spell list every
  // day -- they have no personal "spellbook" to build up, so the pool to
  // prepare from is just every level>0 spell their class grants. A Wizard
  // instead only ever prepares from spells actually copied into their
  // spellbook (sc.known, built via "+ Добавить в книгу заклинаний").
  function spellPrepPool(cls, sc) {
    if (cls.spellcasting.preparedFormula) {
      // A Жрец/Друид/Изобретатель has access to their WHOLE class list from
      // level 1 (there's no personal "known" list to grow, unlike a Wizard's
      // spellbook) -- but that doesn't mean every circle is preparable
      // immediately: a 3rd-circle spell is only choosable once the
      // character actually has a 3rd-circle slot (see "Количество ячеек"
      // above), same as any other caster. Gate the pool on the slot count
      // the player has entered for each circle, rather than only on class
      // membership -- 0/blank means "no access yet" for that circle.
      const slots = sc.slots || {};
      return SPELLS.filter((sp) => sp.level > 0 && sp.classes.includes(cls.id) && Number(slots[sp.level] || 0) > 0);
    }
    // Characters created before this prepare/spellbook split had their
    // starting spells written straight into "prepared" (the old bucket for
    // a prepared caster) instead of "known" -- folding both in here keeps
    // an existing wizard's spellbook showing up instead of looking empty
    // until every spell is manually re-added.
    const ids = new Set([...(sc.known || []), ...(sc.prepared || [])]);
    return SPELLS.filter((sp) => sp.level > 0 && ids.has(sp.id));
  }

  // Rules-of-thumb daily prepared-spell count: spellcasting ability modifier
  // + levels in the spellcasting class (minimum 1) -- for Artificer, half
  // that class level instead (its slower "mod+halflevel" formula). Mirrors
  // wizard.js's level1SpellLimit(), just driven by the character's current
  // level rather than a fixed level-1 value.
  function preparedSpellsMax(sc, cls) {
    if (!cls || !cls.spellcasting) return 0;
    const mod = getAbilityMod(data, sc.ability || cls.spellcasting.ability);
    const clsEntry = (data.classes || []).find((c) => c.id === cls.id);
    const lvl = clsEntry && clsEntry.level ? Number(clsEntry.level) : totalLevel(data);
    if (cls.spellcasting.preparedFormula === "mod+halflevel") return Math.max(1, mod + Math.floor(lvl / 2));
    return Math.max(1, mod + lvl);
  }

  function spellsTab() {
    const sc = data.spellcasting || {};
    const dc = spellSaveDC(data);
    const atk = spellAttackBonus(data);
    const slots = sc.slots || {};
    const cls = sc.classFilter ? getClass(sc.classFilter) : null;
    // Only spells the character's own class(es) grant are offered when
    // browsing to add one; with no class chosen yet, fall back to the full
    // list so an early-stage character can still pick something.
    const classIds = (data.classes || []).map((c) => c.id).filter(Boolean);
    const showPrepUI = !!(cls && PREP_UI_CLASSES.has(cls.id));
    const cantripSpells = SPELLS.filter((sp) => (sc.cantrips || []).includes(sp.id));

    // Круг земли (друид 3+ ур.): местность определяет заклинания круга
    const landEntry = (data.classes || []).find((x) => x.id === "druid" && /земл/i.test(x.subclass || "") && (Number(x.level) || 1) >= 3);
    const terrainHtml = landEntry
      ? `<div class="panel"><div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;"><strong>Местность Круга земли:</strong>
          <select data-land-terrain style="flex:none;width:auto;"><option value="">— не выбрана —</option>${DRUID_LAND_TERRAINS.map((t) => `<option value="${escapeHtml(t)}" ${data.landTerrain === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select>
          <span class="muted" style="font-size:0.82rem;">Определяет заклинания круга (всегда подготовлены).</span></div></div>`
      : "";
    let listSectionHtml;
    if (showPrepUI) {
      const isSpellbook = !cls.spellcasting.preparedFormula;
      // Domain spells (Cleric) are always prepared for free and don't count
      // against the prepared-spells cap, so they're folded into the shown
      // pool/list here but tracked separately from sc.prepared -- see
      // currentDomainSpellIds() and spellCardControlHtml()'s domainIds check.
      const domainIds = currentDomainSpellIds(cls);
      const basePool = spellPrepPool(cls, sc);
      const pool = [...basePool, ...SPELLS.filter((sp) => domainIds.includes(sp.id) && !basePool.some((p) => p.id === sp.id))];
      const preparedIds = new Set(sc.prepared || []);
      const max = preparedSpellsMax(sc, cls);
      // заклинания от расы/черт/умений — всегда в списке (не занимают место подготовленных)
      const grantedExtra = SPELLS.filter((sp) => sp.level > 0 && (sc.known || []).includes(sp.id) && spellGrantSource(sp.id));
      const baseShown = spellPrepMode ? pool : pool.filter((sp) => preparedIds.has(sp.id) || domainIds.includes(sp.id));
      const shown = [
        ...cantripSpells,
        ...baseShown,
        ...grantedExtra.filter((sp) => !baseShown.some((b) => b.id === sp.id)),
      ].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru"));
      const browseKnownIds = new Set([...(sc.cantrips || []), ...(sc.known || [])]);
      listSectionHtml = `${terrainHtml}
        <div class="panel">
          <div class="row between" style="align-items:center;flex-wrap:wrap;gap:8px;">
            <h3 style="margin:0;">Известные / подготовленные заклинания</h3>
            <span class="muted">Подготовлено: ${preparedIds.size} / ${max}</span>
          </div>
          <div class="row" style="gap:8px;flex-wrap:wrap;margin:8px 0 4px;">
            <button class="small ${spellPrepMode ? "" : "primary"}" data-action="toggle-spell-prep-mode">${spellPrepMode ? "✕ Скрыть неподготовленные" : "Подготовить заклинания"}</button>
            ${isSpellbook ? `<button class="small primary" data-action="toggle-spell-browse">${spellBrowseOpen ? "✕ Закрыть подбор" : "+ Добавить в книгу заклинаний"}</button>` : `<button class="small primary" data-action="toggle-spell-browse">${spellBrowseOpen ? "✕ Закрыть подбор" : "+ Добавить заговор"}</button>`}
          </div>
          ${
            shown.length
              ? spellLevelSections(shown, sc, { preparedIds, max, spellbook: isSpellbook, editing: spellPrepMode, domainIds: new Set(domainIds) })
              : isSpellbook
                ? '<p class="muted">Пока нет заклинаний в книге заклинаний — нажмите «+ Добавить в книгу заклинаний», чтобы выбрать, затем подготовьте нужные кнопкой выше.</p>'
                : '<p class="muted">Пока нет заговоров — выберите их при создании персонажа, затем подготовьте заклинания круга кнопкой выше.</p>'
          }
        </div>
        ${spellBrowseOpen ? spellBrowsePanelHtml(browseKnownIds, classIds, !isSpellbook) : ""}`;
    } else {
      const oathIds = oathSpellIdSet();
      const knownIds = new Set([...(sc.cantrips || []), ...(sc.known || []), ...(sc.prepared || [])]);
      const shownIds = new Set([...knownIds, ...oathIds]);
      const knownSpells = SPELLS.filter((sp) => shownIds.has(sp.id)).sort(
        (a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru")
      );
      listSectionHtml = `
        <div class="panel">
          <div class="row between" style="align-items:center;">
            <h3 style="margin:0;">Известные / подготовленные заклинания</h3>
            <button class="small primary" data-action="toggle-spell-browse">${spellBrowseOpen ? "✕ Закрыть подбор" : "+ Добавить заклинание"}</button>
          </div>
          ${
            knownSpells.length
              ? spellLevelSections(knownSpells, sc)
              : '<p class="muted">Пока нет выбранных заклинаний — нажмите «+ Добавить заклинание», чтобы выбрать. Свои заклинания можно добавить как заметку в разделе «Черты».</p>'
          }
        </div>
        ${spellBrowseOpen ? spellBrowsePanelHtml(shownIds, classIds) : ""}`;
    }

    return `
      <div class="panel">
        <div class="row between" style="align-items:center;flex-wrap:wrap;gap:8px;">
          <h2 style="margin:0;">Заклинания</h2>
          <button class="small primary" data-action="toggle-extra-browse">${extraBrowseOpen ? "✕ Закрыть подбор" : "+ Заговор / заклинание любого класса (сверх лимита)"}</button>
        </div>
        <div class="row" style="gap:16px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;">
          <div class="col" style="flex:1;min-width:180px;">
            <label>Базовая характеристика</label>
            <select data-bind="spellcasting.ability">
              <option value="">— нет заклинаний —</option>
              ${ABILITIES.map((a) => `<option value="${a.id}" ${sc.ability === a.id ? "selected" : ""}>${a.label}</option>`).join("")}
            </select>
          </div>
          <div class="grid cols-2 combat-stats" style="flex:none;width:auto;">
            <div class="stat-box"><div class="value">${dc ?? "—"}</div><div class="label">Слож. спасброска</div></div>
            <button type="button" class="stat-box" ${atk !== null ? 'data-action="roll-spell-attack"' : "disabled"} title="Бросить атаку заклинанием" style="cursor:pointer;font:inherit;color:inherit;"><div class="value">${atk !== null ? formatModifier(atk) : "—"}</div><div class="label">🎲 Бонус атаки</div></button>
          </div>
        </div>
        <div style="margin-top:14px;">
          <h3 style="margin-bottom:8px;">Количество ячеек</h3>
          <div class="spell-slots-grid">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9]
              .map(
                (lvl) => `
              <div class="col">
                <label>${lvl}-й круг</label>
                <input type="number" min="0" data-bind="spellcasting.slots.${lvl}" value="${slots[lvl] ?? ""}" />
              </div>`
              )
              .join("")}
          </div>
        </div>
      </div>
      ${extraSpellsPanelHtml(sc)}
      ${listSectionHtml}`;
  }

  // «Дополнительные заклинания»: any cantrip/spell of ANY class, added on top
  // of (and never counted against) the class's own known/prepared limits --
  // for magic items, DM rulings, multiclass leftovers, etc. Stored as ids in
  // data.spellcasting.extra.
  function extraSpellsPanelHtml(sc) {
    const extraIds = new Set(sc.extra || []);
    if (!extraIds.size && !extraBrowseOpen) return "";
    const extraSpells = SPELLS.filter((sp) => extraIds.has(sp.id)).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru"));
    const removeBtn = (sp) => `<button class="small danger" data-action="toggle-extra-spell" data-spell="${sp.id}" title="Убрать">✕</button>`;
    let listHtml = extraSpells.length
      ? [...new Set(extraSpells.map((sp) => sp.level))].map((lvl) => `
        <div class="spell-level-section">
          <div class="spell-level-header"><h4>${lvl === 0 ? "Заговоры" : `${lvl}-й круг`}</h4></div>
          <div class="spell-level-divider"></div>
          <div class="spell-cards">${extraSpells.filter((sp) => sp.level === lvl).map((sp) => spellCardHtml(sp, removeBtn(sp), { known: true })).join("")}</div>
        </div>`).join("")
      : '<p class="muted">Здесь можно добавить заговор или заклинание любого класса сверх лимита — они не занимают места среди известных/подготовленных.</p>';
    let browseHtml = "";
    if (extraBrowseOpen) {
      const known = new Set([...(sc.cantrips || []), ...(sc.known || []), ...(sc.prepared || []), ...extraIds]);
      const q = extraSpellSearch.trim().toLowerCase();
      const pool = SPELLS.filter((sp) => {
        if (known.has(sp.id)) return false;
        if (extraSpellLevel !== "all" && String(sp.level) !== extraSpellLevel) return false;
        if (extraSpellClass !== "all" && !sp.classes.includes(extraSpellClass)) return false;
        if (q && !sp.name.toLowerCase().includes(q)) return false;
        return true;
      });
      const shown = pool.slice(0, 60);
      browseHtml = `
        <div class="panel" style="margin-top:10px;">
          <h4 style="margin-top:0;">Выбор заклинания (любой класс)</h4>
          <div class="row spell-filters" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;">
            <input type="text" data-extra-search placeholder="Поиск по названию…" value="${escapeHtml(extraSpellSearch)}" style="flex:1;min-width:160px;" />
            <select data-extra-class style="flex:none;width:auto;">
              <option value="all">Все классы</option>
              ${CLASSES.filter((c) => SPELLS.some((sp) => sp.classes.includes(c.id))).map((c) => `<option value="${c.id}" ${extraSpellClass === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
            </select>
            <select data-extra-level style="flex:none;width:auto;">
              <option value="all">Все уровни</option>
              <option value="0" ${extraSpellLevel === "0" ? "selected" : ""}>Заговоры</option>
              ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => `<option value="${l}" ${extraSpellLevel === String(l) ? "selected" : ""}>${l}-й круг</option>`).join("")}
            </select>
          </div>
          ${shown.length ? `<div class="spell-cards">${shown.map((sp) => spellCardHtml(sp, `<button class="small primary" data-action="toggle-extra-spell" data-spell="${sp.id}" title="Добавить сверх лимита">+ Добавить</button>`)).join("")}</div>${pool.length > shown.length ? `<p class="muted">Показаны первые ${shown.length} из ${pool.length} — уточните поиск.</p>` : ""}` : '<p class="muted">Ничего не найдено — измените фильтры.</p>'}
        </div>`;
    }
    return `
      <div class="panel">
        <div class="row between" style="align-items:center;flex-wrap:wrap;gap:8px;">
          <h3 style="margin:0;">Дополнительные заклинания (сверх лимита)</h3>
        </div>
        ${listHtml}
        ${browseHtml}
      </div>`;
  }

  // Known spells grouped into a section per circle (0 = заговоры, no
  // slots), each headed by its circle name and -- for circles 1-9 -- a row
  // of large slot-tracking circles (filled gold = still available; click
  // to mark one spent, click again to restore it), separated from the
  // spell cards below by a thin gold divider line.
  function spellLevelSections(knownSpells, sc, prepCtx) {
    const byLevel = new Map();
    knownSpells.forEach((sp) => {
      if (!byLevel.has(sp.level)) byLevel.set(sp.level, []);
      byLevel.get(sp.level).push(sp);
    });
    return [...byLevel.keys()]
      .sort((a, b) => a - b)
      .map((lvl) => {
        const spells = byLevel.get(lvl);
        const header = lvl === 0 ? "Заговоры" : `${lvl}-й круг`;
        return `
        <div class="spell-level-section">
          <div class="spell-level-header">
            <h4>${header}</h4>
            ${lvl > 0 ? spellSlotCirclesHtml(sc, lvl) : ""}
          </div>
          <div class="spell-level-divider"></div>
          <div class="spell-cards">${spells
            .map((sp) => spellCardHtml(sp, spellCardControlHtml(sp, prepCtx), { known: true, domain: !!(prepCtx && prepCtx.domainIds && prepCtx.domainIds.has(sp.id)) || oathSpellIdSet().has(sp.id) }))
            .join("")}</div>
        </div>`;
      })
      .join("");
  }

  // Top-right control for a known/prepared spell card. Normally a plain
  // remove button (toggle-spell). Inside a prepared caster's flow (prepCtx
  // set, Task #109), a leveled spell shows a checkbox toggling whether it's
  // prepared today -- capped at prepCtx.max -- but ONLY while prepCtx.editing
  // (the "Подготовить заклинания" picker) is open. Outside of that editing
  // mode the collapsed/default view shows every card in this list because it
  // IS prepared, so the checkbox would do nothing useful except invite an
  // accidental misclick that silently unprepares a spell -- it's replaced by
  // a plain non-interactive "✓ подготовлено" badge instead. When editing,
  // a class with a personal spellbook (prepCtx.spellbook) also gets a small
  // extra ✕ to strike the spell from the spellbook entirely. Cantrips are
  // never rationed by preparation, so they always keep the plain remove
  // button regardless of prepCtx.
  // A spell that came from a class/subclass feature (see
  // FEATURE_GRANTED_SPELLS) is cast without spending a spell slot -- the
  // card shows a badge instead of a remove button. Future casting mechanics
  // should check this map (data.spellcasting.granted[spellId] = feature name).
  function spellGrantSource(spId) {
    const g = data.spellcasting && data.spellcasting.granted;
    const name = g && g[spId];
    if (name && ((data.features || []).some((f) => f.name === name) || (data.feats || []).some((f) => (f.baseName || f.name) === name))) return { label: name, free: true };
    // раса / подраса: заговоры из grantedCantrips (считаются по названию расы, хранить ничего не нужно)
    const raceName = data.raceName || "";
    if (raceName) {
      for (const race of RACES) {
        const subs = race.subraces || [];
        const matchedSub = subs.find((sr) => raceName.includes(sr.name));
        for (const src of [race, ...subs]) {
          if (!src.grantedCantrips || !src.grantedCantrips.includes(spId) || !raceName.includes(src.name)) continue;
          if (src === race && matchedSub && matchedSub.overridesRaceCantrips) continue;
          return { label: `Раса: ${src.name}`, free: false };
        }
      }
    }
    // черты: заговоры/заклинания, выданные самой чертой (старые и новые записи)
    for (const f of data.feats || []) {
      const ids = [...(f.grantedCantrips || []), ...(f.grantedSpell ? [f.grantedSpell] : []), ...((f.fx && f.fx.cantrips) || []), ...((f.fx && f.fx.known) || [])];
      if (ids.includes(spId)) return { label: `Черта: ${f.baseName || f.name}`, free: false };
    }
    return null;
  }
  function spellGrantedBy(spId) { const r = spellGrantSource(spId); return r ? r.label : null; }
  // Заклинания клятвы паладина (и любого другого не-«подготавливающего» класса,
  // у подкласса которого есть domainSpells): всегда подготовлены, в лимит не
  // входят, убрать нельзя.
  // Уровни заклинаний подкласса: domainSpells, а у Круга земли — по выбранной местности.
  function subclassGrantedTiers(sub) {
    if (sub && sub.terrainSpells) return (data.landTerrain && sub.terrainSpells[data.landTerrain]) || [];
    if (sub && sub.slug === "divine-soul") {
      const aff = DIVINE_AFFINITIES.find((a) => a.name === data.divineAffinity);
      return aff ? [{ level: 1, spells: [aff.spell] }] : [];
    }
    return (sub && sub.domainSpells) || [];
  }
  function oathSpellIdSet() {
    const ids = new Set();
    (data.classes || []).forEach((entry) => {
      const cls = getClass(entry.id);
      if (!cls || PREP_UI_CLASSES.has(cls.id) || !entry.subclass) return;
      const sub = (cls.subclasses || []).find((x) => x.name.toLowerCase() === entry.subclass.toLowerCase());
      if (!sub) return;
      const lvl = Number(entry.level) || 1;
      subclassGrantedTiers(sub).forEach((t) => { if (t.level <= lvl) t.spells.forEach((id) => ids.add(id)); });
    });
    return ids;
  }
  function spellCardControlHtml(sp, prepCtx) {
    if (oathSpellIdSet().has(sp.id)) {
      return `<span class="spell-card-badge spell-card-badge-domain" title="Заклинание подкласса — всегда подготовлено, не занимает место среди подготовленных">дар подкласса</span>`;
    }
    const grantSrc = spellGrantSource(sp.id);
    if (grantSrc) {
      const tip = grantSrc.free ? `Даётся «${grantSrc.label}» — накладывается без траты ячеек заклинаний` : `Даётся: ${grantSrc.label}`;
      return `<span class="spell-card-badge spell-card-badge-domain" title="${escapeHtml(tip)}">✦ ${escapeHtml(grantSrc.label)}${grantSrc.free ? " · без ячейки" : ""}</span>`;
    }
    if (!prepCtx || sp.level === 0) {
      return `<button class="small danger" data-action="toggle-spell" data-spell="${sp.id}" title="Убрать из листа">✕</button>`;
    }
    // Domain spells are always prepared for free (don't cost a prepared
    // slot and can't be unprepared), so they get a fixed badge instead of
    // the normal checkbox/badge logic below, in both editing and non-editing
    // views -- see currentDomainSpellIds().
    if (prepCtx.domainIds && prepCtx.domainIds.has(sp.id)) {
      return `<span class="spell-card-badge spell-card-badge-domain" title="Дар домена — подготовлено всегда, не занимает ячейку подготовленных заклинаний">дар домена</span>`;
    }
    if (!prepCtx.editing) {
      return `<span class="spell-card-badge" title="Подготовлено на сегодня">✓</span>`;
    }
    const checked = prepCtx.preparedIds.has(sp.id);
    const disabled = !checked && prepCtx.preparedIds.size >= prepCtx.max;
    const title = checked ? "Подготовлено — нажмите, чтобы снять" : disabled ? "Лимит подготовленных заклинаний достигнут" : "Подготовить";
    const checkbox = `<input type="checkbox" data-action="toggle-prepared" data-spell="${sp.id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} title="${title}" />`;
    if (!prepCtx.spellbook) return checkbox;
    return `<span style="display:inline-flex;gap:6px;align-items:center;">${checkbox}<button class="small danger" data-action="toggle-spell" data-spell="${sp.id}" title="Убрать из книги заклинаний">✕</button></span>`;
  }

  // A circle-level's slot state, resized on the fly to however many slots
  // that circle currently has (from "Количество ячеек" above) -- an array
  // of booleans on data.spellcasting.slotsFilled[level], filled = still
  // available. New characters get every slot filled (full, unspent).
  function spellSlotsArrayFor(sc, lvl) {
    const max = Number((sc.slots || {})[lvl]) || 0;
    const stored = (sc.slotsFilled || {})[lvl];
    const arr = Array.isArray(stored) ? stored.slice(0, max) : [];
    while (arr.length < max) arr.push(true);
    return arr;
  }
  function spellSlotCirclesHtml(sc, lvl) {
    const arr = spellSlotsArrayFor(sc, lvl);
    if (!arr.length) return "";
    const circles = arr
      .map((filled, j) => `<button type="button" class="spell-slot-circle ${filled ? "filled" : ""}" data-action="toggle-spell-slot" data-level="${lvl}" data-slot-index="${j}" title="${filled ? "Отметить ячейку как потраченную" : "Восстановить ячейку"}"></button>`)
      .join("");
    return `<div class="spell-slot-circles"><span class="pip-label">ячейки</span>${circles}</div>`;
  }

  // The "+ Добавить заклинание" panel: search + level filter over the
  // spells the character's class(es) actually grant (or the full list, if
  // no class is set yet), excluding ones already known/prepared.
  // A chosen subclass (Колдун покровитель, etc.) can widen the pool of
  // pickable spells beyond its class's own list -- e.g. a Warlock's
  // Otherworldly Patron "Расширенный список заклинаний" -- looked up from
  // data.classes[i].subclass (a plain name string) against that class's
  // catalog of subclasses.
  function characterExpandedSpellIds() {
    const ids = new Set();
    (data.classes || []).forEach((c) => {
      if (!c.subclass) return;
      const cls = getClass(c.id);
      const sub = (cls?.subclasses || []).find((s) => s.name.toLowerCase() === c.subclass.toLowerCase());
      (sub?.expandedSpells || []).forEach((id) => ids.add(id));
    });
    optionalExtraSpellIds().forEach((id) => ids.add(id));
    return ids;
  }
  // Опциональное умение «Дополнительные заклинания <класса>» (Tasha's): расширяет список заклинаний класса.
  function optionalExtraSpellIds(classIdFilter) {
    const out = new Set();
    (data.classes || []).forEach((c) => {
      if (classIdFilter && c.id !== classIdFilter) return;
      if ((data.features || []).some((f) => f.name === ADDITIONAL_SPELLS_NAME(c.id))) additionalSpellIds(c.id).forEach((id) => out.add(id));
    });
    return out;
  }
  // Cleric domain spells (and any future subclass with the same
  // "domainSpells" shape): unlike expandedSpells above, these aren't just a
  // widened pool to pick from -- the character always has them prepared,
  // for free, from the moment their class level reaches that tier (1/3/5/7/9),
  // no picking involved. Only the tiers whose level is <= the class's
  // current level count, and only spells the catalog actually carries are
  // returned -- the 5th/7th/9th-level tiers name spells (Revivify, Death
  // Ward, Raise Dead...) the catalog doesn't have yet, so those tiers simply
  // contribute nothing for now instead of showing a broken card.
  function currentDomainSpellIds(cls) {
    if (!cls) return [];
    const entry = (data.classes || []).find((c) => c.id === cls.id);
    if (!entry || !entry.subclass) return [];
    const sub = (cls.subclasses || []).find((s) => s.name.toLowerCase() === entry.subclass.toLowerCase());
    if (!sub) return [];
    const lvl = Number(entry.level) || 1;
    const ids = new Set();
    subclassGrantedTiers(sub).forEach((tier) => {
      if (tier.level <= lvl) tier.spells.forEach((id) => ids.add(id));
    });
    return [...ids].filter((id) => SPELLS.some((sp) => sp.id === id));
  }
  function spellBrowsePanelHtml(knownIds, classIds, cantripsOnly) {
    const q = spellSearch.trim().toLowerCase();
    const expandedIds = characterExpandedSpellIds();
    const pool = SPELLS.filter((sp) => !knownIds.has(sp.id) && (expandedIds.has(sp.id) || !classIds.length || sp.classes.some((id) => classIds.includes(id))));
    const filtered = pool.filter((sp) => {
      if (cantripsOnly && sp.level !== 0) return false;
      if (spellLevelFilter !== "all" && String(sp.level) !== spellLevelFilter) return false;
      if (q && !sp.name.toLowerCase().includes(q)) return false;
      return true;
    });
    return `
      <div class="panel">
        <h3>${cantripsOnly ? "Выбор заговора" : "Выбор заклинания"}</h3>
        <p class="muted">${classIds.length ? "Показаны заклинания, доступные классу персонажа." : "Класс персонажа не задан — показаны все заклинания."}</p>
        <div class="row spell-filters" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <input type="text" data-spell-search placeholder="Поиск по названию…" value="${escapeHtml(spellSearch)}" style="flex:1;min-width:160px;" />
          <select data-spell-level-filter style="flex:none;width:auto;${cantripsOnly ? "display:none;" : ""}">
            <option value="all" ${spellLevelFilter === "all" ? "selected" : ""}>Все уровни</option>
            <option value="0" ${spellLevelFilter === "0" ? "selected" : ""}>Заговоры</option>
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((lvl) => `<option value="${lvl}" ${spellLevelFilter === String(lvl) ? "selected" : ""}>${lvl}-й круг</option>`).join("")}
          </select>
        </div>
        ${
          filtered.length
            ? `<div class="spell-cards">${filtered
                .map((sp) => spellCardHtml(sp, `<button class="small primary" data-action="toggle-spell" data-spell="${sp.id}" title="Добавить в лист">+ Добавить</button>`))
                .join("")}</div>`
            : '<p class="muted">Ничего не найдено — измените фильтры.</p>'
        }
      </div>`;
  }


  // ---- Облики (звериные облики) --------------------------------------
  // The character keeps a list of chosen forms (data.forms.known: beast ids)
  // and at most one active form (data.forms.active) with its own hit point
  // pool (data.forms.hp), like Wild Shape: damage to the form first, and
  // when it drops to 0 the character reverts with the overflow carried over.
  function ensureForms() {
    if (!data.forms || typeof data.forms !== "object") data.forms = { known: [], active: null, hp: null };
    if (!Array.isArray(data.forms.known)) data.forms.known = [];
    return data.forms;
  }
  function ensureBeastsLoaded() {
    if (beastsData || beastsLoading) return;
    beastsLoading = true;
    import("../data/beasts.js")
      .then((m) => { beastsData = m.BEASTS; })
      .catch(() => { beastsData = []; })
      .finally(() => { beastsLoading = false; if (activeTab === "forms" || activeTab === "pets") render(); });
  }
  function beastCrNum(cr) {
    const s = String(cr || "0");
    if (s.includes("/")) { const [a, b] = s.split("/").map(Number); return a / b; }
    return Number(s) || 0;
  }
  function beastMoves(b) {
    const sp = b.speed || "";
    return { fly: /летая/i.test(sp), swim: /плавая/i.test(sp), climb: /лазая/i.test(sp), burrow: /копая/i.test(sp) };
  }
  function beastMaxHp(b) { return parseInt(b.hp, 10) || 1; }
  // Wild Shape limits by Druid level (PHB): CR 1/4 no fly/swim from 2, CR 1/2
  // no fly from 4, CR 1 from 8; Circle of the Moon: CR 1 from 2, then
  // level/3 (rounded down). null when the character has no Druid levels.
  function wildShapeLimit() {
    const c = (data.classes || []).find((x) => x.id === "druid");
    if (!c) return null;
    const lvl = Number(c.level) || 1;
    const moon = /лун/i.test(c.subclass || c.subclassName || "");
    if (moon) {
      return { maxCr: lvl >= 6 ? Math.floor(lvl / 3) : 1, noFly: lvl < 8, noSwim: false, label: `Круг Луны, ${lvl} ур.` };
    }
    if (lvl < 2) return { maxCr: -1, noFly: true, noSwim: true, label: `${lvl} ур.` };
    if (lvl < 4) return { maxCr: 0.25, noFly: true, noSwim: true, label: `${lvl} ур.` };
    if (lvl < 8) return { maxCr: 0.5, noFly: true, noSwim: false, label: `${lvl} ур.` };
    return { maxCr: 1, noFly: false, noSwim: false, label: `${lvl} ур.` };
  }
  function beastAllowedByWildShape(b, lim) {
    if (!lim) return true;
    const m = beastMoves(b);
    return beastCrNum(b.cr) <= lim.maxCr && !(lim.noFly && m.fly) && !(lim.noSwim && m.swim);
  }
  function beastAbilitiesHtml(b) {
    return `<div class="beast-abil">${(b.abil || [])
      .map((a) => {
        const m = String(a).match(/^([А-Яа-яЁё]+)\s*(\d+)\s*\(([^)]*)\)/);
        return m
          ? `<div><span class="prop-label">${escapeHtml(m[1])}</span><strong>${escapeHtml(m[2])}</strong><span class="muted">${escapeHtml(m[3])}</span></div>`
          : `<div><strong>${escapeHtml(a)}</strong></div>`;
      })
      .join("")}</div>`;
  }
  // Attack/damage buttons for a beast action: «+N к попаданию» becomes an
  // attack roll with that bonus. The text after «Попадание:» is split into
  // sentences: the first is the fixed damage ("2к6+2 колющего", or a flat
  // number like "Колющий урон 1"), later sentences that mention damage are
  // situational extras (charge, pounce, ...) offered as checkboxes.
  function beastDamageParts(sentence) {
    const parts = [];
    let m;
    // "14 (4к6) … или 7 (2к6), если у роя половина хитов" -- keep the first option only.
    const cut = sentence.search(/\s+или\s+\d+\s*\(/i);
    const src = cut > 0 ? sentence.slice(0, cut) : sentence;
    const TYPE = /(колющ|дробящ|рубящ|огнен|огнём|холод|кислот|ядом|ядовит|некротическ|излучени|звуков|звуком|психическ|силов|электр|молни)[а-яё]*/i;
    const dice = /\((\d*)к(\d+)(?:\s*([+\-−–])\s*(\d+))?\)/gi;
    while ((m = dice.exec(src))) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const t = after.match(TYPE);
      parts.push({ expr: `${m[1] || 1}d${m[2]}${m[3] ? (m[3] === "+" ? "+" : "-") + m[4] : ""}`, type: t ? t[0] : "" });
    }
    if (!parts.length) {
      const flat = src.match(/(?:урон\s+(\d+))|(?:(\d+)\s+(?:[а-яё]+\s+)?урон)/i);
      if (flat) {
        const t = src.match(TYPE);
        parts.push({ flat: parseInt(flat[1] || flat[2], 10), type: t ? t[0] : "" });
      }
    }
    return parts;
  }
  function parseBeastAction(item) {
    const t = String(item.t || "");
    const atk = t.match(/([+-]\s?\d+)\s*к попаданию/);
    const hitIdx = t.search(/Попадание:/);
    let base = [];
    const conds = [];
    if (hitIdx >= 0) {
      const tail = t.slice(hitIdx + "Попадание:".length).trim();
      // sentence split on ". " followed by a capital letter
      const sentences = tail.split(/\.\s+(?=[А-ЯЁ])/).map((x) => x.replace(/\.$/, "").trim()).filter(Boolean);
      if (sentences.length) base = beastDamageParts(sentences[0]);
      sentences.slice(1).forEach((sent) => {
        const parts = beastDamageParts(sent);
        if (parts.length) conds.push({ text: sent, parts });
      });
    }
    return { bonus: atk ? parseInt(atk[1].replace(/\s/g, ""), 10) : null, base, conds };
  }
  function beastPartLabel(p) {
    return `${p.expr ? toCyrillicDice(p.expr) : p.flat}${p.type ? " " + p.type : ""}`;
  }
  function beastRollButtons(item) {
    const act = parseBeastAction(item);
    if (act.bonus === null && !act.base.length && !act.conds.length) return "";
    const name = item.n || "Атака";
    return `<div class="beast-roll-row">${
      act.bonus !== null ? `<button class="small primary" data-beast-atk="${act.bonus}" data-beast-name="${escapeHtml(name)}">🎲 Атака ${formatModifier(act.bonus)}</button>` : ""
    }${
      act.base.length || act.conds.length ? `<button class="small danger" data-beast-dmg="${escapeHtml(JSON.stringify({ base: act.base, conds: act.conds }))}" data-beast-name="${escapeHtml(name)}">💥 Урон${act.base.length ? " " + escapeHtml(act.base.map(beastPartLabel).join(" + ")) : ""}</button>` : ""
    }</div>`;
  }
  // Damage window for a beast attack (same layout as a weapon's damage
  // window): the fixed damage from the stat block, situational extras as
  // checkboxes, own extra dice, a crit checkbox, and a roll button whose
  // result has an expandable log.
  function startBeastDamage(name, act) {
    let extraDice = [];
    const html = `
      <h3>Урон: ${escapeHtml(name)}</h3>
      <p style="margin:0 0 8px;"><strong>Фиксированный урон:</strong> ${act.base.length ? escapeHtml(act.base.map(beastPartLabel).join(" + ")) : '<span class="muted">не указан</span>'}</p>
      ${act.conds.length ? `<div style="border-top:1px solid var(--border);padding-top:8px;"><span class="muted" style="font-size:0.82rem;">Урон по условиям (из описания зверя):</span>
        ${act.conds.map((c, i) => `<label class="row" style="gap:8px;align-items:flex-start;margin-top:6px;"><input type="checkbox" data-beast-cond="${i}" style="margin-top:4px;" /><span>${escapeHtml(c.text)} <strong>(+${escapeHtml(c.parts.map(beastPartLabel).join(" + "))})</strong></span></label>`).join("")}</div>` : ""}
      <label class="row" style="gap:8px;align-items:center;margin-top:10px;"><input type="checkbox" data-beast-crit /> критическое попадание (кубики ×2)</label>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);">
        <span class="muted" style="font-size:0.82rem;">Дополнительные кубики к урону:</span>
        <div class="row" style="gap:6px;align-items:center;margin-top:4px;">
          <select data-extra-die-sides style="flex:none;">${[4, 6, 8, 10, 12, 20, 100].map((d) => `<option value="${d}" ${d === 6 ? "selected" : ""}>к${d}</option>`).join("")}</select>
          <span class="muted">×</span>
          <input type="number" data-extra-die-count min="1" max="99" value="1" style="width:52px;text-align:center;" />
          <button type="button" class="small" data-action="add-extra-die">+ Добавить</button>
        </div>
        <div class="dice-pool-list" data-extra-dice-list style="margin-top:6px;"></div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px;"><button data-action="confirm-beast-damage" class="primary">🎲 Бросить</button></div>`;
    const modal = openModal(html);
    const chips = () => {
      const list = modal.querySelector("[data-extra-dice-list]");
      list.innerHTML = extraDice.map((d, i) => `<span class="dice-pool-chip">${d.count}к${d.sides}<button type="button" data-action="remove-extra-die" data-index="${i}" title="Убрать">✕</button></span>`).join("");
    };
    on(modal, "click", "[data-action=add-extra-die]", () => {
      const sides = Number(modal.querySelector("[data-extra-die-sides]").value);
      const count = Math.max(1, Math.min(99, Number(modal.querySelector("[data-extra-die-count]").value) || 1));
      extraDice.push({ sides, count });
      chips();
    });
    on(modal, "click", "[data-action=remove-extra-die]", (e, el) => { extraDice.splice(Number(el.dataset.index), 1); chips(); });
    on(modal, "click", "[data-action=confirm-beast-damage]", () => {
      const parts = [...act.base];
      const used = [];
      modal.querySelectorAll("[data-beast-cond]").forEach((cb) => {
        if (cb.checked) { const c = act.conds[Number(cb.dataset.beastCond)]; parts.push(...c.parts); used.push(c.text); }
      });
      const crit = modal.querySelector("[data-beast-crit]").checked;
      closeModal();
      rollBeastDamage(name, parts, extraDice, crit);
    });
  }
  function rollBeastDamage(name, parts, extraDice, crit) {
    const lines = [];
    const breakdown = [];
    let total = 0;
    const addRoll = (expr, label) => {
      const ex = crit ? doubleDiceCount(expr) : expr;
      const r = rollExpr(ex);
      total += r.total;
      lines.push(`${toCyrillicDice(ex)}${label ? " " + label : ""} = ${r.rolls.join("+")}${r.modifier ? formatModifier(r.modifier) : ""}`);
      r.rolls.forEach((v) => breakdown.push({ value: v, label: `к${r.sides}${label ? " · " + label : ""}` }));
      if (r.modifier) breakdown.push({ value: r.modifier, label: `модификатор${label ? " · " + label : ""}` });
    };
    parts.forEach((p) => {
      if (p.expr) addRoll(p.expr, p.type);
      else if (p.flat != null) {
        total += p.flat;
        lines.push(`${p.flat}${p.type ? " " + p.type : ""}`);
        breakdown.push({ value: p.flat, label: `фиксированный урон${p.type ? " · " + p.type : ""}` });
      }
    });
    (extraDice || []).forEach((d) => addRoll(`${d.count}d${d.sides}`, "доп. кубики"));
    showRollResult({
      label: `${name}: урон${crit ? " (крит)" : ""}`,
      detail: lines.join("; ") || "нет кубиков урона",
      total,
      breakdown,
    });
  }
  function beastCardHtml(b, actionsHtml, { active = false, note = "" } = {}) {
    const paragraph = (i) => `<p>${i.n ? `<strong>${escapeHtml(i.n)}.</strong> ` : ""}${escapeHtml(i.t)}</p>${beastRollButtons(i)}`;
    return `
      <div class="spell-card beast-card ${active ? "known" : ""}" data-beast-id="${b.id}">
        <div class="spell-card-header">
          <div class="spell-card-icon" title="Зверь">🐾</div>
          <div class="spell-card-title-group">
            <h4 class="spell-card-title">${escapeHtml(b.name)}</h4>
            <p class="spell-card-subtitle">${escapeHtml(b.sta || "Зверь")} · опасность ${escapeHtml(b.cr)}</p>
          </div>
        </div>
        ${note ? `<div class="beast-note">${note}</div>` : ""}
        <div class="spell-card-props">
          <div class="spell-card-prop"><span class="prop-label">Класс доспеха</span><span>${escapeHtml(b.ac || "—")}</span></div>
          <div class="spell-card-prop"><span class="prop-label">Хиты</span><span>${escapeHtml(b.hp || "—")}</span></div>
          <div class="spell-card-prop spell-card-classes"><span class="prop-label">Скорость</span><span>${escapeHtml(b.speed || "—")}</span></div>
        </div>
        ${beastAbilitiesHtml(b)}
        <div class="spell-card-desc">
          ${[["Чувства", b.senses], ...(b.extra || [])].filter(([, v]) => v).map(([l, v]) => `<p><strong>${escapeHtml(l)}:</strong> ${escapeHtml(v)}</p>`).join("")}
          ${(b.traits || []).map(paragraph).join("")}
          ${(b.sections || []).map((sec) => `<h5 class="beast-section-title">${escapeHtml(sec.title)}</h5>${(sec.items || []).map(paragraph).join("")}`).join("")}
          ${b.src ? `<p class="muted" style="font-size:0.78rem;">Источник: ${escapeHtml(b.src)} (dnd.su)</p>` : ""}
        </div>
        ${actionsHtml ? `<div class="beast-card-actions">${actionsHtml}</div>` : ""}
      </div>`;
  }
  function formsTab() {
    ensureBeastsLoaded();
    const forms = ensureForms();
    if (!beastsData) {
      return `<div class="panel"><h2>Облики</h2><p class="muted">Загружаю список зверей…</p></div>`;
    }
    const byId = new Map(beastsData.map((b) => [b.id, b]));
    const lim = wildShapeLimit();
    const active = forms.active ? byId.get(forms.active) : null;
    const known = forms.known.map((id) => byId.get(id)).filter(Boolean);
    const noteFor = (b) => {
      if (!lim) return "";
      const ok = beastAllowedByWildShape(b, lim);
      return ok
        ? `<span class="beast-ok">✔ доступен по правилам «Дикого облика»</span>`
        : `<span class="beast-no">✖ не подходит под «Дикий облик» (${escapeHtml(lim.label)})</span>`;
    };
    const activeHp = Number(forms.hp) || 0;
    const activeHtml = active
      ? `
      <div class="panel" style="border-color:var(--gold);">
        <div class="row between"><h2 style="margin:0;">Текущий облик: ${escapeHtml(active.name)}</h2>
          <button class="small danger" data-action="revert-form">Вернуть обычный облик</button></div>
        <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0;">
          <span>Хиты облика:</span>
          <input type="number" min="0" max="${beastMaxHp(active)}" style="width:72px;" data-form-hp value="${activeHp}" />
          <span class="muted">из ${beastMaxHp(active)}</span>
          <input type="number" min="0" data-form-hp-delta style="width:64px;" value="1" />
          <button class="small danger" data-action="form-damage">− Урон</button>
          <button class="small primary" data-action="form-heal">+ Лечение</button>
        </div>
        <p class="muted" style="font-size:0.82rem;margin:0 0 10px;">Пока вы в облике, урон тратит хиты облика; когда они падают до 0, вы возвращаетесь в свой облик, а лишний урон переходит на ваши хиты. Хиты, КД и скорость в этой панели — зверя.</p>
        <div class="spell-cards" style="grid-template-columns:minmax(280px,420px);">${beastCardHtml(active, "", { active: true })}</div>
      </div>`
      : "";
    const knownHtml = known.length
      ? `<div class="spell-cards">${known
          .map((b) =>
            beastCardHtml(
              b,
              `<button class="small primary" data-action="take-form" data-beast="${b.id}" ${forms.active === b.id ? "disabled" : ""}>${forms.active === b.id ? "Облик принят" : "Принять облик"}</button>
               <button class="small danger" data-action="remove-form" data-beast="${b.id}" title="Убрать из списка">✕ Убрать</button>`,
              { active: forms.active === b.id, note: noteFor(b) }
            )
          )
          .join("")}</div>`
      : `<p class="muted">Пока нет ни одного облика — нажмите «+ Добавить облик» и выберите зверей из списка.</p>`;
    return `
      ${activeHtml}
      <div class="panel">
        <div class="row between"><h2 style="margin:0;">Мои облики</h2>
          <button class="small primary" data-action="toggle-form-browse">${formBrowseOpen ? "✕ Закрыть подбор" : "+ Добавить облик"}</button></div>
        ${lim ? `<p class="muted" style="font-size:0.85rem;">«Дикий облик» (${escapeHtml(lim.label)}): ${lim.maxCr < 0 ? "облики пока недоступны (с 2 уровня друида)" : `опасность не выше ${lim.maxCr === 0.25 ? "1/4" : lim.maxCr === 0.5 ? "1/2" : lim.maxCr}${lim.noFly ? ", без скорости полёта" : ""}${lim.noSwim ? ", без скорости плавания" : ""}`}.</p>` : ""}
        ${knownHtml}
      </div>
      ${formBrowseOpen ? formBrowsePanelHtml(forms, lim, noteFor) : ""}`;
  }
  function formBrowsePanelHtml(forms, lim, noteFor) {
    const q = formSearch.trim().toLowerCase();
    const crOptions = ["0", "1/8", "1/4", "1/2", "1", "2", "3", "4", "5", "6", "8"];
    const filtered = beastsData.filter((b) => {
      if (forms.known.includes(b.id)) return false;
      if (q && !(b.name.toLowerCase().includes(q) || (b.en || "").toLowerCase().includes(q))) return false;
      if (formCrFilter !== "all" && beastCrNum(b.cr) > beastCrNum(formCrFilter)) return false;
      const m = beastMoves(b);
      if (formMoveFilter === "fly" && !m.fly) return false;
      if (formMoveFilter === "swim" && !m.swim) return false;
      if (formMoveFilter === "climb" && !m.climb) return false;
      if (formMoveFilter === "burrow" && !m.burrow) return false;
      if (formMoveFilter === "ground" && (m.fly || m.swim || m.climb || m.burrow)) return false;
      if (formOnlyAllowed && lim && !beastAllowedByWildShape(b, lim)) return false;
      return true;
    });
    return `
      <div class="panel">
        <h3>Выбор облика</h3>
        <p class="muted">Существа типа «Зверь» из бестиария dnd.su (${beastsData.length}). Найдено: ${filtered.length}.</p>
        <div class="row spell-filters" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">
          <input type="text" data-form-search placeholder="Поиск по названию…" value="${escapeHtml(formSearch)}" style="flex:1;min-width:160px;" />
          <select data-form-cr-filter style="flex:none;width:auto;">
            <option value="all">Любая опасность</option>
            ${crOptions.map((c) => `<option value="${c}" ${formCrFilter === c ? "selected" : ""}>Опасность до ${c}</option>`).join("")}
          </select>
          <select data-form-move-filter style="flex:none;width:auto;">
            ${[["all", "Любое движение"], ["ground", "Только по земле"], ["fly", "Летает"], ["swim", "Плавает"], ["climb", "Лазает"], ["burrow", "Копает"]].map(([v, l]) => `<option value="${v}" ${formMoveFilter === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          ${lim ? `<label class="row" style="gap:6px;align-items:center;"><input type="checkbox" data-form-only-allowed ${formOnlyAllowed ? "checked" : ""} /> <span>Только доступные по «Дикому облику»</span></label>` : ""}
        </div>
        ${
          filtered.length
            ? `<div class="spell-cards">${filtered
                .slice(0, formShown)
                .map((b) => beastCardHtml(b, `<button class="small primary" data-action="add-form" data-beast="${b.id}">+ Добавить</button>`, { note: noteFor(b) }))
                .join("")}</div>${filtered.length > formShown ? `<div class="row" style="justify-content:center;margin-top:12px;"><button class="primary" data-action="form-more">Показать ещё (${Math.min(30, filtered.length - formShown)} из ${filtered.length - formShown} оставшихся)</button></div>` : ""}`
            : '<p class="muted">Ничего не найдено — измените фильтры.</p>'
        }
      </div>`;
  }

  // ---- Артефакты (магические предметы) ---------------------------------
  // data.artifacts: [{ name, desc, open, damage, damageType, damageOn,
  //   uses: {enabled, max, recharge}, usesState: [bool], spells: [{ id, max, usesState }] }]
  const ARTIFACT_RECHARGE = { none: "без восстановления", short: "короткий отдых", long: "продолжительный отдых", dawn: "на рассвете", any: "любой отдых" };
  function artifactPipsHtml(arr, action, idx, sub) {
    return arr
      .map((filled, j) => `<button type="button" class="pip ${filled ? "filled" : ""}" data-action="${action}" data-index="${idx}" ${sub !== undefined ? `data-spell-index="${sub}"` : ""} data-use-index="${j}" title="${filled ? "Отметить как потраченное" : "Восстановить использование"}"></button>`)
      .join("");
  }
  function artifactUsesArray(state, max) {
    const arr = Array.isArray(state) ? state.slice(0, max) : [];
    while (arr.length < max) arr.push(true);
    return arr;
  }
  function artifactCardHtml(a, i) {
    const u = a.uses || {};
    const usesMax = Math.max(1, Number(u.max) || 1);
    const edit = !a.saved;
    const dawnD = parseDiceFromText(u.dawnDice);
    const spells = (a.spells || []).map((sl, si) => {
      const sp = SPELLS.find((x) => x.id === sl.id);
      if (!sp) return "";
      const max = Number(sl.max) || 0;
      return `
        <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;">
          <button type="button" class="small" data-action="open-artifact-spell" data-spell="${sp.id}" title="Открыть карточку заклинания">✨ ${escapeHtml(sp.name)}</button>
          <span class="muted" style="font-size:0.8rem;">${sp.level === 0 ? "заговор" : sp.level + "-й круг"}</span>
          ${edit ? `<label class="muted" style="font-size:0.8rem;">исп.:
            <input type="number" min="0" max="20" style="width:52px;" data-artifact-spell-max data-index="${i}" data-spell-index="${si}" value="${max}" title="0 — без счётчика" />
          </label>` : ""}
          ${max > 0 ? `<span class="feature-card-uses" style="padding:0;">${artifactPipsHtml(artifactUsesArray(sl.usesState, max), "toggle-artifact-spell-use", i, si)}</span>` : ""}
          ${edit ? `<button type="button" class="small danger" data-action="remove-artifact-spell" data-index="${i}" data-spell-index="${si}" title="Убрать заклинание">✕</button>` : ""}
        </div>`;
    }).join("");
    const dmgDice = parseDiceFromText(a.damage);
    const usesPips = u.enabled ? `<span class="feature-card-uses" style="padding:0;">${artifactPipsHtml(artifactUsesArray(a.usesState, usesMax), "toggle-artifact-use", i)}</span>` : "";
    const dawnBtn = u.enabled && dawnD ? `<button type="button" class="small" data-action="roll-artifact-dawn" data-index="${i}" title="Бросить восстановление зарядов на рассвете">🌅 Рассвет: +${escapeHtml(dawnD.raw)}</button>` : "";
    const header = `
        <div class="row" style="gap:8px;align-items:center;padding-right:28px;flex-wrap:wrap;">
          <button type="button" class="small" data-action="toggle-artifact-open" data-index="${i}" title="${a.open ? "Свернуть" : "Развернуть"}">${a.open ? "▾" : "▸"}</button>
          ${edit
            ? `<input type="text" class="feature-card-title" style="flex:1;min-width:0;" data-artifact-field="name" data-index="${i}" value="${escapeHtml(a.name || "")}" placeholder="Название предмета" />`
            : `<strong class="feature-card-title" style="flex:1;min-width:0;">${escapeHtml(a.name || "Магический предмет")}</strong>`}
          ${a.damageOn && dmgDice ? `<span class="badge" title="Урон включён">⚡ ${escapeHtml(dmgDice.raw)}</span>` : ""}
          <button type="button" class="small ${a.attuned ? "primary" : ""}" data-action="toggle-artifact-attune" data-index="${i}" title="Настройка на предмет">${a.attuned ? "✦ Настроен" : "◇ Не настроен"}</button>
        </div>`;
    let body = "";
    if (a.open) {
      if (edit) {
        body = `
        <label class="feature-card-desc" style="margin-top:8px;">
          <textarea data-artifact-field="desc" data-index="${i}" rows="3" placeholder="Описание, свойства, настройка…">${escapeHtml(a.desc || "")}</textarea>
        </label>
        <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">
          <span class="muted">Урон:</span>
          <input type="text" style="width:90px;" data-artifact-field="damage" data-index="${i}" value="${escapeHtml(a.damage || "")}" placeholder="напр. 1к6" />
          <input type="text" style="width:130px;" data-artifact-field="damageType" data-index="${i}" value="${escapeHtml(a.damageType || "")}" placeholder="вид (огонь…)" />
          <button type="button" class="small ${a.damageOn ? "primary" : ""}" data-action="toggle-artifact-damage" data-index="${i}" title="Включённый урон добавляется в окно урона оружия">${a.damageOn ? "⚡ Урон включён" : "Включить урон"}</button>
          <button type="button" class="small feature-card-roll" data-action="roll-artifact-damage" data-index="${i}">🎲 Бросить</button>
        </div>
        <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">
          <label class="row" style="gap:6px;align-items:center;"><input type="checkbox" data-artifact-uses-enabled data-index="${i}" ${u.enabled ? "checked" : ""} /> Использования / заряды</label>
          ${u.enabled ? `<input type="number" min="1" max="30" style="width:60px;" data-artifact-uses-max data-index="${i}" value="${usesMax}" />
          <select data-artifact-recharge data-index="${i}" style="width:auto;">
            ${Object.entries(ARTIFACT_RECHARGE).map(([k, l]) => `<option value="${k}" ${(u.recharge || "long") === k ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <label class="muted" style="font-size:0.85rem;">на рассвете: <input type="text" style="width:90px;" data-artifact-dawn-dice data-index="${i}" value="${escapeHtml(u.dawnDice || "")}" placeholder="1к6+4" title="Сколько зарядов возвращается на рассвете (кубик), напр. 1к6+4. Пусто — без броска." /></label>
          ${usesPips}` : ""}
        </div>
        <div style="margin-top:10px;">
          <span class="muted">Заклинания предмета:</span>
          ${spells || '<p class="muted" style="margin:4px 0;">Нет заклинаний.</p>'}
          <div class="row" style="gap:8px;margin-top:6px;">
            <select data-artifact-spell-select data-index="${i}" style="flex:1;min-width:160px;">
              <option value="">Добавить заклинание…</option>
              ${[...SPELLS].sort((x, y) => x.name.localeCompare(y.name, "ru")).map((sp) => `<option value="${sp.id}">${escapeHtml(sp.name)} (${sp.level === 0 ? "заг." : sp.level + " кр."})</option>`).join("")}
            </select>
            <button type="button" class="small primary" data-action="add-artifact-spell" data-index="${i}">+ Добавить</button>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:10px;"><button type="button" class="primary" data-action="save-artifact" data-index="${i}">💾 Сохранить</button></div>`;
      } else {
        body = `
        ${a.desc ? `<div style="margin-top:8px;white-space:pre-wrap;line-height:1.4;">${escapeHtml(a.desc)}</div>` : ""}
        ${dmgDice ? `<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">
          <span class="muted">Урон:</span><strong>${escapeHtml(dmgDice.raw)}${a.damageType ? " " + escapeHtml(a.damageType) : ""}</strong>
          <button type="button" class="small ${a.damageOn ? "primary" : ""}" data-action="toggle-artifact-damage" data-index="${i}" title="Включённый урон добавляется в окно урона оружия">${a.damageOn ? "⚡ Урон включён" : "Включить урон"}</button>
          <button type="button" class="small feature-card-roll" data-action="roll-artifact-damage" data-index="${i}">🎲 Бросить</button>
        </div>` : ""}
        ${u.enabled ? `<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">
          <span class="muted">Заряды (${escapeHtml(ARTIFACT_RECHARGE[u.recharge || "long"])}):</span>${usesPips}${dawnBtn}</div>` : ""}
        ${spells ? `<div style="margin-top:8px;"><span class="muted">Заклинания предмета:</span>${spells}</div>` : ""}
        <div class="row" style="justify-content:flex-end;margin-top:10px;"><button type="button" class="small" data-action="edit-artifact" data-index="${i}">✎ Редактировать</button></div>`;
      }
    }
    return `
      <div class="feature-card artifact-card" style="height:auto;">
        <button class="feature-card-remove" data-action="remove-artifact" data-index="${i}" title="Удалить">✕</button>
        ${header}${body}
      </div>`;
  }
  function artifactsPanelHtml() {
    const list = data.artifacts || [];
    const attuned = list.filter((x) => x.attuned).length;
    return `
      <div class="panel">
        <div class="row between"><h2 style="margin:0;">Магические предметы${list.length ? ` <span class="muted" style="font-size:0.8rem;font-weight:normal;">настроено: ${attuned}/3</span>` : ""}</h2><button class="small primary" data-action="add-artifact">+ Добавить предмет</button></div>
        ${list.length ? `<div style="display:flex;flex-direction:column;gap:10px;margin-top:10px;">${list.map(artifactCardHtml).join("")}</div>` : '<p class="muted">Магические предметы: карточка с описанием, уроном, зарядами (в т.ч. восстановление на рассвете), настройкой и заклинаниями.</p>'}
      </div>`;
  }
  function inventoryTab() {
    const weapons = data.weapons || [];
    // Wrapped in .inventory-panels so its four panels (Деньги/Оружие/
    // Боеприпасы/Прочее снаряжение) can sit closer together than panels
    // elsewhere in the app -- see the tighter margin-bottom override for
    // that class in style.css.
    return `
      <div class="inventory-panels">
      <div class="panel">
        <h2>Деньги</h2>
        <div class="money-row">
          ${[["cp", "ММ"], ["sp", "СМ"], ["gp", "ЗМ"], ["pp", "ПМ"]].map(([coin, label]) => `
            <div class="money-box">
              <label>${label}</label>
              <input type="number" data-bind="money.${coin}" value="${data.money[coin] || 0}" />
            </div>`).join("")}
        </div>
        ${moneyCalculatorHtml()}
      </div>
      <div class="panel">
        <div class="row between"><h2 style="margin:0;">Оружие</h2></div>
        <div class="row" style="margin-bottom:10px;">
          <select data-weapon-select style="flex:1;min-width:200px;">
            <option value="">Выберите оружие…</option>
            ${WEAPONS.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("")}
          </select>
          <button class="small primary" data-action="add-weapon">+ Добавить</button>
        </div>
        ${
          weapons.length === 0
            ? '<p class="muted">Оружия пока нет — выберите из списка выше или добавьте своё.</p>'
            : `<table class="sheet-table weapons-table-compact">
          <thead><tr><th style="width:150px;">Название</th><th style="width:55px;">Урон</th><th style="width:70px;">Тип</th><th style="width:95px;">Дальность</th><th style="width:130px;">Свойства</th><th>Особые свойства</th><th></th></tr></thead>
          <tbody>
            ${weapons
              .map((w, i) => {
                // "Already in Атаки" is inferred by name match against the
                // attacks list -- there's no separate id linking a weapon
                // row to the attack it spawned, but the button already
                // copies the weapon's exact name into a new attack, so a
                // name match is a reliable enough signal for this badge.
                const alreadyAdded = (data.attacks || []).some((a) => (a.name || "").trim().toLowerCase() === (w.name || "").trim().toLowerCase() && w.name);
                return `
              <tr>
                <td><input type="text" data-weapon-field="name" data-weapon-index="${i}" value="${escapeHtml(w.name)}" /></td>
                <td><input type="text" data-weapon-field="damage" data-weapon-index="${i}" value="${escapeHtml(w.damage || "")}" /></td>
                <td><input type="text" data-weapon-field="type" data-weapon-index="${i}" value="${escapeHtml(w.type || "")}" /></td>
                <td>
                  <select data-weapon-range-type data-weapon-index="${i}" title="Ближний бой / дальнобойное / метательное — используется боевыми стилями (напр. «Стрельба из лука»)">
                    <option value="">—</option>
                    ${Object.entries(WEAPON_RANGE_TYPE_LABELS).map(([id, label]) => `<option value="${id}" ${w.rangeType === id ? "selected" : ""}>${label}</option>`).join("")}
                  </select>
                </td>
                <td><input type="text" data-weapon-field="properties" data-weapon-index="${i}" value="${escapeHtml(w.properties || "")}" title="${escapeHtml(w.properties || "")}" /></td>
                <td><input type="text" data-weapon-field="special" data-weapon-index="${i}" value="${escapeHtml(w.special || "")}" title="${escapeHtml(w.special || "")}" placeholder="напр. +1к6 огонь" /></td>
                <td class="row" style="gap:4px;flex-wrap:nowrap;align-items:center;">
                  <button class="small ${w.equipped !== false ? "primary" : ""}" data-action="toggle-weapon-equipped" data-index="${i}" title="Надето/снято">
                    ${w.equipped !== false ? "⚔️ надето" : "снято"}
                  </button>
                  <button class="small" data-action="add-weapon-to-attacks" data-index="${i}" title="Добавить в атаки">→ Атаки</button>
                  ${alreadyAdded ? '<span class="badge" style="color:var(--green);border-color:var(--green);white-space:nowrap;">✓ добавлено</span>' : ""}
                  <button class="small danger" data-action="remove-weapon" data-index="${i}">✕</button>
                </td>
              </tr>`;
              })
              .join("")}
          </tbody>
        </table>`
        }
      </div>
      ${artifactsPanelHtml()}
      ${ammoPanel()}
      <div class="panel">
        <h2>Прочее снаряжение</h2>
        <p class="muted">Выберите предмет из списка снаряжения — он добавится строкой ниже с ценой и весом. Также можно дописывать вручную.</p>
        <div class="row" style="margin-bottom:10px;">
          <select data-gear-select style="flex:1;min-width:200px;">
            <option value="">Выберите снаряжение…</option>
            ${GEAR.map((g) => `<option value="${g.id}">${escapeHtml(g.name)} (${escapeHtml(g.cost)}${g.weight ? `, ${g.weight} фнт.` : ""})</option>`).join("")}
          </select>
          <button class="small primary" data-action="add-gear">+ Добавить</button>
        </div>
        <textarea data-bind="equipmentText" rows="12" style="width:100%;" placeholder="напр.:&#10;Рюкзак&#10;Верёвка, 50 фт&#10;Комплект для выживания&#10;Зелье лечения ×2">${escapeHtml(data.equipmentText || "")}</textarea>
      </div>
      </div>`;
  }

  function featsTab() {
    const feats = data.feats || [];
    const preview = FEATS.find((f) => f.id === featPreviewId) || null;
    return `
      <div class="panel">
        <div class="row between"><h2 style="margin:0;">Черты</h2></div>
        <p class="muted">Полный список Player's Handbook, перенесён с <a href="https://dnd.su/feats/" target="_blank" rel="noopener">dnd.su/feats</a>. Черты берутся вместо повышения характеристик на определённых уровнях.</p>
        <div class="row" style="margin-bottom:10px;">
          <select data-feat-select style="flex:1;min-width:200px;">
            <option value="">Выберите черту…</option>
            ${featSelectOptionsHtml(featPreviewId)}
          </select>
          <button class="small primary" data-action="add-feat" ${preview && !featAlreadyTaken(preview, data) && !(preview.id === "martial-adept" && featChosenManeuvers.length < 2) && !featPicksIncomplete(preview, featNewSel, data) ? "" : "disabled"}>+ Добавить</button>
        </div>
        ${
          preview
            ? `
          <div class="card" style="margin-bottom:10px;border-color:var(--gold-dim);">
            ${featInfoHtml(preview, { takenHtml: featAlreadyTaken(preview, data) ? `<p style="margin:0 0 6px;color:var(--danger, #e57373);font-weight:600;">${FEAT_TAKEN_MESSAGE}</p>` : "" })}
            ${
              preview.abilityIncrease && preview.abilityIncrease.choices.length > 1
                ? `
              <div class="row" style="align-items:center;">
                <label style="margin-right:8px;">Повысить характеристику:</label>
                <select data-feat-ability-choice>
                  ${preview.abilityIncrease.choices.map((a) => `<option value="${a}" ${a === featChosenAbility ? "selected" : ""}>${ABILITIES.find((x) => x.id === a)?.label || a}</option>`).join("")}
                </select>
              </div>`
                : ""
            }
            ${
              preview.skillChoice
                ? `
              <p class="muted" style="margin:6px 0 2px;">Выберите ${preview.skillChoice.count} навыка(ов):</p>
              <div class="grid cols-3">
                ${SKILLS.filter((s) => !(data.proficiencies.skills || []).includes(s.id)).map(
                  (s) => `
                  <label style="font-weight:normal;"><input type="checkbox" data-feat-skill-choice value="${s.id}" ${featChosenSkills.includes(s.id) ? "checked" : ""} /> ${escapeHtml(s.label)}</label>`
                ).join("")}
              </div>`
                : ""
            }
            ${
              preview.weaponChoice
                ? `
              <p class="muted" style="margin:6px 0 2px;">Выберите ${preview.weaponChoice.count} вида оружия:</p>
              <div class="grid cols-3">
                ${WEAPONS.filter((w) => w.id !== "custom" && !(data.proficiencies.weapons || []).includes(w.name)).map(
                  (w) => `
                  <label style="font-weight:normal;"><input type="checkbox" data-feat-weapon-choice value="${escapeHtml(w.name)}" ${featChosenWeapons.includes(w.name) ? "checked" : ""} /> ${escapeHtml(w.name)}</label>`
                ).join("")}
              </div>`
                : ""
            }
            ${
              preview.languageChoice
                ? `
              <p class="muted" style="margin:6px 0 2px;">Выберите ${preview.languageChoice.count} языка(ов):</p>
              <div class="grid cols-3">
                ${LANGUAGE_GROUPS.flatMap((g) => g.items).filter((l) => !(data.proficiencies.languages || []).includes(l)).map(
                  (l) => `
                  <label style="font-weight:normal;"><input type="checkbox" data-feat-language-choice value="${escapeHtml(l)}" ${featChosenLanguages.includes(l) ? "checked" : ""} /> ${escapeHtml(l)}</label>`
                ).join("")}
              </div>`
                : ""
            }
            ${
              preview.damageTypeChoice
                ? `
              <div class="row" style="align-items:center;">
                <label style="margin-right:8px;">Вид урона:</label>
                <select data-feat-element-choice>
                  ${ELEMENTAL_ADEPT_DAMAGE_TYPES.map((d) => `<option value="${d.id}" ${d.id === featChosenElement ? "selected" : ""}>${d.label}</option>`).join("")}
                </select>
              </div>`
                : ""
            }
            ${
              preview.magicInitiateChoice || preview.spellSniperChoice
                ? (() => {
                    const cantripCount = preview.magicInitiateChoice ? 2 : 1;
                    const alreadyKnown = new Set([...((data.spellcasting && data.spellcasting.cantrips) || []), ...((data.spellcasting && data.spellcasting.known) || [])]);
                    let cantrips = SPELLS.filter((s) => s.level === 0 && s.classes.includes(featChosenSpellClass) && !alreadyKnown.has(s.id));
                    // «Меткие заклинания» ["Spell Sniper"] only lets you pick a
                    // cantrip that requires an attack roll (its whole benefit
                    // -- ignoring half/three-quarters cover, plus the bonus
                    // cantrip -- is meaningless on a save-based one). SPELLS
                    // has no structured attack/save flag, but every
                    // attack-roll cantrip's own PHB text spells out making a
                    // "дальнобойную/рукопашную атаку заклинанием" as the
                    // resolution mechanic, while a save-based cantrip instead
                    // calls for a "спасбросок" -- a reliable signal to filter on.
                    if (preview.spellSniperChoice) cantrips = cantrips.filter((s) => /атаку заклинанием/i.test((s.desc || []).join(" ")));
                    const spells1 = SPELLS.filter((s) => s.level === 1 && s.classes.includes(featChosenSpellClass) && !alreadyKnown.has(s.id));
                    return `
              <div class="row" style="align-items:center;">
                <label style="margin-right:8px;">Класс:</label>
                <select data-feat-spell-class>
                  ${FEAT_SPELL_CLASS_OPTIONS.map((c) => `<option value="${c.id}" ${c.id === featChosenSpellClass ? "selected" : ""}>${c.label}</option>`).join("")}
                </select>
              </div>
              <p class="muted" style="margin:6px 0 2px;">Выберите ${cantripCount} заговор(а)${preview.spellSniperChoice ? " (требующий броска атаки)" : ""} (${featChosenCantrips.length}/${cantripCount}):</p>
              <div class="grid cols-2">
                ${cantrips.map((s) => `
                <label class="row" style="gap:6px;font-weight:normal;">
                  <input type="checkbox" data-feat-cantrip-choice value="${s.id}" ${featChosenCantrips.includes(s.id) ? "checked" : ""}
                    ${!featChosenCantrips.includes(s.id) && featChosenCantrips.length >= cantripCount ? "disabled" : ""} />
                  ${spellHoverNameHtml(s)}
                </label>`).join("")}
              </div>
              ${
                preview.magicInitiateChoice
                  ? `
              <p class="muted" style="margin:6px 0 2px;">Выберите заклинание 1-го уровня:</p>
              <div class="grid cols-2">
                ${spells1.map((s) => `
                <label class="row" style="gap:6px;font-weight:normal;">
                  <input type="radio" name="feat-spell1-choice" data-feat-spell1-choice value="${s.id}" ${s.id === featChosenSpell ? "checked" : ""} />
                  ${spellHoverNameHtml(s)}
                </label>`).join("")}
              </div>`
                  : ""
              }`;
                  })()
                : ""
            }
            ${
              preview.id === "martial-adept"
                ? `
              <p class="muted" style="margin:6px 0 2px;">Выберите 2 приёма (${featChosenManeuvers.length}/2):</p>
              <div class="grid cols-2">
                ${MANEUVERS.map(
                  (m) => `
                <label class="row" style="gap:6px;align-items:flex-start;font-weight:normal;">
                  <input type="checkbox" data-feat-maneuver-choice value="${m.id}" ${featChosenManeuvers.includes(m.id) ? "checked" : ""}
                    ${!featChosenManeuvers.includes(m.id) && featChosenManeuvers.length >= 2 ? "disabled" : ""} />
                  <span><strong>${escapeHtml(m.name)}</strong><br /><span class="muted" style="font-size:0.82rem;">${escapeHtml(m.desc)}</span></span>
                </label>`
                ).join("")}
              </div>`
                : ""
            }
            ${featPicksHtml(preview, featNewSel, data)}
          </div>`
            : ""
        }
        ${
          feats.length === 0
            ? '<p class="muted">Черт пока нет.</p>'
            : feats
                .map(
                  (f, i) => `
          <div class="card" style="margin-bottom:8px;">
            <div class="row between">
              <h4 style="margin:0;">${escapeHtml(f.name)}</h4>
              <button class="small danger" data-action="remove-feat" data-index="${i}">✕</button>
            </div>
            ${(() => { const src = (FEATS.find((x) => x.id === f.id) || {}).source || "Книга игрока"; return `<p class="muted" style="margin:2px 0;font-size:0.8rem;">${escapeHtml(src)}</p>`; })()}
            ${f.prereq ? `<p class="muted" style="margin:2px 0;">Требование: ${escapeHtml(f.prereq)}</p>` : ""}
            <p style="white-space:pre-line;">${escapeHtml(f.desc || "")}</p>
            ${f.grantedAbility ? `<p class="muted" style="margin:2px 0;">Характеристика: +${f.grantedAmount} ${ABILITIES.find((a) => a.id === f.grantedAbility)?.label || f.grantedAbility}</p>` : ""}
            ${f.grantedSkills && f.grantedSkills.length ? `<p class="muted" style="margin:2px 0;">Навыки: ${f.grantedSkills.map((s) => SKILLS.find((x) => x.id === s)?.label || s).join(", ")}</p>` : ""}
          </div>`
                )
                .join("")
        }
      </div>`;
  }

  function traitsTab() {
    const prof = data.proficiencies || {};
    const listField = (key, label) => `
      <div class="col" style="margin-bottom:6px;">
        <label>${label}</label>
        <textarea rows="2" data-bind-list="proficiencies.${key}" placeholder="через запятую" style="font-size:0.86rem;resize:vertical;">${escapeHtml((prof[key] || []).join(", "))}</textarea>
      </div>`;
    return `
      <div class="panel">
        <h2>Владения и языки</h2>
        <div class="grid cols-2">
          ${listField("armor", "Броня")}
          ${listField("weapons", "Оружие")}
          ${listField("tools", "Инструменты")}
          ${listField("languages", "Языки")}
        </div>
      </div>
      <div class="panel">
        <div class="row between"><h2 style="margin:0;">Умения</h2><button class="small" data-action="add-feature">+ Умение</button></div>
        <p class="muted">Расовые и классовые умения, особенности предыстории — всё, что не является чертой со вкладки «Черты».</p>
        <div class="feature-cards-grid">
          ${(data.features || [])
            .map(
              (f, i) => `
            <div class="feature-card">
              <button class="feature-card-remove" data-action="remove-feature" data-index="${i}" title="Удалить">✕</button>
              <div class="feature-card-header">
                <div class="feature-card-icon">${featureIcon(f.name)}</div>
                <textarea class="feature-card-title" data-feature-field="name" data-feature-index="${i}" rows="1" placeholder="Название">${escapeHtml(f.name)}</textarea>
              </div>
              <div class="feature-card-divider"></div>
              <label class="feature-card-source">
                <span class="feature-card-source-icon">👤</span>
                <input type="text" data-feature-field="source" data-feature-index="${i}" value="${escapeHtml(f.source || "")}" placeholder="Источник (класс/раса/предыстория)" />
              </label>
              ${
                (() => {
                  const known = findKnownFeatureText(f.name, f.source);
                  return known && known.length > (f.desc || "").length
                    ? `<button type="button" class="small feature-card-refresh" data-action="refresh-feature-desc" data-index="${i}" title="Подставить полный текст из базы">↻ Обновить описание из базы</button>`
                    : "";
                })()
              }
              <label class="feature-card-desc">
                <textarea data-feature-field="desc" data-feature-index="${i}" rows="1" placeholder="Описание">${escapeHtml(f.desc || "")}</textarea>
              </label>
              ${featureResourceHtml(f, i)}
              ${
                (() => {
                  // Скрытая атака doesn't get its own roll button here: its
                  // die count scales with Rogue level rather than the flat
                  // "1к6" in its stored text, and it's only ever added onto
                  // a weapon's damage roll (see startDamageRoll), never
                  // rolled by itself. Бардовское вдохновение's "к6" is the
                  // die the RECIPIENT rolls later, not something the bard
                  // rolls here -- so it gets no roll button either.
                  // Проклятие ведьмовского клинка and Ужасающий облик each
                  // mention a bare "«19» или «20» на к20"/"1к10" in passing
                  // (a crit-range note, a temp-HP amount) rather than
                  // something meant to be rolled from this card -- so
                  // featureDiceInfo's generic "к20"/"к10" match is
                  // suppressed for both, same treatment as Скрытая атака.
                  const noRollButton =
                    !!f.rider ||
                    /^Скрытая атака(?![a-zа-яё])/i.test(f.name || "") ||
                    BARD_INSPIRATION_FEATURE_NAME.test(f.name || "") ||
                    /^Проклятие ведьмовского клинка$/i.test(f.name || "") ||
                    /^Ужасающий облик$/i.test(f.name || "") ||
                    // Плут «Надёжный талант»'s own text mentions "к20, равный
                    // 9 и ниже" as the threshold it rewrites, not something
                    // to actually roll from this card -- featureDiceInfo's
                    // generic "к20" match would otherwise add a bogus
                    // "🎲 Бросить 1к20" button.
                    /^Надёжный талант$/i.test(f.name || "") ||
                    // Плут «Каприз судьбы» (20 ур.) turns a failed d20 into a
                    // 20 -- the "к20" in its text is the roll being
                    // rewritten, not something to roll from this card.
                    /^Каприз судьбы$/i.test(f.name || "") ||
                    // Лечащий свет already gets its own dice-count-adjustable
                    // roll button from featureResourceHtml's pool tracker above --
                    // this would otherwise add a second, fixed "🎲 Бросить к6".
                    HEALING_LIGHT_FEATURE_NAME.test(f.name || "") ||
                    // Боевое превосходство's own roll button (below) spends a
                    // pip from the pool -- the generic button would otherwise
                    // add a second, non-spending "🎲 Бросить к8" from the die
                    // size mentioned in the same card's text.
                    BATTLEMASTER_SUPERIORITY_FEATURE_NAME.test(f.name || "") ||
                    // Божественная кара's dice count depends on which spell
                    // slot is spent, chosen only at the moment of a weapon
                    // damage roll (see the "Божественная кара" section of
                    // startDamageRoll) -- a standalone "🎲 Бросить 2к8" button
                    // here would just roll the WRONG (always-minimum)
                    // amount and not spend a slot.
                    /^Божественная кара$/i.test(f.name || "") ||
                    // Фантом «Призрачная походка»'s "1к10 урона силовым
                    // полем" is fall-through damage for ending your turn
                    // inside a creature/object while phased, not something
                    // to roll from this card on its own.
                    /^Призрачная походка$/i.test(f.name || "") ||
                    // Клинок души «Психические клинки» conjures a weapon,
                    // not a one-off roll -- best added to the Атаки tab like
                    // any other weapon (1к6 + характеристика, «фехтовальное,
                    // метательное»), which already has its own attack/damage/
                    // crit roll buttons, rather than duplicated here.
                    /^Психические клинки$/i.test(f.name || "") ||
                    // Бонусные кубики урона следопыта -- предлагаются в окне
                    // урона оружия (см. damageRiders), а не отдельной кнопкой.
                    /^(Планарный воин|Добыча охотника|Победитель чудовищ|Угроза из засады|Добыча убийцы|Ужасающие удары)/i.test(f.name || "") ||
                    // Паладин: Улучшенная божественная кара предлагается в окне
                    // урона оружия (см. damageRiders); Непобедимый покоритель --
                    // "к20" в тексте это порог, а не бросок; Жуткий лорд получает
                    // свои собственные кнопки ниже.
                    /^(Улучшенная божественная кара|Непобедимый покоритель|Жуткий лорд|Всплеск дикости|Нестабильная отдача|Контролируемый всплеск)$/i.test(f.name || "") ||
                    !!divineStrikeType(f) ||
                    /^(Песнь отдыха|Праведное восстановление|Использование божественной силы|Универсальность|Мастер на все руки)/i.test(f.name || "");
                  const dice = noRollButton
                    ? null
                    : PSIONIC_POWER_FEATURE_NAME.test(f.name || "")
                      ? { expr: `1d${psionicDieSides(data)}`, raw: `1к${psionicDieSides(data)}` }
                      : PSI_WARRIOR_POWER_CARD.test(f.name || "") && /Пси-воин/i.test(f.source || "")
                        ? psiWarriorPowerDice()
                      : GRAVE_MIGHT_FEATURE_NAME.test(f.name || "")
                        ? graveyardShriekDice()
                        : monkFeatureDice(f) || featureDiceInfo(f.desc);
                  // «Вор заклинаний»'s own text only says "Сл равна вашей Сл
                  // спасброска заклинания" -- it doesn't restate the 8 +
                  // proficiency + ability formula featureSaveDCInfo's regex
                  // looks for, so that parser correctly finds nothing here.
                  // The DC it's referring to is simply the character's own
                  // spellcasting DC, already computed elsewhere on the sheet.
                  // Клинок души «Раздирание разума»'s own DC formula reads
                  // "8 + бонус мастерства + ваш модификатор Ловкости" (Психические
                  // клинки cast off Ловкость/Харизма/Мудрость), but the save it
                  // actually FORCES is Мудрости -- two different abilities in
                  // the same sentence, which featureSaveDCInfo's generic parser
                  // (built assuming they're always the same ability) can't tell
                  // apart, so it showed the DC-computing ability as if it were
                  // the save type. The DC number itself (computed off Ловкости)
                  // is correct; only the label needs overriding to the save
                  // that's actually rolled.
                  const dc = /^Вор заклинаний$/i.test(f.name || "")
                    ? (spellSaveDC(data) !== null ? { dc: spellSaveDC(data), abilityId: data.spellcasting?.ability || null } : null)
                    : /^Раздирание разума$/i.test(f.name || "")
                      ? (() => { const d = featureSaveDCInfo(f.desc); return d ? { dc: d.dc, abilityId: "wis" } : null; })()
                      : featureSaveDCInfo(f.desc);
                  // Бездонный патрона's "Щупальце из глубин" is a melee
                  // spell attack -- the generic dice button already covers
                  // its cold-damage roll, this adds the missing attack roll
                  // (spell attack bonus) right alongside it.
                  const isTentacle = /^Щупальце из глубин$/i.test(f.name || "");
                  const isDreadLord = /^Жуткий лорд$/i.test(f.name || "");
                  const isSurge = /^(Всплеск дикости|Нестабильная отдача)$/i.test(f.name || "");
                  const isTales = /^Истории с того света$/i.test(f.name || "");
                  const isDragonPick = f.name === "Драконий предок" && /драконьей/i.test(f.source || "");
                  const isDivineMagic = f.name === "Божественная магия" && /божествен/i.test(f.source || "");
                  const isLunar = f.name === "Лунное воплощение";
                  const isGrave = f.name === "Сила могилы";
                  const isFlex = /^Исток магии$/i.test(f.name || "") && /Чародей/i.test(f.source || "");
                  // Школа Прорицания «Знамение»: 2к20 (3к20 с «Великого знамения»); значения хранятся на карточке до следующего броска.
                  const isStormAura = /^Аура бури(?::|$)/.test(f.name || "") && /буревестник/i.test(f.source || "");
                  const stormHtml = isStormAura
                    ? `<select data-storm-env title="Окружение ауры бури" style="flex:none;width:auto;"><option value="">${data.stormEnv ? "Сменить окружение…" : "Выберите окружение…"}</option>${STORM_ENVIRONMENTS.filter((env) => env !== data.stormEnv).map((env) => `<option value="${env}">${env}</option>`).join("")}</select>`
                    : "";
                  const isPortent = /^Знамение$/i.test(f.name || "");
                  const portentCount = (data.features || []).some((x) => /^Великое знамение$/i.test(x.name || "")) ? 3 : 2;
                  const portentRolls = isPortent && Array.isArray(data.portentRolls) ? data.portentRolls : [];
                  const portentHtml = isPortent
                    ? `<button class="small feature-card-roll" data-action="roll-portent">🎲 Бросить знамения (${portentCount}к20)</button>${portentRolls.map((r, ri) => `<button type="button" class="small ${r.used ? "" : "primary"}" data-action="toggle-portent" data-portent="${ri}" title="${r.used ? "Использовано — нажмите, чтобы вернуть" : "Нажмите, когда значение использовано"}" style="min-width:42px;font-weight:700;${r.used ? "text-decoration:line-through;opacity:0.55;" : ""}">${r.v}</button>`).join("")}`
                    : "";
                  const attackBonus = isTentacle || isDreadLord ? spellAttackBonus(data) : null;
                  const isSuperiority = BATTLEMASTER_SUPERIORITY_FEATURE_NAME.test(f.name || "");
                  // Чемпион «Уцелевший»: passive at-the-start-of-your-turn
                  // heal, triggered off a game moment (your turn starting)
                  // the sheet has no clock for -- a button the player clicks
                  // themselves each such turn, same idea as a rest button but
                  // per-turn instead of per-rest.
                  const isSurvivor = /^Уцелевший$/i.test(f.name || "");
                  const survivorAmount = isSurvivor ? 5 + getAbilityMod(data, "con") : 0;
                  const survivorEligible = isSurvivor && Number(data.hp.current) > 0 && Number(data.hp.current) <= Math.floor((Number(data.hp.max) || 0) / 2);
                  // Скрытая атака deliberately gets no roll button of its own
                  // (see noRollButton above -- it's only ever rolled as a
                  // checkbox alongside a weapon's damage), but the card still
                  // benefits from showing the CURRENT die count somewhere,
                  // since it grows with Rogue level and the desc text can't
                  // bake in a number that would go stale.
                  const isSneakAttack = /^Скрытая атака(?![a-zа-яё])/i.test(f.name || "");
                  const sneakInfo = isSneakAttack ? sneakAttackDice() : null;
                  // Bladesinging's "Песнь клинка" is a bonus-action toggle
                  // lasting 1 minute (or until a two-handed weapon attack,
                  // heavier armor/a shield, or being incapacitated ends it
                  // early) that changes derived stats (AC, and later "Песнь
                  // победы"'s melee damage bonus) while active -- the sheet
                  // has no minute-by-minute clock, so this is a manual
                  // on/off switch the player flips themselves, the same way
                  // "Уцелевший" above is a manual per-turn button standing in
                  // for a trigger the sheet can't observe on its own.
                  // armorClass()/doRollAttackDamage() read data.bladesongActive
                  // directly (see the matching comment there).
                  const isBladesong = /^Песнь клинка$/i.test(f.name || "");
                  const bladesongActive = isBladesong && !!data.bladesongActive;
                  const disciplineMeta = disciplineMetaFor(f);
                  const isSharp = SHARP_BLADE_NAME.test(f.name || "") && /кэнсэя/i.test(f.source || "");
                  const isIntervention = /^Божественное вмешательство$/i.test(f.name || "");
                  const clericLevelNow = ((data.classes || []).find((c) => c.id === "cleric") || {}).level || 0;
                  const interventionBtn = isIntervention
                    ? `<button class="small feature-card-roll" data-action="roll-feature-expr" data-expr="1d100" data-label="Божественное вмешательство (успех, если выпало ${clericLevelNow} или меньше)">🎲 Бросить к100</button>`
                    : "";
                  if (!dice && !dc && attackBonus === null && !isSuperiority && !isSurvivor && !sneakInfo && !isBladesong && !isDreadLord && !isSurge && !isTales && !isFlex && !isDragonPick && !isDivineMagic && !isLunar && !isGrave && !isPortent && !isStormAura && !isIntervention && !disciplineMeta && !isSharp) return "";
                  const dcSpan = dc
                    ? `<span class="feature-card-dc" title="Сложность спасброска = 8 + бонус мастерства + модификатор ${ABILITIES.find((a) => a.id === dc.abilityId)?.label || ""}">Сл ${dc.dc}${dc.abilityId ? ` (${ABILITIES.find((a) => a.id === dc.abilityId)?.short || ""})` : ""}</span>`
                    : "";
                  const attackBtn = attackBonus !== null
                    ? `<button class="small feature-card-roll" data-action="roll-feature-attack" data-index="${i}">🎲 Атака ${formatModifier(attackBonus)}</button>`
                    : "";
                  const superiorityBtn = isSuperiority
                    ? `<button class="small feature-card-roll" data-action="roll-superiority-die" data-index="${i}" ${superiorityDiceAvailable() > 0 ? "" : "disabled"}>🎲 Кость превосходства (к${superiorityDieSides(data)})</button>`
                    : "";
                  const rollBtn = dice
                    ? `<button class="small feature-card-roll" data-action="roll-feature" data-index="${i}">🎲 Бросить ${escapeHtml(dice.raw)}</button>`
                    : "";
                  const survivorBtn = isSurvivor
                    ? `<button class="small feature-card-roll" data-action="apply-survivor-heal" data-index="${i}" ${survivorEligible ? "" : "disabled"} title="${survivorEligible ? "" : "Доступно только когда текущие хиты не выше половины максимума и больше 0"}">✚ Восстановить ${survivorAmount} хитов</button>`
                    : "";
                  const sneakSpan = sneakInfo
                    ? `<span class="feature-card-dc" title="Растёт с уровнем Плута — добавляется как флажок в окне броска урона оружием">Сейчас: ${escapeHtml(sneakInfo.raw)}</span>`
                    : "";
                  const bladesongBtn = isBladesong
                    ? `<button class="small feature-card-roll ${bladesongActive ? "primary" : ""}" data-action="toggle-bladesong" data-index="${i}">${bladesongActive ? "✔ Активировано" : "Активировать"}</button>`
                    : "";
                  const chaMod = getAbilityMod(data, "cha");
                  const dreadBtns = isDreadLord
                    ? `<button class="small feature-card-roll" data-action="roll-feature-expr" data-expr="3d10${chaMod ? (chaMod > 0 ? "+" : "") + chaMod : ""}" data-label="Жуткий лорд — тени (некротическая энергия)">🎲 Тени: 3к10${chaMod ? formatModifier(chaMod) : ""} некрот.</button><button class="small feature-card-roll" data-action="roll-feature-expr" data-expr="4d10" data-label="Жуткий лорд — испуганный враг в ауре (психическая энергия)">🎲 Испуганный враг: 4к10 психич.</button>`
                    : "";
                  return `<div class="feature-card-uses" style="justify-content:flex-start;gap:10px;">${disciplineMeta ? disciplineControlsHtml(f, i) : ""}${isSharp ? sharpBladeControlsHtml() : ""}${dreadBtns}${isSurge ? `<button class="small feature-card-roll" data-action="open-wild-table" title="Открыть таблицу «Дикая магия» и бросить по ней">📋 Таблица (бросок)</button>` : ""}${isTales ? `<button class="small feature-card-roll" data-action="open-tales-table" title="Открыть таблицу «Истории духов» и бросить по ней">📋 Таблица (бросок)</button>` : ""}${isDivineMagic ? `<select data-divine-affinity title="Склонность" style="flex:none;width:auto;"><option value="">${data.divineAffinity ? "Сменить склонность…" : "Выберите склонность…"}</option>${DIVINE_AFFINITIES.filter((a) => a.name !== data.divineAffinity).map((a) => `<option value="${a.name}">${a.name} (${(SPELLS.find((x) => x.id === a.spell) || {}).name || ""})</option>`).join("")}</select>${data.divineAffinity ? `<span class="muted">Склонность: ${escapeHtml(data.divineAffinity)}</span>` : ""}` : ""}${isLunar ? lunarPhaseControlsHtml() : ""}${isGrave ? graveControlsHtml() : ""}${isDragonPick ? `<select data-dragon-pick title="Наследие драконьей крови" style="flex:none;width:auto;"><option value="">Выберите предка…</option>${DRAGON_ANCESTRIES.map((d) => `<option value="${d.name}">${d.name} (${d.damage})</option>`).join("")}</select>` : ""}${isFlex ? `<button class="small feature-card-roll" data-action="open-flex-casting" title="Обменять очки чародейства на ячейки и обратно">🔁 Очки ↔ ячейки</button>` : ""}${interventionBtn}${attackBtn}${superiorityBtn}${rollBtn}${survivorBtn}${bladesongBtn}${portentHtml}${stormHtml}${sneakSpan}${dcSpan}</div>`;
                })()
              }
              ${featureSpellPreviewHtml(f)}
            </div>`
            )
            .join("")}
        </div>
        ${(data.features || []).length === 0 ? '<p class="muted">Умений пока нет — добавьте первое.</p>' : ""}
      </div>`;
  }

  // Picks a small thematic glyph for a feature card's icon circle from a
  // few common keywords in its name (темное зрение → eye, сопротивление →
  // shield, etc.); falls back to a plain star when nothing matches, since
  // free-form features have no dedicated icon field of their own.
  function featureIcon(name) {
    const n = (name || "").toLowerCase();
    if (/зрени|виде/.test(n)) return "👁";
    if (/сопротивлен|защит|броня|щит/.test(n)) return "🛡";
    if (/скорост|бег|прыж/.test(n)) return "💨";
    if (/яд|отрав/.test(n)) return "☠";
    if (/огон|пламя|огнен/.test(n)) return "🔥";
    if (/лед|холод|мороз/.test(n)) return "❄";
    if (/магн|заклинан|волшеб/.test(n)) return "✨";
    if (/удач|везен/.test(n)) return "🍀";
    if (/сил|мощь|атлет/.test(n)) return "💪";
    if (/чувств|нюх|слух|обонян/.test(n)) return "👃";
    return "✦";
  }

  function combatStatBox(key, label, value, auto, rollAction) {
    const manual = manualOverride(data, key) !== null;
    const notes = key === "speed"
      ? [...speedBonusSources(data).map((b) => `+${b.amount} (${b.label})`), ...(exhaustionLevel(data) >= 2 ? [`Истощение ${exhaustionLevel(data)}: ${exhaustionLevel(data) >= 5 ? "скорость 0" : "скорость вдвое"}`] : [])]
      : [];
    const shown = key === "init" ? (value >= 0 ? "+" + value : String(value)) : String(value);
    return `<div class="stat-box${manual ? " manual" : ""}" title="${escapeHtml(notes.join(", "))}">
      <input class="value" type="text" inputmode="numeric" style="width:100%;min-width:0;box-sizing:border-box;text-align:center;background:transparent;border:none;padding:0;color:var(--gold-bright);font-weight:800;" data-override="${key}" data-auto="${key === "init" ? formatModifier(auto) : auto}" value="${shown}" />
      <div class="label">${label}${rollAction ? ` <button class="btn small ghost" data-action="${rollAction}" title="Бросить">🎲</button>` : ""}${manual ? ` <button class="btn small ghost" data-override-reset="${key}" title="Сбросить к расчётному (${key === "init" ? formatModifier(auto) : auto})">↺</button>` : ""}</div>
    </div>`;
  }

  function personalityTab() {
    const p = data.personality || {};
    // Fixed-height boxes that scroll inside themselves once the text outgrows
    // them (same behaviour as a feature card's description), instead of a
    // tiny 2-row box or a page that keeps stretching.
    const field = (key, label, height = 72) => `
      <div class="col" style="margin-bottom:8px;">
        <label>${label}</label>
        <textarea class="scroll-text" data-bind="personality.${key}" style="height:${height}px;min-height:56px;">${escapeHtml(p[key] || "")}</textarea>
      </div>`;
    return `
      <div class="panel">
        <h2>Личность и предыстория</h2>
        ${field("traits", "Черты характера")}
        ${field("ideals", "Идеалы")}
        ${field("bonds", "Привязанности")}
        ${field("flaws", "Слабости")}
        ${field("backstory", "История персонажа", 320)}
      </div>
      <div class="panel">
        <h2>Заметки</h2>
        <textarea class="scroll-text" data-bind="notes" style="height:260px;">${escapeHtml(data.notes || "")}</textarea>
      </div>`;
  }

  // ---- Спутники и существа: карточки со статами, как в «Обликах» -------------------------------
  function petMaxHp(p) { return parseInt(p.hp, 10) || 0; }
  function petCardHtml(p, i) {
    const max = petMaxHp(p);
    const cur = p.hpCur == null ? max : Number(p.hpCur) || 0;
    const actions = `
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;">
        <label class="muted" style="font-size:0.82rem;">Хиты <input type="number" data-pet-num="hpCur" data-pet-index="${i}" value="${cur}" style="width:64px;" /> / ${max || "—"}</label>
        <label class="muted" style="font-size:0.82rem;">Врем. хиты <input type="number" min="0" data-pet-num="tempHp" data-pet-index="${i}" value="${Number(p.tempHp) || 0}" style="width:56px;" /></label>
      </div>
      <textarea data-pet-field="desc" data-pet-index="${i}" rows="2" placeholder="Заметки" style="margin-top:6px;">${escapeHtml(p.desc || "")}</textarea>
      <div class="row" style="gap:8px;margin-top:6px;">
        <button class="small" data-action="edit-pet" data-index="${i}">✎ Изменить статы</button>
        <button class="small danger" data-action="remove-pet" data-index="${i}">✕ Удалить</button>
      </div>`;
    return beastCardHtml({ ...p, id: `pet-${i}`, name: p.name || "Без имени", sta: p.sta || "Существо", cr: p.cr || "—" }, actions, { active: true });
  }
  function petsTab() {
    ensureCompanions();
    const pets = data.pets || [];
    return `
      <div class="panel">
        <div class="row between" style="flex-wrap:wrap;gap:8px;">
          <h2 style="margin:0;">Спутники и питомцы</h2>
          <div class="row" style="gap:8px;"><button class="small" data-action="add-pet">+ Своё существо</button><button class="small" data-action="browse-pet-beasts">+ Зверь из списка</button></div>
        </div>
        ${pets.length ? `<div class="spell-cards" style="margin-top:12px;">${pets.map(petCardHtml).join("")}</div>` : `<p class="muted">Спутников пока нет.</p>`}
      </div>`;
  }
  // Спутники, которых дают умения: добавляются автоматически (один раз по ключу).
  const COMPANION_FEATURES = [
    { key: "hound-of-ill-omen", feature: "Гончая дурного знамения", beastEn: "Dire wolf", make: (b, lvl) => ({
      name: "Гончая дурного знамения", sta: "Средний Монстр, без мировоззрения", tempHp: Math.floor(lvl / 2),
      desc: "Вызывается бонусным действием за 3 очка чародейства (цель в 120 футах). Врем. хиты = половина уровня чародея. Проходит сквозь существ и объекты как через труднопроходимую местность; 5 силового урона, если ход закончен внутри объекта. Появляется в пределах 30 футов от цели, бросает инициативу; в свой ход только движется к цели и атакует её. Цель в пределах 5 футов от гончей совершает с помехой спасброски против ваших заклинаний. Длится 1 минуту, пока гончая или цель не умрут или вы не отпустите её.",
    }) },
  ];
  function ensureCompanions() {
    if (!Array.isArray(data.pets)) data.pets = [];
    let changed = false;
    COMPANION_FEATURES.forEach((cf) => {
      if (!(data.features || []).some((f) => f.name === cf.feature)) return;
      if (data.pets.some((p) => p.key === cf.key)) return;
      if (!beastsData) { ensureBeastsLoaded(); return; }
      const base = beastsData.find((b) => b.en === cf.beastEn);
      if (!base) return;
      const lvl = ((data.classes || []).find((c) => c.id === "sorcerer") || {}).level || 6;
      data.pets.push({ ...JSON.parse(JSON.stringify(base)), ...cf.make(base, lvl), key: cf.key, hpCur: parseInt(base.hp, 10) || 0 });
      changed = true;
    });
    if (changed) doSave();
    return changed;
  }
  const PET_ABIL = [["Сил", "str"], ["Лов", "dex"], ["Тел", "con"], ["Инт", "int"], ["Мдр", "wis"], ["Хар", "cha"]];
  function petLinesToItems(txt) {
    return String(txt || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^([^.]{1,60})\.\s+(.*)$/);
      return m ? { n: m[1], t: m[2] } : { n: "", t: l };
    });
  }
  function petItemsToLines(items) { return (items || []).map((x) => (x.n ? `${x.n}. ${x.t}` : x.t)).join("\n"); }
  function openPetEditor(index) {
    const p = index == null ? {} : data.pets[index];
    const abilVals = PET_ABIL.map(([lab], k) => {
      const m = String((p.abil || [])[k] || "").match(/(\d+)/);
      return m ? m[1] : "10";
    });
    const actionsSec = (p.sections || []).find((sc) => /Действия/i.test(sc.title)) || { items: [] };
    const otherSecs = (p.sections || []).filter((sc) => sc !== actionsSec);
    const f = (label, key, val, w) => `<label style="flex:${w || 1};min-width:120px;"><span class="muted" style="font-size:0.8rem;">${label}</span><input type="text" data-pe="${key}" value="${escapeHtml(val || "")}" /></label>`;
    const modal = openModal(`
      <h3>${index == null ? "Новое существо" : "Статы: " + escapeHtml(p.name || "")}</h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;">${f("Имя", "name", p.name, 2)}${f("Тип и размер", "sta", p.sta, 2)}${f("Опасность", "cr", p.cr)}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap;">${f("Класс доспеха", "ac", p.ac)}${f("Хиты (напр. 37 (5к10+10))", "hp", p.hp)}${f("Скорость", "speed", p.speed)}</div>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px;">${PET_ABIL.map(([lab], k) => `<label style="width:64px;"><span class="muted" style="font-size:0.8rem;">${lab}</span><input type="number" data-pe-abil="${k}" value="${abilVals[k]}" /></label>`).join("")}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap;">${f("Чувства", "senses", p.senses, 2)}</div>
      <label style="display:block;margin-top:6px;"><span class="muted" style="font-size:0.8rem;">Особенности (по строке: «Название. Текст»)</span><textarea data-pe="traits" rows="3">${escapeHtml(petItemsToLines(p.traits))}</textarea></label>
      <label style="display:block;margin-top:6px;"><span class="muted" style="font-size:0.8rem;">Действия (по строке: «Название. Текст», для атаки пишите «+5 к попаданию … Попадание: 2к6+3 колющего»)</span><textarea data-pe="actions" rows="4">${escapeHtml(petItemsToLines(actionsSec.items))}</textarea></label>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:10px;"><button type="button" data-action="close-modal">Отмена</button><button type="button" class="primary" data-action="save-pet-edit">Сохранить</button></div>`, { wide: true });
    on(modal, "click", "[data-action=close-modal]", closeModal);
    on(modal, "click", "[data-action=save-pet-edit]", () => {
      const g = (k) => modal.querySelector(`[data-pe="${k}"]`).value.trim();
      if (!g("name")) { modal.querySelector('[data-pe="name"]').focus(); return; }
      const abil = PET_ABIL.map(([lab], k) => { const v = Number(modal.querySelector(`[data-pe-abil="${k}"]`).value) || 10; const mod = Math.floor((v - 10) / 2); return `${lab}${v} (${mod >= 0 ? "+" : ""}${mod})`; });
      const sections = [...otherSecs];
      const acts = petLinesToItems(g("actions"));
      if (acts.length) sections.unshift({ title: "Действия", items: acts });
      const np = { ...p, name: g("name"), sta: g("sta"), cr: g("cr"), ac: g("ac"), hp: g("hp"), speed: g("speed"), senses: g("senses"), abil, traits: petLinesToItems(g("traits")), sections };
      if (np.hpCur == null) np.hpCur = petMaxHp(np);
      if (index == null) data.pets.push(np); else data.pets[index] = np;
      closeModal(); doSave(); render();
    });
  }
  function openPetBeastBrowser() {
    const modal = openModal(`<h3>Зверь из списка</h3><input type="text" data-pb-q placeholder="Поиск по названию…" style="width:100%;margin-bottom:8px;" /><div data-pb-list class="muted">Загрузка…</div><div class="row" style="justify-content:flex-end;margin-top:10px;"><button type="button" data-action="close-modal">Закрыть</button></div>`, { wide: true });
    on(modal, "click", "[data-action=close-modal]", closeModal);
    const paint = () => {
      const q = modal.querySelector("[data-pb-q]").value.trim().toLowerCase();
      const list = (beastsData || []).filter((b) => !q || b.name.toLowerCase().includes(q) || (b.en || "").toLowerCase().includes(q)).slice(0, 60);
      modal.querySelector("[data-pb-list]").innerHTML = list.length ? list.map((b) => `<div class="row between" style="padding:4px 0;border-bottom:1px solid var(--border,#ccc3);"><span>${escapeHtml(b.name)} <span class="muted">· ${escapeHtml(b.cr)} · ${escapeHtml(b.sta || "")}</span></span><button class="small primary" data-pb-add="${b.id}">+ Добавить</button></div>`).join("") : "Ничего не найдено.";
    };
    const go = () => paint();
    if (beastsData) go(); else import("../data/beasts.js").then((m) => { beastsData = m.BEASTS; go(); }).catch(() => { modal.querySelector("[data-pb-list]").textContent = "Не удалось загрузить список."; });
    on(modal, "input", "[data-pb-q]", paint);
    on(modal, "click", "[data-pb-add]", (e, el) => {
      const b = (beastsData || []).find((x) => String(x.id) === el.dataset.pbAdd);
      if (!b) return;
      data.pets.push({ ...JSON.parse(JSON.stringify(b)), hpCur: parseInt(b.hp, 10) || 0 });
      closeModal(); doSave(); render();
    });
  }

  // ---------- wiring (delegated on #app, attached once) ----------
  const app = document.getElementById("app");
  wireHoverCardPortal(app);

  if (rollLogRefreshHandler) document.removeEventListener("dnd5e:roll-logged", rollLogRefreshHandler);
  rollLogRefreshHandler = () => {
    const logEl = $("[data-roll-log]", app);
    if (logEl) logEl.innerHTML = rollLogEntriesHtml();
  };
  document.addEventListener("dnd5e:roll-logged", rollLogRefreshHandler);

  on(app, "click", "[data-tab]", (e, el) => {
    activeTab = el.dataset.tab;
    render();
  });

  const bindHandler = (e, el) => {
    const path = el.dataset.bind;
    let value = el.value;
    if (el.type === "number") value = value === "" ? null : Number(value);
    set(data, path, value);
    if (path === "armorId") data.armorEquipped = !!value;
    doSave();
    recomputeIfNeeded(path);
    if (path === "spellcasting.ability" || path === "edition" || path === "armorId") render();
  };
  on(app, "input", "[data-bind]", bindHandler);
  on(app, "change", "select[data-bind]", bindHandler);
  // Shared min/max guard for the number inputs that used to accept negative
  // or unbounded values (HP, shield/armor AC fields) -- `data-clamp="min:max"`
  // on the input, checked on blur/change (not every keystroke, so clearing
  // the field to type a fresh multi-digit value doesn't get snapped back
  // mid-edit the way an on-input clamp would).
  on(app, "change", "[data-override]", (e, el) => {
    const key = el.dataset.override;
    const n = parseInt(String(el.value).replace(/[^\d+-]/g, ""), 10);
    data.overrides = data.overrides || {};
    if (!Number.isFinite(n) || String(n) === String(parseInt(String(el.dataset.auto).replace("+", ""), 10))) delete data.overrides[key];
    else data.overrides[key] = Math.max(1, Math.min(key === "speed" ? 100 : 35, n));
    doSave();
    render();
  });
  on(app, "click", "[data-override-reset]", (e, el) => {
    if (data.overrides) delete data.overrides[el.dataset.overrideReset];
    doSave();
    render();
  });
  on(app, "change", "[data-clamp]", (e, el) => {
    const [min, max] = el.dataset.clamp.split(":").map(Number);
    const fallback = Number.isFinite(min) ? min : 0;
    const clamped = clampInt(el.value, min, max, fallback);
    el.value = clamped;
    set(data, el.dataset.bind, clamped);
    doSave();
    recomputeIfNeeded(el.dataset.bind);
  });
  on(app, "change", "[data-bind-checkbox]", (e, el) => {
    set(data, el.dataset.bindCheckbox, el.checked);
    doSave();
  });
  on(app, "input", "[data-bind-list]", (e, el) => {
    const list = el.value.split(",").map((s) => s.trim()).filter(Boolean);
    set(data, el.dataset.bindList, list);
    doSave();
  });

  on(app, "input", "[data-ability-score]", (e, el) => {
    const ab = el.dataset.abilityScore;
    set(data, `abilities.${ab}`, el.value === "" ? 10 : Number(el.value));
    doSave();
    recomputeAll();
  });
  // 1-30 is the actual rules ceiling/floor for an ability score (a wish/
  // magic-item effect can push a score past 20, but nothing pushes it past
  // 30) -- clamped here on blur/change rather than on every keystroke, so
  // typing a fresh multi-digit value (clear the field, then type "1", "8")
  // doesn't get snapped back to the floor mid-edit. Creation/level-up below
  // stop at 20 instead, since nothing short of a manual sheet edit is meant
  // to push a score past that.
  on(app, "change", "[data-ability-score]", (e, el) => {
    const ab = el.dataset.abilityScore;
    const clamped = clampInt(el.value, 1, 30, 10);
    el.value = clamped;
    set(data, `abilities.${ab}`, clamped);
    doSave();
    recomputeAll();
  });

  on(app, "click", "[data-action=toggle-save-prof]", (e, el) => {
    const ab = el.dataset.ability;
    const list = data.proficiencies.savingThrows;
    const idx = list.indexOf(ab);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(ab);
    doSave();
    render();
  });

  on(app, "click", "[data-action=cycle-skill-prof]", (e, el) => {
    const sk = el.dataset.skill;
    const profList = data.proficiencies.skills;
    const expList = data.proficiencies.expertise;
    const isProf = profList.includes(sk);
    const isExp = expList.includes(sk);
    if (!isProf && !isExp) {
      profList.push(sk);
    } else if (isProf && !isExp) {
      expList.push(sk);
    } else {
      set(data, "proficiencies.skills", profList.filter((x) => x !== sk));
      set(data, "proficiencies.expertise", expList.filter((x) => x !== sk));
    }
    doSave();
    render();
  });

  // classes
  on(app, "click", "[data-action=add-class]", () => {
    const levelBefore = totalLevel(data);
    data.classes.push({ id: "", name: "", level: 1, subclass: "" });
    syncHitDiceTotalToLevel(levelBefore);
    doSave();
    render();
  });
  on(app, "click", "[data-action=remove-class]", (e, el) => {
    const levelBefore = totalLevel(data);
    data.classes.splice(Number(el.dataset.index), 1);
    syncHitDiceTotalToLevel(levelBefore);
    doSave();
    render();
  });
  on(app, "input", "[data-class-field]", (e, el) => {
    const i = Number(el.dataset.classIndex);
    const field = el.dataset.classField;
    // The subclass dropdown is handled by the dedicated "change" listener
    // below (it has to rebuild feature cards and prune spells, not just
    // store the new value), and the free-text fallback for a class with no
    // catalog entries has nothing else to rebuild, so plain assignment there
    // is still fine -- but skip the dropdown case here entirely so the two
    // listeners don't fight over the same field on the same event.
    if (field === "subclass" && el.tagName === "SELECT") return;
    const levelBefore = field === "level" ? totalLevel(data) : null;
    let val = el.value;
    if (field === "level") val = Math.max(1, Math.min(20, Number(val) || 1));
    if (field === "id") {
      const cls = CLASSES.find((c) => c.id === val);
      data.classes[i].name = cls ? cls.name : "";
    }
    data.classes[i][field] = val;
    if (field === "level") syncHitDiceTotalToLevel(levelBefore);
    doSave();
    if (field !== "subclass") render();
  });
  // Changing the subclass dropdown swaps every feature card and prunes any
  // stranded expanded-list spell (see applySubclassFeatures/
  // pruneStaleSubclassSpells above) instead of just overwriting the label.
  on(app, "change", "select[data-class-field=subclass]", (e, el) => {
    const i = Number(el.dataset.classIndex);
    const c = data.classes[i];
    if (!c) return;
    const cls = getClass(c.id);
    if (!cls) return;
    const oldSubName = c.subclass || "";
    const newSubName = el.value || "";
    if (oldSubName.toLowerCase() === newSubName.toLowerCase()) return;
    const findSub = (name) => (cls.subclasses || []).find((s) => s.name.toLowerCase() === name.toLowerCase()) || null;
    const oldSub = oldSubName ? findSub(oldSubName) : null;
    const newSub = newSubName ? findSub(newSubName) : null;
    removeSubclassFeatures(cls, oldSubName);
    pruneStaleSubclassSpells(oldSub, newSub);
    c.subclass = newSubName;
    applySubclassFeatures(cls, newSub, Number(c.level) || 1);
    doSave();
    render();
  });
  // Changing the fighting-style dropdown swaps that one feature card (see
  // applyFightingStyleChange above) -- a completely separate choice from
  // the subclass dropdown handled just above, even though both live in the
  // same class row.
  on(app, "change", "[data-class-fighting-style]", (e, el) => {
    const i = Number(el.dataset.classIndex);
    const c = data.classes[i];
    if (!c) return;
    const cls = getClass(c.id);
    if (!cls || !cls.level1Choice || cls.level1Choice.type !== "fightingStyle") return;
    applyFightingStyleChange(cls, el.value || "");
    doSave();
    render();
  });

  // attacks
  on(app, "click", "[data-action=add-attack]", () => {
    data.attacks.push({ name: "", bonus: "", damage: "", special: "", useSpecial: false, rangeType: "" });
    doSave();
    render();
  });
  on(app, "click", "[data-action=remove-attack]", (e, el) => {
    data.attacks.splice(Number(el.dataset.index), 1);
    doSave();
    render();
  });
  on(app, "click", "[data-action=cycle-attack-hand]", (e, el) => {
    const a = data.attacks[Number(el.dataset.index)];
    if (!a) return;
    const idx = ATTACK_HAND_CYCLE.indexOf(a.hand);
    a.hand = ATTACK_HAND_CYCLE[(idx + 1) % ATTACK_HAND_CYCLE.length];
    doSave();
    render();
  });
  on(app, "input", "[data-attack-field]", (e, el) => {
    const i = Number(el.dataset.attackIndex);
    data.attacks[i][el.dataset.attackField] = el.value;
    doSave();
  });
  on(app, "change", "[data-attack-range-type]", (e, el) => {
    const i = Number(el.dataset.attackIndex);
    data.attacks[i].rangeType = el.value;
    doSave();
  });
  // Attack bonus, when an ability is picked, is always (that ability's
  // modifier + current proficiency bonus) computed live -- NOT a number
  // baked into a.bonus once and left stale as the character's proficiency
  // bonus grows with level. a.bonus itself is only ever read/written for
  // the manual-entry case (no ability picked).
  function attackBonusValue(a) {
    return getAbilityMod(data, a.ability) + proficiencyBonus(data);
  }
  // Picking an ability here just switches the bonus field to live/read-only
  // mode (see attackBonusValue above and its use in the table render and
  // roll-attack below); choosing "—" hands the field back for manual entry.
  on(app, "change", "[data-attack-ability]", (e, el) => {
    const i = Number(el.dataset.attackIndex);
    data.attacks[i].ability = el.value;
    doSave();
    render();
  });
  // Клятва преданности (3-й уровень паладина): «Священное оружие» -- until it
  // ends (1 минута) the weapon's attack rolls get +Харизма (минимум +1). Offered
  // as an optional checkbox in the attack roll window.
  function sacredWeaponAvailable() {
    const p = (data.classes || []).find((c) => c.id === "paladin");
    return !!(p && Number(p.level) >= 3 && /преданности/i.test(p.subclass || ""));
  }
  on(app, "click", "[data-action=roll-attack]", (e, el) => {
    const a = data.attacks[Number(el.dataset.index)];
    let bonus = a.ability ? attackBonusValue(a) : parseInt(String(a.bonus).replace(/[^-\d]/g, ""), 10) || 0;
    // Боевой стиль «Стрельба из лука»: +2 к броскам атаки, but only for a
    // weapon actually classified Дальнобойное -- a thrown Ближний бой
    // weapon (dagger, handaxe...) doesn't qualify even at range, per how
    // the PHB weapon table itself splits Melee vs Ranged (see
    // weaponRangeType() in dnd5e-data.js).
    const archeryBonus = a.rangeType === "ranged" && hasFightingStyle("Стрельба из лука") ? 2 : 0;
    bonus += archeryBonus;
    openD20RollModal({
      label: `Атака: ${a.name || "без названия"}${archeryBonus ? " (+2 Стрельба из лука)" : ""}`,
      modifier: bonus,
      forcedDisadvantage: exhaustionDisadvantage("attack"),
      critMin: attackCritRange(),
      superiorityDie: hasBattlemaster()
        ? { sides: superiorityDieSides(data), available: superiorityDiceAvailable(), onUse: () => { const used = consumeSuperiorityDie(); if (used) render(); return used; } }
        : null,
      blessed: !!data.blessingActive,
      bonusOptions: [...(sacredWeaponAvailable() ? [{ label: `Священное оружие (+${Math.max(1, getAbilityMod(data, "cha"))} — модификатор Харизмы) — Божественный канал активен`, bonus: Math.max(1, getAbilityMod(data, "cha")) }] : []), ...(Number(data.sharpBlade) && (data.features || []).some((f) => SHARP_BLADE_NAME.test(f.name || "")) ? [{ label: `Заострённый клинок (+${Number(data.sharpBlade)})`, bonus: Number(data.sharpBlade) }] : [])],
      powerAttack: hasFeat(GREAT_WEAPON_MASTER_FEAT_ID) && weaponIsHeavyMelee(a)
        ? { penalty: 5, label: "-5 к атаке (Мастер большого оружия) — при попадании +10 к урону", onToggle: (used) => { a.usePowerAttack = used; doSave(); } }
        : hasFeat(SHARPSHOOTER_FEAT_ID) && a.rangeType === "ranged"
          ? { penalty: 5, label: "-5 к атаке (Меткий стрелок) — при попадании +10 к урону", onToggle: (used) => { a.usePowerAttack = used; doSave(); } }
          : null,
    });
    const ammoType = ammoTypeForWeapon(a.name);
    if (ammoType) {
      if (!data.ammo) data.ammo = { arrows: 0, bolts: 0, javelins: 0, darts: 0 };
      if ((data.ammo[ammoType] || 0) > 0) {
        data.ammo[ammoType] -= 1;
        doSave();
        render();
      }
    }
  });
  // Скрытая атака (Sneak Attack) no longer gets its own 🎲 button on the
  // feature card (see traitsTab/featureDiceInfo below) -- a flat "roll 1к6"
  // button there was misleading anyway, since the die count actually scales
  // with Rogue level (1к6 at 1st, +1к6 every 2 levels, up to 10к6 at 20th)
  // and it's only ever added ONTO a weapon's damage roll, never rolled on
  // its own. Instead it's offered as a checkbox alongside the weapon's own
  // "special properties" bonus dice in startDamageRoll below.
  function sneakAttackDice() {
    const rogue = (data.classes || []).find((c) => c.id === "rogue");
    const lvl = rogue ? Number(rogue.level) || 0 : 0;
    if (lvl < 1) return null;
    const count = Math.min(10, Math.ceil(lvl / 2));
    return { expr: `${count}d6`, raw: `${count}к6` };
  }
  // A fighting-style feature card is always named "<Боевой стиль label>:
  // <style name>" (e.g. "Боевой стиль: Дуэлянт") -- see doFinish() in
  // wizard.js and applyFightingStyleChange() below, which both use this
  // same naming convention when creating/switching the card. Matching on
  // that suffix (rather than a hardcoded class check) means this keeps
  // working for any class that grants a fighting style this way (Воин at
  // creation now, Паладин/Следопыт once they reach the level that grants
  // one and a player records it the same way).
  function hasFightingStyle(styleName) {
    const re = new RegExp(`боевой стиль\\s*:\\s*${styleName}\\s*$`, "i");
    return (data.features || []).some((f) => re.test(f.name || ""));
  }
  function hasFeat(featId) {
    return (data.feats || []).some((f) => f.id === featId);
  }
  const SAVAGE_ATTACKER_FEAT_ID = "savage-attacker";
  const GREAT_WEAPON_MASTER_FEAT_ID = "great-weapon-master";
  const SHARPSHOOTER_FEAT_ID = "sharpshooter";
  // Half-orc's "Свирепые атаки": on a critical hit, one extra weapon damage
  // die (on top of the normal crit doubling) is merged straight into the
  // base weapon die count -- unlike Скрытая атака this is automatic on
  // every crit, not situational, so it needs no checkbox. Per the user's
  // correction, this must NOT show up as a separate roll+segment with
  // explanatory text -- it has to be part of the single combined base-die
  // expression from the start (e.g. a 1к6 weapon on a crit becomes 3к6:
  // 2 dice from crit-doubling + 1 from Свирепые атаки, all rolled and
  // displayed as one pool), with no "(свирепые атаки)" text anywhere in
  // the output.
  function hasSavageAttacks() {
    return (data.features || []).some((f) => /свирепые атаки/i.test(f.name || ""));
  }
  // Champion's crit-range widening (see item 3, sheet.js's roll-attack
  // handler below) -- "Превосходные критические попадания" (15th level,
  // 18-20) supersedes "Улучшенные критические попадания" (3rd level,
  // 19-20), same feature-name-match convention as hasSavageAttacks above.
  function attackCritRange() {
    if ((data.features || []).some((f) => /^Превосходные критические попадания$/i.test(f.name || ""))) return 18;
    if ((data.features || []).some((f) => /^Улучшенные критические попадания$/i.test(f.name || ""))) return 19;
    return 20;
  }
  // Rolls an attack's damage: weapon die + the ability modifier its Хар-ка
  // dropdown selects (not whatever flat number the free-text "Урон/тип"
  // field happens to carry -- that could double-count the ability mod),
  // plus the special-properties bonus dice when useSpecial is true, plus
  // Скрытая атака's dice when useSneak is true. On a crit, every damage DIE
  // (base + bonus + sneak) is doubled in count -- modifiers (ability mod,
  // any flat +K in the expression) are left exactly as-is, per 5e crit
  // rules.
  function doubleDiceCount(expr) {
    const m = String(expr).match(/^(\d*)d(\d+)([+-]\s*\d+)?$/i);
    if (!m) return expr;
    const count = (m[1] ? parseInt(m[1], 10) : 1) * 2;
    return `${count}d${m[2]}${m[3] || ""}`;
  }
  // Adds Свирепые атаки's one extra die directly onto a dice expression's
  // count (2к6 -> 3к6), rather than rolling/displaying it separately.
  function addSavageAttacksDie(expr) {
    return addExtraDice(expr, 1);
  }
  function addExtraDice(expr, extra) {
    const m = String(expr).match(/^(\d*)d(\d+)([+-]\s*\d+)?$/i);
    if (!m) return expr;
    const count = (m[1] ? parseInt(m[1], 10) : 1) + extra;
    return `${count}d${m[2]}${m[3] || ""}`;
  }
  // Barbarian's «Сильный критический удар»: extra weapon damage dice merged into the
  // crit roll, same idea as Half-Orc's Свирепые атаки above but scaling with
  // level (1 die at 9th, 2 at 13th, 3 at 17th) instead of a flat one.
  function barbarianLevel(data) {
    const b = (data.classes || []).find((c) => c.id === "barbarian");
    return b && b.level ? b.level : 0;
  }
  function brutalCriticalDice(data) {
    const lvl = barbarianLevel(data);
    if (lvl >= 17) return 3;
    if (lvl >= 13) return 2;
    if (lvl >= 9) return 1;
    return 0;
  }
  function rageDamageBonus(data) {
    const lvl = barbarianLevel(data);
    if (lvl >= 16) return 4;
    if (lvl >= 9) return 3;
    return 2;
  }
  // Every dice-formula segment shown to the player must use Cyrillic "к",
  // never Latin "d" -- some formulas are built from whatever the user
  // literally typed into a free-text field (parseDiceFromText's "raw"),
  // which could be "d" either way, and downstream formula-parsing elsewhere
  // in the app expects "к" consistently. This replaces every "NdM" run in
  // an expression (not just an anchored one at the very start), so it's
  // safe regardless of how the count is written.
  function toCyrillicDice(expr) {
    return String(expr).replace(/(\d*)d(\d+)/gi, (mm, n, sides) => `${n || "1"}к${sides}`);
  }
  // Splits a combined base-weapon roll's individual dice into "оружие" vs
  // "свирепые атаки" for the breakdown log -- addSavageAttacksDie() always
  // appends exactly one extra die onto the END of the count before rolling
  // (see doRollAttackDamage below), so the last rolled die is the Свирепые
  // атаки one and everything before it is the weapon's own dice.
  function pushBaseRollBreakdown(breakdown, rolls, isSavage) {
    const savageCount = isSavage ? 1 : 0;
    const weaponRolls = rolls.slice(0, rolls.length - savageCount);
    const savageRolls = savageCount ? rolls.slice(-savageCount) : [];
    weaponRolls.forEach((v) => breakdown.push({ value: v, label: "оружие" }));
    savageRolls.forEach((v) => breakdown.push({ value: v, label: "свирепые атаки" }));
  }
  function hasDivineSmiteFeature() {
    return (data.features || []).some((f) => /^Божественная кара$/i.test(f.name || ""));
  }
  // How many of a given spell-slot circle are still unspent -- same
  // "true = available" array shape spellSlotsArrayFor() (further below)
  // reads for the Заклинания tab's own slot pips, read here independently
  // since Божественная кара needs to both check and (via
  // consumeSpellSlotOfLevel) spend one without rendering anything.
  function spellSlotAvailableCount(level) {
    const sc = data.spellcasting;
    const max = Number((sc && sc.slots && sc.slots[level]) || 0);
    if (!max) return 0;
    const stored = sc.slotsFilled && sc.slotsFilled[level];
    const arr = Array.isArray(stored) ? stored.slice(0, max) : [];
    while (arr.length < max) arr.push(true);
    return arr.filter(Boolean).length;
  }
  function consumeSpellSlotOfLevel(level) {
    const sc = data.spellcasting;
    if (!sc) return false;
    const max = Number((sc.slots && sc.slots[level]) || 0);
    if (!max) return false;
    if (!sc.slotsFilled) sc.slotsFilled = {};
    const stored = sc.slotsFilled[level];
    const arr = Array.isArray(stored) ? stored.slice(0, max) : [];
    while (arr.length < max) arr.push(true);
    const idx = arr.indexOf(true);
    if (idx === -1) return false;
    arr[idx] = false;
    sc.slotsFilled[level] = arr;
    doSave();
    return true;
  }
  // Божественная кара's own damage-dice count for a given slot level: 2к8
  // at 1st, +1к8 per level above that, capped at 5к8 (5th level or higher).
  function smiteDiceForSlotLevel(level) {
    return Math.min(5, level + 1);
  }
  function availableSmiteSlotLevels() {
    const levels = [];
    for (let lvl = 1; lvl <= 9; lvl++) {
      const available = spellSlotAvailableCount(lvl);
      if (available > 0) levels.push({ level: lvl, available });
    }
    return levels;
  }
  // Боевой стиль «Сражение большим оружием»: кость урона, на которой выпало 1 или 2, перебрасывается
  // (нужно использовать новый результат) — для рукопашного оружия, которое держат двумя руками
  // (двуручное, либо «универсальное» двумя руками — рука «Две руки» или галочка «двумя руками»).
  function applyGreatWeaponFighting(a, useVersatile, rBase) {
    if (!hasFightingStyle("Сражение большим оружием") || a.rangeType === "ranged") return "";
    const w = a.name ? WEAPONS.find((x) => x.name.toLowerCase() === a.name.trim().toLowerCase()) : null;
    const cat = w ? weaponHandCategoryFromProperties(w.properties) : "one-handed";
    const twoHanded = cat === "two-handed" || a.hand === "both" || (cat === "versatile" && useVersatile);
    if (!twoHanded) return "";
    const notes = [];
    rBase.rolls = rBase.rolls.map((v) => {
      if (v > 2) return v;
      const nv = rollDice(1, rBase.sides)[0];
      notes.push(`${v}→${nv}`);
      return nv;
    });
    rBase.total = rBase.rolls.reduce((x, y) => x + y, 0) + rBase.modifier;
    return notes.length ? `Сражение большим оружием: переброс ${notes.join(", ")}` : "";
  }
  function doRollAttackDamage(a, useSpecial, isCrit, useSneak, useDuelist, useVersatile, useSuperiority, smiteLevel, useSmiteUndead, extraDice, priorRoll) {
    let base = parseDiceFromText(a.damage);
    if (!base) { alert("Не удалось распознать кубик урона в поле «Урон/тип» (напр. 1к8+3)."); return; }
    if (useVersatile) {
      const sides = versatileDieSidesForAttack(a);
      if (sides) base = applyVersatileDie(base, sides);
    }
    const isSavage = isCrit && hasSavageAttacks();
    // Сильный критический удар only applies to a melee weapon attack, same
    // "rangeType" gate Дуэлянт uses above -- a thrown weapon fired at range
    // doesn't qualify even though it's still the same weapon.
    const brutalDice = isCrit && a.rangeType !== "ranged" ? brutalCriticalDice(data) : 0;
    const parts = [];
    const breakdown = [];
    let total = 0;
    let gwfNote = "";
    if (a.ability) {
      let dieOnly = base.expr.replace(/[+-]\s*\d+$/, "");
      if (isCrit) dieOnly = doubleDiceCount(dieOnly);
      if (isSavage) dieOnly = addSavageAttacksDie(dieOnly);
      if (brutalDice) dieOnly = addExtraDice(dieOnly, brutalDice);
      const rBase = rollExpr(dieOnly);
      gwfNote = applyGreatWeaponFighting(a, useVersatile, rBase);
      const abilityMod = getAbilityMod(data, a.ability);
      total += rBase.total + abilityMod;
      // Just the number, not the ability's name -- the modifier is already
      // implied by this being a damage roll for that attack.
      parts.push(`${toCyrillicDice(dieOnly)} = ${rBase.rolls.join("+")}${abilityMod ? formatModifier(abilityMod) : ""}`);
      pushBaseRollBreakdown(breakdown, rBase.rolls, isSavage);
      if (abilityMod) {
        const abilityInfo = ABILITIES.find((ab) => ab.id === a.ability);
        breakdown.push({ value: abilityMod, label: `модификатор ${(abilityInfo && abilityInfo.label) || a.ability}` });
      }
    } else {
      let expr = isCrit ? doubleDiceCount(base.expr) : base.expr;
      if (isSavage) expr = addSavageAttacksDie(expr);
      if (brutalDice) expr = addExtraDice(expr, brutalDice);
      const rBase = rollExpr(expr);
      gwfNote = applyGreatWeaponFighting(a, useVersatile, rBase);
      total += rBase.total;
      // formatModifier always signs its number ("+0" for a zero modifier),
      // which reads as a bogus "+0" tacked onto the roll when the dice
      // expression had no flat modifier at all -- only show it when nonzero.
      parts.push(`${toCyrillicDice(isCrit || isSavage ? expr : base.raw)} = ${rBase.rolls.join("+")}${rBase.modifier ? formatModifier(rBase.modifier) : ""}`);
      pushBaseRollBreakdown(breakdown, rBase.rolls, isSavage);
      if (rBase.modifier) breakdown.push({ value: rBase.modifier, label: "модификатор" });
    }
    if (useSpecial) {
      const bonusDice = parseDiceFromText(a.special);
      if (bonusDice) {
        const bonusExpr = isCrit ? doubleDiceCount(bonusDice.expr) : bonusDice.expr;
        const rBonus = rollExpr(bonusExpr);
        total += rBonus.total;
        parts.push(`${toCyrillicDice(isCrit ? bonusExpr : bonusDice.raw)} = ${rBonus.rolls.join("+")}${rBonus.modifier ? formatModifier(rBonus.modifier) : ""}`);
        rBonus.rolls.forEach((v) => breakdown.push({ value: v, label: "особые свойства" }));
        if (rBonus.modifier) breakdown.push({ value: rBonus.modifier, label: "модификатор (особые свойства)" });
      }
    }
    if (useSneak) {
      const sneak = sneakAttackDice();
      if (sneak) {
        const sneakExpr = isCrit ? doubleDiceCount(sneak.expr) : sneak.expr;
        const rSneak = rollExpr(sneakExpr);
        total += rSneak.total;
        parts.push(`${toCyrillicDice(isCrit ? sneakExpr : sneak.raw)} = ${rSneak.rolls.join("+")}`);
        rSneak.rolls.forEach((v) => breakdown.push({ value: v, label: "скрытая атака" }));
      }
    }
    // Боевой стиль «Дуэлянт»: +2 flat damage, but only while wielding a
    // Ближний бой weapon alone in that hand (no second weapon) -- situational
    // like Скрытая атака, so it's offered as a checkbox in startDamageRoll
    // below rather than applied automatically.
    if (useDuelist) {
      total += 2;
      parts.push(`2`);
      breakdown.push({ value: 2, label: "боевой стиль: Дуэлянт" });
    }
    // Боевой стиль «Сражение метательным оружием»: +2 к урону метательной атакой (автоматически).
    if (a.rangeType === "thrown" && hasFightingStyle("Сражение метательным оружием")) {
      total += 2;
      parts.push(`2`);
      breakdown.push({ value: 2, label: "боевой стиль: Сражение метательным оружием" });
    }
    // Ярость's flat damage bonus (+2/+3/+4 by Barbarian level, see
    // rageDamageBonus below) applies automatically to every Силовая (Str)
    // Ближний бой attack while the "Ярость" toggle (top of the sheet, see
    // inspirationWidget) is on -- same automatic pattern as Благословение/
    // Песнь победы below, now that the sheet actually tracks a "currently
    // raging" state instead of asking the player to tick a checkbox on
    // every single damage roll.
    if (data.rageActive && a.rangeType === "melee" && a.ability === "str") {
      const bonus = rageDamageBonus(data);
      total += bonus;
      parts.push(`${bonus}`);
      breakdown.push({ value: bonus, label: "Ярость" });
    }
    // Bladesinging «Песнь победы» (14th level): automatic while «Песнь
    // клинка» is active (see the toggle button on that feature card and
    // bladesongACBonus() in character.js for the matching AC bonus) --
    // unlike Дуэлянт/Ярость above, RAW gives no choice about it, so it's
    // applied here directly rather than as a checkbox in startDamageRoll.
    if (data.bladesongActive && a.rangeType !== "ranged" && (data.features || []).some((f) => /^Песнь победы$/i.test(f.name || ""))) {
      const bonus = Math.max(1, getAbilityMod(data, "int"));
      total += bonus;
      parts.push(`${bonus}`);
      breakdown.push({ value: bonus, label: "Песнь победы" });
    }
    // «Мастер большого оружия»/«Меткий стрелок»: the -5/+10 choice was made
    // back at the ATTACK roll (see the powerAttack option on
    // openD20RollModal in the roll-attack handler), which stored it on the
    // attack itself since this damage roll is a separate step -- consumed
    // (reset to false) here so it doesn't silently reapply to a later,
    // un-chosen damage roll on the same attack.
    if (a.usePowerAttack) {
      total += 10;
      parts.push("10");
      breakdown.push({ value: 10, label: a.rangeType === "ranged" ? "Меткий стрелок" : "Мастер большого оружия" });
      a.usePowerAttack = false;
      doSave();
    }
    // Free-form extra dice (see the "Дополнительные кубики к урону" builder
    // in startDamageRoll) -- rolled and added just like any other bonus,
    // each die type gets its own breakdown entries.
    (extraDice || []).forEach(({ sides, count, label, flat }) => {
      if (!sides && flat) { total += flat; parts.push(`${label ? label + " " : ""}+${flat}`); breakdown.push({ value: flat, label: label || "бонус" }); return; }
      if (!count || !sides) return;
      const rolls = rollDice(count, sides);
      const sum = rolls.reduce((s, v) => s + v, 0) + (flat || 0);
      total += sum;
      parts.push(`${label ? label + " " : ""}${count}к${sides}: [${rolls.join(", ")}]`);
      rolls.forEach((v) => breakdown.push({ value: v, label: label ? `${label} (к${sides})` : `доп. к${sides}` }));
    });
    // Божественная кара: spends the chosen slot here (rather than trusting
    // the level picked in the modal alone), same "don't trust the confirmed
    // choice blindly" reasoning as the superiority-die spend right below --
    // a slot that ran out between opening the modal and confirming can't be
    // spent twice. Crit doubles the dice count (RAW), same as Жестокая
    // критика/Свирепые атаки above; the +1к8 undead/fiend bonus is part of
    // the same pool of "divine smite dice" so it doubles right along with it.
    if (smiteLevel && consumeSpellSlotOfLevel(smiteLevel)) {
      let diceCount = smiteDiceForSlotLevel(smiteLevel) + (useSmiteUndead ? 1 : 0);
      if (isCrit) diceCount *= 2;
      const rSmite = rollDice(diceCount, 8);
      const smiteTotal = rSmite.reduce((s, v) => s + v, 0);
      total += smiteTotal;
      parts.push(`${diceCount}к8: [${rSmite.join(", ")}]`);
      rSmite.forEach((v) => breakdown.push({ value: v, label: "божественная кара" }));
    }
    // Мастер боевых искусств: adding a superiority die spends one from the
    // "Боевое превосходство" card's own pip pool -- checked here (rather
    // than trusting the checkbox alone) so a pool that ran out between
    // opening the modal and confirming can't be spent twice.
    if (useSuperiority && consumeSuperiorityDie()) {
      const sides = superiorityDieSides(data);
      const rSup = rollDice(1, sides)[0];
      total += rSup;
      parts.push(`к${sides}: [${rSup}]`);
      breakdown.push({ value: rSup, label: "кость превосходства" });
    }
    // «Дикий атакующий»: offered AFTER the roll (as a reroll option on the
    // result itself, see showRollResult's `reroll` param) rather than as a
    // checkbox before rolling -- the feat lets you see the result first and
    // then decide whether it's worth rerolling. A reroll re-runs this whole
    // function again (same bonuses/checkboxes) and keeps whichever total is
    // higher; priorRoll being set here means this IS that reroll, so it
    // doesn't offer itself again.
    let finalTotal = total;
    let finalDetail = parts.join(" + ") + (gwfNote ? ` (${gwfNote})` : "");
    if (priorRoll) {
      if (priorRoll.total >= total) {
        finalTotal = priorRoll.total;
        finalDetail = `${priorRoll.detail} (после переброса «Дикий атакующий» оставлен этот результат, новый бросок дал ${total})`;
      } else {
        finalDetail = `${finalDetail} (переброс «Дикий атакующий», было ${priorRoll.total})`;
      }
    }
    const savageAvailable = !priorRoll && a.rangeType !== "ranged" && hasFeat(SAVAGE_ATTACKER_FEAT_ID);
    showRollResult({
      label: `Урон${isCrit ? " (крит!)" : ""}: ${a.name || "атака"}`,
      detail: finalDetail,
      total: finalTotal,
      breakdown,
      reroll: savageAvailable
        ? {
            label: "Дикий атакующий: перебросить кости урона",
            onClick: () => doRollAttackDamage(a, useSpecial, isCrit, useSneak, useDuelist, useVersatile, useSuperiority, 0, false, [], { total, detail: parts.join(" + ") }),
          }
        : null,
    });
    if (useSuperiority || smiteLevel) render();
  }
  // Both the plain-damage and crit buttons funnel through this: roll right
  // away when there's no bonus-dice choice to make, otherwise ask first --
  // a Rogue with Скрытая атака always gets asked (даже без "особых
  // свойств"), since sneak attack is situational (needs advantage or an
  // ally in melee) rather than automatic on every hit.
  // Once-per-turn / conditional bonus damage dice from class & subclass
  // features (Следопыт etc.): offered as checkboxes in the damage window
  // instead of a roll button on the feature card.
  // Жрец «Божественный удар» (домены с фиксированным видом урона): бонусная кость — флажок в окне урона оружием, а не кнопка на карточке.
  const DIVINE_STRIKE_TYPES = [
    [/обмана/i, "ядом"],
    [/природы/i, "электричеством"],
    [/смерти/i, "некротической энергией"],
    [/кузни/i, "огнём"],
    [/порядка/i, "психической энергией"],
    [/сумерек/i, "излучением"],
  ];
  function divineStrikeType(f) {
    if (!f || !/^Божественный удар$/i.test(f.name || "")) return "";
    const hit = DIVINE_STRIKE_TYPES.find(([re]) => re.test(f.source || ""));
    return hit ? hit[1] : "";
  }
  function damageRiders() {
    const names = (data.features || []).map((f) => f.name || "");
    const has = (re) => names.some((n) => re.test(n));
    const rangerLvl = ((data.classes || []).find((c) => c.id === "ranger") || {}).level || 0;
    const list = [];
    if (has(/Губитель исполинов/)) list.push({ id: "giant-killer", label: "Губитель исполинов", note: "цель Большого размера или крупнее", sides: 8, count: 1 });
    if (has(/Истребитель колоссов/)) list.push({ id: "colossus", label: "Истребитель колоссов", note: "раз в ход, у цели уже есть рана", sides: 8, count: 1 });
    if (has(/^Победитель чудовищ/)) list.push({ id: "foe-slayer", label: "Победитель чудовищ", note: "раз за ход, по избранному врагу", sides: 8, count: 1 });
    if (has(/^Планарный воин$/)) list.push({ id: "planar", label: "Планарный воин", note: "цель отмечена бонусным действием; весь урон атаки становится силовым", sides: 8, count: rangerLvl >= 11 ? 2 : 1 });
    if (has(/^Угроза из засады$/)) list.push({ id: "ambush", label: "Угроза из засады", note: "дополнительная атака в первый ход боя", sides: 8, count: 1 });
    if (has(/^Добыча убийцы$/)) list.push({ id: "slayer-prey", label: "Добыча убийцы", note: "первое попадание за ход по выбранной цели", sides: 6, count: 1 });
    if (has(/^Ужасающие удары$/)) list.push({ id: "dread-strikes", label: "Ужасающие удары", note: "психическая энергия, раз в ход", sides: rangerLvl >= 11 ? 6 : 4, count: 1 });
    if (has(/^Единство с клинком$/)) list.push({ id: "kensei-agile", label: "Ловкий удар", note: "оружие кэнсэя, раз в ход; тратит 1 очко ци", sides: martialArtsSides(), count: 1, kiCost: 1 });
    if (has(/^Торс астрального тела$/)) list.push({ id: "astral-arms", label: "Усиленные руки", note: "атака руками астрального тела, раз в ход", sides: martialArtsSides(), count: 1 });
    if (Number(data.sharpBlade) && has(/^Заостр[её]нный клинок$/)) list.push({ id: "sharp-blade", label: "Заострённый клинок", note: "оружие кэнсэя (ци уже потрачено)", sides: 0, count: 0, flat: Number(data.sharpBlade), auto: true });
    (data.features || []).forEach((f) => {
      const t = divineStrikeType(f);
      if (!t) return;
      const clericLvl = ((data.classes || []).find((c) => c.id === "cleric") || {}).level || 0;
      list.push({ id: "divine-strike", label: "Божественный удар", note: `${t}, раз в ход`, sides: 8, count: clericLvl >= 14 ? 2 : 1 });
    });
    // Карточки умений с кубиком урона (черты: «Удар великанов», «Точный удар» и др.) — поле rider.
    (data.features || []).forEach((f, fi) => {
      const r = f.rider;
      if (!r || !r.sides) return;
      list.push({ id: `feature-${fi}`, label: f.name, note: r.note || "", sides: Number(r.sides), count: Number(r.count) || 1, flat: r.flatPb ? proficiencyBonus(data) : 0, consume: !!r.consume, featureIndex: fi });
    });
    (data.artifacts || []).forEach((art, ai) => {
      const d = art.damageOn && parseDiceFromText(art.damage);
      if (!d) return;
      const m = /^(\d+)d(\d+)/.exec(d.expr);
      if (m) list.push({ id: `artifact-${ai}`, label: art.name || "Артефакт", note: art.damageType || "урон артефакта", sides: Number(m[2]), count: Number(m[1]), auto: true });
    });
    if (has(/^Улучшенная божественная кара$/)) list.push({ id: "improved-smite", label: "Улучшенная божественная кара", note: "излучение, любая рукопашная атака оружием", sides: 8, count: 1, meleeOnly: true, auto: true });
    return list;
  }
  function startDamageRoll(a, isCrit) {
    const riders = damageRiders().filter((r) => !r.meleeOnly || a.rangeType !== "ranged");
    const bonusDice = parseDiceFromText(a.special);
    const sneak = sneakAttackDice();
    // Дуэлянт only applies to a Ближний бой weapon (see hasFightingStyle
    // above and weaponRangeType() in dnd5e-data.js) -- offered as a checkbox
    // like Скрытая атака since "no weapon in the other hand" is a table
    // fact the app has no way to verify on its own.
    const duelist = a.rangeType === "melee" && hasFightingStyle("Дуэлянт");
    const versatileSides = versatileDieSidesForAttack(a);
    const superiorityAvailable = hasBattlemaster() && superiorityDiceAvailable() > 0;
    // Ярость's damage bonus (see rageDamageBonus above and its automatic
    // application in doRollAttackDamage) now applies on its own whenever
    // the top-of-sheet "Ярость" toggle is on and the attack qualifies, so
    // there's no separate checkbox to offer here any more -- this flag is
    // kept only to show a small confirmation note in the modal.
    const rageApplies = data.rageActive && a.rangeType === "melee" && a.ability === "str";
    // Божественная кара only applies to a melee weapon attack that hit, and
    // needs at least one unspent spell slot to actually offer -- a level with
    // 0 available (all spent, or the character just doesn't have that circle
    // yet) isn't shown as an option, same "don't offer what can't be used"
    // rule the superiority-die/tool checkboxes above already follow.
    const smiteAvailable = a.rangeType === "melee" && hasDivineSmiteFeature() && availableSmiteSlotLevels().length > 0;
    // Free-form extra dice (any type, any count) -- same idea as the "Кубики"
    // tab's own dice-pool builder (openFreeDiceModal in diceModal.js), just
    // offered here too so a one-off bonus (an inspiration die, a DM ruling,
    // a homebrew effect) can be folded straight into the damage total
    // instead of rolled separately and added by hand. Always offered, so
    // this modal no longer short-circuits straight to the roll even when no
    // other bonus applies -- it's the one option that's always on the table.
    let extraDice = [];
    const oneHandedRaw = parseDiceFromText(a.damage);
    const html = `
      <h3>Урон${isCrit ? " (крит!)" : ""}: ${escapeHtml(a.name || "атака")}</h3>
      ${
        versatileSides
          ? `<label class="row" style="gap:8px;align-items:center;">
        <input type="checkbox" data-use-versatile />
        универсальное — взять двумя руками (${oneHandedRaw ? escapeHtml(oneHandedRaw.raw) : "?"} → ${escapeHtml(`1к${versatileSides}`)})
      </label>`
          : ""
      }
      ${
        bonusDice
          ? `<label class="row" style="gap:8px;align-items:center;margin-top:${versatileSides ? "6px" : "0"};">
        <input type="checkbox" data-use-special ${a.useSpecial ? "checked" : ""} />
        учитывать «${escapeHtml(a.special)}»
      </label>`
          : ""
      }
      ${
        sneak
          ? `<label class="row" style="gap:8px;align-items:center;margin-top:${versatileSides || bonusDice ? "6px" : "0"};">
        <input type="checkbox" data-use-sneak />
        добавить Скрытую атаку (${sneak.raw}) — нужно преимущество на атаку или союзник рядом с целью
      </label>`
          : ""
      }
      ${
        duelist
          ? `<label class="row" style="gap:8px;align-items:center;margin-top:${versatileSides || bonusDice || sneak ? "6px" : "0"};">
        <input type="checkbox" data-use-duelist />
        добавить Боевой стиль «Дуэлянт» (+2) — нужно оружие одной рукой без второго оружия в другой руке
      </label>`
          : ""
      }
      ${
        superiorityAvailable
          ? `<label class="row" style="gap:8px;align-items:center;margin-top:${versatileSides || bonusDice || sneak || duelist ? "6px" : "0"};">
        <input type="checkbox" data-use-superiority />
        добавить кость превосходства (к${superiorityDieSides(data)}) — осталось ${superiorityDiceAvailable()}
      </label>`
          : ""
      }
      ${
        rageApplies
          ? `<p class="muted" style="font-size:0.8rem;margin:${versatileSides || bonusDice || sneak || duelist || superiorityAvailable ? "6px" : "0"} 0 0;">✔ Ярость (+${rageDamageBonus(data)}) добавится автоматически</p>`
          : ""
      }
      ${riders
        .map((r, i) => `<label class="row" style="gap:8px;align-items:center;margin-top:6px;"><input type="checkbox" data-use-rider="${i}" ${r.auto ? "checked" : ""} /> добавить «${escapeHtml(r.label)}» (${r.sides ? `${isCrit ? r.count * 2 : r.count}к${r.sides}${r.flat ? "+" + r.flat : ""}` : `+${r.flat}`}) — ${escapeHtml(r.note)}${r.consume ? " · тратит использование" : ""}</label>`)
        .join("")}
      ${
        smiteAvailable
          ? `<div style="margin-top:${versatileSides || bonusDice || sneak || duelist || superiorityAvailable || rageApplies ? "10px" : "0"};padding-top:8px;border-top:1px solid var(--border);">
        <label class="row" style="gap:8px;align-items:center;">
          <span>Божественная кара:</span>
          <select data-smite-level style="flex:1;">
            <option value="0">Не использовать</option>
            ${availableSmiteSlotLevels()
              .map((s) => `<option value="${s.level}">ячейка ${s.level} круга (${smiteDiceForSlotLevel(s.level)}к8) — осталось ${s.available}</option>`)
              .join("")}
          </select>
        </label>
        <label class="row" style="gap:8px;align-items:center;margin-top:6px;">
          <input type="checkbox" data-smite-undead />
          цель — нежить или исчадие (+1к8)
        </label>
      </div>`
          : ""
      }
      <div style="margin-top:${versatileSides || bonusDice || sneak || duelist || superiorityAvailable || rageApplies || smiteAvailable ? "10px" : "0"};padding-top:8px;border-top:1px solid var(--border);">
        <span class="muted" style="font-size:0.82rem;">Дополнительные кубики к урону:</span>
        <div class="row" style="gap:6px;align-items:center;margin-top:4px;">
          <select data-extra-die-sides style="flex:none;">
            ${[4, 6, 8, 10, 12, 20, 100].map((d) => `<option value="${d}" ${d === 6 ? "selected" : ""}>к${d}</option>`).join("")}
          </select>
          <span class="muted">×</span>
          <input type="number" data-extra-die-count min="1" max="99" value="1" style="width:52px;text-align:center;" />
          <button type="button" class="small" data-action="add-extra-die">+ Добавить</button>
        </div>
        <div class="dice-pool-list" data-extra-dice-list style="margin-top:6px;"></div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px;">
        <button data-action="confirm-roll-damage" class="primary">Бросить</button>
      </div>`;
    const modal = openModal(html);
    const renderExtraDiceChips = () => {
      const list = modal.querySelector("[data-extra-dice-list]");
      if (!list) return;
      list.innerHTML = extraDice.length
        ? extraDice.map((d, i) => `<span class="dice-pool-chip">${d.count}к${d.sides}<button type="button" data-action="remove-extra-die" data-index="${i}" title="Убрать">✕</button></span>`).join("")
        : "";
    };
    on(modal, "click", "[data-action=add-extra-die]", () => {
      const sides = Number(modal.querySelector("[data-extra-die-sides]").value);
      const count = Math.max(1, Math.min(99, Number(modal.querySelector("[data-extra-die-count]").value) || 1));
      extraDice.push({ sides, count });
      renderExtraDiceChips();
    });
    on(modal, "click", "[data-action=remove-extra-die]", (e, el) => {
      extraDice.splice(Number(el.dataset.index), 1);
      renderExtraDiceChips();
    });
    on(modal, "click", "[data-action=confirm-roll-damage]", () => {
      const useSpecial = bonusDice ? modal.querySelector("[data-use-special]").checked : false;
      const useSneak = sneak ? modal.querySelector("[data-use-sneak]").checked : false;
      const useDuelist = duelist ? modal.querySelector("[data-use-duelist]").checked : false;
      const useVersatile = versatileSides ? modal.querySelector("[data-use-versatile]").checked : false;
      const useSuperiority = superiorityAvailable ? modal.querySelector("[data-use-superiority]").checked : false;
      const smiteLevel = smiteAvailable ? Number(modal.querySelector("[data-smite-level]").value) : 0;
      const useSmiteUndead = smiteAvailable ? modal.querySelector("[data-smite-undead]").checked : false;
      a.useSpecial = useSpecial;
      doSave();
      closeModal();
      const riderDice = [];
      modal.querySelectorAll("[data-use-rider]").forEach((cb) => {
        if (cb.checked) {
          const r = riders[Number(cb.dataset.useRider)];
          if (r.kiCost && !spendKi(r.kiCost)) return;
          riderDice.push({ sides: r.sides, count: isCrit ? r.count * 2 : r.count, label: r.label, flat: r.flat || 0 });
          if (r.consume && r.featureIndex !== undefined) spendFeatureUse(data.features[r.featureIndex]);
        }
      });
      doRollAttackDamage(a, useSpecial, isCrit, useSneak, useDuelist, useVersatile, useSuperiority, smiteLevel, useSmiteUndead, [...extraDice, ...riderDice]);
    });
  }
  on(app, "click", "[data-action=roll-attack-damage]", (e, el) => {
    startDamageRoll(data.attacks[Number(el.dataset.index)], false);
  });
  on(app, "click", "[data-action=roll-attack-crit]", (e, el) => {
    startDamageRoll(data.attacks[Number(el.dataset.index)], true);
  });

  // weapons (inventory)
  on(app, "click", "[data-action=add-weapon]", () => {
    const sel = $("[data-weapon-select]", app);
    const id = sel && sel.value;
    if (!id) return;
    const preset = WEAPONS.find((w) => w.id === id);
    if (!preset) return;
    const newWeapon = id === "custom"
      ? { name: "Новое оружие", damage: "", type: "", properties: "", special: "", equipped: true, rangeType: "" }
      : { name: preset.name, damage: preset.damage, type: preset.type, properties: preset.properties, special: "", equipped: true, rangeType: weaponRangeType(preset) };
    data.weapons.push(newWeapon);
    // A weapon from the catalogue goes into Атаки straight away.
    if (id !== "custom") {
      const typeNote = newWeapon.type ? ` ${newWeapon.type}` : "";
      data.attacks.push({ name: newWeapon.name, bonus: "", damage: `${newWeapon.damage || ""}${typeNote}`.trim(), special: "", useSpecial: false, rangeType: newWeapon.rangeType || "", hand: autoAssignAttackHand(newWeapon.properties) });
    }
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-weapon-equipped]", (e, el) => {
    const w = data.weapons[Number(el.dataset.index)];
    if (!w) return;
    w.equipped = w.equipped === false; // undefined/true (equipped) -> false; false -> true
    doSave();
    render();
  });
  on(app, "click", "[data-action=remove-weapon]", (e, el) => {
    data.weapons.splice(Number(el.dataset.index), 1);
    doSave();
    render();
  });
  on(app, "input", "[data-weapon-field]", (e, el) => {
    const i = Number(el.dataset.weaponIndex);
    data.weapons[i][el.dataset.weaponField] = el.value;
    doSave();
  });
  on(app, "change", "[data-weapon-range-type]", (e, el) => {
    const i = Number(el.dataset.weaponIndex);
    data.weapons[i].rangeType = el.value;
    doSave();
  });
  on(app, "click", "[data-action=add-weapon-to-attacks]", (e, el) => {
    const w = data.weapons[Number(el.dataset.index)];
    if (!w) return;
    const typeNote = w.type ? ` ${w.type}` : "";
    data.attacks.push({ name: w.name, bonus: "", damage: `${w.damage || ""}${typeNote}`.trim(), special: w.special || "", useSpecial: false, rangeType: w.rangeType || "", hand: autoAssignAttackHand(w.properties) });
    doSave();
    render();
  });

  on(app, "click", "[data-action=add-gear]", () => {
    const sel = $("[data-gear-select]", app);
    const id = sel && sel.value;
    if (!id) return;
    const item = GEAR.find((g) => g.id === id);
    if (!item) return;
    // A "Набор ..." item (traveler's/burglar's/priest's/etc. pack) is a
    // single GEAR line but stands for a whole bundle of gear — add that
    // bundle's actual contents too, the same list the wizard expands from
    // class starting-equipment text, instead of just the pack's own name.
    const packContents = EQUIPMENT_PACK_DESCRIPTIONS[item.name.toLowerCase()];
    const line = `${item.name} (${item.cost}${item.weight ? `, ${item.weight} фнт.` : ""})${packContents ? `: ${packContents}` : ""}`;
    data.equipmentText = data.equipmentText ? `${data.equipmentText}\n${line}` : line;
    doSave();
    render();
  });

  // feats (Черты — picked from a fixed list, full PHB set imported from dnd.su)
  on(app, "change", "[data-feat-select]", (e, el) => {
    featPreviewId = el.value;
    const feat = FEATS.find((f) => f.id === featPreviewId);
    featChosenAbility = feat && feat.abilityIncrease ? feat.abilityIncrease.choices[0] : "";
    featChosenSkills = [];
    featChosenManeuvers = [];
    featChosenWeapons = [];
    featChosenLanguages = [];
    featChosenCantrips = [];
    featChosenSpell = "";
    featNewSel = newFeatSel();
    render();
  });
  wireFeatPicks(app, () => featNewSel, () => FEATS.find((f) => f.id === featPreviewId), render);
  on(app, "change", "[data-feat-ability-choice]", (e, el) => {
    featChosenAbility = el.value;
  });
  on(app, "change", "[data-feat-element-choice]", (e, el) => {
    featChosenElement = el.value;
  });
  on(app, "change", "[data-feat-spell-class]", (e, el) => {
    featChosenSpellClass = el.value;
    featChosenCantrips = [];
    featChosenSpell = "";
    render();
  });
  on(app, "change", "[data-feat-cantrip-choice]", (e, el) => {
    const v = el.value;
    if (el.checked) {
      if (!featChosenCantrips.includes(v)) featChosenCantrips.push(v);
    } else {
      featChosenCantrips = featChosenCantrips.filter((c) => c !== v);
    }
    render();
  });
  on(app, "change", "[data-feat-spell1-choice]", (e, el) => {
    featChosenSpell = el.value;
    render();
  });
  on(app, "change", "[data-feat-skill-choice]", (e, el) => {
    const v = el.value;
    if (el.checked) {
      if (!featChosenSkills.includes(v)) featChosenSkills.push(v);
    } else {
      featChosenSkills = featChosenSkills.filter((s) => s !== v);
    }
  });
  on(app, "change", "[data-feat-weapon-choice]", (e, el) => {
    const v = el.value;
    if (el.checked) {
      if (!featChosenWeapons.includes(v)) featChosenWeapons.push(v);
    } else {
      featChosenWeapons = featChosenWeapons.filter((w) => w !== v);
    }
  });
  on(app, "change", "[data-feat-language-choice]", (e, el) => {
    const v = el.value;
    if (el.checked) {
      if (!featChosenLanguages.includes(v)) featChosenLanguages.push(v);
    } else {
      featChosenLanguages = featChosenLanguages.filter((l) => l !== v);
    }
  });
  on(app, "change", "[data-feat-maneuver-choice]", (e, el) => {
    const v = el.value;
    if (el.checked) {
      if (!featChosenManeuvers.includes(v) && featChosenManeuvers.length < 2) featChosenManeuvers.push(v);
    } else {
      featChosenManeuvers = featChosenManeuvers.filter((m) => m !== v);
    }
    render();
  });
  on(app, "click", "[data-action=add-feat]", () => {
    const feat = FEATS.find((f) => f.id === featPreviewId);
    if (!feat) return;
    if (!feat.repeatable && (data.feats || []).some((f) => f.id === feat.id)) {
      alert("Эта черта уже добавлена.");
      return;
    }
    const conModBefore = getAbilityMod(data, "con");
    // «Стихийный адепт»: "Вы можете брать это умение несколько раз. Каждый
    // раз, когда вы это делаете, вы выбираете новый вид урона." -- the only
    // repeatable feat on file, so its own chosen damage type is folded into
    // the stored name/desc right away (rather than a separate field) so
    // each copy reads as its own distinct entry in the Черты list instead
    // of several identical "Стихийный адепт" rows.
    const elementLabel = feat.damageTypeChoice ? ELEMENTAL_ADEPT_DAMAGE_TYPES.find((d) => d.id === featChosenElement)?.label : null;
    const entry = {
      id: feat.id,
      name: elementLabel ? `${feat.name} (${elementLabel})` : feat.name,
      desc: elementLabel ? feat.desc.replace(/^Когда вы получаете это умение, выберите[^.]*\./, `Выбранный вид урона: ${elementLabel}.`) : feat.desc,
      prereq: feat.prereq || "",
    };
    // Ability-increasing feats mechanically raise the chosen ability score,
    // tracked in data.abilityBonuses so the "откуда бонус" box can show it.
    if (feat.abilityIncrease) {
      const ability = feat.abilityIncrease.choices.length > 1 ? featChosenAbility : feat.abilityIncrease.choices[0];
      const amount = feat.abilityIncrease.amount;
      if (ability) {
        data.abilities[ability] = Math.min(20, (Number(data.abilities[ability]) || 10) + amount);
        data.abilityBonuses = data.abilityBonuses || [];
        data.abilityBonuses.push({ source: `Черта (${feat.name})`, ability, amount });
        entry.grantedAbility = ability;
        entry.grantedAmount = amount;
      }
      if (feat.grantsSaveProficiency && ability) {
        data.proficiencies.savingThrows = data.proficiencies.savingThrows || [];
        if (!data.proficiencies.savingThrows.includes(ability)) data.proficiencies.savingThrows.push(ability);
      }
    }
    // Skill-granting feats (Одарённый) add proficiency in the chosen skills.
    if (feat.skillChoice) {
      const skills = featChosenSkills.slice(0, feat.skillChoice.count);
      data.proficiencies.skills = data.proficiencies.skills || [];
      skills.forEach((s) => { if (!data.proficiencies.skills.includes(s)) data.proficiencies.skills.push(s); });
      entry.grantedSkills = skills;
    }
    // «Мастер оружия»: proficiency in the chosen weapons.
    if (feat.weaponChoice) {
      const weapons = featChosenWeapons.slice(0, feat.weaponChoice.count);
      data.proficiencies.weapons = data.proficiencies.weapons || [];
      weapons.forEach((w) => { addProficiencyValue(data.proficiencies.weapons, w); });
      entry.grantedWeapons = weapons;
    }
    // «Языковед»: the chosen languages.
    if (feat.languageChoice) {
      const languages = featChosenLanguages.slice(0, feat.languageChoice.count);
      data.proficiencies.languages = data.proficiencies.languages || [];
      languages.forEach((l) => addProficiencyValue(data.proficiencies.languages, l));
      entry.grantedLanguages = languages;
    }
    // «Посвящённый в магию»/«Меткие заклинания»: the chosen cantrips (and,
    // for Magic Initiate, one 1st-level spell) go straight onto the
    // character's known spells like any other -- the app's spellcasting
    // model is one ability/one list for the whole character rather than
    // per-source, so if nothing is set yet this fills in a reasonable
    // starting ability for the chosen class; an existing caster's own
    // ability is left alone rather than overwritten.
    if (feat.magicInitiateChoice || feat.spellSniperChoice) {
      const cantripCount = feat.magicInitiateChoice ? 2 : 1;
      const cantrips = featChosenCantrips.slice(0, cantripCount);
      if (!data.spellcasting) data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} };
      if (!data.spellcasting.cantrips) data.spellcasting.cantrips = [];
      if (!data.spellcasting.known) data.spellcasting.known = [];
      if (!data.spellcasting.ability) {
        data.spellcasting.ability = { bard: "cha", warlock: "cha", sorcerer: "cha", wizard: "int", cleric: "wis", druid: "wis" }[featChosenSpellClass] || "int";
      }
      cantrips.forEach((id) => { if (!data.spellcasting.cantrips.includes(id)) data.spellcasting.cantrips.push(id); });
      entry.grantedCantrips = cantrips;
      if (feat.magicInitiateChoice && featChosenSpell) {
        if (!data.spellcasting.known.includes(featChosenSpell)) data.spellcasting.known.push(featChosenSpell);
        entry.grantedSpell = featChosenSpell;
      }
    }
    applyFeatPicks(data, feat, entry, featNewSel);
    data.feats.push(entry);
    applyConHpRetroactive(conModBefore, getAbilityMod(data, "con"));
    if (feat.id === TOUGH_FEAT_ID) applyToughFeatHpGrant();
    // Armor/weapon proficiency-granting feats (Знаток лёгких/средних/
    // тяжёлых доспехов, etc.) -- same text parser class/subclass/race
    // features already go through via applyFeatureProficiencyGrants, just
    // called directly here since this feat text has no separate "name"
    // wrapper the way a feature card's short blurb does.
    const profGrants = parseProficiencyGrantsFromText(feat.desc);
    profGrants.armor.forEach((a) => { addProficiencyValue(data.proficiencies.armor, a); });
    profGrants.weapons.forEach((w) => { addProficiencyValue(data.proficiencies.weapons, w); });
    // «Воинский адепт»: 2 chosen maneuvers plus its own fixed-size (к6, 1 die)
    // superiority-die pool -- same maneuver cards Battle Master's own pick
    // pushes, plus a dedicated pool card kept separate from Battle Master's
    // (see MARTIAL_ADEPT_SUPERIORITY_FEATURE_NAME below) since this feat's
    // die stays к6 forever even if the character is also a high-level Battle
    // Master with a bigger die from that source.
    if (feat.id === "martial-adept") {
      const source = `Черта (${feat.name})`;
      featChosenManeuvers.forEach((id) => {
        const m = MANEUVERS.find((mm) => mm.id === id);
        if (!m) return;
        if ((data.features || []).some((f) => f.name === m.name && f.source === source)) return;
        data.features.push({ name: m.name, source, desc: m.desc });
      });
      data.features.push({
        name: MARTIAL_ADEPT_SUPERIORITY_FEATURE_NAME_TEXT,
        source,
        desc: "Даёт одну кость превосходства к6, используемую для выбранных приёмов. Тратится при использовании, восстанавливается после окончания короткого или продолжительного отдыха.",
      });
    }
    featPreviewId = "";
    featChosenAbility = "";
    featChosenSkills = [];
    featChosenManeuvers = [];
    featChosenWeapons = [];
    featChosenLanguages = [];
    featChosenCantrips = [];
    featChosenSpell = "";
    featNewSel = newFeatSel();
    doSave();
    render();
  });
  on(app, "click", "[data-action=remove-feat]", (e, el) => {
    const [feat] = data.feats.splice(Number(el.dataset.index), 1);
    if (feat) revertFeatExtras(data, feat);
    // Undo the mechanical effects this feat granted, if any.
    if (feat && feat.grantedAbility) {
      data.abilities[feat.grantedAbility] = Math.max(1, (Number(data.abilities[feat.grantedAbility]) || 10) - feat.grantedAmount);
      data.abilityBonuses = (data.abilityBonuses || []).filter(
        (b) => !(b.source === `Черта (${feat.name})` && b.ability === feat.grantedAbility)
      );
    }
    if (feat && feat.grantedSkills) {
      // Only drop skills not granted by another source we can't tell apart —
      // simplest safe behaviour: leave proficiency as-is (player can uncheck
      // manually in Владения если нужно), just clean up the bonus log entry.
    }
    if (feat && feat.id === TOUGH_FEAT_ID) {
      const loss = 2 * totalLevel(data);
      data.hp.max = Math.max(1, (Number(data.hp.max) || 0) - loss);
      data.hp.current = Math.max(0, Math.min(data.hp.current, data.hp.max));
    }
    doSave();
    render();
  });

  // features (Умения — free-form race/class/background features)
  on(app, "click", "[data-action=add-feature]", () => {
    data.features.push({ name: "", source: "", desc: "" });
    doSave();
    render();
  });
  on(app, "click", "[data-action=remove-feature]", (e, el) => {
    data.features.splice(Number(el.dataset.index), 1);
    doSave();
    render();
  });
  on(app, "input", "[data-feature-field]", (e, el) => {
    const i = Number(el.dataset.featureIndex);
    data.features[i][el.dataset.featureField] = el.value;
    if (el.tagName === "TEXTAREA" && el.dataset.featureField === "name") autoGrowTextarea(el);
    doSave();
  });
  on(app, "click", "[data-action=toggle-feature-use]", (e, el) => {
    const i = Number(el.dataset.index);
    const j = Number(el.dataset.useIndex);
    const f = data.features[i];
    const uses = resolveFeatureUses(f);
    if (!uses) return;
    const arr = usesArrayFor(f, uses.max);
    arr[j] = !arr[j];
    setFeatureUsesState(f, arr);
    doSave();
    render();
  });
  on(app, "click", "[data-action=refresh-feature-desc]", (e, el) => {
    const i = Number(el.dataset.index);
    const f = data.features[i];
    const known = findKnownFeatureText(f.name, f.source);
    if (!known) return;
    f.desc = known;
    doSave();
    render();
  });
  on(app, "click", "[data-action=roll-feature]", (e, el) => {
    const f = data.features[Number(el.dataset.index)];
    const dice = PSIONIC_POWER_FEATURE_NAME.test(f.name || "")
      ? { expr: `1d${psionicDieSides(data)}` }
      : PSI_WARRIOR_POWER_CARD.test(f.name || "") && /Пси-воин/i.test(f.source || "")
        ? psiWarriorPowerDice()
      : GRAVE_MIGHT_FEATURE_NAME.test(f.name || "")
        ? graveyardShriekDice()
        : monkFeatureDice(f) || featureDiceInfo(f.desc);
    if (!dice) return;
    let expr = dice.expr;
    if (SECOND_WIND_FEATURE_NAME.test(f.name || "")) {
      const lvl = fighterLevel(data);
      if (lvl) expr = `${expr}+${lvl}`;
    }
    const r = rollExpr(expr);
    showRollResult({ label: f.name || "Умение", detail: `${toCyrillicDice(expr)} = ${r.rolls.join("+")}${r.modifier ? formatModifier(r.modifier) : ""}`, total: r.total });
  });
  on(app, "click", "[data-action=apply-survivor-heal]", (e, el) => {
    const amount = 5 + getAbilityMod(data, "con");
    const max = effectiveMaxHp(data);
    data.hp.current = Math.min(max, (Number(data.hp.current) || 0) + amount);
    doSave();
    render();
  });
  on(app, "change", "[data-land-terrain]", (e, el) => {
    data.landTerrain = el.value;
    applyLandTerrainCard();
    doSave();
    render();
  });
  on(app, "click", "[data-action=roll-portent]", () => {
    const n = (data.features || []).some((x) => /^Великое знамение$/i.test(x.name || "")) ? 3 : 2;
    data.portentRolls = rollDice(n, 20).map((v) => ({ v, used: false }));
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-portent]", (e, el) => {
    const r = (data.portentRolls || [])[Number(el.dataset.portent)];
    if (!r) return;
    r.used = !r.used;
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-bladesong]", () => {
    data.bladesongActive = !data.bladesongActive;
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-condition]", (e, el) => {
    const id = el.dataset.condition;
    data.conditions = data.conditions || [];
    if (data.conditions.includes(id)) data.conditions = data.conditions.filter((c) => c !== id);
    else data.conditions.push(id);
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-exhaustion-menu]", () => {
    exhaustionMenuOpen = !exhaustionMenuOpen;
    render();
  });
  on(app, "mouseover", "[data-exh-desc]", (e, el) => {
    const box = app.querySelector("[data-exh-detail]");
    if (box) box.textContent = el.dataset.exhDesc;
  });
  on(app, "click", "[data-exh-level]", (e, el) => {
    const lvl = Number(el.dataset.exhLevel) || 0;
    data.exhaustion = lvl;
    data.conditions = (data.conditions || []).filter((c) => c !== "exhaustion");
    // Level 4+: hit point maximum is halved -- current HP can't exceed it.
    const effMax = effectiveMaxHp(data);
    if (lvl >= 4 && (Number(data.hp.current) || 0) > effMax) data.hp.current = effMax;
    exhaustionMenuOpen = false;
    doSave();
    render();
  });
  // Clicking anywhere outside the open exhaustion menu closes it (removed
  // straight from the DOM rather than via render(), so the click that closed
  // it still reaches whatever it landed on).
  app.addEventListener("click", (e) => {
    if (exhaustionMenuOpen && !e.target.closest(".exh-dd")) {
      exhaustionMenuOpen = false;
      app.querySelector(".exh-menu")?.remove();
    }
  });
  on(app, "click", "[data-action=toggle-blessing]", () => {
    data.blessingActive = !data.blessingActive;
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-rage]", () => {
    if (!data.rageActive) {
      if (rageUsesLeft() <= 0) return;
      spendFeatureUse(rageFeatureCard());
    }
    data.rageActive = !data.rageActive;
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-ability-bonuses]", () => {
    abilityBonusesOpen = !abilityBonusesOpen;
    render();
  });
  on(app, "click", "[data-action=toggle-roll-log-panel]", () => {
    rollLogPanelOpen = !rollLogPanelOpen;
    render();
  });
  on(app, "click", "[data-action=toggle-lucky-point]", (e, el) => {
    const entry = (data.feats || []).find((f) => f.id === LUCKY_FEAT_ID);
    if (!entry) return;
    const i = Number(el.dataset.index);
    const used = Array.isArray(entry.luckyUsed) ? entry.luckyUsed.slice(0, 3) : [];
    while (used.length < 3) used.push(false);
    used[i] = !used[i];
    entry.luckyUsed = used;
    doSave();
    render();
  });
  // Артефакты
  const artifactAt = (el) => (data.artifacts || [])[Number(el.dataset.index)];
  on(app, "click", "[data-action=add-artifact]", () => {
    (data.artifacts = data.artifacts || []).push({ name: "Новый магический предмет", desc: "", open: true, saved: false, attuned: false, damage: "", damageType: "", damageOn: false, uses: { enabled: false, max: 1, recharge: "long" }, usesState: [], spells: [] });
    doSave(); render();
  });
  on(app, "click", "[data-action=remove-artifact]", (e, el) => {
    if (!confirm("Удалить артефакт?")) return;
    data.artifacts.splice(Number(el.dataset.index), 1); doSave(); render();
  });
  on(app, "click", "[data-action=toggle-artifact-open]", (e, el) => { const a = artifactAt(el); if (a) { a.open = !a.open; doSave(); render(); } });
  on(app, "input", "[data-artifact-field]", (e, el) => { const a = artifactAt(el); if (a) { a[el.dataset.artifactField] = el.value; doSave(); } });
  on(app, "click", "[data-action=save-artifact]", (e, el) => { const a = artifactAt(el); if (a) { a.saved = true; doSave(); render(); } });
  on(app, "click", "[data-action=edit-artifact]", (e, el) => { const a = artifactAt(el); if (a) { a.saved = false; doSave(); render(); } });
  on(app, "click", "[data-action=toggle-artifact-attune]", (e, el) => { const a = artifactAt(el); if (a) { a.attuned = !a.attuned; doSave(); render(); } });
  on(app, "input", "[data-artifact-dawn-dice]", (e, el) => { const a = artifactAt(el); if (a) { a.uses = a.uses || {}; a.uses.dawnDice = el.value; doSave(); } });
  on(app, "click", "[data-action=roll-artifact-dawn]", (e, el) => {
    const a = artifactAt(el); const d = a && a.uses && parseDiceFromText(a.uses.dawnDice); if (!d) return;
    const max = Math.max(1, Number(a.uses.max) || 1);
    const arr = artifactUsesArray(a.usesState, max);
    const r = rollExpr(d.expr);
    const gain = Math.max(0, r.total);
    let restored = 0;
    for (let j = 0; j < arr.length && restored < gain; j++) if (!arr[j]) { arr[j] = true; restored++; }
    a.usesState = arr; doSave(); render();
    showRollResult({ label: `${a.name || "Предмет"} — заряды на рассвете`, detail: `${toCyrillicDice(d.expr)} = ${r.rolls.join("+")}${r.modifier ? formatModifier(r.modifier) : ""} · восстановлено: ${restored}${gain > restored ? " (больше максимума)" : ""}`, total: r.total });
  });
  on(app, "click", "[data-action=toggle-artifact-damage]", (e, el) => { const a = artifactAt(el); if (!a) return; if (!parseDiceFromText(a.damage)) { alert("Сначала впишите урон (например 1к6)."); return; } a.damageOn = !a.damageOn; doSave(); render(); });
  on(app, "click", "[data-action=roll-artifact-damage]", (e, el) => {
    const a = artifactAt(el); const d = a && parseDiceFromText(a.damage); if (!d) return;
    const r = rollExpr(d.expr);
    showRollResult({ label: `${a.name || "Артефакт"} — урон${a.damageType ? " (" + a.damageType + ")" : ""}`, detail: `${toCyrillicDice(d.expr)} = ${r.rolls.join("+")}${r.modifier ? formatModifier(r.modifier) : ""}`, total: r.total });
  });
  on(app, "change", "[data-artifact-uses-enabled]", (e, el) => { const a = artifactAt(el); if (a) { a.uses = a.uses || { max: 1, recharge: "long" }; a.uses.enabled = el.checked; doSave(); render(); } });
  on(app, "change", "[data-artifact-uses-max]", (e, el) => { const a = artifactAt(el); if (a) { a.uses.max = Math.max(1, Math.min(30, Number(el.value) || 1)); a.usesState = Array(a.uses.max).fill(true); doSave();
    // re-draw only the pips: a full render() here would swallow the click that moved focus to the next field
    const holder = el.closest(".feature-card, .card, div");
    const pipsEl = holder && holder.querySelector(".feature-card-uses");
    if (pipsEl) pipsEl.innerHTML = artifactPipsHtml(artifactUsesArray(a.usesState, a.uses.max), "toggle-artifact-use", Number(el.dataset.index));
    else render(); } });
  on(app, "change", "[data-artifact-recharge]", (e, el) => { const a = artifactAt(el); if (a) { a.uses.recharge = el.value; doSave(); } });
  on(app, "click", "[data-action=toggle-artifact-use]", (e, el) => {
    const a = artifactAt(el); if (!a) return;
    const arr = artifactUsesArray(a.usesState, Math.max(1, Number(a.uses.max) || 1)); const j = Number(el.dataset.useIndex);
    arr[j] = !arr[j]; a.usesState = arr; doSave(); render();
  });
  on(app, "click", "[data-action=add-artifact-spell]", (e, el) => {
    const a = artifactAt(el); const sel = app.querySelector(`[data-artifact-spell-select][data-index="${el.dataset.index}"]`);
    if (!a || !sel || !sel.value) return;
    a.spells = a.spells || [];
    if (!a.spells.some((x) => x.id === sel.value)) a.spells.push({ id: sel.value, max: 0, usesState: [] });
    doSave(); render();
  });
  on(app, "click", "[data-action=remove-artifact-spell]", (e, el) => { const a = artifactAt(el); if (a) { a.spells.splice(Number(el.dataset.spellIndex), 1); doSave(); render(); } });
  on(app, "click", "[data-action=open-artifact-spell]", (e, el) => {
    const sp = SPELLS.find((x) => x.id === el.dataset.spell);
    if (sp) openModal(spellCardHtml(sp, "", { known: true }));
  });
  on(app, "change", "[data-artifact-spell-max]", (e, el) => {
    const a = artifactAt(el); const sl = a && a.spells[Number(el.dataset.spellIndex)]; if (!sl) return;
    sl.max = Math.max(0, Math.min(20, Number(el.value) || 0)); sl.usesState = Array(sl.max).fill(true); doSave(); render();
  });
  on(app, "click", "[data-action=toggle-artifact-spell-use]", (e, el) => {
    const a = artifactAt(el); const sl = a && a.spells[Number(el.dataset.spellIndex)]; if (!sl) return;
    const arr = artifactUsesArray(sl.usesState, Number(sl.max) || 0); const j = Number(el.dataset.useIndex);
    arr[j] = !arr[j]; sl.usesState = arr; doSave(); render();
  });
  on(app, "click", "[data-action=open-wild-table]", () => openWildMagicTable());
  on(app, "click", "[data-action=open-tales-table]", () => openSpiritTalesTable());
  on(app, "click", "[data-action=open-flex-casting]", () => openFlexibleCasting());
  on(app, "change", "[data-divine-affinity]", (e, el) => {
    const a = DIVINE_AFFINITIES.find((x) => x.name === el.value);
    if (!a) return;
    data.divineAffinity = a.name;
    doSave();
    render();
  });
  on(app, "click", "[data-action=set-lunar-phase]", (e, el) => { data.lunarPhase = el.dataset.phase; doSave(); render(); });
  on(app, "input", "[data-grave-damage]", (e, el) => {
    graveDamage = Math.max(0, Number(el.value) || 0);
    const dcEl = el.closest(".feature-card-uses").querySelector("[data-grave-dc]");
    if (dcEl) dcEl.textContent = `Сл ${5 + graveDamage}`;
  });
  on(app, "click", "[data-action=roll-grave-save]", () => {
    const mod = getAbilityMod(data, "cha");
    const r = rollDice(1, 20)[0];
    const total = r + mod;
    const dc = 5 + graveDamage;
    showRollResult({ label: `Сила могилы: спасбросок Харизмы (Сл ${dc})`, detail: `к20: [${r}] ${formatModifier(mod)} = ${total} — ${total >= dc ? "успех: остаётесь с 1 хитом" : "провал"}`, total, breakdown: [{ value: r, label: "к20" }, { value: mod, label: "модификатор Харизмы" }] });
  });
  on(app, "change", "[data-dragon-pick]", (e, el) => {
    const da = DRAGON_ANCESTRIES.find((d) => d.name === el.value);
    const card = (data.features || []).find((f) => f.name === "Драконий предок" && /драконьей/i.test(f.source || ""));
    if (!da || !card) return;
    card.name = `Драконий предок: ${da.name} (${da.damage})`;
    card.desc = `${card.desc || ""}\n\nВаш предок — ${da.name.toLowerCase()} дракон; связанный вид урона — ${da.damage}.`;
    if (!data.proficiencies) data.proficiencies = {};
    if (!Array.isArray(data.proficiencies.languages)) data.proficiencies.languages = [];
    if (!data.proficiencies.languages.includes("Драконий")) data.proficiencies.languages.push("Драконий");
    doSave();
    render();
  });
  on(app, "change", "[data-storm-env]", (e, el) => {
    if (!el.value) return;
    applyStormEnvironment(el.value);
    doSave();
    render();
  });
  on(app, "click", "[data-action=roll-wild-surge]", () => {
    const controlled = (data.features || []).some((f) => /^Контролируемый всплеск$/i.test(f.name || ""));
    const r1 = rollDice(1, 8)[0];
    const e1 = WILD_MAGIC_SURGE_TABLE.find((x) => x.roll === r1);
    if (!controlled) {
      showRollResult({ label: "Дикая магия", detail: e1 ? e1.text : "", total: r1 });
      return;
    }
    const r2 = rollDice(1, 8)[0];
    const e2 = WILD_MAGIC_SURGE_TABLE.find((x) => x.roll === r2);
    showRollResult({
      label: "Дикая магия (Контролируемый всплеск: два кубика)",
      detail: r1 === r2 ? `Выпало [${r1}] и [${r2}] — одинаково, выберите ЛЮБОЙ эффект из таблицы.` : `[${r1}] ${e1 ? e1.text : ""}\n\n[${r2}] ${e2 ? e2.text : ""}\n\nВыберите любой из двух эффектов.`,
      total: Math.max(r1, r2),
    });
  });
  on(app, "click", "[data-action=roll-spell-attack]", () => {
    const bonus = spellAttackBonus(data);
    if (bonus === null) return;
    const dis = exhaustionDisadvantage("attack");
    const r = rollD20({ modifier: bonus, mode: dis ? "disadvantage" : "normal" });
    showRollResult({ label: "Атака заклинанием", detail: dis ? `к20: [${r.first}, ${r.second}] → взято ${r.picked} ${formatModifier(bonus)} (помеха: ${dis})` : `к20: [${r.first}] ${formatModifier(bonus)}`, total: r.total, isCrit: r.isCrit, isFumble: r.isFumble });
  });
  on(app, "click", "[data-action=sharp-on]", (e, el) => {
    const n = Number(el.dataset.n) || 1;
    if (!spendKi(n)) return;
    data.sharpBlade = n;
    doSave();
    render();
  });
  on(app, "click", "[data-action=sharp-off]", () => { data.sharpBlade = 0; doSave(); render(); });
  on(app, "change", "[data-action=discipline-extra]", (e, el) => {
    const f = data.features[Number(el.dataset.index)];
    if (!f) return;
    f.discExtra = Number(el.value) || 0;
    doSave();
    render();
  });
  on(app, "click", "[data-action=cast-discipline]", (e, el) => {
    const f = data.features[Number(el.dataset.index)];
    const meta = disciplineMetaFor(f);
    if (!meta) return;
    const extra = Math.min(Number(f.discExtra) || 0, disciplineMaxExtra(meta));
    const cost = meta.ki + extra;
    const ki = kiCard();
    const uses = ki && resolveFeatureUses(ki);
    if (!ki || !uses || !(uses.max > 0)) { showRollResult({ label: f.name, detail: "Нет карточки «Ци» — очки ци не списаны.", total: `${cost} ци` }); return; }
    const arr = usesArrayFor(ki, uses.max);
    if (arr.filter(Boolean).length < cost) { showRollResult({ label: f.name, detail: `Недостаточно очков ци: нужно ${cost}, осталось ${arr.filter(Boolean).length}.`, total: "—" }); return; }
    for (let n = 0; n < cost; n++) { const j = arr.lastIndexOf(true); if (j >= 0) arr[j] = false; }
    setFeatureUsesState(ki, arr);
    doSave();
    let detail = `Потрачено очков ци: ${cost}.`;
    let total = `${cost} ци`;
    if (meta.spell) detail += ` Заклинание «${meta.spell.name}»${meta.spell.upcast && extra ? ` как заклинание ${meta.spell.level + extra}-го круга` : ""}, без материальных компонентов.`;
    if (meta.dmg) {
      const expr = meta.dmg.base ? `${meta.dmg.base}${extra ? `+${extra}d10` : ""}` : (extra ? `${extra}d10` : "");
      if (expr) { const r = rollExpr(expr); detail += ` Урон ${toCyrillicDice(expr)} (${meta.dmg.type}): ${r.rolls.join("+")}.`; total = `${r.total} урона`; }
    }
    showRollResult({ label: f.name, detail, total });
    render();
  });
  on(app, "click", "[data-action=roll-feature-expr]", (e, el) => {
    const expr = el.dataset.expr;
    const r = rollExpr(expr);
    showRollResult({ label: el.dataset.label || "Бросок", detail: `${toCyrillicDice(expr)} = ${r.rolls.join("+")}${r.modifier ? formatModifier(r.modifier) : ""}`, total: r.total });
  });
  on(app, "click", "[data-action=roll-feature-attack]", (e, el) => {
    const f = data.features[Number(el.dataset.index)];
    const bonus = spellAttackBonus(data);
    if (bonus === null) return;
    const dis = exhaustionDisadvantage("attack");
    const r = rollD20({ modifier: bonus, mode: dis ? "disadvantage" : "normal" });
    showRollResult({ label: `${f.name || "Умение"} — атака`, detail: dis ? `к20: [${r.first}, ${r.second}] → взято ${r.picked} ${formatModifier(bonus)} (помеха: ${dis})` : `к20: [${r.first}] ${formatModifier(bonus)}`, total: r.total, isCrit: r.isCrit, isFumble: r.isFumble });
  });
  on(app, "click", "[data-action=roll-superiority-die]", () => {
    const sides = superiorityDieSides(data);
    if (!consumeSuperiorityDie()) return;
    const r = rollDice(1, sides)[0];
    showRollResult({ label: "Кость превосходства", detail: `к${sides}: [${r}]`, total: r });
    render();
  });
  on(app, "input", "[data-action=lay-on-hands-pool]", (e, el) => {
    const i = Number(el.dataset.index);
    const max = layOnHandsPoolMax();
    const v = Math.max(0, Math.min(Number(el.value) || 0, max));
    data.features[i].poolCurrent = v;
    doSave();
  });
  on(app, "click", "[data-action=lay-on-hands-reset]", (e, el) => {
    const i = Number(el.dataset.index);
    data.features[i].poolCurrent = layOnHandsPoolMax();
    doSave();
    render();
  });
  on(app, "input", "[data-action=healing-light-pool]", (e, el) => {
    const i = Number(el.dataset.index);
    const max = healingLightPoolMax(data);
    const v = Math.max(0, Math.min(Number(el.value) || 0, max));
    data.features[i].poolCurrent = v;
    doSave();
  });
  on(app, "input", "[data-action=healing-light-spend]", (e, el) => {
    const i = Number(el.dataset.index);
    const maxPerUse = healingLightMaxDicePerUse(data);
    data.features[i].healSpend = Math.max(1, Math.min(maxPerUse, Number(el.value) || 1));
    doSave();
  });
  on(app, "click", "[data-action=healing-light-reset]", (e, el) => {
    const i = Number(el.dataset.index);
    data.features[i].poolCurrent = healingLightPoolMax(data);
    doSave();
    render();
  });
  on(app, "click", "[data-action=roll-healing-light]", (e, el) => {
    const i = Number(el.dataset.index);
    const f = data.features[i];
    const max = healingLightPoolMax(data);
    const current = Math.max(0, Math.min(typeof f.poolCurrent === "number" ? f.poolCurrent : max, max));
    if (current <= 0) return;
    const maxPerUse = Math.min(healingLightMaxDicePerUse(data), current);
    const spend = Math.max(1, Math.min(typeof f.healSpend === "number" ? f.healSpend : maxPerUse, maxPerUse));
    const r = rollExpr(`${spend}d6`);
    f.poolCurrent = current - spend;
    doSave();
    showRollResult({ label: f.name || "Лечащий свет", detail: `${spend}к6 = ${r.rolls.join("+")}`, total: r.total });
    render();
  });

  // pets
  on(app, "click", "[data-action=add-pet]", () => openPetEditor(null));
  on(app, "click", "[data-action=edit-pet]", (e, el) => openPetEditor(Number(el.dataset.index)));
  on(app, "click", "[data-action=browse-pet-beasts]", () => openPetBeastBrowser());
  on(app, "click", "[data-action=remove-pet]", (e, el) => {
    data.pets.splice(Number(el.dataset.index), 1);
    doSave();
    render();
  });
  on(app, "input", "[data-pet-field]", (e, el) => {
    const i = Number(el.dataset.petIndex);
    data.pets[i][el.dataset.petField] = el.value;
    doSave();
  });
  on(app, "change", "[data-pet-num]", (e, el) => {
    const i = Number(el.dataset.petIndex);
    data.pets[i][el.dataset.petNum] = Math.max(el.dataset.petNum === "tempHp" ? 0 : -999, Number(el.value) || 0);
    doSave();
  });

  // spells: a card moves between the "known" grid and the "add spell"
  // browse grid on toggle, so (unlike a plain checkbox) this always needs a
  // full re-render.
  on(app, "click", "[data-action=toggle-spell]", (e, el) => {
    const spellId = el.dataset.spell;
    const spell = SPELLS.find((s) => s.id === spellId);
    const sc = data.spellcasting;
    if (spell.level === 0) {
      const list = sc.cantrips || (sc.cantrips = []);
      const idx = list.indexOf(spellId);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(spellId);
    } else {
      // A leveled spell's card here always represents either "known" (a
      // wizard's spellbook, or a known-caster's learned spells) or -- for
      // legacy data from before Task #109's prepared/known split -- a
      // spell sitting directly in "prepared". Removing checks both buckets
      // so this stays correct for older characters instead of only ever
      // checking "known" and, on a miss, silently re-adding the spell.
      const known = sc.known || (sc.known = []);
      const prepared = sc.prepared || (sc.prepared = []);
      const ki = known.indexOf(spellId);
      const pi = prepared.indexOf(spellId);
      if (ki >= 0 || pi >= 0) {
        if (ki >= 0) known.splice(ki, 1);
        if (pi >= 0) prepared.splice(pi, 1);
      } else {
        known.push(spellId);
      }
    }
    doSave();
    render();
  });
  // Toggles whether a leveled spell is among today's prepared spells
  // (Task #109), capped at the class's rules-formula limit -- clicking past
  // the cap on an unprepared spell is a no-op rather than bumping it out.
  on(app, "click", "[data-action=toggle-prepared]", (e, el) => {
    const spellId = el.dataset.spell;
    const sc = data.spellcasting || (data.spellcasting = {});
    const cls = sc.classFilter ? getClass(sc.classFilter) : null;
    const list = sc.prepared || (sc.prepared = []);
    const idx = list.indexOf(spellId);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      const max = preparedSpellsMax(sc, cls);
      if (list.length >= max) return;
      list.push(spellId);
    }
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-spell-prep-mode]", () => {
    spellPrepMode = !spellPrepMode;
    render();
  });
  on(app, "click", "[data-action=toggle-extra-browse]", () => { extraBrowseOpen = !extraBrowseOpen; render(); });
  on(app, "click", "[data-action=toggle-extra-spell]", (e, el) => {
    const sc = data.spellcasting || (data.spellcasting = { ability: null, classFilter: "", cantrips: [], known: [], prepared: [], slots: {} });
    const list = sc.extra || (sc.extra = []);
    const i = list.indexOf(el.dataset.spell);
    if (i >= 0) list.splice(i, 1);
    else list.push(el.dataset.spell);
    doSave();
    render();
  });
  on(app, "input", "[data-extra-search]", (e, el) => {
    extraSpellSearch = el.value;
    const pos = el.selectionStart;
    render();
    const n = $("[data-extra-search]", app);
    if (n) { n.focus(); n.setSelectionRange(pos, pos); }
  });
  on(app, "change", "[data-extra-class]", (e, el) => { extraSpellClass = el.value; render(); });
  on(app, "change", "[data-extra-level]", (e, el) => { extraSpellLevel = el.value; render(); });
  on(app, "click", "[data-action=toggle-spell-browse]", () => {
    spellBrowseOpen = !spellBrowseOpen;
    render();
  });
  on(app, "click", "[data-action=toggle-spell-slot]", (e, el) => {
    const lvl = el.dataset.level;
    const j = Number(el.dataset.slotIndex);
    const sc = data.spellcasting || (data.spellcasting = {});
    const arr = spellSlotsArrayFor(sc, lvl);
    arr[j] = !arr[j];
    if (!sc.slotsFilled) sc.slotsFilled = {};
    sc.slotsFilled[lvl] = arr;
    doSave();
    render();
  });

  // "+ Добавить заклинание" browse panel: search box + level filter, both
  // rebuild the card grid since the result set changes. Search preserves
  // focus/cursor across the re-render (mount() replaces the whole DOM).
  on(app, "input", "[data-spell-search]", (e, el) => {
    spellSearch = el.value;
    const cursorPos = el.selectionStart;
    render();
    const newEl = $("[data-spell-search]", app);
    if (newEl) {
      newEl.focus();
      newEl.setSelectionRange(cursorPos, cursorPos);
    }
  });
  on(app, "change", "[data-spell-level-filter]", (e, el) => {
    spellLevelFilter = el.value;
    render();
  });

  // death saves
  on(app, "click", "[data-action=death-success]", (e, el) => {
    const i = Number(el.dataset.index);
    data.deathSaves.successes = data.deathSaves.successes === i + 1 ? i : i + 1;
    doSave();
    render();
  });
  on(app, "click", "[data-action=death-failure]", (e, el) => {
    const i = Number(el.dataset.index);
    data.deathSaves.failures = data.deathSaves.failures === i + 1 ? i : i + 1;
    doSave();
    render();
  });

  // dice / rolls
  // Selecting the score-input's text (mousedown inside it, drag, release
  // just past its edge but still inside the surrounding .ability-box) used
  // to fire the box's own roll-ability click, since the click's target ends
  // up being the box rather than the input -- the plain `e.target.matches
  // ("input")` guard only catches a release that lands back on the input
  // itself. Tracking where the mousedown started instead catches a release
  // anywhere else in the box too.
  let abilityRollMousedownOnInput = false;
  on(app, "mousedown", "[data-ability-score]", () => { abilityRollMousedownOnInput = true; });

  // Облики
  on(app, "click", "[data-action=toggle-form-browse]", () => { formBrowseOpen = !formBrowseOpen; render(); });
  on(app, "input", "[data-form-search]", (e, el) => {
    formSearch = el.value; formShown = 30;
    const pos = el.selectionStart;
    render();
    const n = $("[data-form-search]", app);
    if (n) { n.focus(); n.setSelectionRange(pos, pos); }
  });
  on(app, "change", "[data-form-cr-filter]", (e, el) => { formCrFilter = el.value; formShown = 30; render(); });
  on(app, "change", "[data-form-move-filter]", (e, el) => { formMoveFilter = el.value; formShown = 30; render(); });
  on(app, "change", "[data-form-only-allowed]", (e, el) => { formOnlyAllowed = el.checked; formShown = 30; render(); });
  on(app, "click", "[data-action=add-form]", (e, el) => {
    const forms = ensureForms();
    const id = Number(el.dataset.beast);
    if (!forms.known.includes(id)) forms.known.push(id);
    doSave();
    render();
  });
  on(app, "click", "[data-action=remove-form]", (e, el) => {
    const forms = ensureForms();
    const id = Number(el.dataset.beast);
    forms.known = forms.known.filter((x) => x !== id);
    if (forms.active === id) { forms.active = null; forms.hp = null; }
    doSave();
    render();
  });
  on(app, "click", "[data-action=take-form]", (e, el) => {
    const forms = ensureForms();
    const id = Number(el.dataset.beast);
    const b = (beastsData || []).find((x) => x.id === id);
    if (!b) return;
    forms.active = id;
    forms.hp = beastMaxHp(b);
    doSave();
    render();
  });
  on(app, "click", "[data-action=revert-form]", () => {
    const forms = ensureForms();
    forms.active = null;
    forms.hp = null;
    doSave();
    render();
  });
  on(app, "change", "[data-form-hp]", (e, el) => {
    const forms = ensureForms();
    const b = (beastsData || []).find((x) => x.id === forms.active);
    if (!b) return;
    forms.hp = clampInt(el.value, 0, beastMaxHp(b), 0);
    doSave();
    render();
  });
  on(app, "click", "[data-action=form-more]", () => { formShown += 30; render(); });
  on(app, "click", "[data-beast-atk]", (e, el) => {
    openD20RollModal({ label: `${el.dataset.beastName}: атака`, modifier: Number(el.dataset.beastAtk) || 0 });
  });
  on(app, "click", "[data-beast-dmg]", (e, el) => {
    let act;
    try { act = JSON.parse(el.dataset.beastDmg); } catch { return; }
    startBeastDamage(el.dataset.beastName, act);
  });
  on(app, "click", "[data-action=form-damage]", () => {
    const forms = ensureForms();
    const delta = Math.max(0, Math.floor(Number($("[data-form-hp-delta]", app)?.value) || 0));
    if (!forms.active || !delta) return;
    const left = (Number(forms.hp) || 0) - delta;
    if (left > 0) { forms.hp = left; doSave(); render(); return; }
    // Form drops to 0: revert, and the excess damage lands on the character.
    forms.active = null;
    forms.hp = null;
    if (left < 0) applyDamage(-left);
    else { doSave(); render(); }
  });
  on(app, "click", "[data-action=form-heal]", () => {
    const forms = ensureForms();
    const delta = Math.max(0, Math.floor(Number($("[data-form-hp-delta]", app)?.value) || 0));
    const b = (beastsData || []).find((x) => x.id === forms.active);
    if (!b || !delta) return;
    forms.hp = Math.min(beastMaxHp(b), (Number(forms.hp) || 0) + delta);
    doSave();
    render();
  });

  // Money calculator
  on(app, "click", "[data-coin-pick]", (e, el) => {
    coinCalc.coin = el.dataset.coinPick;
    coinCalc.msg = "";
    render();
  });
  on(app, "input", "[data-coin-amount]", (e, el) => { coinCalc.amount = el.value; });
  on(app, "click", "[data-coin-op]", (e, el) => {
    const op = el.dataset.coinOp;
    if (op === "exchange") {
      coinCalc.exchangeOpen = !coinCalc.exchangeOpen;
      coinCalc.msg = "";
      render();
    } else if (op === "spend") coinCalcSpend();
    else if (op === "gain") coinCalcGain();
  });
  on(app, "click", "[data-coin-exchange-to]", (e, el) => { coinCalcExchange(el.dataset.coinExchangeTo); });
  on(app, "click", "[data-action=roll-ability]", (e, el) => {
    const startedOnInput = abilityRollMousedownOnInput;
    abilityRollMousedownOnInput = false;
    if (e.target.matches("input") || startedOnInput) return;
    const ab = el.dataset.ability;
    openD20RollModal({ label: `Проверка: ${ABILITIES.find((a) => a.id === ab).label}`, modifier: abilityCheckBonus(data, ab), blessed: !!data.blessingActive, forcedDisadvantage: exhaustionDisadvantage("check") });
  });
  on(app, "click", "[data-action=roll-save]", (e, el) => {
    const ab = el.dataset.ability;
    openD20RollModal({ label: `Спасбросок: ${ABILITIES.find((a) => a.id === ab).label}`, modifier: saveBonus(data, ab), blessed: !!data.blessingActive, forcedDisadvantage: exhaustionDisadvantage("save") });
  });
  on(app, "click", "[data-action=roll-skill]", (e, el) => {
    const sk = el.dataset.skill;
    openD20RollModal({ label: `Навык: ${SKILLS.find((s) => s.id === sk).label}`, modifier: skillBonus(data, sk), blessed: !!data.blessingActive, forcedDisadvantage: exhaustionDisadvantage("check") });
  });
  on(app, "click", "[data-action=roll-initiative]", () => {
    openD20RollModal({ label: "Инициатива", modifier: initiativeBonus(data), forcedDisadvantage: exhaustionDisadvantage("check"), forcedAdvantage: initiativeAdvantageSource(data) });
  });
  // Dice-pool builder: queue up any mix of dice (e.g. 2к6 + 1к8), see what's
  // queued, remove entries, then roll everything together at once. Clicking
  // the die picture itself does nothing -- it's purely decorative.
  on(app, "click", "[data-action=add-to-pool]", () => {
    const sides = Number($("[data-pool-die]", app).value);
    const countInput = $("[data-pool-count]", app);
    const count = Math.max(1, Number(countInput ? countInput.value : 1) || 1);
    const existing = dicePool.find((p) => p.sides === sides);
    if (existing) existing.count += count;
    else dicePool.push({ sides, count });
    render();
  });
  on(app, "click", "[data-action=remove-pool-die]", (e, el) => {
    dicePool.splice(Number(el.dataset.index), 1);
    render();
  });
  on(app, "click", "[data-action=roll-pool]", () => {
    if (!dicePool.length) return;
    const rolls = dicePool.map((p) => ({ ...p, r: rollExpr(`${p.count}d${p.sides}`) }));
    const total = rolls.reduce((sum, x) => sum + x.r.total, 0);
    const detail = rolls.map((x) => `${x.count}к${x.sides}: [${x.r.rolls.join(", ")}]`).join(", ");
    const diceCount = dicePool.reduce((s, p) => s + p.count, 0);
    showRollResult({ label: `Бросок ${diceCount} ${pluralizeDice(diceCount)}`, detail, total });
    dicePool = [];
    render();
  });
  on(app, "click", "[data-action=clear-log]", () => {
    clearRollLog();
    const logEl = $("[data-roll-log]", app);
    if (logEl) logEl.innerHTML = rollLogEntriesHtml();
  });
  on(app, "click", "[data-action=toggle-armor]", () => {
    if (!data.armorId) return;
    data.armorEquipped = !data.armorEquipped;
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-shield]", () => {
    data.shieldEquipped = !data.shieldEquipped;
    doSave();
    render();
  });

  on(app, "change", "[data-action=race-select]", (e, el) => {
    if (el.value === "__custom__") {
      raceCustomOpen = true;
      data.raceName = "";
    } else {
      raceCustomOpen = false;
      data.raceName = el.value;
    }
    doSave();
    render();
  });
  on(app, "change", "[data-action=background-select]", (e, el) => {
    if (el.value === "__custom__") {
      backgroundCustomOpen = true;
      data.backgroundName = "";
    } else {
      backgroundCustomOpen = false;
      data.backgroundName = el.value;
    }
    doSave();
    render();
  });

  // Crop window for the character portrait: drag the picture and use the
  // slider to zoom, so the player chooses which part of it is shown.
  function openPortraitCropper(img) {
    const VIEW = 280;
    const st = { zoom: 1, ox: 0, oy: 0 };
    const base = Math.max(VIEW / img.width, VIEW / img.height);
    const modal = openModal(`
      <h3 style="margin-top:0;">Область изображения</h3>
      <p class="muted" style="font-size:0.85rem;margin:0 0 8px;">Перетащите картинку и настройте масштаб — в портрете будет видна выбранная область.</p>
      <div style="display:flex;justify-content:center;"><canvas data-crop-canvas width="${VIEW}" height="${VIEW}" style="width:${VIEW}px;height:${VIEW}px;border:2px solid var(--gold);border-radius:8px;cursor:grab;touch-action:none;background:#000;"></canvas></div>
      <label class="row" style="gap:8px;align-items:center;margin-top:10px;"><span>Масштаб</span><input type="range" data-crop-zoom min="1" max="4" step="0.01" value="1" style="flex:1;" /></label>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px;"><button data-action="close-modal">Отмена</button><button class="primary" data-crop-ok>Готово</button></div>`);
    const cv = modal.querySelector("[data-crop-canvas]");
    const ctx = cv.getContext("2d");
    const clamp = () => {
      const w = img.width * base * st.zoom, h = img.height * base * st.zoom;
      st.ox = Math.min(0, Math.max(VIEW - w, st.ox));
      st.oy = Math.min(0, Math.max(VIEW - h, st.oy));
    };
    const draw = () => {
      clamp();
      ctx.clearRect(0, 0, VIEW, VIEW);
      ctx.drawImage(img, st.ox, st.oy, img.width * base * st.zoom, img.height * base * st.zoom);
    };
    st.ox = (VIEW - img.width * base) / 2;
    st.oy = (VIEW - img.height * base) / 2;
    draw();
    let drag = null;
    cv.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, ox: st.ox, oy: st.oy }; cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; });
    cv.addEventListener("pointermove", (e) => { if (!drag) return; st.ox = drag.ox + (e.clientX - drag.x); st.oy = drag.oy + (e.clientY - drag.y); draw(); });
    const end = () => { drag = null; cv.style.cursor = "grab"; };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    modal.querySelector("[data-crop-zoom]").addEventListener("input", (e) => {
      const old = st.zoom, nz = Number(e.target.value);
      // zoom around the centre of the viewport
      const cx = (VIEW / 2 - st.ox) / old, cy = (VIEW / 2 - st.oy) / old;
      st.zoom = nz;
      st.ox = VIEW / 2 - cx * nz;
      st.oy = VIEW / 2 - cy * nz;
      draw();
    });
    on(modal, "click", "[data-action=close-modal]", closeModal);
    on(modal, "click", "[data-crop-ok]", () => {
      const size = 256, k = size / VIEW;
      const out = document.createElement("canvas");
      out.width = size; out.height = size;
      out.getContext("2d").drawImage(img, st.ox * k, st.oy * k, img.width * base * st.zoom * k, img.height * base * st.zoom * k);
      data.portraitDataUrl = out.toDataURL("image/jpeg", 0.85);
      closeModal();
      doSave();
      render();
    });
  }
  // portrait (top-left image box) — click opens the hidden file input, then
  // the chosen image is downscaled via canvas before being stored as a data
  // URL, to avoid bloating the character's JSON blob in D1.
  on(app, "click", "[data-action=pick-portrait]", (e, el) => {
    const input = $("[data-portrait-input]", el);
    if (input) input.click();
  });
  on(app, "change", "[data-portrait-input]", (e, el) => {
    const file = el.files && el.files[0];
    if (!file) return;
    const MAX_PORTRAIT_BYTES = 2 * 1024 * 1024;
    if (file.size > MAX_PORTRAIT_BYTES) {
      alert(`Файл слишком большой (${(file.size / (1024 * 1024)).toFixed(1)} МБ) — выберите изображение до 2 МБ.`);
      el.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => { openPortraitCropper(img); el.value = ""; };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  // inspiration
  function ensureInspiration() {
    if (!data.inspiration) data.inspiration = { dmStars: 0, bardDie: "d6", bardStar: false, heroic: false };
  }
  on(app, "click", "[data-action=toggle-dm-star]", (e, el) => {
    const idx = Number(el.dataset.index);
    ensureInspiration();
    data.inspiration.dmStars = data.inspiration.dmStars === idx + 1 ? idx : idx + 1;
    doSave();
    render();
  });
  on(app, "click", "[data-action=toggle-bard-star]", (e, el) => {
    ensureInspiration();
    data.inspiration.bardStar = !data.inspiration.bardStar;
    doSave();
    render();
  });
  on(app, "click", "[data-action=roll-bard-inspiration]", (e, el) => {
    ensureInspiration();
    if (!data.inspiration.bardStar) return;
    const die = data.inspiration.bardDie || "d6";
    const r = rollExpr(`1${die}`);
    showRollResult({ label: "Вдохновение барда", detail: `${toCyrillicDice(`1${die}`)} = ${r.rolls.join("+")}`, total: r.total });
    // Spent the instant it's rolled -- the die is lost after one use.
    data.inspiration.bardStar = false;
    doSave();
    render();
  });
  on(app, "click", "[data-action=open-rest-modal]", () => openRestModal());
  on(app, "click", "[data-action=open-level-up-modal]", () => openLevelUpModal());
  on(app, "click", "[data-action=revert-level-up]", () => {
    const stack = data._levelUpUndoStack;
    if (!Array.isArray(stack) || !stack.length) return;
    if (!window.confirm("Откатить последнее повышение уровня? Все изменения этого уровня (хиты, умения, черта/характеристика, подкласс) будут отменены.")) return;
    const snapshot = stack[stack.length - 1];
    const remainingStack = stack.slice(0, -1);
    // Инвентарь, оружие и атаки не относятся к уровню — после отката остаются такими, какими были до отката.
    const KEEP_ON_REVERT = ["armorId", "armorEquipped", "customArmor", "shieldEquipped", "shieldACBonus", "healingPotions", "attacks", "weapons", "ammo", "equipmentText", "money", "artifacts", "pets", "notes", "personality", "portraitDataUrl"];
    const kept = {};
    KEEP_ON_REVERT.forEach((k) => { if (k in data) kept[k] = JSON.parse(JSON.stringify(data[k])); });
    Object.keys(data).forEach((k) => delete data[k]);
    Object.assign(data, snapshot, kept);
    // The restored snapshot has no stack of its own (it was stripped out
    // when taken -- see applyLevelUp), so the remaining, one-shorter stack
    // is reattached here, letting the button keep working for further
    // consecutive undos down to level 1.
    data._levelUpUndoStack = remainingStack;
    doSave();
    render();
  });

  // hits: damage / heal / healing potions
  function applyDamage(delta) {
    let temp = Number(data.hp.temp) || 0;
    let cur = Number(data.hp.current) || 0;
    const absorbed = Math.min(temp, delta);
    temp -= absorbed;
    cur = Math.max(0, cur - (delta - absorbed));
    data.hp.temp = temp;
    data.hp.current = cur;
    doSave();
    render();
  }
  function applyHeal(delta) {
    const max = effectiveMaxHp(data);
    data.hp.current = Math.min(max, (Number(data.hp.current) || 0) + delta);
    doSave();
    render();
  }
  on(app, "click", "[data-action=apply-damage]", () => {
    const input = $("[data-hp-delta-input]", app);
    applyDamage(Math.max(0, Number(input?.value) || 0));
  });
  on(app, "click", "[data-action=apply-heal]", () => {
    const input = $("[data-hp-delta-input]", app);
    applyHeal(Math.max(0, Number(input?.value) || 0));
  });
  function ensurePotionsObject() {
    if (!data.healingPotions || typeof data.healingPotions !== "object") {
      data.healingPotions = { common: 0, greater: 0, superior: 0, supreme: 0 };
    }
  }
  on(app, "click", "[data-action=add-potion]", (e, el) => {
    const tier = el.dataset.tier;
    ensurePotionsObject();
    data.healingPotions[tier] = (data.healingPotions[tier] || 0) + 1;
    doSave();
    render();
  });
  on(app, "click", "[data-action=remove-potion]", (e, el) => {
    const tier = el.dataset.tier;
    ensurePotionsObject();
    data.healingPotions[tier] = Math.max(0, (data.healingPotions[tier] || 0) - 1);
    doSave();
    render();
  });
  on(app, "click", "[data-action=drink-potion]", (e, el) => {
    const tier = el.dataset.tier;
    ensurePotionsObject();
    if (!data.healingPotions[tier]) return;
    const def = HEALING_POTIONS.find((t) => t.id === tier);
    if (!def) return;
    data.healingPotions[tier] -= 1;
    const r = rollExpr(def.diceExpr);
    applyHeal(r.total);
    showRollResult({ label: def.name, detail: `${def.dice} = ${r.rolls.join("+")}${formatModifier(r.modifier)}`, total: r.total });
    doSave();
    render();
  });

  // death saves: d20 auto-roller
  on(app, "click", "[data-action=roll-death-save]", () => {
    const r = rollExpr("1d20");
    const total = r.total;
    if (total < 10) {
      data.deathSaves.failures = Math.min(3, (data.deathSaves.failures || 0) + 1);
    } else {
      data.deathSaves.successes = Math.min(3, (data.deathSaves.successes || 0) + 1);
    }
    showRollResult({ label: "Спасбросок от смерти", detail: total < 10 ? "Провал (< 10)" : "Успех (≥ 10)", total });
    doSave();
    render();
  });

  function recomputeIfNeeded(path) {
    const acPaths = ["armorId", "armorEquipped", "shieldEquipped", "shieldACBonus", "customArmor.baseAC", "customArmor.dexMode", "customArmor.dexCap"];
    if (acPaths.includes(path)) {
      const el = $('[data-derived="ac"]');
      if (el) el.textContent = armorClass(data);
    }
  }

  function recomputeAll() {
    ABILITIES.forEach((a) => {
      const el = $(`[data-derived="mod-${a.id}"]`);
      if (el) el.textContent = formatModifier(getAbilityMod(data, a.id));
      const saveEl = $(`[data-derived="save-${a.id}"]`);
      if (saveEl) saveEl.textContent = formatModifier(saveBonus(data, a.id));
    });
    SKILLS.forEach((s) => {
      const el = $(`[data-derived="skill-${s.id}"]`);
      if (el) el.textContent = formatModifier(skillBonus(data, s.id));
    });
    const acEl = $('[data-derived="ac"]');
    if (acEl) acEl.textContent = armorClass(data);
    const initEl = $('[data-derived="initiative"]');
    if (initEl) initEl.textContent = formatModifier(initiativeBonus(data));
  }

  if (ensureBattleragerSpikes() | ensureSunBolt()) doSave();
  render();
}
