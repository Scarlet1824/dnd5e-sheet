import { openModal, closeModal, on, escapeHtml } from "./dom.js";
import { rollD20, rollExpr, rollDie, pushRollLog, formatModifier } from "./dice.js";

// A plain static picture (a copy of the reference d20 image), not an
// animated shape — clicking it rolls instantly with no spin effect.
export function d20VectorSvg(size, extraClass = "") {
  return `<img class="d20-quick-icon ${extraClass}" src="assets/icons/d20-quick.png" width="${size}" height="${size}" alt="к20" />`;
}

// Opens a result popup for an already-computed roll and logs it.
//
// `breakdown` (optional) is the roll's per-die/per-source detail, one entry
// per individual die (or flat modifier) -- e.g. for a half-orc rogue's crit:
// [{value:2,label:"оружие"},{value:6,label:"оружие"},{value:4,label:"свирепые атаки"},
//  {value:6,label:"скрытая атака"},{value:1,label:"модификатор Ловкости"}]
// -- shown as a collapsed-by-default <details> under the plain formula/total
// so the player can see exactly which die rolled what without cluttering the
// main result. Only damage rolls build this today (see doRollAttackDamage in
// sheet.js); anything that doesn't pass it just gets the plain result as
// before.
// `reroll` (optional) is { label, onClick } -- a follow-up choice offered
// on the result itself, for effects that only make sense to decide about
// AFTER seeing the roll (e.g. «Дикий атакующий»: "once per turn you may
// reroll all the weapon's damage dice", which only makes sense to invoke
// once you've seen whether the first roll was worth rerolling). Clicking
// it closes this modal and calls onClick(), which is expected to compute
// and show its own follow-up result (typically by calling showRollResult
// again) -- this function has no opinion on what a reroll produces, it
// just offers the button and gets out of the way once clicked.
export function showRollResult({ label, detail, total, isCrit, isFumble, breakdown, reroll }) {
  pushRollLog({ label, detail, total, isCrit, isFumble, breakdown });
  // Lets any inline roll-log display (e.g. the one on the sheet's main tab)
  // refresh itself in place without needing a full page re-render.
  document.dispatchEvent(new CustomEvent("dnd5e:roll-logged"));
  const cls = isCrit ? "crit" : isFumble ? "fumble" : "";
  const html = `
    <h3>${escapeHtml(label)}</h3>
    <p class="muted">${escapeHtml(detail)}</p>
    <p style="font-size:2.2rem; text-align:center;" class="${cls}">${total}</p>
    ${isCrit ? '<p class="muted" style="text-align:center;color:var(--green)">Критический успех!</p>' : ""}
    ${isFumble ? '<p class="muted" style="text-align:center;color:var(--red)">Критический провал!</p>' : ""}
    ${
      breakdown && breakdown.length
        ? `<details class="roll-breakdown">
      <summary>Подробный расчёт (${breakdown.length})</summary>
      <ul>
        ${breakdown.map((b) => `<li><span class="roll-breakdown-value">${escapeHtml(String(b.value))}</span><span class="roll-breakdown-label">${escapeHtml(b.label)}</span></li>`).join("")}
      </ul>
    </details>`
        : ""
    }
    <div class="row" style="justify-content:${reroll ? "space-between" : "flex-end"};align-items:center;">
      ${reroll ? `<button data-action="reroll-result">🎲 ${escapeHtml(reroll.label)}</button>` : ""}
      <button data-action="close-modal" class="primary">ОК</button>
    </div>`;
  const modal = openModal(html);
  on(modal, "click", "[data-action=close-modal]", closeModal);
  if (reroll) {
    on(modal, "click", "[data-action=reroll-result]", () => {
      closeModal();
      reroll.onClick();
    });
  }
}

