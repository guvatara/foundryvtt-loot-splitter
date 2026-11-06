const MODULE_ID = "loot-splitter";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Loot Splitter window.
 *
 * The GM drags items and enters a gold amount, picks the recipient
 * characters, and the module hands out the loot — evenly or by manual
 * assignment — and writes a summary to the chat log.
 */
export class LootSplitterApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Items dropped into the window: {id, uuid, name, img, data, assigned}. */
  items = [];

  /** Gold to split. */
  gold = 0;

  /** Distribution mode: "even" | "manual". */
  mode = "even";

  /** Recipient actors: {id, name, img, selected}. */
  participants = [];

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "loot-splitter",
    tag: "form",
    window: {
      title: "LOOT_SPLITTER.App.Title",
      icon: "fas fa-coins",
      resizable: true
    },
    position: { width: 620 },
    actions: {
      distribute: LootSplitterApp.#onDistribute,
      removeItem: LootSplitterApp.#onRemoveItem,
      clearAll: LootSplitterApp.#onClearAll
    },
    dragDrop: [{ dropSelector: "[data-drop-area]" }]
  };

  /** @override */
  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/loot-splitter.hbs` }
  };

  /* ------------------------------------------ */
  /*  Rendering                                  */
  /* ------------------------------------------ */

  /** @override */
  async _prepareContext(_options) {
    this.#refreshParticipants();
    const selected = this.participants.filter((p) => p.selected);
    return {
      items: this.items,
      gold: this.gold,
      mode: this.mode,
      modeChoices: {
        even: game.i18n.localize("LOOT_SPLITTER.Mode.Even"),
        manual: game.i18n.localize("LOOT_SPLITTER.Mode.Manual")
      },
      isManual: this.mode === "manual",
      participants: this.participants,
      participantOptions: selected.map((p) => ({ value: p.id, label: p.name }))
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;

    root.addEventListener("submit", (ev) => ev.preventDefault());

    root.querySelector('[name="gold"]')?.addEventListener("change", (ev) => {
      this.gold = Math.max(0, Math.floor(Number(ev.target.value) || 0));
    });

    root.querySelector('[name="mode"]')?.addEventListener("change", (ev) => {
      this.mode = ev.target.value === "manual" ? "manual" : "even";
      this.render();
    });

    root.querySelectorAll("[data-participant]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const p = this.participants.find((x) => x.id === cb.dataset.participant);
        if (p) p.selected = cb.checked;
        if (this.mode === "manual") this.render();
      })
    );

    root.querySelectorAll("[data-assign]").forEach((sel) =>
      sel.addEventListener("change", () => {
        const item = this.items.find((i) => i.id === sel.dataset.assign);
        if (item) item.assigned = sel.value;
      })
    );
  }

  /**
   * Rebuild the participant list from player-owned actors, preserving
   * previous selections where possible.
   */
  #refreshParticipants() {
    let actors = game.actors.filter((a) => a.hasPlayerOwner && a.type === "character");
    if (!actors.length) actors = game.actors.filter((a) => a.hasPlayerOwner);
    const previous = new Map(this.participants.map((p) => [p.id, p.selected]));
    this.participants = actors.map((a) => ({
      id: a.id,
      name: a.name,
      img: a.img,
      selected: previous.has(a.id) ? previous.get(a.id) : true
    }));
  }

  /* ------------------------------------------ */
  /*  Drag & Drop                                */
  /* ------------------------------------------ */

  /** Handle an item dropped into the window. */
  async _onDrop(event) {
    const data = TextEditor.getDragEventData(event);
    if (data?.type !== "Item") return;
    const item = await getDocumentClass("Item").fromDropData(data);
    if (!item) return;
    this.items.push({
      id: foundry.utils.randomID(),
      uuid: item.uuid ?? null,
      name: item.name,
      img: item.img,
      data: item.toObject(),
      assigned: null
    });
    this.render();
  }

  /* ------------------------------------------ */
  /*  Actions                                    */
  /* ------------------------------------------ */

  static #onRemoveItem(_event, target) {
    const id = target.dataset.itemId;
    this.items = this.items.filter((i) => i.id !== id);
    this.render();
  }

  static #onClearAll(_event, _target) {
    this.items = [];
    this.gold = 0;
    this.render();
  }

  static async #onDistribute(_event, _target) {
    const participants = this.participants.filter((p) => p.selected);
    if (!participants.length) {
      return ui.notifications.warn(game.i18n.localize("LOOT_SPLITTER.Warnings.NoParticipants"));
    }
    if (!this.items.length && this.gold <= 0) {
      return ui.notifications.warn(game.i18n.localize("LOOT_SPLITTER.Warnings.NothingToDistribute"));
    }

    const denom = game.settings.get(MODULE_ID, "currencyDenomination");

    /** @type {Map<string, {actor: Actor, gold: number, items: object[]}>} */
    const assignments = new Map(
      participants.map((p) => [p.id, { actor: game.actors.get(p.id), gold: 0, items: [] }])
    );

    // --- Gold: split evenly, remainder coins go one-by-one from the top.
    if (this.gold > 0) {
      const share = Math.floor(this.gold / participants.length);
      let remainder = this.gold - share * participants.length;
      for (const p of participants) {
        let g = share;
        if (remainder > 0) {
          g += 1;
          remainder -= 1;
        }
        assignments.get(p.id).gold = g;
      }
    }

    // --- Items: round-robin in "even" mode, per-item choice in "manual".
    this.items.forEach((entry, index) => {
      let targetId;
      if (this.mode === "manual") {
        const valid = entry.assigned && participants.some((p) => p.id === entry.assigned);
        targetId = valid ? entry.assigned : participants[0].id;
      } else {
        targetId = participants[index % participants.length].id;
      }
      assignments.get(targetId).items.push(entry);
    });

    // --- Apply the changes.
    for (const [, a] of assignments) {
      if (!a.actor) continue;

      if (a.gold > 0) {
        const path = `system.currency.${denom}`;
        if (foundry.utils.hasProperty(a.actor, path)) {
          const current = Number(foundry.utils.getProperty(a.actor, path)) || 0;
          await a.actor.update({ [path]: current + a.gold });
        } else {
          ui.notifications.warn(
            game.i18n.format("LOOT_SPLITTER.Warnings.NoCurrency", { name: a.actor.name })
          );
        }
      }

      if (a.items.length) {
        const docs = a.items.map((entry) => {
          const d = foundry.utils.deepClone(entry.data);
          delete d._id;
          return d;
        });
        await a.actor.createEmbeddedDocuments("Item", docs);
      }
    }

    await this.#logDistribution(assignments, denom);

    this.items = [];
    this.gold = 0;
    this.render();
  }

  /* ------------------------------------------ */
  /*  Chat log                                   */
  /* ------------------------------------------ */

  static async #logDistribution(assignments, denom) {
    const entries = [];
    for (const [, a] of assignments) {
      if (!a.actor) continue;
      const goldPart = a.gold > 0 ? ` — ${a.gold} ${denom}` : "";
      const itemsPart = a.items.length
        ? `<ul>${a.items
            .map((i) => `<li><img src="${i.img}" alt="" width="20" height="20"> ${i.name}</li>`)
            .join("")}</ul>`
        : "";
      entries.push(
        `<div class="loot-splitter-entry"><strong>${a.actor.name}</strong>${goldPart}${itemsPart}</div>`
      );
    }

    const content = `
      <div class="loot-splitter-log">
        <h3><i class="fas fa-coins"></i> ${game.i18n.localize("LOOT_SPLITTER.Chat.Header")}</h3>
        ${entries.join("")}
      </div>`;

    const messageData = {
      speaker: { alias: game.i18n.localize("LOOT_SPLITTER.Chat.Alias") },
      content
    };
    if (game.settings.get(MODULE_ID, "logMode") === "gm") {
      messageData.whisper = ChatMessage.getWhisperRecipients("GM");
    }
    await ChatMessage.create(messageData);
  }
}
