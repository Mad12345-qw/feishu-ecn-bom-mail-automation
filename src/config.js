import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

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

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() !== "false";
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

loadDotEnv();

export const config = {
  rootDir,
  port: Number(process.env.PORT || 8787),
  feishu: {
    appId: process.env.FEISHU_APP_ID || "",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
    senderMailboxId: process.env.FEISHU_SENDER_MAILBOX_ID || "",
    senderDisplayName: process.env.FEISHU_SENDER_DISPLAY_NAME || "BOM释放通知",
    syncChatId: process.env.FEISHU_SYNC_CHAT_ID || ""
  },
  bitable: {
    appToken: process.env.BITABLE_APP_TOKEN || "",
    tableId: process.env.BITABLE_TABLE_ID || "",
    sources: parseBitableSources(),
    skipExistingOnStart: parseBoolean(process.env.BITABLE_SKIP_EXISTING_ON_START, false)
  },
  safeTestMode: parseBoolean(process.env.SAFE_TEST_MODE, true),
  emailDryRun: parseBoolean(process.env.EMAIL_DRY_RUN, true),
  fixedRecipients: parseCsvList(process.env.FIXED_RECIPIENTS),
  testRecipients: parseCsvList(process.env.TEST_RECIPIENTS),
  assemblyFactories: readJson("config/assembly-factories.json", {}),
  fieldMapping: readJson("config/field-mapping.json", {})
};

export function missingRequiredConfig() {
  const missing = [];
  if (!config.feishu.appId) missing.push("FEISHU_APP_ID");
  if (!config.feishu.appSecret) missing.push("FEISHU_APP_SECRET");
  if (!config.feishu.senderMailboxId) missing.push("FEISHU_SENDER_MAILBOX_ID");
  return missing;
}