// A d20-based check/save/attack with advantage/disadvantage buttons.
// `critMin` (see rollD20 in dice.js) widens the crit range for callers like
// a Champion's weapon attack. `superiorityDie` (Мастер боевых искусств: a
// maneuver like Точная атака adds a superiority die to the ATTACK roll)
// offers a checkbox that adds one extra die to the total and, on confirm,
// calls `onUse()` to spend it from the character's own pool -- this modal
// has no character context of its own, so the caller supplies both the die
// size/remaining count to show and the callback that actually spends one.
// `blessed` (optional) -- true while the "Благословение" toggle (top of the
// sheet, next to Вдохновение барда) is on: adds a к4 to the roll
// automatically, no checkbox, since unlike the superiority die it isn't a
// limited resource the player opts into per-roll.
// `powerAttack` (optional) -- «Мастер большого оружия»/«Стрелок дальнего
// боя»: a checkbox that subtracts `penalty` from the ATTACK roll's modifier
// when checked. The matching damage bonus isn't decided here (this modal
// only rolls a к20) -- `onToggle(checked)` reports the player's choice back
// to the caller so it can remember it (on the attack itself) for the
// damage roll that follows, the same way `a.useSpecial` already persists a
// choice from one roll to the next.
// `forcedDisadvantage` (optional) -- a reason string (e.g. "Истощение 3")
// when a condition already imposes disadvantage on this roll: the plain roll
// becomes a disadvantage roll, and picking advantage instead just cancels the
// two out into a normal roll (PHB: advantage and disadvantage cancel).
export function openD20RollModal({ label, modifier, critMin = 20, superiorityDie = null, blessed = false, powerAttack = null, forcedDisadvantage = "", bonusOptions = [] }) {
  const showDieOption = superiorityDie && superiorityDie.available > 0;
  const html = `
    <h3>${escapeHtml(label)}</h3>
    <p class="muted">Модификатор: ${formatModifier(modifier)}${critMin < 20 ? ` · крит при ${critMin}-20` : ""}</p>
    ${
      showDieOption
        ? `<label class="row" style="gap:8px;align-items:center;margin-bottom:10px;">
      <input type="checkbox" data-superiority-die />
      <span>добавить кость превосходства (к${superiorityDie.sides}) — осталось ${superiorityDie.available}</span>
    </label>`
        : ""
    }
    ${
      powerAttack
        ? `<label class="row" style="gap:8px;align-items:center;margin-bottom:10px;">
      <input type="checkbox" data-power-attack />
      <span>${escapeHtml(powerAttack.label || `-${powerAttack.penalty} к атаке, +10 к урону при попадании`)}</span>
    </label>`
        : ""
    }
    ${(bonusOptions || []).map((o, i) => `<label class="row" style="gap:8px;align-items:center;margin-bottom:10px;"><input type="checkbox" data-bonus-option="${i}" /><span>${escapeHtml(o.label)}</span></label>`).join("")}
    ${forcedDisadvantage ? `<p style="color:var(--red);margin:0 0 10px;">Помеха: ${escapeHtml(forcedDisadvantage)}</p>` : ""}
    <div class="col" style="gap:8px;">
      ${
        forcedDisadvantage
          ? `<button data-mode="disadvantage" class="primary" style="width:100%;">Бросок с помехой</button>
      <button data-mode="normal" style="width:100%;">С преимуществом (гасит помеху) — обычный бросок</button>`
          : `<button data-mode="normal" class="primary" style="width:100%;">Обычный бросок</button>
      <div class="row" style="gap:8px;flex-wrap:nowrap;">
        <button data-mode="disadvantage" style="flex:1;">С помехой</button>
        <button data-mode="advantage" style="flex:1;">С преимуществом</button>
      </div>`
      }
    </div>`;
  const modal = openModal(html);
  on(modal, "click", "[data-mode]", (e, el) => {
    const mode = el.dataset.mode;
    const useDie = showDieOption && modal.querySelector("[data-superiority-die]").checked;
    const usePower = !!(powerAttack && modal.querySelector("[data-power-attack]").checked);
    if (powerAttack) powerAttack.onToggle(usePower);
    let extraBonus = 0;
    (bonusOptions || []).forEach((o, i) => { const cb = modal.querySelector(`[data-bonus-option="${i}"]`); if (cb && cb.checked) extraBonus += o.bonus; });
    const effectiveModifier = modifier - (usePower ? powerAttack.penalty : 0) + extraBonus;
    const r = rollD20({ modifier: effectiveModifier, mode, label, critMin });
    closeModal();
    let detail =
      mode === "normal"
        ? `к20: [${r.first}] ${formatModifier(effectiveModifier)}`
        : `к20: [${r.first}, ${r.second}] → взято ${r.picked} ${formatModifier(effectiveModifier)} (${mode === "advantage" ? "преим." : "помеха"})`;
    let total = r.total;
    if (useDie && superiorityDie.onUse()) {
      const dieRoll = rollDie(superiorityDie.sides);
      total += dieRoll;
      detail += ` + к${superiorityDie.sides}: [${dieRoll}]`;
    }
    if (blessed) {
      const blessRoll = rollDie(4);
      total += blessRoll;
      detail += ` + к4: [${blessRoll}]`;
    }
    showRollResult({ label, detail, total, isCrit: r.isCrit, isFumble: r.isFumble });
  });
}

