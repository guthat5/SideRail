/**
 * Customer website API (separate from the admin panel).
 * Users sign up with email + password, buy keys with credits and see their own keys.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { db, getSetting } from "./db.js";
import { createUser, listUsers, isUserActive } from "./users.js";
import { buildUserLinks } from "./links.js";
import { restartCore } from "./core.js";
import { loginRateLimit } from "./ratelimit.js";
import { authGuard } from "./auth.js";
import { KEY_PACKAGES } from "./bot.js";
import type { Inbound } from "./types.js";

const COOKIE = "sr_user";

db.exec(`
  CREATE TABLE IF NOT EXISTS site_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

interface SiteUser {
  id: number;
  email: string;
  password_hash: string;
  credits: number;
  token_version: number;
  created_at: number;
}

type SiteReq = Request & { site?: SiteUser };

function numSetting(key: string, def: number): number {
  const raw = getSetting(key);
  const v = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) ? v : def;
}
const newUserCredits = () => Math.max(0, Math.floor(numSetting("bot_new_user_credits", 5)));
const keyDays = () => Math.max(1, Math.floor(numSetting("bot_key_days", 3)));

const getSiteUserById = (id: number) =>
  db.prepare("SELECT * FROM site_users WHERE id = ?").get(id) as unknown as SiteUser | undefined;
const getSiteUserByEmail = (email: string) =>
  db.prepare("SELECT * FROM site_users WHERE email = ?").get(email) as unknown as SiteUser | undefined;

const ownerTag = (id: number) => `site:${id}`;
const sizeLabel = (gb: number) => (gb >= 1 ? `${gb} GB` : `${Math.round(gb * 1024)} MB`);

function setCookie(res: Response, u: SiteUser): void {
  const token = jwt.sign({ typ: "site", uid: u.id, tv: u.token_version }, config.jwtSecret, {
    expiresIn: "7d",
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

function siteAuth(req: SiteReq, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE];
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const p = jwt.verify(token, config.jwtSecret) as { typ?: string; uid?: number; tv?: number };
    if (p.typ !== "site" || !p.uid) throw new Error("bad token");
    const u = getSiteUserById(p.uid);
    if (!u || u.token_version !== (p.tv ?? -1)) throw new Error("revoked");
    req.site = u;
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}

function summary(u: SiteUser) {
  return { id: u.id, email: u.email, credits: u.credits, keys: keysOwnedBy(u.id).length };
}

function keysOwnedBy(id: number): UserWithInbounds[] {
  return listUsers().filter((k) => k.comment === ownerTag(id));
}
type UserWithInbounds = ReturnType<typeof listUsers>[number];

function enabledInbounds(): Inbound[] {
  return db.prepare("SELECT * FROM inbounds WHERE enabled = 1").all() as unknown as Inbound[];
}

export const siteRouter = Router();

siteRouter.post("/signup", loginRateLimit, (req: Request, res: Response) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!/^\S+@\S+\.\S+$/.test(email)) return void res.status(400).json({ error: "email မှားနေပါတယ်" });
  if (password.length < 8) return void res.status(400).json({ error: "password အနည်းဆုံး ၈ လုံး" });
  if (getSiteUserByEmail(email)) return void res.status(409).json({ error: "ဒီ email နဲ့ အကောင့်ရှိပြီးသား" });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO site_users (email, password_hash, credits, token_version, created_at) VALUES (?, ?, ?, 0, ?)")
    .run(email, hash, newUserCredits(), Date.now());
  const u = getSiteUserById(Number(info.lastInsertRowid))!;
  setCookie(res, u);
  res.json(summary(u));
});

siteRouter.post("/login", loginRateLimit, (req: Request, res: Response) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const u = getSiteUserByEmail(email);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return void res.status(401).json({ error: "email (သို့) password မှားနေပါတယ်" });
  }
  setCookie(res, u);
  res.json(summary(u));
});

siteRouter.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

siteRouter.get("/me", siteAuth, (req: SiteReq, res: Response) => {
  res.json(summary(req.site!));
});

siteRouter.get("/packages", (_req: Request, res: Response) => {
  res.json(
    Object.entries(KEY_PACKAGES).map(([id, p]) => ({
      id,
      label: p.label,
      credits: p.credits,
    })),
  );
});

siteRouter.post("/buy", siteAuth, async (req: SiteReq, res: Response) => {
  const u = req.site!;
  const pkg = KEY_PACKAGES[String(req.body?.pkg || "")];
  if (!pkg) return void res.status(400).json({ error: "package မတွေ့ပါ" });
  if (!config.publicDomain) return void res.status(503).json({ error: "server မှာ PUBLIC_DOMAIN မသတ်မှတ်ရသေးပါ" });
  const inbounds = enabledInbounds();
  if (inbounds.length === 0) return void res.status(503).json({ error: "ရောင်းလို့ရတဲ့ inbound မရှိသေးပါ" });

  const spent = db
    .prepare("UPDATE site_users SET credits = credits - ? WHERE id = ? AND credits >= ?")
    .run(pkg.credits, u.id, pkg.credits);
  if (spent.changes === 0) {
    return void res.status(402).json({ error: `Credit မလုံလောက်ပါ (လိုအပ်: ${pkg.credits})` });
  }

  try {
    const inboundIds = inbounds.map((ib) => ib.id);
    const created = pkg.sizes.map((size) =>
      createUser({
        email: `Turbo key-${randomBytes(3).toString("hex")}`,
        dataLimit: size,
        expireDays: keyDays(),
        telegramId: "",
        comment: ownerTag(u.id),
        inboundIds,
        createdBy: null,
      }),
    );
    restartCore();
    res.json({
      ok: true,
      keys: created.map((k) => keyView(k, inbounds)),
      credits: getSiteUserById(u.id)?.credits ?? 0,
    });
  } catch (e) {
    console.error("[site] buy failed, refunding:", e);
    db.prepare("UPDATE site_users SET credits = credits + ? WHERE id = ?").run(pkg.credits, u.id);
    res.status(500).json({ error: "key ထုတ်မရပါ။ credit ပြန်ထည့်ပေးပြီးပါပြီ" });
  }
});

function keyView(k: UserWithInbounds, inbounds: Inbound[]) {
  const host = config.publicDomain;
  const links = host
    ? buildUserLinks(host, k, inbounds).map((l) => ({ tag: l.tag, link: l.link }))
    : [];
  return {
    id: k.id,
    name: k.email,
    enabled: !!k.enabled,
    active: !!k.enabled && isUserActive(k),
    expire_at: k.expire_at ?? null,
    used: k.total,
    limit: k.data_limit,
    links,
  };
}

siteRouter.get("/keys", siteAuth, (req: SiteReq, res: Response) => {
  const inbounds = enabledInbounds();
  res.json(keysOwnedBy(req.site!.id).map((k) => keyView(k, inbounds)));
});

// ---- admin: top up site users (uses the normal admin login) ----
export const siteAdminRouter = Router();
siteAdminRouter.use(authGuard);

siteAdminRouter.get("/users", (_req: Request, res: Response) => {
  const rows = db
    .prepare("SELECT id, email, credits, created_at FROM site_users ORDER BY id DESC")
    .all() as unknown as { id: number; email: string; credits: number; created_at: number }[];
  res.json(rows);
});

siteAdminRouter.post("/users/:id/credit", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const amount = Math.floor(Number(req.body?.amount));
  if (!getSiteUserById(id)) return void res.status(404).json({ error: "user မတွေ့ပါ" });
  if (!Number.isFinite(amount) || amount === 0) return void res.status(400).json({ error: "amount မှားနေပါတယ်" });
  db.prepare("UPDATE site_users SET credits = MAX(0, credits + ?) WHERE id = ?").run(amount, id);
  res.json({ ok: true, credits: getSiteUserById(id)?.credits ?? 0 });
});
