import { config } from "./config.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const FEISHU_AUTH_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const USER_TOKEN_PATH = path.join(config.rootDir, "data", "feishu-user-token.json");

let cachedTenantToken = null;
let cachedTenantTokenExpiresAt = 0;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || (data.code && data.code !== 0)) {
    const message = data.msg || data.message || response.statusText;
    throw new Error(`Feishu API failed: ${message}`);
  }
  return data;
}

export async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedTenantToken && cachedTenantTokenExpiresAt > now + 60_000) {
    return cachedTenantToken;
  }

  const data = await requestJson(`${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret
    })
  });

  cachedTenantToken = data.tenant_access_token;
  cachedTenantTokenExpiresAt = now + Number(data.expire || 7200) * 1000;
  return cachedTenantToken;
}

export async function feishuApi(path, options = {}) {
  const token = await getTenantAccessToken();
  return requestJson(`${FEISHU_BASE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
}

export function buildFeishuOAuthUrl({ redirectUri, state }) {
  const url = new URL(FEISHU_AUTH_URL);
  url.searchParams.set("client_id", config.feishu.appId);
  url.searchParams.set("app_id", config.feishu.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", [
    "mail:user_mailbox:readonly",
    "mail:user_mailbox.message:send",
    "mail:user_mailbox.message:readonly"
  ].join(" "));
  return url.toString();
}

export function createOAuthState() {
  return crypto.randomBytes(18).toString("hex");
}

export async function exchangeOAuthCode({ code, redirectUri }) {
  const data = await requestJson(`${FEISHU_BASE_URL}/authen/v2/oauth/token`, {
    method: "POST",
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.feishu.appId,
      client_secret: config.feishu.appSecret,
      code,
      redirect_uri: redirectUri
    })
  });

  return saveUserToken(data.data || data);
}

export async function refreshUserAccessToken(refreshToken) {
  const data = await requestJson(`${FEISHU_BASE_URL}/authen/v2/oauth/token`, {
    method: "POST",
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: config.feishu.appId,
      client_secret: config.feishu.appSecret,
      refresh_token: refreshToken
    })
  });

  return saveUserToken(data.data || data);
}

export async function getUserAccessToken() {
  const stored = readUserToken();
  if (!stored?.refresh_token) {
    throw new Error("Missing Feishu user authorization. Open /oauth/feishu/start first.");
  }

  if (stored.access_token && stored.access_token_expires_at > Date.now() + 60_000) {
    return stored.access_token;
  }

  const refreshed = await refreshUserAccessToken(stored.refresh_token);
  return refreshed.access_token;
}

export function getUserAuthStatus() {
  const stored = readUserToken();
  return {
    authorized: Boolean(stored?.refresh_token),
    accessTokenValid: Boolean(stored?.access_token && stored.access_token_expires_at > Date.now() + 60_000),
    refreshTokenValid: Boolean(stored?.refresh_token && stored.refresh_token_expires_at > Date.now() + 60_000)
  };
}

export async function userFeishuApi(path, options = {}) {
  const token = await getUserAccessToken();
  return requestJson(`${FEISHU_BASE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
}

export async function sendFeishuMail({ to, cc = [], subject, html }) {
  if (!config.feishu.senderMailboxId) {
    throw new Error("Missing FEISHU_SENDER_MAILBOX_ID");
  }

  const raw = buildRawMail({
    from: config.feishu.senderMailboxId,
    fromName: config.feishu.senderDisplayName,
    to,
    cc,
    subject,
    html
  });

  return userFeishuApi(`/mail/v1/user_mailboxes/${encodeURIComponent(config.feishu.senderMailboxId)}/messages/send`, {
    method: "POST",
    body: JSON.stringify({ raw })
  });
}

function saveUserToken(data) {
  const now = Date.now();
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    access_token_expires_at: now + Number(data.expires_in || 7200) * 1000,
    refresh_token_expires_at: now + Number(data.refresh_token_expires_in || 30 * 24 * 3600) * 1000,
    updated_at: new Date(now).toISOString()
  };

  fs.mkdirSync(path.dirname(USER_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(USER_TOKEN_PATH, JSON.stringify(token, null, 2), "utf8");
  return token;
}

function readUserToken() {
  if (!fs.existsSync(USER_TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(USER_TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

function buildRawMail({ from, fromName, to, cc, subject, html }) {
  const headers = [
    `From: ${formatAddress(from, fromName)}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64"
  ];

  const body = Buffer.from(html, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

function formatAddress(email, name) {
  return name ? `${encodeMimeHeader(name)} <${email}>` : email;
}

function encodeMimeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
