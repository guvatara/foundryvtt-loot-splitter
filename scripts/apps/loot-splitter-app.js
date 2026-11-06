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

    root.querySelectorAll("[data-share]").forEach((inp) =>
      inp.addEventListener("change", () => {
        const p = this.participants.find((x) => x.id === inp.dataset.share);
        if (p) p.share = Math.max(0, Number(inp.value) || 0);
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
    const previous = new Map(this.participants.map((p) => [p.id, { selected: p.selected, share: p.share }]));
    this.participants = actors.map((a) => {
      const prev = previous.get(a.id);
      return {
        id: a.id,
        name: a.name,
        img: a.img,
        selected: prev ? prev.selected : true,
        share: prev ? prev.share : 1
      };
    });
  }

  /* ------------------------------------------ */
  /*  Drag & Drop                                */
  /* ------------------------------------------ */

  /** Handle an item dropped into the window. */
  async _onDrop(event) {
    // In v13+ TextEditor lives under foundry.applications.ux; keep the global alias as fallback.
    const TextEditorImpl = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    const data = TextEditorImpl.getDragEventData(event);
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

    /** Recipients with a positive share — the only ones who earn gold. */
    const earners = participants.filter((p) => p.share > 0);
    if (!earners.length) {
      return ui.notifications.warn(game.i18n.localize("LOOT_SPLITTER.Warnings.NoShares"));
    }

    /** @type {Map<string, {actor: Actor, gold: number, items: object[]}>} */
    const assignments = new Map(
      participants.map((p) => [p.id, { actor: game.actors.get(p.id), gold: 0, items: [] }])
    );

    // --- Gold: proportional to shares; remainder goes by largest fractional part.
    if (this.gold > 0) {
      const totalShares = earners.reduce((s, p) => s + p.share, 0);
      const exact = earners.map((p) => (this.gold * p.share) / totalShares);
      const base = exact.map(Math.floor);
      const remainder = this.gold - base.reduce((a, b) => a + b, 0);
      const byFraction = exact
        .map((v, i) => ({ i, frac: v - base[i] }))
        .sort((a, b) => b.frac - a.frac);
      for (let k = 0; k < remainder; k++) base[byFraction[k % byFraction.length].i] += 1;
      earners.forEach((p, i) => {
        assignments.get(p.id).gold = base[i];
      });
    }

    // --- Items: smooth weighted round-robin in "even" mode (zero-share
    // participants get nothing), per-item choice in "manual".
    if (this.mode === "manual") {
      this.items.forEach((entry) => {
        const valid = entry.assigned && participants.some((p) => p.id === entry.assigned);
        const targetId = valid ? entry.assigned : participants[0].id;
        assignments.get(targetId).items.push(entry);
      });
    } else {
      const totalShares = earners.reduce((s, p) => s + p.share, 0);
      const current = new Map(earners.map((p) => [p.id, 0]));
      for (const entry of this.items) {
        let bestId = null;
        for (const p of earners) {
          const v = current.get(p.id) + p.share;
          current.set(p.id, v);
          if (bestId === null || v > current.get(bestId)) bestId = p.id;
        }
        current.set(bestId, current.get(bestId) - totalShares);
        assignments.get(bestId).items.push(entry);
      }
    }

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

    // --- Log: chat + journal history.
    // NB: actions are invoked with this = app instance, so static private
    // helpers must be called through the class name (this.#x would TypeError).
    const content = LootSplitterApp.#buildLogContent(assignments, denom);
    await LootSplitterApp.#postChatLog(content);
    if (game.settings.get(MODULE_ID, "historyLog")) {
      try {
        await LootSplitterApp.#logToJournal(content);
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to write journal history`, err);
      }
    }

    this.items = [];
    this.gold = 0;
    this.render();
  }

  /* ------------------------------------------ */
  /*  Logging (chat + journal)                   */
  /* ------------------------------------------ */

  /** Build the shared HTML summary of a distribution. */
  static #buildLogContent(assignments, denom) {
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

    return `
      <div class="loot-splitter-log">
        <h3><i class="fas fa-coins"></i> ${game.i18n.localize("LOOT_SPLITTER.Chat.Header")}</h3>
        ${entries.join("")}
      </div>`;
  }

  /** Post the distribution summary to the chat. */
  static async #postChatLog(content) {
    const messageData = {
      speaker: { alias: game.i18n.localize("LOOT_SPLITTER.Chat.Alias") },
      content
    };
    const createOptions = {};
    if (game.settings.get(MODULE_ID, "logMode") === "gm") {
      if (foundry.utils.isNewerVersion(game.version, "13")) {
        // v14+: recommended option ("public" | "gm" | "blind" | "self").
        createOptions.messageMode = "gm";
      } else {
        // v12–v13: deprecated-but-working whisper field.
        messageData.whisper = game.users.filter((u) => u.isGM).map((u) => u.id);
      }
    }
    await ChatMessage.create(messageData, createOptions);
  }

  /**
   * Append the distribution summary to the world journal.
   * The journal entry is located (or lazily created) by a module flag;
   * every distribution becomes a separate page named by timestamp.
   */
  static async #logToJournal(content) {
    let journal = game.journal.find((j) => j.getFlag(MODULE_ID, "isHistoryLog"));
    if (!journal) {
      journal = await JournalEntry.create({
        name: game.i18n.localize("LOOT_SPLITTER.Journal.Name"),
        flags: { [MODULE_ID]: { isHistoryLog: true } }
      });
    }
    if (!journal) return;

    const format = CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1;
    await journal.createEmbeddedDocuments("JournalEntryPage", [
      {
        name: new Date().toLocaleString(),
        type: "text",
        text: { content, format }
      }
    ]);
  }
}
