/**
 * SideRail - Xray-core VPN management panel
 * Copyright (c) 2025 icubaby. All rights reserved.
 * Official repository: https://github.com/icubaby/SideRail
 *
 * Licensed under the SideRail Proprietary License (see LICENSE).
 * Unauthorized selling, white-labeling, or removal of attribution,
 * branding, or the embedded authorship identifiers is prohibited.
 * Watermark: sr-icubaby-2025-9f4c1a7e
 */
import { getSetting } from "./db.js";
import type { Inbound, UserWithInbounds } from "./types.js";

interface LinkContext {
  host: string;
  address: string;
  user: UserWithInbounds;
  inbound: Inbound;
}

function label(user: UserWithInbounds): string {
  return configName(user);
}

/**
 * Convert ASCII letters/digits to the Unicode "mathematical bold" font
 * so config names render as: 𝗦𝗶𝗱𝗲𝗥𝗮𝗶𝗹 - <client name>
 * Non-ASCII characters (Persian, Chinese, emoji, spaces...) pass through unchanged.
 */
export function toBoldAscii(input: string): string {
  let out = "";
  for (const ch of input) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x41 && c <= 0x5a) out += String.fromCodePoint(0x1d5d4 + (c - 0x41));
    else if (c >= 0x61 && c <= 0x7a) out += String.fromCodePoint(0x1d5ee + (c - 0x61));
    else if (c >= 0x30 && c <= 0x39) out += String.fromCodePoint(0x1d7ce + (c - 0x30));
    else out += ch;
  }
  return out;
}

/** Config / subscription name: the client (key) name, e.g. Turbo key-3fa91c */
export function configName(user: UserWithInbounds): string {
  return toBoldAscii(user.email);
}

function commonQuery(ctx: LinkContext): Record<string, string> {
  const { inbound, user, host } = ctx;
  const q: Record<string, string> = {
    security: "tls",
    sni: host,
    host,
    fp: user.fingerprint || "chrome",
  };
  q.type = inbound.transport === "xhttp" ? "xhttp" : inbound.transport;
  q.path = inbound.path;
  if (inbound.transport === "ws" || inbound.transport === "httpupgrade") {
    q.alpn = "http/1.1";
    q.headerType = "none";
  } else {
    q.alpn = user.alpn || "h2,http/1.1";
  }
  return q;
}

function qs(params: Record<string, string>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

function vlessLink(ctx: LinkContext): string {
  const { user, address } = ctx;
  const query = qs({ ...commonQuery(ctx), encryption: "none" });
  return `vless://${user.uuid}@${address}:443?${query}#${encodeURIComponent(label(user))}`;
}

function trojanLink(ctx: LinkContext): string {
  const { user, address } = ctx;
  const query = qs(commonQuery(ctx));
  return `trojan://${encodeURIComponent(user.password)}@${address}:443?${query}#${encodeURIComponent(
    label(user),
  )}`;
}

function vmessLink(ctx: LinkContext): string {
  const { user, inbound, host, address } = ctx;
  const isXhttp = inbound.transport === "xhttp";
  const obj = {
    v: "2",
    ps: label(user),
    add: address,
    port: "443",
    id: user.uuid,
    aid: "0",
    scy: "auto",
    net: isXhttp ? "xhttp" : inbound.transport,
    type: "none",
    host,
    path: inbound.path,
    tls: "tls",
    sni: host,
    alpn: isXhttp ? "h2,http/1.1" : "http/1.1",
    fp: user.fingerprint || "chrome",
  };
  return "vmess://" + Buffer.from(JSON.stringify(obj)).toString("base64");
}

export function buildLink(ctx: LinkContext): string {
  switch (ctx.inbound.protocol) {
    case "vless":
      return vlessLink(ctx);
    case "trojan":
      return trojanLink(ctx);
    case "vmess":
      return vmessLink(ctx);
  }
}

function resolveAddress(host: string): string {
  const clean = (getSetting("clean_address") || "").trim();
  return clean || host;
}

export function buildUserLinks(
  host: string,
  user: UserWithInbounds,
  inbounds: Inbound[],
): { tag: string; protocol: string; transport: string; link: string }[] {
  const address = resolveAddress(host);
  return inbounds
    .filter((ib) => ib.enabled && user.inbound_ids.includes(ib.id))
    .map((inbound) => ({
      tag: inbound.tag,
      protocol: inbound.protocol,
      transport: inbound.transport,
      link: buildLink({ host, address, user, inbound }),
    }));
}
