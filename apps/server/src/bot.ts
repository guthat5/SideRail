import https from "node:https";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { db, getSetting, setSetting } from "./db.js";
import { exportData } from "./backup.js";
import {
  createUser,
  getUser,
  listUsers,
  setUserEnabled,
  isUserActive,
  summarize,
} from "./users.js";
import { buildUserLinks } from "./links.js";
import { restartCore, isRunning } from "./core.js";
import { getSystemStats } from "./system.js";
import { logActivity } from "./activity.js";
import type { Inbound, UserWithInbounds } from "./types.js";

interface TgResult {
  ok: boolean;
  description?: string;
  result?: unknown;
}

function apiCall(token: string, method: string, payload: Record<string, unknown>): Promise<TgResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as TgResult);
          } catch {
            resolve({ ok: false, description: "invalid response" });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, description: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, description: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

function sendDocument(
  token: string,
  chatId: string,
  filename: string,
  content: string,
  caption: string,
): Promise<TgResult> {
  return new Promise((resolve) => {
    const boundary = `----SideRail${Date.now()}`;
    const parts: Buffer[] = [];
    const push = (s: string) => parts.push(Buffer.from(s, "utf8"));

    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="chat_id"\r\n\r\n');
    push(`${chatId}\r\n`);

    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="caption"\r\n\r\n');
    push(`${caption}\r\n`);

    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="parse_mode"\r\n\r\n');
    push(`HTML\r\n`);

    push(`--${boundary}\r\n`);
    push(
      `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        "Content-Type: application/json\r\n\r\n",
    );
    push(content);
    push(`\r\n--${boundary}--\r\n`);

    const payload = Buffer.concat(parts);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendDocument`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.length,
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as TgResult);
          } catch {
            resolve({ ok: false, description: "invalid response" });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, description: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, description: "timeout" });
    });
    req.write(payload);
    req.end();
  });
}

export interface BotConfig {
  enabled: boolean;
  token: string;
  chatIds: string[];
  dailyBackup: boolean;
}

export function getBotConfig(): BotConfig {
  return {
    enabled: getSetting("bot_enabled") === "1",
    token: getSetting("bot_token") || "",
    chatIds: JSON.parse(getSetting("bot_chat_ids") || "[]") as string[],
    dailyBackup: getSetting("bot_daily_backup") !== "0",
  };
}

export function saveBotConfig(cfg: Partial<BotConfig>): void {
  if (cfg.enabled !== undefined) setSetting("bot_enabled", cfg.enabled ? "1" : "0");
  if (cfg.token !== undefined) setSetting("bot_token", cfg.token.trim());
  if (cfg.chatIds !== undefined)
    setSetting("bot_chat_ids", JSON.stringify(cfg.chatIds.map((c) => c.trim()).filter(Boolean)));
  if (cfg.dailyBackup !== undefined) setSetting("bot_daily_backup", cfg.dailyBackup ? "1" : "0");
}

export async function broadcast(html: string): Promise<void> {
  const cfg = getBotConfig();
  if (!cfg.enabled || !cfg.token || cfg.chatIds.length === 0) return;
  for (const chatId of cfg.chatIds) {
    await apiCall(cfg.token, "sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}

export async function testBot(
  token: string,
  chatIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!token || chatIds.length === 0) return { ok: false, error: "token and chat id required" };
  const message =
    "<b>✅ SideRail bot connected</b>\n\n" +
    '🔗 <a href="https://github.com/icubaby/SideRail">github.com/icubaby/SideRail</a>\n\n' +
    "⭐️ If you enjoy the project, please give it a star — it means a lot!";
  let anyOk = false;
  let lastError = "";
  for (const chatId of chatIds) {
    const res = await apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    });
    if (res.ok) anyOk = true;
    else lastError = res.description || "failed";
  }
  return anyOk ? { ok: true } : { ok: false, error: lastError };
}

export async function sendDailyBackup(): Promise<void> {
  const cfg = getBotConfig();
  if (!cfg.enabled || !cfg.token || cfg.chatIds.length === 0 || !cfg.dailyBackup) return;
  const data = JSON.stringify(exportData(), null, 2);
  const date = new Date().toISOString().slice(0, 10);
  const caption =
    "<b>🗄 SideRail daily backup</b>\n" +
    `<b>Date:</b> ${date}\n` +
    "Keep this file safe — you can restore it from the dashboard.";
  for (const chatId of cfg.chatIds) {
    await sendDocument(cfg.token, chatId, `siderail-backup-${date}.json`, data, caption);
  }
}

// ---------------------------------------------------------------------------
// Telegram bot: user menu, credits, admin panel
// ---------------------------------------------------------------------------

// Keys are sold in these packages. sizes = GB per key.
export const KEY_PACKAGES: Record<string, { label: string; credits: number; sizes: number[] }> = {
  p500: { label: "500 MB · 1 key", credits: 1, sizes: [0.5] },
  p1gb: { label: "1 GB · 1 key", credits: 3, sizes: [1] },
  p3gb: { label: "3 GB · 1 key", credits: 5, sizes: [3] },
  p2x250: { label: "250 MB × 2 keys", credits: 5, sizes: [0.25, 0.25] },
};

const PAGE = 8;

type Btn = {
  text: string;
  callback_data?: string;
  url?: string;
  style?: "primary" | "success" | "danger";
};
type Markup = { inline_keyboard: Btn[][] };

