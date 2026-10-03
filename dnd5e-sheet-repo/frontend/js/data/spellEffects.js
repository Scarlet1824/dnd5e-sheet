// Механика применения заклинаний 1-го круга (кнопка «Применить» на карточке заклинания).
// attack: бросок атаки заклинанием; save: спасбросок цели (half — половина урона при успехе);
// dmg: [{ expr, type, up, label }] — урон; up — добавка за каждый круг ячейки выше круга заклинания;
// heal: лечение (mod — плюс модификатор базовой характеристики); temp: временные хиты;
// pool: пул хитов (Усыпление, Сверкающие брызги); darts: Волшебная стрела; rider: урон добавляется к другой атаке/эффекту.
export const SPELL_EFFECTS = {
  "burning-hands": { save: "dex", half: true, dmg: [{ expr: "3d6", type: "огонь", up: "1d6" }] },
  "thunderwave": { save: "con", half: true, dmg: [{ expr: "2d8", type: "звук", up: "1d8" }] },
  "hellish-rebuke": { save: "dex", half: true, dmg: [{ expr: "2d10", type: "огонь", up: "1d10" }], note: "Реакция на получение урона." },
  "hail-of-thorns": { save: "dex", half: true, rider: true, dmg: [{ expr: "1d10", type: "колющий", up: "1d10" }], note: "Следующая дальнобойная атака оружием: урон цели и в радиусе 5 футов." },
  "dissonant-whispers": { save: "wis", half: true, dmg: [{ expr: "3d6", type: "психическая энергия", up: "1d6" }] },
  "earth-tremor": { save: "dex", dmg: [{ expr: "1d6", type: "дробящий", up: "1d6" }] },
  "tashas-caustic-brew": { save: "dex", dmg: [{ expr: "2d4", type: "кислота", up: "2d4" }], note: "Урон повторяется в начале каждого хода цели." },
  "catapult": { save: "dex", dmg: [{ expr: "3d8", type: "дробящий", up: "1d8" }] },
  "frost-fingers": { save: "con", half: true, dmg: [{ expr: "2d8", type: "холод", up: "1d8" }] },
  "arms-of-hadar": { save: "str", half: true, dmg: [{ expr: "2d6", type: "некротическая энергия", up: "1d6" }] },
  "ice-knife": { attack: true, dmg: [{ expr: "1d10", type: "колющий", label: "попадание" }, { expr: "2d6", type: "холод", up: "1d6", label: "взрыв (спасбросок Ловкости)", save: "dex" }] },
  "witch-bolt": { attack: true, dmg: [{ expr: "1d12", type: "электричество", up: "1d12" }], note: "Далее бонусным действием 1к12 каждый ход." },
  "ray-of-sickness": { attack: true, dmg: [{ expr: "2d8", type: "яд", up: "1d8" }], note: "Цель спасбросок Телосложения, иначе отравлена." },
  "inflict-wounds": { attack: true, dmg: [{ expr: "3d10", type: "некротическая энергия", up: "1d10" }] },
  "guiding-bolt": { attack: true, dmg: [{ expr: "4d6", type: "излучение", up: "1d6" }] },
  "chromatic-orb": { attack: true, dmg: [{ expr: "3d8", type: "кислота/холод/огонь/электричество/яд/звук (на выбор)", up: "1d8" }] },
  "chaos-bolt": { attack: true, dmg: [{ expr: "2d8", type: "тип по выпавшей кости к8" }, { expr: "1d6", type: "дополнительно", up: "1d6", label: "доп. кость" }], note: "Если на двух к8 выпало одинаковое число, снаряд перескакивает." },
  "magic-missile": { darts: { base: 3, expr: "1d4+1", type: "силовое поле" } },
  "divine-favor": { rider: true, dmg: [{ expr: "1d4", type: "излучение" }], note: "Добавляется к каждому попаданию оружием." },
  "wrathful-smite": { rider: true, save: "wis", dmg: [{ expr: "1d6", type: "психическая энергия" }] },
  "thunderous-smite": { rider: true, save: "str", dmg: [{ expr: "2d6", type: "звук" }] },
  "searing-smite": { rider: true, save: "con", dmg: [{ expr: "1d6", type: "огонь", up: "1d6" }], note: "Далее 1к6 огнём в начале каждого хода цели." },
  "ensnaring-strike": { rider: true, save: "str", dmg: [{ expr: "1d6", type: "колющий", up: "1d6" }], note: "Урон в начале каждого хода цели, пока она опутана." },
  "hunters-mark": { rider: true, dmg: [{ expr: "1d6", type: "урон оружия" }] },
  "hex": { rider: true, dmg: [{ expr: "1d6", type: "некротическая энергия" }] },
  "zephyr-strike": { rider: true, dmg: [{ expr: "1d8", type: "силовое поле" }], note: "Один раз за ход, при попадании оружием." },
  "absorb-elements": { rider: true, dmg: [{ expr: "1d6", type: "тип поглощённого урона", up: "1d6" }], note: "Урон при вашей следующей рукопашной атаке." },
  "healing-word": { heal: { expr: "1d4", up: "1d4", mod: true } },
  "cure-wounds": { heal: { expr: "1d8", up: "1d8", mod: true } },
  "false-life": { temp: { expr: "1d4+4", upFlat: 5 } },
  "armor-of-agathys": { temp: { flat: 5, upFlat: 5 }, note: "Атакующий в рукопашной получает столько же урона холодом, пока есть временные хиты." },
  "sleep": { pool: { expr: "5d8", up: "2d8" } },
  "color-spray": { pool: { expr: "6d10", up: "2d10" } },
  // только спасбросок цели
  "bane": { save: "cha" }, "cause-fear": { save: "wis" }, "charm-person": { save: "wis" }, "command": { save: "wis" },
  "compelled-duel": { save: "wis" }, "animal-friendship": { save: "wis" }, "faerie-fire": { save: "dex" }, "entangle": { save: "str" },
  "grease": { save: "dex" }, "tashas-hideous-laughter": { save: "wis" }, "sanctuary": { save: "wis" },
};
