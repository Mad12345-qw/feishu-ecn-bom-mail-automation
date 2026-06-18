import { config } from "./config.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const FEISHU_AUTH_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const USER_TOKEN_PATH = path.join(config.rootDir, "data", "feishu-user-token.json");
const USER_TOKEN_ENV_KEY = "FEISHU_USER_TOKEN_B64";

let cachedTenantToken = null;
let cachedTenantTokenExpiresAt = 0;
let cachedUserToken = null;

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

async function requestBinary(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const content = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    let message = response.statusText;
    try {
      const text = content.toString("utf8");
      const data = text ? JSON.parse(text) : {};
      message = data.msg || data.message || message;
    } catch {
      // Binary or empty error bodies do not need extra parsing.
    }
    throw new Error(message);
  }

  return { contentType, content };
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

export async function downloadFeishuMedia(fileToken, fallbackName = "attachment") {
  const token = await getTenantAccessToken();
  const media = await requestBinary(`${FEISHU_BASE_URL}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  return {
    filename: fallbackName,
    contentType: media.contentType,
    content: media.content
  };
}

export async function downloadFeishuMediaWithUserFallback(fileToken, fallbackName = "attachment") {
  try {
    return await downloadFeishuMedia(fileToken, fallbackName);
  } catch (tenantError) {
    const token = await getUserAccessToken();
    const media = await requestBinary(`${FEISHU_BASE_URL}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    return {
      filename: fallbackName,
      contentType: media.contentType,
      content: media.content,
      tenantError: tenantError.message
    };
  }
}

export async function downloadDirectUrlAttachment(url, fallbackName = "attachment") {
  const media = await requestBinary(url);
  return {
    filename: fallbackName,
    contentType: media.contentType,
    content: media.content
  };
}

export async function exportFeishuDriveFile({ token, type, fileExtension, filename }) {
  const task = await userFeishuApi("/drive/v1/export_tasks", {
    method: "POST",
    body: JSON.stringify({
      file_extension: fileExtension,
      token,
      type
    })
  });
  const ticket = task.data?.ticket || task.ticket;
  if (!ticket) {
    throw new Error("Feishu export task did not return a ticket");
  }

  let fileToken = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await userFeishuApi(`/drive/v1/export_tasks/${encodeURIComponent(ticket)}?token=${encodeURIComponent(token)}`);
    const result = status.data?.result || status.data || status;
    fileToken = result.file_token || result.fileToken || "";
    const jobStatus = result.job_status || result.jobStatus || result.status;
    if (fileToken) break;
    if (jobStatus === 3 || jobStatus === "failed" || jobStatus === "fail") {
      throw new Error(`Feishu export task failed: ${JSON.stringify(result)}`);
    }
  }

  if (!fileToken) {
    throw new Error("Feishu export task timed out before returning file_token");
  }

  const userToken = await getUserAccessToken();
  const media = await requestBinary(`${FEISHU_BASE_URL}/drive/v1/export_tasks/file/${encodeURIComponent(fileToken)}/download`, {
    headers: {
      authorization: `Bearer ${userToken}`
    }
  });
  return {
    filename,
    contentType: media.contentType,
    content: media.content
  };
}

export function buildFeishuOAuthUrl({ redirectUri, state }) {
  const url = new URL(FEISHU_AUTH_URL);
  url.searchParams.set("client_id", config.feishu.appId);
  url.searchParams.set("app_id", config.feishu.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", [
    "offline_access",
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

  return await saveUserToken(data.data || data);
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

  return await saveUserToken(data.data || data);
}

export async function getUserAccessToken() {
  const stored = await readUserToken();
  if (!stored?.access_token && !stored?.refresh_token) {
    throw new Error("Missing Feishu user authorization. Open /oauth/feishu/start first.");
  }

  if (stored.access_token && stored.access_token_expires_at > Date.now() + 60_000) {
    return stored.access_token;
  }

  if (!stored.refresh_token) {
    throw new Error("Feishu user access token expired and no refresh token was returned. Please reauthorize.");
  }

  const refreshed = await refreshUserAccessToken(stored.refresh_token);
  return refreshed.access_token;
}

export async function getUserAuthStatus() {
  let stored = null;
  let readError = "";
  try {
    stored = await readUserToken();
  } catch (error) {
    readError = error.message;
  }

  return {
    authorized: Boolean(stored?.access_token || stored?.refresh_token),
    hasRefreshToken: Boolean(stored?.refresh_token),
    accessTokenValid: Boolean(stored?.access_token && stored.access_token_expires_at > Date.now() + 60_000),
    refreshTokenValid: Boolean(stored?.refresh_token && stored.refresh_token_expires_at > Date.now() + 60_000),
    persistentStoreConfigured: isUpstashConfigured(),
    persistentStore: isUpstashConfigured() ? "upstash" : "local",
    ...(readError ? { readError } : {})
  };
}

export async function exportUserTokenForRenderEnv() {
  const stored = await readUserToken();
  if (!stored?.access_token && !stored?.refresh_token) {
    return {
      ok: false,
      reason: "Missing Feishu user authorization. Open /oauth/feishu/start first."
    };
  }

  return {
    ok: true,
    envKey: USER_TOKEN_ENV_KEY,
    envValue: Buffer.from(JSON.stringify(stored), "utf8").toString("base64url"),
    status: await getUserAuthStatus()
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

export async function sendFeishuMail({ to, cc = [], subject, html, attachments = [] }) {
  if (!config.feishu.senderMailboxId) {
    throw new Error("Missing FEISHU_SENDER_MAILBOX_ID");
  }

  const raw = buildRawMail({
    from: config.feishu.senderMailboxId,
    fromName: config.feishu.senderDisplayName,
    to,
    cc,
    subject,
    html,
    attachments
  });

  return userFeishuApi(`/mail/v1/user_mailboxes/${encodeURIComponent(config.feishu.senderMailboxId)}/messages/send`, {
    method: "POST",
    body: JSON.stringify({ raw })
  });
}

export async function sendFeishuChatText({ chatId, text }) {
  if (!chatId) {
    throw new Error("Missing FEISHU_SYNC_CHAT_ID");
  }

  return feishuApi("/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text })
    })
  });
}