/** Colour per button: green = buy/join, red = destructive, blue = normal, grey = back. */
function styleFor(b: Btn): Btn["style"] {
  if (b.url) return "success";
  if (b.text.startsWith("⬅️")) return undefined;
  const d = b.callback_data || "";
  if (d === "check:join" || d === "menu:buy" || d.startsWith("buy:") || d.startsWith("adm:gv:")) return "success";
  if (d === "adm:revoke" || d === "adm:server:restart" || d.startsWith("adm:t:")) return "danger";
  return "primary";
}
const kb = (rows: Btn[][]): Markup => ({
  inline_keyboard: rows.map((r) =>
    r.map((b) => {
      const st = styleFor(b);
      return st ? { ...b, style: st } : b;
    }),
  ),
});

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  from?: TgUser;
}
interface TgCallback {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

interface BotUserRow {
  chat_id: string;
  credits: number;
  referred_by: string | null;
  created_at: number;
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pollOffset = 0;
let botUsername = "";

// ---- admin text input: after pressing a button, the next message is the answer ----
const pending = new Map<string, { action: string; expires: number }>();

function setPending(chatId: string, action: string): void {
  pending.set(chatId, { action, expires: Date.now() + 5 * 60_000 });
}

function takePending(chatId: string): string | null {
  const p = pending.get(chatId);
  pending.delete(chatId);
  if (!p || p.expires < Date.now()) return null;
  return p.action;
}

// ---- settings (editable from the admin panel, with defaults) ----
function numSetting(key: string, def: number): number {
  const raw = getSetting(key);
  const v = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) ? v : def;
}
const newUserCredits = () => Math.max(0, Math.floor(numSetting("bot_new_user_credits", 5)));
const keyDays = () => Math.max(1, Math.floor(numSetting("bot_key_days", 3)));
const referralBonus = () => Math.max(0, Math.floor(numSetting("bot_referral_bonus", 5)));
const DEFAULT_CHANNEL = "@arsar2027";
const channelSetting = (): string => {
  const raw = getSetting("bot_channel");
  return raw === null ? DEFAULT_CHANNEL : raw.trim();
};

function ensureBotTables(): void {
  db.exec("CREATE TABLE IF NOT EXISTS bot_paused (user_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_users (
      chat_id TEXT PRIMARY KEY,
      credits INTEGER NOT NULL DEFAULT 0,
      referred_by TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

function enabledInbounds(): Inbound[] {
  return db.prepare("SELECT * FROM inbounds WHERE enabled = 1").all() as unknown as Inbound[];
}

// ---- bot user storage ----
/** Creates the user with the new-user credit. Returns true when newly created. */
function registerBotUser(chatId: string, referrer: string | null): boolean {
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO bot_users (chat_id, credits, referred_by, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(chatId, newUserCredits(), referrer, Date.now());
  return info.changes > 0;
}

function botUserRow(chatId: string): BotUserRow | undefined {
  return db
    .prepare("SELECT chat_id, credits, referred_by, created_at FROM bot_users WHERE chat_id = ?")
    .get(chatId) as unknown as BotUserRow | undefined;
}

function allBotUsers(): BotUserRow[] {
  return db
    .prepare("SELECT chat_id, credits, referred_by, created_at FROM bot_users ORDER BY created_at DESC")
    .all() as unknown as BotUserRow[];
}

function getCredits(chatId: string): number {
  return botUserRow(chatId)?.credits ?? 0;
}

function addCredits(chatId: string, n: number): void {
  registerBotUser(chatId, null);
  db.prepare("UPDATE bot_users SET credits = credits + ? WHERE chat_id = ?").run(n, chatId);
}

/** Atomic check-and-deduct, so two taps can't spend the same credits twice. */
function spendCredits(chatId: string, n: number): boolean {
  const info = db
    .prepare("UPDATE bot_users SET credits = credits - ? WHERE chat_id = ? AND credits >= ?")
    .run(n, chatId, n);
  return info.changes > 0;
}

function referralCount(chatId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM bot_users WHERE referred_by = ?").get(chatId) as {
      c: number;
    }
  ).c;
}

function totals(): { users: number; credits: number } {
  const r = db.prepare("SELECT COALESCE(SUM(credits), 0) AS s, COUNT(*) AS c FROM bot_users").get() as {
    s: number;
    c: number;
  };
  return { users: r.c, credits: r.s };
}

/** Panel keys that belong to this Telegram chat. */
function keysOf(chatId: string): UserWithInbounds[] {
  return listUsers().filter((u) => u.telegram_id === chatId);
}

// ---- Telegram helpers ----
async function tgCall(token: string, method: string, payload: Record<string, unknown>): Promise<TgResult> {
  let res = await apiCall(token, method, payload);
  const markup = payload.reply_markup as Markup | undefined;
  if (!res.ok && markup && /button|style|markup|keyboard/i.test(res.description || "")) {
    const plain: Markup = {
      inline_keyboard: markup.inline_keyboard.map((r) => r.map(({ style: _style, ...b }) => b)),
    };
    res = await apiCall(token, method, { ...payload, reply_markup: plain });
  }
  return res;
}

async function sendText(token: string, chatId: string, html: string, markup?: Markup): Promise<void> {
  await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(markup ? { reply_markup: markup } : {}),
  });
}

async function editText(
  token: string,
  chatId: string,
  messageId: number,
  html: string,
  markup: Markup,
): Promise<void> {
  await tgCall(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: markup,
  });
}

async function showMsg(
  token: string,
  chatId: string,
  mid: number | undefined,
  html: string,
  markup: Markup,
): Promise<void> {
  if (mid) await editText(token, chatId, mid, html, markup);
  else await sendText(token, chatId, html, markup);
}

