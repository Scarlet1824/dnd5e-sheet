import { ABILITIES, SKILLS, ARMORS, SHIELD_DEFAULT_AC_BONUS, abilityMod, proficiencyBonusForLevel } from "./data/dnd5e-data.js";

export function blankCharacter(edition = "2014") {
  return {
    name: "Безымянный герой",
    edition,
    portraitDataUrl: "", // top-left character portrait, resized data URL
    race: null, // { id, chosenAbilityChoice? }
    background: null, // { id }
    classes: [], // [{ id, name, level, subclass }]
    xp: 0, // experience points — tracked alongside level for the future level-up flow
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    abilityMethod: "standard",
    abilityBonuses: [], // [{ source, ability, amount }] — race/feat bonuses already baked into `abilities`, kept here just for the "откуда бонус" box
    proficiencies: { skills: [], expertise: [], savingThrows: [], armor: [], weapons: [], tools: [], languages: [] },
    hp: { max: 10, current: 10, temp: 0 },
    hitDice: { die: 8, total: 1, current: 1 },
    armorId: null, // owned armor (ARMORS id, or "custom"), or null = no armor owned
    armorEquipped: true, // whether the owned armor is currently worn
    customArmor: { name: "", baseAC: 10, dexMode: "full", dexCap: 2, note: "" }, // used when armorId === "custom" — for homebrew/magic armor
    shieldEquipped: false,
    shieldACBonus: SHIELD_DEFAULT_AC_BONUS,
    speed: 30,
    inspiration: {
      dmStars: 0, // 2014: DM inspiration, 0-5 stars marked
      bardDie: "d6", // 2014: bardic inspiration die size
      bardStar: false, // 2014: bardic inspiration granted & not yet used
      heroic: false, // 2024: heroic inspiration (on/off)
    },
    healingPotions: { common: 0, greater: 0, superior: 0, supreme: 0 }, // counts per HEALING_POTIONS tier
    deathSaves: { successes: 0, failures: 0 },
    attacks: [],
    spellcasting: { ability: null, slots: {}, cantrips: [], known: [], prepared: [] },
    weapons: [], // [{ name, damage, type, properties, special }] — structured, via the weapon picker
    ammo: { arrows: 0, bolts: 0, javelins: 0, darts: 0 }, // consumed by matching ranged attacks
    equipmentText: "", // free-text box for everything else carried (gear, tools, consumables…)
    money: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    feats: [], // [{ name, desc }] — real feats gained at certain levels (Черты)
    features: [], // [{ name, source, desc }] — race/class/background features (Умения)
    personality: { traits: "", ideals: "", bonds: "", flaws: "", backstory: "" },
    notes: "",
    pets: [], // [{ name, desc }]
  };
}

export function totalLevel(data) {
  return (data.classes || []).reduce((s, c) => s + (Number(c.level) || 0), 0) || 1;
}

export function proficiencyBonus(data) {
  return proficiencyBonusForLevel(totalLevel(data));
}

export function getAbilityScore(data, abilityId) {
  return Number(data.abilities?.[abilityId] ?? 10);
}

export function getAbilityMod(data, abilityId) {
  return abilityMod(getAbilityScore(data, abilityId));
}

export function isProficientSkill(data, skillId) {
  return (data.proficiencies?.skills || []).includes(skillId);
}
export function isExpertSkill(data, skillId) {
  return (data.proficiencies?.expertise || []).includes(skillId);
}

export function skillBonus(data, skillId) {
  const skill = SKILLS.find((s) => s.id === skillId);
  if (!skill) return 0;
  let bonus = getAbilityMod(data, skill.ability);
  const proficient = isProficientSkill(data, skillId);
  const expert = isExpertSkill(data, skillId);
  if (proficient) bonus += proficiencyBonus(data);
  if (expert) bonus += proficiencyBonus(data);
  // "Выдающийся атлет" only tops up a Str/Dex/Con skill the proficiency
  // bonus ISN'T already fully included in -- a proficient (or expert) skill
  // already has it, so only a skill with neither gets the half bonus added.
  if (!proficient && !expert && HALF_PROFICIENCY_ABILITIES.includes(skill.ability) && hasRemarkableAthlete(data)) {
    bonus += Math.ceil(proficiencyBonus(data) / 2);
  }
  return bonus;
}

export function isProficientSave(data, abilityId) {
  return (data.proficiencies?.savingThrows || []).includes(abilityId);
}