function isUpstashConfigured() {
  return Boolean(config.upstash.redisRestUrl && config.upstash.redisRestToken);
}

async function saveUserToken(data) {
  const now = Date.now();
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    access_token_expires_at: now + Number(data.expires_in || 7200) * 1000,
    refresh_token_expires_at: now + Number(data.refresh_token_expires_in || 30 * 24 * 3600) * 1000,
    updated_at: new Date(now).toISOString()
  };

  if (isUpstashConfigured()) {
    await writeUserTokenToUpstash(token);
  }

  cachedUserToken = token;
  writeUserTokenToLocalFile(token);
  return token;
}

async function readUserToken() {
  if (cachedUserToken) return cachedUserToken;

  const upstashToken = await readUserTokenFromUpstash();
  if (upstashToken) {
    cachedUserToken = upstashToken;
    return upstashToken;
  }

  if (fs.existsSync(USER_TOKEN_PATH)) {
    try {
      cachedUserToken = JSON.parse(fs.readFileSync(USER_TOKEN_PATH, "utf8"));
      return cachedUserToken;
    } catch {
      return readUserTokenFromEnv();
    }
  }
  return readUserTokenFromEnv();
}

async function readUserTokenFromUpstash() {
  if (!isUpstashConfigured()) return null;

  const data = await upstashRequest(`/get/${encodeURIComponent(config.upstash.userTokenKey)}`);
  if (data.result === null || data.result === undefined || data.result === "") return null;

  if (typeof data.result === "object") return data.result;

  try {
    return JSON.parse(String(data.result));
  } catch (error) {
    throw new Error(`Upstash user token is not valid JSON: ${error.message}`);
  }
}

async function writeUserTokenToUpstash(token) {
  await upstashRequest(`/set/${encodeURIComponent(config.upstash.userTokenKey)}`, {
    method: "POST",
    body: JSON.stringify(token)
  });
}

async function upstashRequest(pathname, options = {}) {
  const baseUrl = config.upstash.redisRestUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${config.upstash.redisRestToken}`,
      "content-type": "text/plain; charset=utf-8",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.error) {
    const message = data.error || data.message || response.statusText;
    throw new Error(`Upstash Redis failed: ${message}`);
  }

  return data;
}

function writeUserTokenToLocalFile(token) {
  fs.mkdirSync(path.dirname(USER_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(USER_TOKEN_PATH, JSON.stringify(token, null, 2), "utf8");
}

function readUserTokenFromEnv() {
  const encoded = process.env[USER_TOKEN_ENV_KEY];
  if (encoded) {
    try {
      cachedUserToken = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      return cachedUserToken;
    } catch {
      return null;
    }
  }

  const rawJson = process.env.FEISHU_USER_TOKEN_JSON;
  if (rawJson) {
    try {
      cachedUserToken = JSON.parse(rawJson);
      return cachedUserToken;
    } catch {
      return null;
    }
  }

  return null;
}

function buildRawMail({ from, fromName, to, cc, subject, html, attachments }) {
  if (attachments.length) {
    return buildMultipartRawMail({ from, fromName, to, cc, subject, html, attachments });
  }

  const headers = [
    `From: ${formatAddress(from, fromName)}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64"
  ];

  const body = wrapBase64(Buffer.from(html, "utf8").toString("base64"));
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

function buildMultipartRawMail({ from, fromName, to, cc, subject, html, attachments }) {
  const boundary = `mixed_${crypto.randomBytes(12).toString("hex")}`;
  const headers = [
    `From: ${formatAddress(from, fromName)}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];

  const parts = [
    [
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(html, "utf8").toString("base64"))
    ].join("\r\n")
  ];

  for (const attachment of attachments) {
    const filename = attachment.filename || "attachment";
    const contentType = attachment.contentType || "application/octet-stream";
    parts.push([
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${encodeMimeHeader(filename)}"`,
      `Content-Disposition: attachment; filename="${encodeMimeHeader(filename)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(attachment.content).toString("base64"))
    ].join("\r\n"));
  }

  parts.push(`--${boundary}--`);
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`);
}

function wrapBase64(value) {
  return value.replace(/(.{76})/g, "$1\r\n");
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