// A dice-pool builder (add several dice, of any mix of types, then roll them
// all together as one total) plus a custom-expression roller (e.g.
// "2к6+3") for anything the pool picker can't express. The plain "pick one
// die type and roll it" job already lives on the main "Кубики" panel (its
// own dropdown + Бросить button, and the icon itself), so this modal is only
// for the two things that panel can't do.
export function openFreeDiceModal() {
  const diceTypes = [4, 6, 8, 10, 12, 20, 100];
  let pool = []; // array of die side-counts, e.g. [6, 6, 20]

  const renderModal = () => {
    const html = `
      <h3>Кубики</h3>
      <div class="row" style="gap:8px;align-items:flex-end;">
        <div class="col" style="flex:1;">
          <label>Добавить кубик в бросок</label>
          <select data-pool-die>
            ${diceTypes.map((d) => `<option value="${d}" ${d === 20 ? "selected" : ""}>к${d}</option>`).join("")}
          </select>
        </div>
        <button data-action="pool-add">+ Добавить</button>
      </div>
      <div class="dice-pool-list">
        ${
          pool.length
            ? pool.map((sides, i) => `<span class="dice-pool-chip">к${sides}<button data-action="pool-remove" data-index="${i}" title="Убрать">✕</button></span>`).join("")
            : '<p class="muted" style="margin:0;">Кубики пока не добавлены.</p>'
        }
      </div>
      <button data-action="pool-roll" class="primary" ${pool.length ? "" : "disabled"}>Бросить все (${pool.length})</button>
      <div class="row" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
        <div class="col" style="flex:1;">
          <label>Своё выражение (напр. 2к6+3)</label>
          <input type="text" data-custom-expr placeholder="2к6+3" />
        </div>
        <button data-action="roll-custom" class="primary" style="align-self:flex-end;">Бросить</button>
      </div>`;
    const modal = openModal(html);
    on(modal, "click", "[data-action=pool-add]", () => {
      pool.push(Number(modal.querySelector("[data-pool-die]").value));
      renderModal();
    });
    on(modal, "click", "[data-action=pool-remove]", (e, el) => {
      pool.splice(Number(el.dataset.index), 1);
      renderModal();
    });
    on(modal, "click", "[data-action=pool-roll]", () => {
      if (!pool.length) return;
      const rolls = pool.map((sides) => ({ sides, r: rollExpr(`1d${sides}`) }));
      const total = rolls.reduce((sum, x) => sum + x.r.total, 0);
      const detail = rolls.map((x) => `к${x.sides}: [${x.r.rolls[0]}]`).join(", ");
      pool = [];
      closeModal();
      showRollResult({ label: `Бросок ${rolls.length} кубиков`, detail, total });
    });
    on(modal, "click", "[data-action=roll-custom]", () => {
      const input = modal.querySelector("[data-custom-expr]");
      const expr = (input.value || "").trim().replace(/к/gi, "d");
      if (!expr) return;
      try {
        const r = rollExpr(expr);
        closeModal();
        showRollResult({ label: expr, detail: `[${r.rolls.join(", ")}]${r.modifier ? " " + formatModifier(r.modifier) : ""}`, total: r.total });
      } catch (err) {
        input.style.borderColor = "var(--red)";
      }
    });
  };
  renderModal();
}

export function openRollLogModal() {
  import("./dice.js").then(({ getRollLog, clearRollLog }) => {
    const render = () => {
      const log = getRollLog();
      const html = `
        <h3>История бросков</h3>
        <div class="roll-log">
          ${
            log.length
              ? log
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
                  .join("")
              : '<p class="muted">Пока пусто — сделайте бросок.</p>'
          }
        </div>
        <div class="row" style="justify-content:space-between; margin-top:10px;">
          <button data-action="clear-log">Очистить</button>
          <button data-action="close-modal" class="primary">Закрыть</button>
        </div>`;
      const modal = openModal(html);
      on(modal, "click", "[data-action=close-modal]", closeModal);
      on(modal, "click", "[data-action=clear-log]", () => {
        clearRollLog();
        render();
      });
    };
    render();
  });
}
