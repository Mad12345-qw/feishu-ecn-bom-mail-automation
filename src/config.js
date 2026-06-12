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

loadDotEnv();

export const config = {
  rootDir,
  port: Number(process.env.PORT || 8787),
  feishu: {
    appId: process.env.FEISHU_APP_ID || "",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
    senderMailboxId: process.env.FEISHU_SENDER_MAILBOX_ID || "",
    senderDisplayName: process.env.FEISHU_SENDER_DISPLAY_NAME || "BOM释放通知"
  },
  safeTestMode: String(process.env.SAFE_TEST_MODE || "true").toLowerCase() !== "false",
  testRecipients: (process.env.TEST_RECIPIENTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
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