export function saveBonus(data, abilityId) {
  let bonus = getAbilityMod(data, abilityId);
  if (isProficientSave(data, abilityId)) bonus += proficiencyBonus(data);
  return bonus;
}

// Champion's "Выдающийся атлет": half proficiency bonus (rounded up) added
// to any Str/Dex/Con ability check or skill check that doesn't already
// include the full proficiency bonus. Matched by exact feature name (the
// same convention as Fighter's other automatic features -- Second Wind,
// Rage's use count, etc.) rather than parsing the prose, since it's a
// single fixed Champion feature rather than a phrasing that varies across
// sourcebooks.
const REMARKABLE_ATHLETE_FEATURE_NAME = /^Выдающийся атлет$/i;
const HALF_PROFICIENCY_ABILITIES = ["str", "dex", "con"];
function hasRemarkableAthlete(data) {
  return (data.features || []).some((f) => REMARKABLE_ATHLETE_FEATURE_NAME.test(f.name || ""));
}
// The half-proficiency bonus for a raw ability check (no matching skill) --
// e.g. a Strength check to force open a door. Skill checks get the same
// treatment inside skillBonus() below instead, since a proficient/expert
// skill already includes the full bonus and shouldn't also get the half one.
export function abilityCheckBonus(data, abilityId) {
  let bonus = getAbilityMod(data, abilityId);
  if (HALF_PROFICIENCY_ABILITIES.includes(abilityId) && hasRemarkableAthlete(data)) {
    bonus += Math.ceil(proficiencyBonus(data) / 2);
  }
  return bonus;
}

export function passivePerception(data) {
  return 10 + skillBonus(data, "perception");
}
export function passiveInvestigation(data) {
  return 10 + skillBonus(data, "investigation");
}
export function passiveInsight(data) {
  return 10 + skillBonus(data, "insight");
}

// Resolves the currently-worn armor to a { baseAC, dexMode, dexCap } shape,
// whether it's a catalog ARMORS entry or the player's own custom/magic armor.
function resolveEquippedArmor(data) {
  if (!data.armorEquipped || !data.armorId) return null;
  if (data.armorId === "custom") {
    const c = data.customArmor || {};
    return { baseAC: Number(c.baseAC ?? 10), dexMode: c.dexMode || "full", dexCap: Number(c.dexCap ?? 2), category: c.category || null };
  }
  return ARMORS.find((a) => a.id === data.armorId) || null;
}

// Passive, always-on AC bonuses granted by a feature's own text -- read the
// same way unarmoredDefenseBonusAbility() reads Unarmored Defense above, so
// either sourcebook wording works and a player's own edited text is
// respected, rather than hardcoding this per class/race. Covers:
// Fighter's Defense fighting style ("Оборона": +1 while wearing any armor),
// Forge Domain's "Душа кузницы" (+1 while wearing heavy armor specifically),
// and races with an unconditional flat AC bonus like Warforged's
// "Встроенная защита" (+1 regardless of armor worn).
function passiveArmorFeatureACBonus(data, armor) {
  let bonus = 0;
  for (const f of data.features || []) {
    const desc = f.desc || "";
    let m = /\+(\d+)\s*к\s*КД,?\s*пока\s+вы\s+носите\s+доспех/i.exec(desc);
    if (m) {
      if (armor) bonus += Number(m[1]);
      continue;
    }
    m = /носите\s+тяжёлый\s+доспех[^.]*?\+(\d+)\s*к\s*КД/i.exec(desc);
    if (m) {
      if (armor && armor.category === "heavy") bonus += Number(m[1]);
      continue;
    }
    m = /^\+(\d+)\s*к\s*КД;/i.exec(desc);
    if (m) {
      bonus += Number(m[1]);
      continue;
    }
  }
  return bonus;
}

const UNARMORED_DEFENSE_ABILITY_WORDS = { "силы": "str", "ловкости": "dex", "телосложения": "con", "интеллекта": "int", "мудрости": "wis", "харизмы": "cha" };
// "Защита без брони" grants a formula-based AC while unarmored instead of
// the flat 10+Dex -- Barbarian's adds Телосложения, Monk's adds Мудрости.
// Read straight off whichever feature card is on file (by its own stated
// formula, not hardcoded by class) so either sourcebook wording works and a
// player's own edited text is respected.
function unarmoredDefenseBonusAbility(data) {
  for (const f of data.features || []) {
    if (!/защита без брони/i.test(f.name || "")) continue;
    const m = /класс\s+доспеха\s+равен\s+10\s*\+\s*модификатор\s+Ловкости\s*\+\s*модификатор\s+(Силы|Ловкости|Телосложения|Интеллекта|Мудрости|Харизмы)/i.exec(f.desc || "");
    if (m) return UNARMORED_DEFENSE_ABILITY_WORDS[m[1].toLowerCase()];
  }
  return null;
}

