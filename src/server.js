import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, missingRequiredConfig } from "./config.js";
import { buildFeishuOAuthUrl, createOAuthState, exchangeOAuthCode, exportUserTokenForRenderEnv, getUserAuthStatus, sendFeishuMail } from "./feishuClient.js";
import { isDuplicateEvent, mapFeishuEventToRecord, processBusinessRecord, summarizeFeishuEvent, syncConfiguredBitableRecords } from "./workflow.js";

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function appendLog(entry) {
  fs.mkdirSync(path.join(config.rootDir, "logs"), { recursive: true });
  const logPath = path.join(config.rootDir, "logs", "events.jsonl");
  const payload = { time: new Date().toISOString(), ...entry };
  fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf8");
  console.log(JSON.stringify(payload));
}

function readRecentEvents() {
  const logPath = path.join(config.rootDir, "logs", "events.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-50)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

async function handleFeishuWebhook(req, res) {
  const body = await readBody(req);

  if (body.type === "url_verification" && body.challenge) {
    if (config.feishu.verificationToken && body.token !== config.feishu.verificationToken) {
      return sendJson(res, 403, { error: "invalid verification token" });
    }
    return sendJson(res, 200, { challenge: body.challenge });
  }

  if (config.feishu.verificationToken && body.token && body.token !== config.feishu.verificationToken) {
    return sendJson(res, 403, { error: "invalid event token" });
  }

  const summary = summarizeFeishuEvent(body);
  if (isDuplicateEvent(summary.eventId)) {
    const duplicate = { status: "duplicate_ignored", eventId: summary.eventId, eventType: summary.eventType };
    appendLog({ type: "feishu_webhook", summary, result: duplicate });
    return sendJson(res, 200, duplicate);
  }

  const record = mapFeishuEventToRecord(body);
  const result = await processBusinessRecord(record);
  appendLog({ type: "feishu_webhook", summary, result });
  return sendJson(res, 200, result);
}

async function handleDemoSend(req, res) {
  const record = await readBody(req);
  const result = await processBusinessRecord(record);
  appendLog({ type: "demo_send", result });
  return sendJson(res, 200, result);
}

async function handleBitableSync(req, res, url) {
  const token = url.searchParams.get("token") || req.headers["x-debug-token"];
  if (!config.feishu.verificationToken || token !== config.feishu.verificationToken) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  const result = await syncConfiguredBitableRecords();
  appendLog({ type: "bitable_sync", result });
  return sendJson(res, 200, result);
}

async function handleTestMail(req, res, url) {
  if (!assertDebugToken(req, url)) return sendJson(res, 403, { error: "forbidden" });
  if (!config.testRecipients.length) return sendJson(res, 400, { error: "TEST_RECIPIENTS is empty" });

  const result = await sendFeishuMail({
    to: config.testRecipients,
    subject: `BOM邮件自动化真实发信测试 - ${new Date().toISOString()}`,
    html: `<p>这是一封飞书邮箱 API 真实发信测试邮件。</p>
<p>如果收到，说明客户飞书邮箱发信链路已经打通。</p>`
  });
  appendLog({ type: "test_mail", to: config.testRecipients, result });
  return sendJson(res, 200, { status: "sent", to: config.testRecipients, result });
}

function handleUserTokenEnvExport(req, res, url) {
  if (!assertDebugToken(req, url)) return sendJson(res, 403, { error: "forbidden" });

  const result = exportUserTokenForRenderEnv();
  appendLog({
    type: "oauth_token_env_export",
    ok: result.ok,
    authorized: result.status?.authorized || false,
    hasRefreshToken: result.status?.hasRefreshToken || false
  });
  return sendJson(res, result.ok ? 200 : 400, result);
}

function assertDebugToken(req, url) {
  const token = url.searchParams.get("token") || req.headers["x-debug-token"];
  if (!config.feishu.verificationToken || token !== config.feishu.verificationToken) {
    return false;
  }
  return true;
}

function getPublicBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || "https";
  return `${proto}://${req.headers.host}`;
}

function handleOAuthStart(req, res, url) {
  if (!assertDebugToken(req, url)) return sendJson(res, 403, { error: "forbidden" });

  const redirectUri = `${getPublicBaseUrl(req)}/oauth/feishu/callback`;
  const state = createOAuthState();
  const authUrl = buildFeishuOAuthUrl({ redirectUri, state });
  appendLog({ type: "oauth_start", redirectUri });

  return sendHtml(res, 200, `<!doctype html>
<html><body style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;padding:32px;">
  <h2>飞书邮箱授权</h2>
  <p>请使用客户公用发件邮箱账号完成授权。</p>
  <p>如果提示 redirect_uri 不匹配，请先在飞书开放平台添加：</p>
  <pre>${escapeHtml(redirectUri)}</pre>
  <p><a href="${escapeHtml(authUrl)}">点击开始授权</a></p>
</body></html>`);
}

async function handleOAuthCallback(req, res, url) {
  const code = url.searchParams.get("code");
  if (!code) {
    return sendHtml(res, 400, "<p>授权失败：没有收到 code。</p>");
  }

  const redirectUri = `${getPublicBaseUrl(req)}/oauth/feishu/callback`;
  const token = await exchangeOAuthCode({ code, redirectUri });
  appendLog({ type: "oauth_callback", status: "authorized", refreshTokenExpiresAt: token.refresh_token_expires_at });

  return sendHtml(res, 200, `<!doctype html>
<html><body style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;padding:32px;">
  <h2>授权成功</h2>
  <p>飞书邮箱用户授权已保存。现在可以回到 Codex 继续测试真实发信。</p>
</body></html>`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "feishu-ecn-bom-mail-automation",
        missingConfig: missingRequiredConfig(),
        safeTestMode: config.safeTestMode,
        emailDryRun: config.emailDryRun,
        bitableConfigured: Boolean(config.bitable.sources.length),
        bitableSourceCount: config.bitable.sources.length,
        bitableSkipExistingOnStart: config.bitable.skipExistingOnStart,
        fixedRecipientCount: config.fixedRecipients.length,
        includeFactoryRecipients: config.includeFactoryRecipients,
        feishuGroupSyncConfigured: Boolean(config.feishu.syncChatId),
        userMailAuth: getUserAuthStatus()
      });
    }

    if (req.method === "GET" && url.pathname === "/debug/events") {
      const token = url.searchParams.get("token") || req.headers["x-debug-token"];
      if (!config.feishu.verificationToken || token !== config.feishu.verificationToken) {
        return sendJson(res, 403, { error: "forbidden" });
      }
      return sendJson(res, 200, { events: readRecentEvents() });
    }

    if (req.method === "POST" && url.pathname === "/webhook/feishu") {
      return await handleFeishuWebhook(req, res);
    }

    if (req.method === "POST" && url.pathname === "/demo/send") {
      return await handleDemoSend(req, res);
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/sync/bitable") {
      return await handleBitableSync(req, res, url);
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/debug/send-test-mail") {
      return await handleTestMail(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/debug/user-token-env") {
      return handleUserTokenEnvExport(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/oauth/feishu/start") {
      return handleOAuthStart(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/oauth/feishu/callback") {
      return await handleOAuthCallback(req, res, url);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    appendLog({ type: "error", message: error.message, stack: error.stack });
    return sendJson(res, 500, { error: error.message });
  }
});

server.listen(config.port, () => {
  console.log(`Feishu mail automation service listening on http://localhost:${config.port}`);
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
