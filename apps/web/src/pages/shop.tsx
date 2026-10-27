/**
 * Customer shop (/shop): sign up / log in with email + password,
 * spend credits on VPN keys, and copy config links.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

interface Me {
  id: number;
  email: string;
  credits: number;
  keys: number;
}
interface Pkg {
  id: string;
  label: string;
  credits: number;
}
interface KeyLink {
  tag: string;
  link: string;
}
interface KeyView {
  id: number;
  name: string;
  enabled: boolean;
  active: boolean;
  expire_at: number | null;
  used: number;
  limit: number;
  links: KeyLink[];
}

const PKG_ICON: Record<string, string> = {
  p500: "🌱",
  p1gb: "🚀",
  p3gb: "⚡",
  p2x250: "🧩",
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body as T;
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

const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "အကန့်အသတ်မရှိ";

/* ---------- small UI pieces ---------- */

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
  );
}

function Pill({ tone, children }: { tone: "green" | "red" | "amber" | "slate"; children: React.ReactNode }) {
  const map = {
    green: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    red: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
    amber: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    slate: "bg-white/5 text-zinc-300 ring-white/10",
  } as const;
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${map[tone]}`}>{children}</span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <button
      onClick={copy}
      className={`shrink-0 rounded-xl px-3 py-2 text-xs font-semibold transition ${
        done ? "bg-emerald-500 text-white" : "bg-indigo-500 text-white hover:bg-indigo-400"
      }`}
    >
      {done ? "✓ Copied" : "Copy"}
    </button>
  );
}

function Progress({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const tone = pct > 90 ? "bg-rose-500" : pct > 70 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------- page ---------- */

export default function ShopPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const [m, k] = await Promise.all([
      call<Me>("/site-api/me").catch(() => null),
      call<KeyView[]>("/site-api/keys").catch(() => []),
    ]);
    setMe(m);
    setKeys(k);
  }, []);

  useEffect(() => {
    call<Pkg[]>("/site-api/packages").then(setPackages).catch(() => {});
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const activeCount = useMemo(() => keys.filter((k) => k.active).length, [keys]);

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const path = mode === "login" ? "/site-api/login" : "/site-api/signup";
      const u = await call<Me>(path, { method: "POST", body: JSON.stringify({ email, password }) });
      setMe(u);
      setPassword("");
      await refresh();
      if (mode === "signup") setNotice("🎉 အကောင့်ဖွင့်ပြီးပါပြီ။ Credit ၅ ခု ရပါပြီ။");
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function buy(pkg: Pkg) {
    setErr("");
    setBusy(true);
    try {
      const r = await call<{ credits: number }>("/site-api/buy", {
        method: "POST",
        body: JSON.stringify({ pkg: pkg.id }),
      });
      setNotice(`✅ ${pkg.label} ဝယ်ပြီးပါပြီ။ ကျန် ${r.credits} credit`);
      await refresh();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await call("/site-api/logout", { method: "POST" }).catch(() => {});
    setMe(null);
    setKeys([]);
  }

  /* loading */
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#07070c] text-zinc-400">
        <div className="flex items-center gap-3">
          <Spinner /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07070c] text-zinc-100 selection:bg-indigo-500/40">
      {/* background glow */}
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute -top-40 left-1/2 h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-indigo-600/20 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[300px] w-[400px] rounded-full bg-fuchsia-600/10 blur-[110px]" />
      </div>

      <div className="relative mx-auto max-w-2xl px-4 pb-16 pt-6 sm:pt-10">
        {/* header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-lg shadow-lg shadow-indigo-500/30">
              ⚡
            </div>
            <div>
              <h1 className="bg-gradient-to-r from-white via-indigo-200 to-fuchsia-200 bg-clip-text text-lg font-extrabold tracking-tight text-transparent sm:text-xl">
                𝕋𝕦𝕣𝕓𝕠 𝕋𝕦𝕟𝕟𝕖𝕝 𝕄𝕄
              </h1>
              <p className="text-xs text-zinc-500">High-speed VPN keys</p>
            </div>
          </div>
          {me && (
            <button
              onClick={logout}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-white/10"
            >
              Logout
            </button>
          )}
        </header>

        {/* toast */}
        {notice && (
          <div className="mt-5 animate-[fadeIn_.3s_ease] rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {notice}
          </div>
        )}

        {!me ? (
          /* ---------- auth ---------- */
          <section className="mt-10 rounded-3xl border border-white/10 bg-white/[0.03] p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
            <div className="text-center">
              <h2 className="text-2xl font-bold">{mode === "login" ? "ပြန်ဝင်ရန်" : "အကောင့်ဖွင့်ရန်"}</h2>
              <p className="mt-1 text-sm text-zinc-400">
                {mode === "login" ? "ကိုယ့် email နဲ့ ဝင်ပါ" : "အသစ်ဖွင့်ရင် credit ၅ ခု အခမဲ့ ရပါမယ်"}
              </p>
            </div>

            <div className="mt-6 grid grid-cols-2 rounded-2xl bg-white/5 p-1">
              {(["login", "signup"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setErr("");
                  }}
                  className={`rounded-xl py-2 text-sm font-semibold transition ${
                    mode === m ? "bg-white text-zinc-900 shadow" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {m === "login" ? "Login" : "Sign up"}
                </button>
              ))}
            </div>

            <form onSubmit={submitAuth} className="mt-6 space-y-3">
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm outline-none transition placeholder:text-zinc-600 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/20"
              />
              <input
                type="password"
                required
                minLength={8}
                placeholder="Password (၈ လုံးနဲ့အထက်)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm outline-none transition placeholder:text-zinc-600 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/20"
              />
              {err && <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{err}</p>}
              <button
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 py-3 font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:brightness-110 disabled:opacity-60"
              >
                {busy && <Spinner />}
                {mode === "login" ? "Login ဝင်မယ်" : "အကောင့်ဖွင့်မယ်"}
              </button>
            </form>
          </section>
        ) : (
          /* ---------- dashboard ---------- */
          <>
            {/* balance hero */}
            <section className="mt-8 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-indigo-600/30 via-violet-600/20 to-fuchsia-600/20 p-6 shadow-2xl shadow-indigo-900/30 sm:p-8">
              <p className="truncate text-sm text-zinc-300">{me.email}</p>
              <div className="mt-3 flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-widest text-zinc-400">ကျန် Credit</p>
                  <p className="mt-1 text-5xl font-extrabold tabular-nums">{me.credits}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-widest text-zinc-400">Active keys</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums">
                    {activeCount}
                    <span className="text-base font-normal text-zinc-500"> / {keys.length}</span>
                  </p>
                </div>
              </div>
            </section>

            {err && <p className="mt-4 rounded-xl bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{err}</p>}

            {/* packages */}
            <section className="mt-10">
              <div className="mb-4 flex items-end justify-between">
                <h2 className="text-lg font-bold">🔑 Key ဝယ်ရန်</h2>
                <span className="text-xs text-zinc-500">သက်တမ်း ၃ ရက်</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {packages.map((p) => {
                  const enough = me.credits >= p.credits;
                  return (
                    <button
                      key={p.id}
                      disabled={busy || !enough}
                      onClick={() => buy(p)}
                      className={`group relative overflow-hidden rounded-2xl border p-5 text-left transition ${
                        enough
                          ? "border-white/10 bg-white/[0.04] hover:-translate-y-0.5 hover:border-indigo-400/50 hover:bg-white/[0.07] hover:shadow-xl hover:shadow-indigo-500/10"
                          : "cursor-not-allowed border-white/5 bg-white/[0.02] opacity-50"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <span className="text-3xl">{PKG_ICON[p.id] ?? "🔑"}</span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-bold ${
                            enough ? "bg-indigo-500 text-white" : "bg-white/10 text-zinc-400"
                          }`}
                        >
                          {p.credits} credit
                        </span>
                      </div>
                      <p className="mt-4 text-base font-semibold">{p.label}</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {enough ? "ဝယ်ရန် နှိပ်ပါ" : "Credit မလုံလောက်ပါ"}
                      </p>
                    </button>
                  );
                })}
              </div>
              {busy && (
                <div className="mt-4 flex items-center gap-2 text-sm text-zinc-400">
                  <Spinner /> ခဏစောင့်ပါ…
                </div>
              )}
            </section>

            {/* keys */}
            <section className="mt-10 space-y-4">
              <h2 className="text-lg font-bold">📁 ကျွန်ုပ်၏ Key များ</h2>

              {keys.length === 0 && (
                <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">
                  Key မရှိသေးပါ။ အပေါ်က package တစ်ခု ရွေးပြီး ဝယ်ပါ။
                </div>
              )}

              {keys.map((k) => (
                <article
                  key={k.id}
                  className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 transition hover:border-white/20 sm:p-6"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="truncate font-semibold">{k.name}</h3>
                    {k.active ? (
                      <Pill tone="green">● Active</Pill>
                    ) : k.enabled ? (
                      <Pill tone="amber">⌛ Expired</Pill>
                    ) : (
                      <Pill tone="red">⛔ Disabled</Pill>
                    )}
                  </div>

                  <div className="mt-4 space-y-2">
                    <div className="flex justify-between text-xs text-zinc-400">
                      <span>
                        {fmtBytes(k.used)} / {k.limit > 0 ? fmtBytes(k.limit) : "∞"}
                      </span>
                      <span>သက်တမ်း {fmtDate(k.expire_at)}</span>
                    </div>
                    <Progress used={k.used} limit={k.limit} />
                  </div>

                  {k.links.length > 0 && (
                    <div className="mt-5 space-y-2 border-t border-white/5 pt-4">
                      {k.links.map((l) => (
                        <div
                          key={l.tag + l.link}
                          className="flex items-center gap-2 rounded-xl bg-black/40 p-2 pl-3"
                        >
                          <code className="min-w-0 flex-1 truncate text-xs text-zinc-400">{l.link}</code>
                          <CopyButton text={l.link} />
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </section>
          </>
        )}

        <footer className="mt-16 text-center text-xs text-zinc-600">© Turbo Tunnel MM</footer>
      </div>
    </div>
  );
}