// A handful of races/subclasses grant a flat "КД <N> + модификатор Ловкости"
// while unarmored, instead of the standard 10+Dex or a Защита без брони
// formula -- e.g. Autognome's "Укреплённый корпус", Thri-kreen's
// "Хамелеонный панцирь", Lizardfolk's "Природный доспех", and Draconic
// Bloodline sorcerer's "Драконья устойчивость". Read the base number
// straight off the feature text, same approach as unarmoredDefenseBonusAbility
// above (the caller only uses this when no Защита без брони formula applied).
function unarmoredFlatACBase(data) {
  let best = null;
  for (const f of data.features || []) {
    if (/защита без брони/i.test(f.name || "")) continue; // handled separately, different formula shape
    const m = /(\d+)\s*\+\s*(?:модификатор\s+)?Ловкост/i.exec(f.desc || "");
    if (m) {
      const n = Number(m[1]);
      if (best === null || n > best) best = n;
    }
  }
  return best;
}

// Bladesinging's "Песнь клинка": while active (a manual on/off toggle on
// its feature card, see sheet.js -- the sheet has no minute-by-minute
// clock to expire it on its own) and the character isn't wearing medium/
// heavy armor or a shield, it adds the Intelligence modifier (minimum +1)
// to AC. Scoped to characters who actually have the feature card, same as
// the other passive-bonus parsers above, so toggling data.bladesongActive
// on a non-Bladesinger (impossible via the UI, but the field is plain
// character data) has no effect.
function bladesongACBonus(data, armor) {
  if (!data.bladesongActive) return 0;
  if (armor && armor.category !== "light") return 0;
  if (data.shieldEquipped) return 0;
  if (!(data.features || []).some((f) => /^Песнь клинка$/i.test(f.name || ""))) return 0;
  return Math.max(1, getAbilityMod(data, "int"));
}

export function armorClass(data) {
  const dexMod = getAbilityMod(data, "dex");
  // Backward compatibility for characters saved before the armor/shield model
  // (they carry the old acBase/acOverride fields instead of armorId).
  if (data.armorId === undefined && (data.acOverride !== undefined || data.acBase !== undefined)) {
    if (data.acOverride !== null && data.acOverride !== undefined && data.acOverride !== "") {
      return Number(data.acOverride);
    }
    return Number(data.acBase || 10) + dexMod;
  }
  const armor = resolveEquippedArmor(data);
  let base;
  if (armor) {
    let dexBonus = 0;
    if (armor.dexMode === "full") dexBonus = dexMod;
    else if (armor.dexMode === "capped") dexBonus = Math.min(dexMod, armor.dexCap);
    base = armor.baseAC + dexBonus;
  } else {
    const bonusAbility = unarmoredDefenseBonusAbility(data);
    if (bonusAbility) {
      base = 10 + dexMod + getAbilityMod(data, bonusAbility);
    } else {
      const flatBase = unarmoredFlatACBase(data);
      base = (flatBase !== null ? flatBase : 10) + dexMod;
    }
  }
  const shieldBonus = data.shieldEquipped ? Number(data.shieldACBonus ?? SHIELD_DEFAULT_AC_BONUS) : 0;
  const featureBonus = passiveArmorFeatureACBonus(data, armor);
  return base + shieldBonus + featureBonus + bladesongACBonus(data, armor);
}

export function initiativeBonus(data) {
  const alert = (data.feats || []).some((f) => f.id === "alert") ? 5 : 0;
  return getAbilityMod(data, "dex") + alert;
}

export function spellSaveDC(data) {
  const ability = data.spellcasting?.ability;
  if (!ability) return null;
  return 8 + proficiencyBonus(data) + getAbilityMod(data, ability);
}

export function spellAttackBonus(data) {
  const ability = data.spellcasting?.ability;
  if (ability === null || ability === undefined) return null;
  return proficiencyBonus(data) + getAbilityMod(data, ability);
}

export function abilityLabel(abilityId) {
  return ABILITIES.find((a) => a.id === abilityId)?.label || abilityId;
}
export function abilityShort(abilityId) {
  return ABILITIES.find((a) => a.id === abilityId)?.short || abilityId?.toUpperCase();
}
