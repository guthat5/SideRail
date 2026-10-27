/**
 * Admin page: website (shop) customers. Search users, see credits,
 * and add or remove credits. Uses the admin session cookie.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Coins, Users2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";

interface ShopUser {
  id: number;
  email: string;
  credits: number;
  created_at: number;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body as T;
}

export default function ShopUsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = React.useState("");
  const [amounts, setAmounts] = React.useState<Record<number, string>>({});
  const [busyId, setBusyId] = React.useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["site-users"],
    queryFn: () => getJson<ShopUser[]>("/api/site-admin/users"),
  });

  const all = data ?? [];
  const term = q.trim().toLowerCase();
  const users = term ? all.filter((u) => u.email.toLowerCase().includes(term)) : all;
  const totalCredits = all.reduce((acc, u) => acc + u.credits, 0);

  async function adjust(u: ShopUser, amount: number) {
    if (!Number.isFinite(amount) || amount === 0) {
      toast.push("error", "amount မှားနေပါတယ်");
      return;
    }
    setBusyId(u.id);
    try {
      const r = await getJson<{ credits: number }>(`/api/site-admin/users/${u.id}/credit`, {
        method: "POST",
        body: JSON.stringify({ amount }),
      });
      toast.push("success", `${u.email}: ${amount > 0 ? "+" : ""}${amount} → ယခု ${r.credits} credit`);
      setAmounts((p) => ({ ...p, [u.id]: "" }));
      await qc.invalidateQueries({ queryKey: ["site-users"] });
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl tracking-tight">🛍 Shop Users</h1>
          <p className="text-sm text-text/60">Website ဝယ်သူများကို ကြည့်ပြီး credit ထည့်/နှုတ် လုပ်ပါ။</p>
        </div>
        <div className="flex gap-2">
          <Badge variant="neutral" className="gap-1">
            <Users2 className="h-3.5 w-3.5" /> {all.length} users
          </Badge>
          <Badge variant="neutral" className="gap-1">
            <Coins className="h-3.5 w-3.5" /> {totalCredits} credit
          </Badge>
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text/50" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Email နဲ့ ရှာပါ…"
          className="pl-9"
        />
      </div>

      {isLoading && <p className="text-sm text-text/60">Loading…</p>}
      {!isLoading && users.length === 0 && (
        <p className="text-sm text-text/60">User မတွေ့ပါ။</p>
      )}

      <div className="grid gap-3">
        {users.map((u) => (
          <Card key={u.id}>
            <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate font-heading text-base">{u.email}</div>
                <div className="text-xs text-text/60">
                  ဖွင့်သည့်နေ့: {new Date(u.created_at).toLocaleDateString()} · ID {u.id}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="neutral" className="gap-1 text-sm">
                  <Coins className="h-3.5 w-3.5" /> {u.credits}
                </Badge>
                <Button
                  variant="neutral"
                  disabled={busyId === u.id}
                  onClick={() => adjust(u, 5)}
                >
                  +5
                </Button>
                <Button
                  variant="neutral"
                  disabled={busyId === u.id}
                  onClick={() => adjust(u, -5)}
                >
                  −5
                </Button>
                <Input
                  type="number"
                  placeholder="အရေအတွက်"
                  value={amounts[u.id] ?? ""}
                  onChange={(e) => setAmounts((p) => ({ ...p, [u.id]: e.target.value }))}
                  className="w-28"
                />
                <Button
                  disabled={busyId === u.id || !amounts[u.id]}
                  onClick={() => adjust(u, Math.floor(Number(amounts[u.id])))}
                >
                  အတည်ပြု
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
