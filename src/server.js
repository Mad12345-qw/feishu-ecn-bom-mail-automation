import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, missingRequiredConfig } from "./config.js";
import { isDuplicateEvent, mapFeishuEventToRecord, processBusinessRecord, summarizeFeishuEvent } from "./workflow.js";

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function appendLog(entry) {
  const logPath = path.join(config.rootDir, "logs", "events.jsonl");
  const payload = { time: new Date().toISOString(), ...entry };
  fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf8");
  console.log(JSON.stringify(payload));
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "feishu-ecn-bom-mail-automation",
        missingConfig: missingRequiredConfig(),
        safeTestMode: config.safeTestMode
      });
    }

    if (req.method === "POST" && url.pathname === "/webhook/feishu") {
      return handleFeishuWebhook(req, res);
    }

    if (req.method === "POST" && url.pathname === "/demo/send") {
      return handleDemoSend(req, res);
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
