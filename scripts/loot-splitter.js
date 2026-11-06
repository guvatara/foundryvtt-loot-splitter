import { LootSplitterApp } from "./apps/loot-splitter-app.js";

export const MODULE_ID = "loot-splitter";

/* ------------------------------------------ */
/*  Settings                                   */
/* ------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "logMode", {
    name: "LOOT_SPLITTER.Settings.LogMode.Name",
    hint: "LOOT_SPLITTER.Settings.LogMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      public: "LOOT_SPLITTER.Settings.LogMode.Public",
      gm: "LOOT_SPLITTER.Settings.LogMode.GM"
    },
    default: "public"
  });

  game.settings.register(MODULE_ID, "currencyDenomination", {
    name: "LOOT_SPLITTER.Settings.Denomination.Name",
    hint: "LOOT_SPLITTER.Settings.Denomination.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "gp"
  });
});

Hooks.once("ready", () => {
  game.lootSplitter = { app: null };
});

/* ------------------------------------------ */
/*  Scene control button                       */
/* ------------------------------------------ */

function openLootSplitter() {
  if (!game.user.isGM) {
    return ui.notifications.warn(game.i18n.localize("LOOT_SPLITTER.Warnings.OnlyGM"));
  }
  if (!game.lootSplitter.app) game.lootSplitter.app = new LootSplitterApp();
  game.lootSplitter.app.render({ force: true });
}

Hooks.on("getSceneControlButtons", (controls) => {
  if (Array.isArray(controls)) {
    // Foundry VTT v12 and earlier: controls is an Array.
    const tokens = controls.find((c) => c.name === "token");
    tokens?.tools.push({
      name: "loot-splitter",
      title: "LOOT_SPLITTER.Controls.Title",
      icon: "fas fa-coins",
      button: true,
      onClick: () => openLootSplitter()
    });
  } else {
    // Foundry VTT v13+: controls is an object keyed by control name.
    const tokens = controls.tokens;
    if (!tokens) return;
    tokens.tools["loot-splitter"] = {
      name: "loot-splitter",
      title: "LOOT_SPLITTER.Controls.Title",
      icon: "fas fa-coins",
      order: Object.keys(tokens.tools).length,
      button: true,
      visible: game.user.isGM,
      onChange: (_event, active) => {
        if (active) openLootSplitter();
      }
    };
  }
});