function pageNav(prefix: string, p: number, pages: number): Btn[] {
  const nav: Btn[] = [];
  if (p > 0) nav.push({ text: "⬅️", callback_data: `${prefix}${p - 1}` });
  nav.push({ text: `${p + 1}/${pages}`, callback_data: `${prefix}${p}` });
  if (p < pages - 1) nav.push({ text: "➡️", callback_data: `${prefix}${p + 1}` });
  return nav;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

const isAdminChat = (chatId: string): boolean => getBotConfig().chatIds.includes(chatId);

function userStatusIcon(u: UserWithInbounds): string {
  if (!u.enabled) return "⛔";
  if (!isUserActive(u)) return "⌛";
  return u.online ? "🟢" : "✅";
}

const expiryText = (u: UserWithInbounds) =>
  u.expire_at ? new Date(u.expire_at).toISOString().slice(0, 10) : "∞";

// ---- keys ----
function fmtSize(gb: number): string {
  return gb >= 1 ? `${gb} GB` : `${Math.round(gb * 1024)} MB`;
}

async function sendKeyLinks(token: string, chatId: string, user: UserWithInbounds): Promise<void> {
  const host = config.publicDomain;
  if (!host) {
    await sendText(token, chatId, "⚠️ <code>PUBLIC_DOMAIN</code> မသတ်မှတ်ရသေးပါ။ Admin ကို ပြောပါ။");
    return;
  }
  const links = buildUserLinks(host, user, enabledInbounds());
  if (links.length === 0) {
    await sendText(token, chatId, "⚠️ ဤ key အတွက် config မရှိသေးပါ။ Admin ကို ပြောပါ။");
    return;
  }
  const rows: Btn[][] = links.map((l, i) => [{ text: `🔗 ${l.tag}`.slice(0, 60), callback_data: `cfg:${user.id}:${i}` }]);
  rows.push([{ text: "⬅️ Back", callback_data: "menu:keys" }]);
  await sendText(
    token,
    chatId,
    `🔐 <b>${escHtml(user.email)}</b>\nသုံးချင်တဲ့ config ကို ရွေးပါ။ Code ပေါ်လာရင် နှိပ်ပြီး Copy ကူးပါ။`,
    kb(rows),
  );
}

/** Creates one key per size and sends it. Caller validates host/inbounds first. */
async function sendKeys(token: string, chatId: string, sizes: number[], days: number, label: string) {
  const inbounds = enabledInbounds();
  const inboundIds = inbounds.map((ib) => ib.id);
  const created = sizes.map((size) => {
    const name = `Turbo key-${randomBytes(3).toString("hex")}`;
    const user = createUser({
      email: name,
      dataLimit: size,
      expireDays: days,
      telegramId: chatId,
      comment: `bot: ${label}`,
      inboundIds,
      createdBy: null,
    });
    return { name, size, user };
  });
  restartCore();

  for (const [i, k] of created.entries()) {
    await sendText(
      token,
      chatId,
      `✅ <b>${escHtml(label)}</b>${sizes.length > 1 ? ` (${i + 1}/${sizes.length})` : ""}\n` +
        `<b>Name:</b> <code>${escHtml(k.name)}</code>\n` +
        `<b>Data:</b> ${fmtSize(k.size)}\n<b>Days:</b> ${days}`,
    );
    await sendKeyLinks(token, chatId, k.user);
  }
}

async function handleBuy(token: string, chatId: string, pkgId: string): Promise<void> {
  const member = isAdminChat(chatId) ? true : await isMember(token, chatId);
  if (member === false) {
    await sendText(token, chatId, joinText(), joinMarkup());
    return;
  }
  if (member === null) {
    await sendText(token, chatId, "⚠️ Channel check မရနိုင်သေးပါ။ ခဏနေ ပြန်ကြိုးစားပါ။");
    return;
  }
  const pkg = KEY_PACKAGES[pkgId];
  if (!pkg) {
    await sendText(token, chatId, "❌ Package မတွေ့ပါ။");
    return;
  }
  if (!config.publicDomain) {
    await sendText(token, chatId, "⚠️ Server မှာ <code>PUBLIC_DOMAIN</code> မသတ်မှတ်ရသေးပါ။ Admin ကို ပြောပါ။");
    return;
  }
  if (enabledInbounds().length === 0) {
    await sendText(token, chatId, "⚠️ ရောင်းလို့ရတဲ့ inbound မရှိသေးပါ။ Admin ကို ပြောပါ။");
    return;
  }
  if (!spendCredits(chatId, pkg.credits)) {
    await sendText(
      token,
      chatId,
      `❌ Credit မလုံလောက်ပါ။\nလိုအပ်: <b>${pkg.credits}</b> · ရှိ: <b>${getCredits(chatId)}</b>`,
      userHomeMarkup(chatId),
    );
    return;
  }
  try {
    await sendKeys(token, chatId, pkg.sizes, keyDays(), pkg.label);
  } catch (e) {
    console.error("[bot] buy failed, refunding:", e);
    addCredits(chatId, pkg.credits);
    await sendText(token, chatId, "⚠️ Key ထုတ်မရပါ။ Credit ကို ပြန်ထည့်ပေးပြီးပါပြီ။");
  }
}

// ---- channel gate ----
const JOINED_STATUSES = new Set(["creator", "administrator", "member", "restricted"]);

/** true = member, false = not a member, null = check unavailable (e.g. bot is not admin in the channel). */
async function isMember(token: string, userId: string): Promise<boolean | null> {
  const ch = channelSetting();
  if (!ch) return true;
  const res = await apiCall(token, "getChatMember", { chat_id: ch, user_id: Number(userId) });
  if (!res.ok) return null;
  const status = (res.result as { status?: string } | undefined)?.status;
  if (!status) return null;
  return JOINED_STATUSES.has(status);
}

function joinText(): string {
  return (
    `<b>📢 Bot သုံးရန် Channel ကို Join ပါ</b>\n\n` +
    `Join ပြီးရင် ✅ Joined ကို နှိပ်ပါ။\n\n` +
    `⚠️ Channel ကနေ ထွက်သွားရင် သင့် key တွေ အလိုအလျောက် ပိတ်ပါမယ်။ ပြန် join ရင် ပြန်ဖွင့်ပေးပါမယ်။`
  );
}

function joinMarkup(): Markup {
  const ch = channelSetting();
  const url = ch.startsWith("@") ? `https://t.me/${ch.slice(1)}` : "https://t.me/";
  return kb([
    [{ text: "📢 Join Channel", url }],
    [{ text: "✅ Joined", callback_data: "check:join" }],
  ]);
}

/** Disables this chat's enabled keys and remembers them. Returns how many were paused. */
function pauseKeys(chatId: string): number {
  const active = keysOf(chatId).filter((u) => u.enabled);
  for (const u of active) {
    setUserEnabled(u.id, false);
    db.prepare("INSERT OR IGNORE INTO bot_paused (user_id, chat_id) VALUES (?, ?)").run(u.id, chatId);
  }
  if (active.length) restartCore();
  return active.length;
}

/** Re-enables keys that pauseKeys() disabled. Returns how many were resumed. */
function resumeKeys(chatId: string): number {
  const rows = db
    .prepare("SELECT user_id FROM bot_paused WHERE chat_id = ?")
    .all(chatId) as unknown as { user_id: number }[];
  for (const r of rows) setUserEnabled(r.user_id, true);
  db.prepare("DELETE FROM bot_paused WHERE chat_id = ?").run(chatId);
  if (rows.length) restartCore();
  return rows.length;
}

/** Checks every bot user who has keys (or paused keys) against the channel. */
async function syncChannelMembers(token: string): Promise<void> {
  if (!channelSetting()) return;
  const ids = new Set<string>();
  for (const r of db
    .prepare("SELECT DISTINCT telegram_id AS tid FROM users WHERE telegram_id != ''")
    .all() as unknown as { tid: string }[]) ids.add(r.tid);
  for (const r of db
    .prepare("SELECT DISTINCT chat_id AS tid FROM bot_paused")
    .all() as unknown as { tid: string }[]) ids.add(r.tid);

  for (const tid of ids) {
    if (isAdminChat(tid)) continue;
    const m = await isMember(token, tid);
    if (m === null) continue; // can't tell right now, don't punish anyone
    if (m === false) {
      const n = pauseKeys(tid);
      if (n > 0) {
        await sendText(
          token,
          tid,
          `⛔ Channel ထဲမှာ မရှိတော့လို့ key ${n} ခု ပိတ်လိုက်ပါပြီ။\nပြန် join ပြီး ✅ Joined ကို နှိပ်ပါ။`,
          joinMarkup(),
        );
      }
    } else {
      const n = resumeKeys(tid);
      if (n > 0) await sendText(token, tid, `✅ Channel ကို ပြန် join လို့ key ${n} ခု ပြန်ဖွင့်ပေးပြီးပါပြီ။`);
    }
    await delay(150);
  }
}

// ---- server health alerts ----
const alertLastSent: Record<string, number> = {};
const ALERT_COOLDOWN = 60 * 60_000;

/** Sends an admin alert when RAM/CPU/disk is high or Xray is down. Each alert repeats at most once per hour. */
async function checkServerAlerts(token: string): Promise<void> {
  const s = getSystemStats();
  const checks: { key: string; on: boolean; text: string }[] = [
    {
      key: "ram",
      on: s.ram.usage >= 85,
      text: `🚨 RAM ${s.ram.usage}% (${fmtBytes(s.ram.used)} / ${fmtBytes(s.ram.total)})`,
    },
    { key: "cpu", on: s.cpu.usage >= 85, text: `🚨 CPU ${s.cpu.usage}%` },
    {
      key: "disk",
      on: s.storage.usage >= 90,
      text: `🚨 Disk ${s.storage.usage}% · free ${fmtBytes(s.storage.free)}`,
    },
  ];
  for (const c of checks) {
    if (!c.on) {
      delete alertLastSent[c.key];
      continue;
    }
    if (Date.now() - (alertLastSent[c.key] ?? 0) < ALERT_COOLDOWN) continue;
    alertLastSent[c.key] = Date.now();
    for (const a of getBotConfig().chatIds) {
      await sendText(token, a, `<b>⚠️ Server alert</b>\n${c.text}`);
    }
  }
}

/** If Xray stopped, restart it right away and tell the admins (at most once per hour). */
async function ensureXrayRunning(token: string): Promise<void> {
  if (getSetting("bot_xray_autorestart") === "0") return;
  if (isRunning()) {
    delete alertLastSent.xray;
    return;
  }
  restartCore();
  if (Date.now() - (alertLastSent.xray ?? 0) < ALERT_COOLDOWN) return;
  alertLastSent.xray = Date.now();
  for (const a of getBotConfig().chatIds) {
    await sendText(token, a, "<b>⚠️ Server alert</b>\n🔄 Xray ရပ်သွားလို့ auto restart လုပ်ပြီးပါပြီ။ ထပ်ရပ်နေရင် Panel မှာ စစ်ပါ။");
  }
}

// ---- hourly usage report ----
async function sendUsageReports(token: string): Promise<void> {
  if (getSetting("bot_usage_report") === "0") return;
  for (const a of getBotConfig().chatIds) {
    await sendText(token, a, usageReport(a, false, 20));
  }
  for (const b of allBotUsers()) {
    if (isAdminChat(b.chat_id)) continue;
    await sendText(token, b.chat_id, usageReport(b.chat_id, true, 20));
    await delay(60);
  }
}

// ---- user screens ----
function userHomeText(chatId: string, name: string, bonus = 0): string {
  return (
    `<b>⚡ ▣▬▬ 𝐖𝐄𝐋𝐂𝐎𝐌𝐄 𝐓𝐎 ⚡ 𝕋𝕦𝕣𝕓𝕠 𝕋𝕦𝕟𝕟𝕖𝕝 𝕄𝕄 ▬▬▣</b>\n\n` +
    `<b>👤 User Information</b>\n` +
    `ID: <code>${escHtml(chatId)}</code>\n` +
    `Name: ${escHtml(name || "-")}\n` +
    `💰 Credit: <b>${getCredits(chatId)}</b>` +
    (bonus > 0 ? `\n🎁 New user bonus: <b>+${bonus}</b>` : "")
  );
}

function userHomeMarkup(chatId: string): Markup {
  const rows: Btn[][] = [
    [{ text: "🔑 Get Key", callback_data: "menu:buy" }],
    [
      { text: "📁 My Keys", callback_data: "menu:keys" },
      { text: "💰 My Credits", callback_data: "menu:credit" },
    ],
    [{ text: "📈 All Usage", callback_data: "menu:usage" }],
    [{ text: "🎁 Invite & Earn", callback_data: "menu:invite" }],
  ];
  if (isAdminChat(chatId)) rows.push([{ text: "🛠 Admin", callback_data: "adm:home" }]);
  return kb(rows);
}

function buyMarkup(): Markup {
  const rows: Btn[][] = Object.entries(KEY_PACKAGES).map(([id, p]) => [
    { text: `${p.label} · ${p.credits} credit`, callback_data: `buy:${id}` },
  ]);
  rows.push([{ text: "⬅️ Back", callback_data: "menu:home" }]);
  return kb(rows);
}

function keysListText(chatId: string): { text: string; markup: Markup } {
  const keys = keysOf(chatId);
  const text =
    `<b>📁 My Keys</b> (${keys.length})\n` +
    (keys.length
      ? keys.map((k) => `${userStatusIcon(k)} ${escHtml(k.email)} · ${fmtSize(k.data_limit / 1024 ** 3)} · exp ${expiryText(k)}`).join("\n")
      : "Key မရှိသေးပါ။ 🔑 Get Key နဲ့ ဝယ်ပါ။");
  const rows: Btn[][] = keys.slice(0, 10).map((k) => [{ text: `${userStatusIcon(k)} ${k.email}`, callback_data: `k:${k.id}` }]);
  rows.push([{ text: "⬅️ Back", callback_data: "menu:home" }]);
  return { text, markup: kb(rows) };
}

function creditText(chatId: string): string {
  return (
    `<b>💰 My Credits</b>\n` +
    `Credit ကျန်: <b>${getCredits(chatId)}</b>\n` +
    `🤝 Referral: ${referralCount(chatId)} ယောက်`
  );
}

function inviteText(chatId: string): string {
  const link = botUsername ? `https://t.me/${botUsername}?start=ref_${chatId}` : "(bot username မရသေး)";
  return (
    `<b>🎁 Invite & Earn</b>\n` +
    `သူငယ်ချင်း ဤလင့်ခ်နဲ့ ပထမဆုံး start လုပ်ရင် credit <b>+${referralBonus()}</b> ရပါမယ်။\n\n` +
    `<code>${escHtml(link)}</code>\n\n` +
    `🤝 ခေါ်ထားသူ: ${referralCount(chatId)} ယောက်`
  );
}

const backMarkup = (to: string): Markup => kb([[{ text: "⬅️ Back", callback_data: to }]]);

// ---- admin screens ----
function adminMarkup(): Markup {
  return kb([
    [
      { text: "📊 Panel Status", callback_data: "adm:status" },
      { text: "👥 User List", callback_data: "adm:users:0" },
    ],
    [
      { text: "🤖 Bot Users", callback_data: "adm:botusers:0" },
      { text: "🔍 Find User", callback_data: "adm:find" },
    ],
    [
      { text: "🔒 Revoke Key", callback_data: "adm:revoke" },
      { text: "📢 Broadcast", callback_data: "adm:broadcast" },
    ],
    [
      { text: "💰 All Credits", callback_data: "adm:credits" },
      { text: "🖥 Server Control", callback_data: "adm:server" },
    ],
    [
      { text: "🩺 Health & RAM", callback_data: "adm:health" },
      { text: "📡 Check Channel Members", callback_data: "adm:channel" },
    ],
    [{ text: "🔑 Generate Key", callback_data: "adm:gp:me" }],
    [{ text: "⚙️ Settings", callback_data: "adm:settings" }],
    [{ text: "⬅️ Back", callback_data: "menu:home" }],
  ]);
}

function statusText(): string {
  const s = getSystemStats();
  const all = listUsers();
  const sum = summarize(all);
  const t = totals();
  const usedTotal = all.reduce((acc, u) => acc + u.total, 0);
  const top5 = [...all].sort((a, b) => b.total - a.total).slice(0, 5);
  return (
    `<b>📊 Panel Status</b>\n` +
    `Xray: ${s.xray.running ? "🟢 running" : "🔴 stopped"} (v${escHtml(s.xray.version)})\n` +
    `CPU ${s.cpu.usage}% · RAM ${s.ram.usage}% · Disk ${s.storage.usage}%\n` +
    `Server uptime: ${fmtDuration(s.uptime)}\n` +
    `IP: <code>${escHtml(s.ip.address || "-")}</code>\n\n` +
    `<b>Keys</b>: ${sum.clients} · 🟢 ${sum.online} online · ✅ ${sum.active} active\n` +
    `<b>Bot users</b>: ${t.users} · 💰 total credit ${t.credits}\n\n` +
    `📊 <b>Total database usage</b>: ${fmtBytes(usedTotal)}\n` +
    `<b>Top 5 users</b>\n` +
    (top5.map((u, i) => `${i + 1}. ${escHtml(u.email)} · ${fmtBytes(u.total)}`).join("\n") || "—")
  );
}

function healthText(): string {
  const s = getSystemStats();
  return (
    `<b>🩺 Health & RAM</b>\n` +
    `CPU: ${s.cpu.usage}% (${s.cpu.cores} cores · load ${s.cpu.avg}%)\n` +
    `RAM: ${s.ram.usage}% · ${fmtBytes(s.ram.used)} / ${fmtBytes(s.ram.total)}\n` +
    `Swap: ${s.swap.usage}% · ${fmtBytes(s.swap.used)} / ${fmtBytes(s.swap.total)}\n` +
    `Disk: ${s.storage.usage}% · free ${fmtBytes(s.storage.free)}\n` +
    `Server uptime: ${fmtDuration(s.uptime)} · Xray uptime: ${fmtDuration(s.xray.uptime)}`
  );
}

function usersPage(page: number): { text: string; markup: Markup } {
  const all = listUsers();
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows: Btn[][] = all
    .slice(p * PAGE, (p + 1) * PAGE)
    .map((u) => [{ text: `${userStatusIcon(u)} ${u.email}`, callback_data: `adm:u:${u.id}` }]);
  rows.push(pageNav("adm:users:", p, pages));
  rows.push([{ text: "⬅️ Admin", callback_data: "adm:home" }]);
  return {
    text: `<b>👥 User List</b> (${all.length})\n🟢 online · ✅ active · ⌛ expired/limit · ⛔ disabled`,
    markup: kb(rows),
  };
}

/** Hides a key name for other users. Own keys keep their full name and get a star. */
function maskKey(name: string): string {
  return name.length > 10 ? `${name.slice(0, 10)}…` : name;
}

function usageReport(forChat: string | null, mask: boolean, limit: number): string {
  const all = [...listUsers()].sort((a, b) => b.total - a.total);
  const used = all.reduce((acc, u) => acc + u.total, 0);
  const rows = all.slice(0, limit).map((u, i) => {
    const mine = forChat !== null && u.telegram_id === forChat;
    const label = mask && !mine ? maskKey(u.email) : escHtml(u.email);
    return `${i + 1}. ${label}${mine ? " ⭐" : ""} · ${fmtBytes(u.total)}`;
  });
  return (
    `<b>📈 All Usage</b> (${all.length} keys)\n` +
    `Total: <b>${fmtBytes(used)}</b>\n\n` +
    (rows.join("\n") || "—")
  );
}

/** Every key ranked by data used, paginated (admin view). */
function usagePage(page: number): { text: string; markup: Markup } {
  const all = [...listUsers()].sort((a, b) => b.total - a.total);
  const used = all.reduce((acc, u) => acc + u.total, 0);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const lines = all
    .slice(p * PAGE, (p + 1) * PAGE)
    .map((u, i) => `${p * PAGE + i + 1}. ${escHtml(u.email)} · ${fmtBytes(u.total)}`);
  const rows: Btn[][] = [pageNav("adm:usage:", p, pages), [{ text: "⬅️ Admin", callback_data: "adm:home" }]];
  return {
    text: `<b>📈 All Usage</b> (${all.length} keys)\nTotal: <b>${fmtBytes(used)}</b>\n\n${lines.join("\n") || "—"}`,
    markup: kb(rows),
  };
}

function botUsersPage(page: number): { text: string; markup: Markup } {
  const all = allBotUsers();
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows: Btn[][] = all
    .slice(p * PAGE, (p + 1) * PAGE)
    .map((b) => [{ text: `${b.chat_id} · 💰${b.credits}`, callback_data: `adm:bu:${b.chat_id}` }]);
  rows.push(pageNav("adm:botusers:", p, pages));
  rows.push([{ text: "⬅️ Admin", callback_data: "adm:home" }]);
  return { text: `<b>🤖 Bot Users</b> (${all.length})`, markup: kb(rows) };
}

function botUserCard(target: string): { text: string; markup: Markup } | null {
  const row = botUserRow(target);
  if (!row) return null;
  const keys = keysOf(target);
  const lines = keys
    .slice(0, 10)
    .map((k) => `${userStatusIcon(k)} ${escHtml(k.email)} · exp ${expiryText(k)}`);
  const text =
    `<b>👤 Bot User</b>\n` +
    `Chat ID: <code>${escHtml(target)}</code>\n` +
    `💰 Credit: <b>${row.credits}</b>\n` +
    `🤝 Referrals: ${referralCount(target)}\n` +
    `Joined: ${new Date(row.created_at).toISOString().slice(0, 10)}\n\n` +
    `<b>Keys (${keys.length})</b>\n` +
    (lines.join("\n") || "—");
  const rows: Btn[][] = [[{ text: "➕ Credit ပေါင်း/နှုတ်", callback_data: `adm:cr:${target}` }]];
  rows.push([{ text: "🔑 Key ပေးမယ်", callback_data: `adm:gp:${target}` }]);
  for (const k of keys.slice(0, 6)) {
    rows.push([{ text: `${userStatusIcon(k)} ${k.email}`, callback_data: `adm:u:${k.id}` }]);
  }
  rows.push([{ text: "⬅️ Bot Users", callback_data: "adm:botusers:0" }]);
  return { text, markup: kb(rows) };
}

function panelUserText(u: UserWithInbounds): string {
  const limit = u.data_limit > 0 ? fmtBytes(u.data_limit) : "∞";
  const state = !u.enabled ? "⛔ disabled" : !isUserActive(u) ? "⌛ expired / limit reached" : "✅ active";
  return (
    `<b>👤 ${escHtml(u.email)}</b>\n` +
    `ID: ${u.id}\n` +
    `Telegram: <code>${escHtml(u.telegram_id || "-")}</code>\n` +
    `Status: ${state}\n` +
    `Usage: ${fmtBytes(u.total)} / ${limit}\n` +
    `Expire: ${expiryText(u)}\n` +
    `Created by: ${escHtml(u.creator || "-")}`
  );
}

function panelUserMarkup(u: UserWithInbounds): Markup {
  const rows: Btn[][] = [
    [{ text: u.enabled ? "⛔ Key ပိတ်မယ်" : "✅ Key ပြန်ဖွင့်မယ်", callback_data: `adm:t:${u.id}` }],
  ];
  if (u.telegram_id) rows.push([{ text: "👤 Bot User", callback_data: `adm:bu:${u.telegram_id}` }]);
  rows.push([{ text: "⬅️ Users", callback_data: "adm:users:0" }]);
  return kb(rows);
}

/** Finds a panel user by id, email or telegram chat id. */
function findPanelUser(s: string): UserWithInbounds | null {
  const q = s.trim();
  if (/^\d+$/.test(q)) {
    const byId = getUser(Number(q));
    if (byId) return byId;
  }
  return listUsers().find((u) => u.email === q || u.telegram_id === q) ?? null;
}

function settingsText(): string {
  return (
    `<b>⚙️ Settings</b>\n` +
    `🎁 New user credit: <b>${newUserCredits()}</b>\n` +
    `📅 Key days: <b>${keyDays()}</b>\n` +
    `🤝 Referral bonus: <b>${referralBonus()}</b>\n` +
    `📡 Channel: <code>${escHtml(channelSetting() || "-")}</code>\n` +
    `📈 Hourly usage report: <b>${getSetting("bot_usage_report") === "0" ? "off" : "on"}</b>\n` +
    `🔄 Xray auto restart: <b>${getSetting("bot_xray_autorestart") === "0" ? "off" : "on"}</b>`
  );
}

function settingsMarkup(): Markup {
  return kb([
    [{ text: "🎁 New user credit", callback_data: "adm:set:bot_new_user_credits" }],
    [{ text: "📅 Key days", callback_data: "adm:set:bot_key_days" }],
    [{ text: "🤝 Referral bonus", callback_data: "adm:set:bot_referral_bonus" }],
    [{ text: "📡 Channel", callback_data: "adm:set:bot_channel" }],
    [{ text: "📈 Hourly usage report: on/off", callback_data: "adm:tog:usage" }],
    [{ text: "🔄 Xray auto restart: on/off", callback_data: "adm:tog:xray" }],
    [{ text: "⬅️ Admin", callback_data: "adm:home" }],
  ]);
}

function serverCtlMarkup(): Markup {
  return kb([
    [{ text: "🔄 Restart Xray", callback_data: "adm:server:restart" }],
    [{ text: "⬅️ Admin", callback_data: "adm:home" }],
  ]);
}

async function handleAdmin(token: string, chatId: string, mid: number | undefined, data: string): Promise<void> {
  const parts = data.split(":");
  const op = parts[1];
  const arg = parts[2];
  const refresh = (to: string): Markup => kb([[{ text: "🔄 Refresh", callback_data: to }], [{ text: "⬅️ Admin", callback_data: "adm:home" }]]);

  switch (op) {
    case "home":
      return showMsg(token, chatId, mid, "<b>🛠 Admin Panel</b>", adminMarkup());
    case "status":
      return showMsg(
        token,
        chatId,
        mid,
        statusText(),
        kb([
          [{ text: "📈 All Usage", callback_data: "adm:usage:0" }],
          [{ text: "🔄 Refresh", callback_data: "adm:status" }],
          [{ text: "⬅️ Admin", callback_data: "adm:home" }],
        ]),
      );
    case "usage": {
      const v = usagePage(Number(arg) || 0);
      return showMsg(token, chatId, mid, v.text, v.markup);
    }
    case "health":
      return showMsg(token, chatId, mid, healthText(), refresh("adm:health"));
    case "users": {
      const v = usersPage(Number(arg) || 0);
      return showMsg(token, chatId, mid, v.text, v.markup);
    }
    case "botusers": {
      const v = botUsersPage(Number(arg) || 0);
      return showMsg(token, chatId, mid, v.text, v.markup);
    }
    case "bu": {
      const card = botUserCard(arg);
      if (!card) return showMsg(token, chatId, mid, "❌ Bot user မတွေ့ပါ။", backMarkup("adm:home"));
      return showMsg(token, chatId, mid, card.text, card.markup);
    }
    case "u": {
      const u = getUser(Number(arg));
      if (!u) return showMsg(token, chatId, mid, "❌ Key မတွေ့ပါ။", backMarkup("adm:users:0"));
      return showMsg(token, chatId, mid, panelUserText(u), panelUserMarkup(u));
    }
    case "t": {
      const cur = getUser(Number(arg));
      if (cur) {
        setUserEnabled(cur.id, !cur.enabled);
        restartCore();
        logActivity("telegram-bot", cur.enabled ? "user_disable" : "user_enable", cur.email);
      }
      const u = getUser(Number(arg));
      if (!u) return showMsg(token, chatId, mid, "❌ Key မတွေ့ပါ။", backMarkup("adm:users:0"));
      return showMsg(token, chatId, mid, panelUserText(u), panelUserMarkup(u));
    }
    case "find":
      setPending(chatId, "find");
      return sendText(token, chatId, "🔍 User ID, Chat ID, (သို့) key email ကို ရိုက်ထည့်ပါ။");
    case "revoke":
      setPending(chatId, "revoke");
      return sendText(token, chatId, "🔒 ပိတ်မယ့် key ရဲ့ email (သို့) user ID ကို ရိုက်ထည့်ပါ။");
    case "broadcast":
      setPending(chatId, "broadcast");
      return sendText(token, chatId, "📢 Bot user အားလုံးဆီ ပို့မယ့် စာသားကို ရိုက်ထည့်ပါ။ (HTML ရေးလို့ရ)");
    case "cr":
      setPending(chatId, `credit:${arg}`);
      return sendText(token, chatId, `➕ <code>${escHtml(arg)}</code> အတွက် credit ပမာဏ ရိုက်ထည့်ပါ။ (နှုတ်ချင်ရင် အနှုတ်ထည့်ပါ)`);
    case "credits": {
      const t = totals();
      const top = [...allBotUsers()].sort((a, b) => b.credits - a.credits).slice(0, 10);
      const lines = top.map((b, i) => `${i + 1}. <code>${escHtml(b.chat_id)}</code> · 💰 ${b.credits}`);
      return showMsg(
        token,
        chatId,
        mid,
        `<b>💰 All Credits</b>\nBot users: ${t.users}\nTotal credit: <b>${t.credits}</b>\n\n<b>Top 10</b>\n` +
          (lines.join("\n") || "—"),
        refresh("adm:credits"),
      );
    }
    case "server": {
      if (arg === "restart") {
        restartCore();
        logActivity("telegram-bot", "xray_restart", "");
      }
      const s = getSystemStats();
      return showMsg(
        token,
        chatId,
        mid,
        `<b>🖥 Server Control</b>\nXray: ${s.xray.running ? "🟢 running" : "🔴 stopped"} · uptime ${fmtDuration(s.xray.uptime)}\n` +
          (arg === "restart" ? "✅ Xray restart လုပ်ပြီးပါပြီ။" : ""),
        serverCtlMarkup(),
      );
    }
    case "channel": {
      const ch = channelSetting();
      if (!ch) {
        return showMsg(token, chatId, mid, "📡 Channel မသတ်မှတ်ရသေးပါ။ Settings မှာ သတ်မှတ်ပါ။", backMarkup("adm:settings"));
      }
      const res = await apiCall(token, "getChatMemberCount", { chat_id: ch });
      const count = res.ok ? String(res.result) : `error: ${res.description || "failed"}`;
      return showMsg(
        token,
        chatId,
        mid,
        `<b>📡 Channel Members</b>\n<code>${escHtml(ch)}</code>\nMembers: <b>${escHtml(count)}</b>`,
        refresh("adm:channel"),
      );
    }
    case "gp": {
      const target = arg === "me" ? chatId : arg;
      const rows: Btn[][] = Object.entries(KEY_PACKAGES).map(([id, p]) => [
        { text: p.label, callback_data: `adm:gv:${target}:${id}` },
      ]);
      rows.push([{ text: "⬅️ Admin", callback_data: "adm:home" }]);
      return showMsg(token, chatId, mid, `<b>🔑 Package ရွေးပါ</b>\nTarget: <code>${escHtml(target)}</code>`, kb(rows));
    }
    case "gv": {
      const target = arg;
      const pkg = KEY_PACKAGES[parts[3]];
      if (!pkg) return showMsg(token, chatId, mid, "❌ Package မတွေ့ပါ။", backMarkup("adm:home"));
      if (!config.publicDomain || enabledInbounds().length === 0) {
        return showMsg(token, chatId, mid, "⚠️ PUBLIC_DOMAIN သို့ enabled inbound မရှိပါ။", backMarkup("adm:home"));
      }
      await sendKeys(token, target, pkg.sizes, keyDays(), `Admin gift: ${pkg.label}`);
      logActivity("telegram-bot", "key_gift", target);
      return sendText(token, chatId, `✅ ${escHtml(pkg.label)} key ကို <code>${escHtml(target)}</code> ထံ ပို့ပြီးပါပြီ။`, adminMarkup());
    }
    case "tog": {
      if (arg === "usage") {
        setSetting("bot_usage_report", getSetting("bot_usage_report") === "0" ? "1" : "0");
      }
      if (arg === "xray") {
        setSetting("bot_xray_autorestart", getSetting("bot_xray_autorestart") === "0" ? "1" : "0");
      }
      return showMsg(token, chatId, mid, settingsText(), settingsMarkup());
    }
    case "settings":
      return showMsg(token, chatId, mid, settingsText(), settingsMarkup());
    case "set": {
      if (arg === "bot_channel") {
        setPending(chatId, "channel");
        return sendText(token, chatId, "📡 Channel username (@name) သို့ ID ရိုက်ပါ။ ပိတ်ချင်ရင် <code>off</code> ရိုက်ပါ။");
      }
      setPending(chatId, `set:${arg}`);
      return sendText(token, chatId, `✏️ <code>${escHtml(arg)}</code> အတွက် ကိန်းဂဏန်း ရိုက်ထည့်ပါ။`);
    }
    default:
      return showMsg(token, chatId, mid, "<b>🛠 Admin Panel</b>", adminMarkup());
  }
}

/** Admin typed something after pressing a button. */
async function handlePendingInput(token: string, chatId: string, action: string, text: string): Promise<void> {
  const input = text.trim();

  if (action === "find" || action === "revoke") {
    const u = findPanelUser(input);
    if (action === "find") {
      if (u?.telegram_id && botUserRow(u.telegram_id)) {
        const card = botUserCard(u.telegram_id);
        if (card) return sendText(token, chatId, card.text, card.markup);
      }
      if (u) return sendText(token, chatId, panelUserText(u), panelUserMarkup(u));
      if (botUserRow(input)) {
        const card = botUserCard(input);
        if (card) return sendText(token, chatId, card.text, card.markup);
      }
      return sendText(token, chatId, "❌ မတွေ့ပါ။", adminMarkup());
    }
    if (!u) return sendText(token, chatId, "❌ Key မတွေ့ပါ။", adminMarkup());
    if (!u.enabled) return sendText(token, chatId, `ℹ️ <b>${escHtml(u.email)}</b> က ပိတ်ပြီးသားပါ။`, panelUserMarkup(u));
    setUserEnabled(u.id, false);
    restartCore();
    logActivity("telegram-bot", "user_disable", u.email);
    const after = getUser(u.id);
    return sendText(token, chatId, `🔒 Key ပိတ်ပြီးပါပြီ။\n\n${after ? panelUserText(after) : ""}`, after ? panelUserMarkup(after) : adminMarkup());
  }

  if (action === "broadcast") {
    const users = allBotUsers();
    let sent = 0;
    for (const b of users) {
      await sendText(token, b.chat_id, text);
      sent++;
      await delay(60);
    }
    return sendText(token, chatId, `📢 ပို့ပြီးပါပြီ: ${sent}/${users.length} ယောက်`, adminMarkup());
  }

  if (action.startsWith("credit:")) {
    const target = action.slice(7);
    const amount = Math.floor(Number(input));
    if (!Number.isFinite(amount) || amount === 0) {
      return sendText(token, chatId, "❌ ကိန်းဂဏန်း မှန်မှန်ရိုက်ပါ။ (ဥပမာ 5 သို့ -2)");
    }
    addCredits(target, amount);
    await sendText(token, chatId, `✅ <code>${escHtml(target)}</code> ယခု credit: <b>${getCredits(target)}</b>`, adminMarkup());
    if (target !== chatId) {
      await sendText(token, target, `💰 Credit <b>${amount > 0 ? "+" : ""}${amount}</b> · ယခု ${getCredits(target)}`);
    }
    return;
  }

  if (action === "channel") {
    setSetting("bot_channel", input.toLowerCase() === "off" ? "" : input);
    return sendText(token, chatId, `✅ Channel: <code>${escHtml(channelSetting() || "-")}</code>`, settingsMarkup());
  }

  if (action.startsWith("set:")) {
    const key = action.slice(4);
    const v = Math.floor(Number(input));
    const min = key === "bot_key_days" ? 1 : 0;
    if (!Number.isFinite(v) || v < min) {
      return sendText(token, chatId, `❌ ${min} ထက်ကြီးတဲ့ ကိန်းဂဏန်း ရိုက်ပါ။`);
    }
    setSetting(key, String(v));
    return sendText(token, chatId, "✅ သိမ်းပြီးပါပြီ။", settingsMarkup());
  }
}

async function handleCallback(token: string, cb: TgCallback): Promise<void> {
  await apiCall(token, "answerCallbackQuery", { callback_query_id: cb.id });

  const chatId = String(cb.message?.chat.id ?? cb.from.id);
  const mid = cb.message?.message_id;
  const data = cb.data || "";
  const name = cb.from.first_name || cb.from.username || "";
  registerBotUser(chatId, null);

  if (data.startsWith("adm:")) {
    if (!isAdminChat(chatId)) return;
    return handleAdmin(token, chatId, mid, data);
  }

  if (data === "check:join") {
    const m = await isMember(token, chatId);
    if (m === null) return sendText(token, chatId, "⚠️ Channel check မရနိုင်သေးပါ။ ခဏနေ ပြန်ကြိုးစားပါ။");
    if (m === false) return sendText(token, chatId, "❌ Channel ကို မ join သေးပါ။", joinMarkup());
    const n = resumeKeys(chatId);
    if (n > 0) await sendText(token, chatId, `✅ key ${n} ခု ပြန်ဖွင့်ပေးပြီးပါပြီ။`);
    return showMsg(token, chatId, mid, userHomeText(chatId, name), userHomeMarkup(chatId));
  }

  if (!isAdminChat(chatId) && (await isMember(token, chatId)) === false) {
    return showMsg(token, chatId, mid, joinText(), joinMarkup());
  }

  if (data === "menu:home") {
    return showMsg(token, chatId, mid, userHomeText(chatId, name), userHomeMarkup(chatId));
  }
  if (data === "menu:buy") {
    return showMsg(token, chatId, mid, "<b>🔑 Package ရွေးပါ</b>", buyMarkup());
  }
  if (data === "menu:keys") {
    const v = keysListText(chatId);
    return showMsg(token, chatId, mid, v.text, v.markup);
  }
  if (data === "menu:usage") {
    return showMsg(token, chatId, mid, usageReport(chatId, true, 20), backMarkup("menu:home"));
  }
  if (data === "menu:credit") {
    return showMsg(token, chatId, mid, creditText(chatId), backMarkup("menu:home"));
  }
  if (data === "menu:invite") {
    return showMsg(token, chatId, mid, inviteText(chatId), backMarkup("menu:home"));
  }
  if (data.startsWith("cfg:")) {
    const [, keyId, idx] = data.split(":");
    const u = getUser(Number(keyId));
    if (!u || u.telegram_id !== chatId) {
      await sendText(token, chatId, "❌ Key မတွေ့ပါ။");
      return;
    }
    const host = config.publicDomain;
    const links = host ? buildUserLinks(host, u, enabledInbounds()) : [];
    const picked = links[Number(idx)];
    if (!picked) {
      await sendText(token, chatId, "❌ Config မတွေ့ပါ။");
      return;
    }
    await sendText(
      token,
      chatId,
      `<b>${escHtml(picked.tag)}</b>\n<code>${escHtml(picked.link)}</code>\n\n👆 စာသားကို နှိပ်ရင် Copy ကူးလို့ရပါတယ်။`,
      kb([[{ text: "⬅️ Back", callback_data: "menu:keys" }]]),
    );
    return;
  }
  if (data.startsWith("k:")) {
    const u = getUser(Number(data.slice(2)));
    if (u && u.telegram_id === chatId) await sendKeyLinks(token, chatId, u);
    return;
  }
  if (data.startsWith("buy:")) {
    await handleBuy(token, chatId, data.slice(4));
    await sendText(token, chatId, userHomeText(chatId, name), userHomeMarkup(chatId));
  }
}

// ---- /start boot animation ----
const BOOT_FRAMES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

function bootFrame(pct: number): string {
  const W = 27; // inner width of the box
  const filled = Math.round(pct / 10);
  const bar = "■".repeat(filled) + "□".repeat(10 - filled);
  const top = `┌───[ TURBO SYSTEM BOOT ]───┐`;
  const mid = `│${` [${bar}] ${pct}% SYNC`.padEnd(W)}│`;
  const load = `│${" 🗄️ Loading Profile...".padEnd(W)}│`;
  const bottom = `└${"─".repeat(W)}┘`;
  return `<pre>${top}\n${mid}\n${load}\n${bottom}</pre>`;
}

/** Sends a message and returns its id (null if Telegram refused). */
async function sendTextGetId(token: string, chatId: string, html: string): Promise<number | null> {
  const res = await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  if (!res.ok) return null;
  return (res.result as { message_id?: number } | undefined)?.message_id ?? null;
}

/** Plays the boot animation in one message, then turns it into the home screen (or the join prompt). */
async function bootThenShow(token: string, chatId: string, isAdmin: boolean, name: string, bonus: number): Promise<void> {
  const mid = await sendTextGetId(token, chatId, bootFrame(0));
  for (const pct of BOOT_FRAMES) {
    await delay(500);
    if (mid) {
      await tgCall(token, "editMessageText", {
        chat_id: chatId,
        message_id: mid,
        text: bootFrame(pct),
        parse_mode: "HTML",
      });
    }
  }
  await delay(800); // hold at 100% before showing the menu

  const member = isAdmin ? true : await isMember(token, chatId);
  const text = member === false ? joinText() : userHomeText(chatId, name, bonus);
  const markup = member === false ? joinMarkup() : userHomeMarkup(chatId);
  if (mid) await editText(token, chatId, mid, text, markup);
  else await sendText(token, chatId, text, markup);
}

async function handleMessage(
  token: string,
  chatId: string,
  isAdmin: boolean,
  text: string,
  name: string,
): Promise<void> {
  // admin is answering a button prompt (Find / Broadcast / Credit / Settings ...)
  if (isAdmin && !text.startsWith("/")) {
    const action = takePending(chatId);
    if (action) return handlePendingInput(token, chatId, action, text);
  }

  const [raw, ...args] = text.split(/\s+/);
  const cmd = raw.split("@")[0].toLowerCase();
  let bonus = 0;

  if (cmd === "/start") {
    const refArg = args[0]?.startsWith("ref_") ? args[0].slice(4) : null;
    const referrer = refArg && refArg !== chatId && botUserRow(refArg) ? refArg : null;
    if (registerBotUser(chatId, referrer)) {
      bonus = newUserCredits();
      if (referrer && referralBonus() > 0) {
        addCredits(referrer, referralBonus());
        await sendText(token, referrer, `🎁 Referral bonus <b>+${referralBonus()}</b> credit ရရှိပါပြီ။`);
      }
    }
  } else {
    registerBotUser(chatId, null);
  }

  if (cmd === "/start") {
    return bootThenShow(token, chatId, isAdmin, name, bonus);
  }

  if (!isAdmin && (await isMember(token, chatId)) === false) {
    return sendText(token, chatId, joinText(), joinMarkup());
  }
  return sendText(token, chatId, userHomeText(chatId, name, bonus), userHomeMarkup(chatId));
}

async function pollOnce(cfg: BotConfig): Promise<boolean> {
  const res = await apiCall(cfg.token, "getUpdates", {
    offset: pollOffset,
    timeout: 10,
    allowed_updates: ["message", "callback_query"],
  });
  if (!res.ok || !Array.isArray(res.result)) return false;

  for (const upd of res.result as TgUpdate[]) {
    pollOffset = upd.update_id + 1;
    try {
      if (upd.callback_query) {
        const m = upd.callback_query.message;
        if (m && m.chat.type !== "private") continue;
        await handleCallback(cfg.token, upd.callback_query);
      } else if (upd.message?.text && upd.message.chat.type === "private") {
        const chatId = String(upd.message.chat.id);
        const name = upd.message.from?.first_name || upd.message.from?.username || "";
        await handleMessage(cfg.token, chatId, cfg.chatIds.includes(chatId), upd.message.text.trim(), name);
      }
    } catch (e) {
      console.error("[bot] update error:", e);
    }
  }
  return true;
}

export function startBotPolling(): void {
  void (async () => {
    ensureBotTables();
    setInterval(() => {
      const c = getBotConfig();
      if (c.enabled && c.token) {
        void syncChannelMembers(c.token).catch((e) => console.error("[bot] channel sync:", e));
        void checkServerAlerts(c.token).catch((e) => console.error("[bot] server alert:", e));
      }
    }, 5 * 60_000);
    setInterval(() => {
      const c = getBotConfig();
      if (c.enabled && c.token) {
        void ensureXrayRunning(c.token).catch((e) => console.error("[bot] xray watch:", e));
      }
    }, 60_000);
    setInterval(() => {
      const c = getBotConfig();
      if (c.enabled && c.token) {
        void sendUsageReports(c.token).catch((e) => console.error("[bot] usage report:", e));
      }
    }, 60 * 60_000);
    for (;;) {
      const cfg = getBotConfig();
      if (!cfg.enabled || !cfg.token) {
        await delay(5000);
        continue;
      }
      try {
        if (!botUsername) {
          const me = await apiCall(cfg.token, "getMe", {});
          botUsername = ((me.result as { username?: string } | undefined)?.username) || "";
        }
        const ok = await pollOnce(cfg);
        if (!ok) await delay(3000);
      } catch (e) {
        console.error("[bot] polling error:", e);
        await delay(5000);
      }
    }
  })();
}
