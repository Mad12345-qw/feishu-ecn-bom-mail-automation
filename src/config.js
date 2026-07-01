import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const DEFAULT_SENDER_DISPLAY_NAME = "BOM\u91ca\u653e\u901a\u77e5";
const DEFAULT_RECIPIENT_CONFIG_NAME = "\u90ae\u4ef6\u6536\u4ef6\u4eba\u914d\u7f6e";
const CONFIG_AUDIT_KEYS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_SENDER_MAILBOX_ID",
  "FEISHU_SENDER_DISPLAY_NAME",
  "FEISHU_SYNC_CHAT_ID",
  "FEISHU_BOM_APPROVAL_CODES",
  "FEISHU_BOM_APPROVAL_NAMES",
  "SAFE_TEST_MODE",
  "EMAIL_DRY_RUN",
  "INCLUDE_DYNAMIC_RECIPIENTS",
  "INCLUDE_FACTORY_RECIPIENTS",
  "READY_STATUS_VALUES",
  "FIXED_RECIPIENTS",
  "TEST_RECIPIENTS",
  "FACTORY_RECIPIENTS",
  "BLOCKED_RECIPIENT_DOMAINS",
  "RECIPIENT_CONFIG_BITABLE",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "UPSTASH_FEISHU_USER_TOKEN_KEY"
];

