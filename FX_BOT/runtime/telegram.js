/**
 * Consensus FX Sentinel - Telegram formatting, targets, commands and client.
 *
 * Reader-facing language rules, enforced by tests:
 *
 * - No unexplained abbreviations. LONG, SHORT, SL, TP, TP1, TP3, RR, 1R, 3R,
 *   BOS, CHoCH, HTF and LTF never appear as bare words.
 * - BUY and SELL may appear only next to a plain sentence saying what they mean.
 * - No message ever claims the reader made or lost money. The bot knows how the
 *   published setup behaved; it cannot know whether anyone traded it.
 * - In research mode the research label is structural and cannot be suppressed.
 *
 * The client talks to the Bot API directly over HTTPS with `fetch`. No npm
 * Telegram library, no webhook, no listener. Importing this module opens
 * nothing; polling starts only when `startPolling` is called.
 */

"use strict";

const PLAYBOOK_LABELS = Object.freeze({
  P1: "Liquidity Sweep Reversal",
  P2: "Higher Timeframe Breakout and Retest",
  P3: "Trend Pullback",
  P4: "Internal Break of Structure Retest",
  P5: "Range Boundary Rejection",
  P6: "Failed Breakout Trap",
});

const HELP_TEXT = [
  "Consensus FX Sentinel",
  "",
  "/status — check the bot and latest market data",
  "/scan — run one scan now",
  "/results — view tracked setup results",
  "/activate — send future alerts to this chat",
  "/deactivate — stop alerts to this chat",
  "/id — show this chat's ID",
  "/help — show this guide",
].join("\n");

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Reader-safe HTML escaping for anything interpolated into a message. */
function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function directionWords(side) {
  return side === "buy"
    ? { emoji: "🟢", action: "BUY", expectation: "Price is expected to rise" }
    : { emoji: "🔴", action: "SELL", expectation: "Price is expected to fall" };
}

function fmtPrice(value, symbol) {
  return Number(value).toFixed(symbol.precision);
}

const LEG_WORDS = Object.freeze({
  win: "TARGET REACHED",
  loss: "STOP LOSS REACHED",
  pending: "still being monitored",
  void: "no result recorded",
});

// ---------------------------------------------------------------------------
// Entry alert
// ---------------------------------------------------------------------------

/**
 * Build the entry alert.
 *
 * `researchMode` forces the research banner and the "performance is still being
 * measured" wording. There is no code path that produces a live-style message
 * while research mode is on.
 */
function formatEntryAlert({ record, symbol, researchMode = true, newsStatus = "unknown" }) {
  const words = directionWords(record.side);
  const reasons = (record.diagnostics && record.diagnostics.confirmations) || [];
  const top = reasons.slice(0, 3).map((c) => `• ${esc(c.text)}`).join("\n");

  const lines = [
    `${words.emoji} <b>${esc(symbol.display)} — ${words.action}</b>`,
    words.expectation,
    "",
  ];

  if (researchMode) {
    lines.push("<b>RESEARCH SETUP — performance is still being measured</b>");
  }
  lines.push(
    "Price source: Tiingo aggregated foreign exchange data",
    "Setup chart: 5 minutes",
    "Structure checked: 15 minutes and 1 hour",
    "",
    `Entry Price: <code>${fmtPrice(record.entry, symbol)}</code>`,
    `Stop Loss: <code>${fmtPrice(record.stop, symbol)}</code>`,
    `First Profit Target (risked amount equals possible gain): <code>${fmtPrice(record.firstTarget, symbol)}</code>`,
    `Final Profit Target (possible gain is three times the risked amount): <code>${fmtPrice(record.finalTarget, symbol)}</code>`,
    "",
    `Setup type: ${esc(PLAYBOOK_LABELS[record.playbookId] || record.playbookId)}`,
    "Why this setup:",
    top,
    "",
    `Alert ID: <code>${esc(record.id)}</code>`,
  );

  // Never claim a news filter passed when no calendar was loaded.
  if (newsStatus !== "clear") {
    lines.push("", "<b>Note:</b> economic news protection is unavailable, so this setup was not checked against upcoming news events.");
  }

  lines.push(
    "",
    "<i>This alert does not place a trade or read your account. Results use Tiingo "
    + "midpoint candles; your broker's prices and fills can differ.</i>",
  );

  return lines.join("\n");
}

