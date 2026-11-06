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

  game.settings.register(MODULE_ID, "historyLog", {
    name: "LOOT_SPLITTER.Settings.HistoryLog.Name",
    hint: "LOOT_SPLITTER.Settings.HistoryLog.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  registerLootCommand();
});

Hooks.once("ready", () => {
  game.lootSplitter = { app: null };
});

/* ------------------------------------------ */
/*  /loot chat command                         */
/* ------------------------------------------ */

/**
 * Register the /loot chat command.
 * v14+: native registration via ChatLog.CHAT_COMMANDS (intercepting unknown
 *       commands through the chatMessage hook no longer works there).
 * v12–13: fallback to the chatMessage hook.
 */
function registerLootCommand() {
  const ChatLogClass = foundry?.applications?.sidebar?.tabs?.ChatLog ?? globalThis.ChatLog;

  if (ChatLogClass?.CHAT_COMMANDS) {
    ChatLogClass.CHAT_COMMANDS.loot = {
      rgx: /^\/loot(?:\s+.*)?$/,
      fn: async () => {
        openLootSplitter();
        return false; // do not create a chat message from the command itself
      }
    };
  } else {
    Hooks.on("chatMessage", (_chatLog, message, _chatData) => {
      if (!/^\/loot(?:\s|$)/.test(message.trim())) return;
      openLootSplitter();
      return false;
    });
  }
}

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
