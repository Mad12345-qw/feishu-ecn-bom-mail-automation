import { config } from "./config.js";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

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

export async function sendFeishuMail({ to, cc = [], subject, html }) {
  if (!config.feishu.senderMailboxId) {
    throw new Error("Missing FEISHU_SENDER_MAILBOX_ID");
  }

  const payload = {
    subject,
    body: {
      content_type: "html",
      content: html
    },
    to: to.map((email) => ({ email })),
    cc: cc.map((email) => ({ email }))
  };

  return feishuApi(`/mail/v1/user_mailboxes/${encodeURIComponent(config.feishu.senderMailboxId)}/messages/send`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