/** Exactly one inline button, using the explicit TradingView symbol map. */
function alertButtons(symbol) {
  return {
    inline_keyboard: [[{
      text: "Open TradingView",
      url: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol.tradingView)}`,
    }]],
  };
}

// ---------------------------------------------------------------------------
// Outcome messages
// ---------------------------------------------------------------------------

function formatOutcome({ event, record, symbol }) {
  const words = directionWords(record.side);
  const head = `<b>${esc(symbol.display)} — ${words.action}</b>`;
  const id = `Alert ID: <code>${esc(record.id)}</code>`;

  if (event.type === "first_target") {
    return [
      "✅ <b>FIRST PROFIT TARGET REACHED</b>",
      "",
      head,
      `Entry Price: <code>${fmtPrice(record.entry, symbol)}</code>`,
      `First Profit Target: <code>${fmtPrice(record.firstTarget, symbol)}</code>`,
      "",
      "The setup reached its first profit target.",
      "The final profit target is still being monitored.",
      "",
      id,
    ].join("\n");
  }

  const first = LEG_WORDS[record.firstLeg] || LEG_WORDS.void;
  const final = LEG_WORDS[record.finalLeg] || LEG_WORDS.void;

  let banner = "⚠️ <b>SETUP MONITORING COMPLETE</b>";
  if (record.firstLeg === "win" && record.finalLeg === "win") {
    banner = "🏆 <b>FINAL PROFIT TARGET REACHED</b>";
  } else if (record.firstLeg === "loss" && record.finalLeg === "loss") {
    banner = "❌ <b>STOP LOSS REACHED</b>";
  }

  return [
    banner,
    "",
    head,
    "",
    `First profit target result: <b>${first}</b>`,
    `Final profit target result: <b>${final}</b>`,
    "",
    id,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Results message
// ---------------------------------------------------------------------------

function fmtR(value) {
  if (value === null || !Number.isFinite(value)) return "not available";
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function fmtRate(value) {
  return value === null ? "not available" : `${value.toFixed(1)}%`;
}

function legBlock(title, leg) {
  if (!leg.resolved) return `<b>${title}</b>\nNo completed setups yet.`;
  return [
    `<b>${title}</b>`,
    `Target reached: <b>${leg.wins}</b>`,
    `Stop loss reached: <b>${leg.losses}</b>`,
    `Success rate: <b>${fmtRate(leg.winRate)}</b>`,
    `Average result after estimated trading costs: <b>${fmtR(leg.netExpectancyR)}</b> times the amount risked`,
    `Independent currency events: <b>${leg.clusterCount}</b> (from ${leg.netSampleSize} costed setups)`,
    `Average per currency event: <b>${fmtR(leg.clusterNetExpectancyR)}</b>`,
    `Statistical confidence (t-statistic): <b>${leg.tStatistic === null ? "not enough data" : leg.tStatistic.toFixed(2)}</b>`,
  ].join("\n");
}

/**
 * Owner-only shadow report.
 *
 * These setups were withheld by a judgement gate and never sent to anyone. The
 * point is to find out whether the gate is helping - the current live
 * diagnostic rejected 24 of 25 candidates, almost all for structural room, and
 * without this evidence there is no way to tell whether that is protection or
 * self-sabotage.
 */
function formatShadowResults(summary) {
  if (!summary || !summary.total) {
    return "<b>Consensus FX Sentinel — Withheld setups</b>\n\n"
      + "Nothing has been withheld yet.";
  }
  const lines = [
    "<b>Consensus FX Sentinel — Withheld setups</b>",
    "",
    "These setups were never sent to anyone. They are measured only to check",
    "whether the rule that withheld them is helping or hurting.",
    "",
    `Total withheld: <b>${summary.total}</b>`,
    "",
    "<b>By reason for withholding</b>",
  ];
  for (const row of Object.values(summary.byReason)) {
    lines.push(
      `${esc(row.key)}: <b>${row.total}</b> withheld, ${row.lifecycle.complete} completed, `
      + `first target ${fmtRate(row.firstLeg.winRate)} (gross ${fmtR(row.firstLeg.grossExpectancyR)}, `
      + `net ${fmtR(row.firstLeg.netExpectancyR)}); `
      + `final target ${fmtRate(row.finalLeg.winRate)} (gross ${fmtR(row.finalLeg.grossExpectancyR)}, `
      + `net ${fmtR(row.finalLeg.netExpectancyR)}); `
      + `${row.firstLeg.clusterCount} first-target independent event(s), `
      + `confidence ${row.firstLeg.tStatistic === null ? "not enough data" : row.firstLeg.tStatistic.toFixed(2)}`
      + (row.unknownCost ? `, ${row.unknownCost} with unknown cost` : ""),
    );
  }
  lines.push("", "<b>By setup type</b>");
  for (const row of Object.values(summary.byPlaybook)) {
    lines.push(
      `${esc(row.key)}: <b>${row.total}</b> withheld, ${row.lifecycle.complete} completed, `
      + `first target ${fmtRate(row.firstLeg.winRate)}, `
      + `gross ${fmtR(row.firstLeg.grossExpectancyR)}, net ${fmtR(row.firstLeg.netExpectancyR)}, `
      + `${row.firstLeg.clusterCount} independent event(s)`,
    );
  }
  lines.push(
    "",
    "<i>Withheld setups are research only. They were never published and are "
    + "never mixed into the published results.</i>",
  );
  return lines.join("\n");
}

function formatResults(summary) {
  const life = summary.lifecycle;
  const lines = [
    "<b>Consensus FX Sentinel — Results</b>",
    "",
    `Mode: <b>${summary.alertMode === "research" ? "Research (measuring only)" : "Normal"}</b>`,
    `Settings fingerprint: <code>${esc(summary.configHash || "unknown")}</code>`,
    "",
    `Total setups published: <b>${summary.uniquePlans}</b>`,
    `Independent currency events: <b>${summary.exposureClusters ?? "not recorded"}</b>`,
    `Waiting for entry price: <b>${life.pending_entry}</b>`,
    `Entered and still being monitored: <b>${life.entered_unresolved}</b>`,
    `Cancelled before entry: <b>${life.cancelled_before_entry}</b>`,
    `Expired without a result: <b>${life.expired}</b>`,
    `Completed setups: <b>${life.complete}</b>`,
    `Setups with incomplete market data: <b>${life.dataGaps}</b>`,
    "",
    legBlock("First Profit Target (risked amount equals possible gain)", summary.firstLeg),
    `First-target verdict: <b>${summary.firstVerdict || "insufficient evidence"}</b>`,
    "",
    legBlock("Final Profit Target (possible gain is three times the risked amount)", summary.finalLeg),
    `Final-target verdict: <b>${summary.finalVerdict || "insufficient evidence"}</b>`,
    "",
    "<i>A t-statistic above 2 is stronger evidence that the result may not be random.</i>",
    "",
    // The trial must be allowed to say it does not know yet.
    `Overall verdict so far: <b>${summary.verdict || "insufficient evidence"}</b>`,
  ];

  if (summary.legacyCount || summary.otherCohortCount) {
    lines.push(
      "",
      `<i>${summary.legacyCount || 0} legacy and ${summary.otherCohortCount || 0} older-cohort `
      + "setup(s) are excluded from the active figures above.</i>",
    );
  }

  const cohorts = Object.values(summary.playbooks);
  if (cohorts.length) {
    lines.push("", "<b>By setup type</b>");
    for (const cohort of cohorts) {
      lines.push(
        `${esc(cohort.playbookName)}: `
        + `${cohort.lifecycle.complete} completed, `
        + `first target ${fmtRate(cohort.firstLeg.winRate)}, `
        + `final target ${fmtRate(cohort.finalLeg.winRate)}`,
      );
    }
  }

  lines.push(
    "",
    "<i>These figures describe published setups measured on Tiingo prices. "
    + "They are not a record of anyone's trading account.</i>",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Target registry
// ---------------------------------------------------------------------------

/**
 * Activated chats. IDs are stored as strings so large Telegram IDs survive
 * JSON round-trips without precision loss.
 */
function createTargets(store, seedChatId) {
  const state = store.load();
  let chatIds = Array.isArray(state.chatIds) ? state.chatIds.map(String) : [];

  // Seed from configuration on first start only; later removals must stick.
  if (!state.seeded && seedChatId) {
    if (!chatIds.includes(String(seedChatId))) chatIds.push(String(seedChatId));
    store.save({ chatIds, seeded: true });
  }

  return {
    list() {
      return [...chatIds];
    },
    has(chatId) {
      return chatIds.includes(String(chatId));
    },
    add(chatId) {
      const id = String(chatId);
      if (chatIds.includes(id)) return false;
      chatIds.push(id);
      store.save({ chatIds, seeded: true });
      return true;
    },
    remove(chatId) {
      const id = String(chatId);
      if (!chatIds.includes(id)) return false;
      chatIds = chatIds.filter((c) => c !== id);
      store.save({ chatIds, seeded: true });
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const OWNER_ONLY = new Set(["scan", "activate", "deactivate", "withheld"]);

function parseCommand(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^\/([a-z_]+)(?:@[\w_]+)?(?:\s+(.*))?$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] || "").trim() };
}

/**
 * Route one update. Pure: returns the reply to send, performs no I/O beyond the
 * target registry the caller supplied.
 */
function handleCommand({ update, targets, ownerUserId, statusText, resultsText, shadowText, onScan }) {
  const message = update && update.message;
  if (!message || !message.chat) return null;
  const command = parseCommand(message.text);
  if (!command) return null;

  const chatId = String(message.chat.id);
  const fromId = message.from ? String(message.from.id) : null;
  const isOwner = Boolean(ownerUserId) && fromId === String(ownerUserId);

  if (OWNER_ONLY.has(command.name) && !isOwner) {
    // Minimal response. Never expose target lists or configuration.
    return { chatId, text: "This command is not available." };
  }

  switch (command.name) {
    case "start":
    case "help":
      return { chatId, text: HELP_TEXT };
    case "id":
      // Answers without storing the chat.
      return { chatId, text: `This chat's ID is <code>${esc(chatId)}</code>` };
    case "activate": {
      const added = targets.add(chatId);
      return {
        chatId,
        text: added
          ? "Alerts are now switched on for this chat."
          : "Alerts were already switched on for this chat.",
      };
    }
    case "deactivate": {
      const removed = targets.remove(chatId);
      return {
        chatId,
        text: removed
          ? "Alerts are now switched off for this chat."
          : "Alerts were not switched on for this chat.",
      };
    }
    case "status":
      return { chatId, text: statusText ? statusText() : "Status is unavailable." };
    case "results":
      return { chatId, text: resultsText ? resultsText() : "No results yet." };
    case "withheld":
      // Owner-only research view. Shadow setups were never sent to anyone.
      return { chatId, text: shadowText ? shadowText() : "No withheld setups yet." };
    case "scan":
      return {
        chatId,
        text: "Scan request received. It will run only when the market-data allowance permits it.",
        scan: onScan || null,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Bot API client
// ---------------------------------------------------------------------------

class TelegramConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelegramConflictError";
    this.fatal = true;
  }
}

/**
 * Minimal Bot API client.
 *
 * A 409 is fatal by design: two processes polling the same token would silently
 * split updates between them, so a second instance must stop rather than
 * compete.
 */
function createTelegramClient({ token, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, payload, { pollTimeoutMs = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), pollTimeoutMs);
    try {
      const response = await fetchImpl(`${base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      });
      if (response.status === 409) {
        throw new TelegramConflictError(
          "Telegram reported a polling conflict (409). Another instance is already "
          + "polling this bot token. Stop it before starting this one.",
        );
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok !== true) {
        // Never include the URL: it carries the token.
        const description = data && data.description ? data.description : `HTTP ${response.status}`;
        throw new Error(`Telegram ${method} failed: ${description}`);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async sendMessage(chatId, text, extra = {}) {
      return call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      });
    },
    async getUpdates(offset, pollSeconds = 25) {
      return call(
        "getUpdates",
        { offset, timeout: pollSeconds, allowed_updates: ["message"] },
        { pollTimeoutMs: (pollSeconds + 10) * 1000 },
      );
    },
  };
}

module.exports = {
  HELP_TEXT,
  LEG_WORDS,
  OWNER_ONLY,
  PLAYBOOK_LABELS,
  TelegramConflictError,
  alertButtons,
  createTargets,
  formatShadowResults,
  createTelegramClient,
  directionWords,
  esc,
  formatEntryAlert,
  formatOutcome,
  formatResults,
  handleCommand,
  parseCommand,
};