function loadDotEnv() {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readJson(relativePath, fallback) {
  const fullPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(fullPath)) return fallback;
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseTextList(value, fallback = []) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() !== "false";
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasSuspiciousText(value) {
  const text = String(value || "");
  return /\?{2,}/.test(text) || [...text].some((char) => char.charCodeAt(0) === 0xfffd);
}

function cleanDisplayText(value, fallback) {
  const text = String(value || "").trim();
  return text && !hasSuspiciousText(text) ? text : fallback;
}

function parseBitableSources() {
  const rawSources = String(process.env.BITABLE_SOURCES || "").trim();
  if (rawSources) {
    return rawSources
      .split(";")
      .map((item, index) => {
        const [appToken, tableId, name] = item.split("|").map((part) => part.trim());
        return {
          appToken,
          tableId,
          name: name || `source-${index + 1}`
        };
      })
      .filter((item) => item.appToken && item.tableId);
  }

  const appToken = process.env.BITABLE_APP_TOKEN || "";
  const tableId = process.env.BITABLE_TABLE_ID || "";
  return appToken && tableId ? [{ appToken, tableId, name: "default" }] : [];
}

function parseBitableSource(value) {
  const raw = String(value || "").trim();
  if (raw) {
    const [appToken, tableId, name] = raw.split("|").map((part) => part.trim());
    return appToken && tableId ? { appToken, tableId, name: cleanDisplayText(name, DEFAULT_RECIPIENT_CONFIG_NAME) } : null;
  }

  const appToken = process.env.RECIPIENT_CONFIG_APP_TOKEN || "";
  const tableId = process.env.RECIPIENT_CONFIG_TABLE_ID || "";
  return appToken && tableId ? { appToken, tableId, name: DEFAULT_RECIPIENT_CONFIG_NAME } : null;
}

function parseFactoryRecipients(value, fallback = {}) {
  const raw = String(value || "").trim();
  if (!raw) return { routes: fallback, source: "config" };

  const routes = {};
  for (const entry of raw.split(";")) {
    const item = entry.trim();
    if (!item) continue;
    const idx = item.indexOf("=");
    if (idx <= 0) continue;
    const name = item.slice(0, idx).trim();
    const recipients = item.slice(idx + 1)
      .split(/[,，\n\r]+/)
      .map((email) => email.trim())
      .filter(Boolean);
    if (!name || !recipients.length) continue;
    routes[name] = { to: recipients, cc: [], enabled: true };
  }

  return Object.keys(routes).length
    ? { routes, source: "env" }
    : { routes: fallback, source: "config" };
}

function parseEmailMap(value) {
  const raw = String(value || "").trim();
  const map = {};
  if (!raw) return map;

  for (const entry of raw.split(/[;；\n\r]+/)) {
    const item = entry.trim();
    if (!item) continue;
    const idx = item.indexOf("=");
    if (idx <= 0) continue;
    const key = item.slice(0, idx).trim();
    const email = item.slice(idx + 1).trim().toLowerCase();
    if (key && /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) {
      map[key] = email;
    }
  }

  return map;
}

loadDotEnv();

const assemblyFactoriesConfig = parseFactoryRecipients(
  process.env.FACTORY_RECIPIENTS,
  readJson("config/assembly-factories.json", {})
);

export const config = {
  rootDir,
  port: Number(process.env.PORT || 8787),
  feishu: {
    appId: process.env.FEISHU_APP_ID || "",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
    senderMailboxId: process.env.FEISHU_SENDER_MAILBOX_ID || "",
    senderDisplayName: cleanDisplayText(process.env.FEISHU_SENDER_DISPLAY_NAME, DEFAULT_SENDER_DISPLAY_NAME),
    syncChatId: process.env.FEISHU_SYNC_CHAT_ID || ""
  },
  upstash: {
    redisRestUrl: process.env.UPSTASH_REDIS_REST_URL || "",
    redisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    userTokenKey: process.env.UPSTASH_FEISHU_USER_TOKEN_KEY || "feishu:user-token"
  },
  bitable: {
    appToken: process.env.BITABLE_APP_TOKEN || "",
    tableId: process.env.BITABLE_TABLE_ID || "",
    syncEnabled: parseBoolean(process.env.BITABLE_SYNC_ENABLED, true),
    sources: parseBitableSources(),
    skipExistingOnStart: parseBoolean(process.env.BITABLE_SKIP_EXISTING_ON_START, false),
    bootstrapRecentReadyWindowMinutes: parseNumber(process.env.BITABLE_BOOTSTRAP_RECENT_READY_WINDOW_MINUTES, 30),
    triggerSourceNames: parseTextList(process.env.BITABLE_TRIGGER_SOURCE_NAMES, ["正式表1", "BOM", "BOM释放", "BOM释放表"]),
    lookupSourceNames: parseTextList(process.env.BITABLE_LOOKUP_SOURCE_NAMES, ["正式表2", "ECN", "ECN表", "ECN变更通知"])
  },
  recipientConfig: parseBitableSource(process.env.RECIPIENT_CONFIG_BITABLE),
  approval: {
    bomApprovalCodes: parseTextList(process.env.FEISHU_BOM_APPROVAL_CODES, []),
    bomApprovalNames: parseTextList(process.env.FEISHU_BOM_APPROVAL_NAMES, ["BOM释放审批"]),
    syncLookbackMinutes: parseNumber(process.env.APPROVAL_SYNC_LOOKBACK_MINUTES, 30),
    queryStartLookbackMinutes: parseNumber(process.env.APPROVAL_QUERY_START_LOOKBACK_MINUTES, 43200)
  },
  safeTestMode: parseBoolean(process.env.SAFE_TEST_MODE, true),
  emailDryRun: parseBoolean(process.env.EMAIL_DRY_RUN, true),
  includeFactoryRecipients: parseBoolean(process.env.INCLUDE_FACTORY_RECIPIENTS, true),
  includeDynamicRecipients: parseBoolean(process.env.INCLUDE_DYNAMIC_RECIPIENTS, true),
  readyStatusValues: parseTextList(process.env.READY_STATUS_VALUES, ["已通过", "审批通过", "完成", "已完成", "已发布"]),
  fixedRecipients: parseCsvList(process.env.FIXED_RECIPIENTS),
  testRecipients: parseCsvList(process.env.TEST_RECIPIENTS),
  blockedRecipientDomains: parseCsvList(process.env.BLOCKED_RECIPIENT_DOMAINS || "neoseektech.com"),
  contactEmailMap: parseEmailMap(process.env.CONTACT_EMAIL_MAP || process.env.DYNAMIC_RECIPIENT_EMAIL_MAP),
  assemblyFactories: assemblyFactoriesConfig.routes,
  assemblyFactoriesSource: assemblyFactoriesConfig.source,
  fieldMapping: readJson("config/field-mapping.json", {})
};

export function missingRequiredConfig() {
  const missing = [];
  if (!config.feishu.appId) missing.push("FEISHU_APP_ID");
  if (!config.feishu.appSecret) missing.push("FEISHU_APP_SECRET");
  if (!config.feishu.senderMailboxId) missing.push("FEISHU_SENDER_MAILBOX_ID");
  return missing;
}

export function configQualityIssues() {
  const issues = [];
  for (const key of CONFIG_AUDIT_KEYS) {
    const value = process.env[key] || "";
    if (value && hasSuspiciousText(value)) {
      issues.push({
        severity: "error",
        key,
        issue: "suspicious_encoding_or_question_marks"
      });
    }
  }

  for (const key of ["SAFE_TEST_MODE", "EMAIL_DRY_RUN", "INCLUDE_DYNAMIC_RECIPIENTS", "INCLUDE_FACTORY_RECIPIENTS"]) {
    const value = process.env[key] || "";
    if (value && !/^(true|false)$/i.test(value)) {
      issues.push({ severity: "error", key, issue: "invalid_boolean" });
    }
  }

  if (process.env.RECIPIENT_CONFIG_BITABLE && !config.recipientConfig) {
    issues.push({ severity: "error", key: "RECIPIENT_CONFIG_BITABLE", issue: "invalid_bitable_source_format" });
  }

  if (config.upstash.redisRestUrl && !/^https:\/\//i.test(config.upstash.redisRestUrl)) {
    issues.push({ severity: "error", key: "UPSTASH_REDIS_REST_URL", issue: "not_https_url" });
  }

  return issues;
}
