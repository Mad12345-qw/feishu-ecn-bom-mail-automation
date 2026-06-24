import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(repoRoot, "..");
const textExtensions = new Set([".env", ".html", ".json", ".md", ".mjs", ".txt", ".yaml", ".yml"]);
const skipDirs = new Set([".git", "node_modules", "data", "logs"]);
const booleanKeys = ["SAFE_TEST_MODE", "EMAIL_DRY_RUN", "INCLUDE_DYNAMIC_RECIPIENTS", "INCLUDE_FACTORY_RECIPIENTS"];
const requiredProductionKeys = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_SENDER_MAILBOX_ID",
  "FEISHU_SENDER_DISPLAY_NAME",
  "FEISHU_SYNC_CHAT_ID",
  "FEISHU_BOM_APPROVAL_CODES",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "UPSTASH_FEISHU_USER_TOKEN_KEY",
  "RECIPIENT_CONFIG_BITABLE"
];
const mojibakeChars = new Set([
  "\u951b",
  "\u9286",
  "\u9205",
  "\u95ab",
  "\u7039",
  "\u9422",
  "\u9359",
  "\u6924",
  "\u7084",
  "\u95b2",
  "\u59a7",
  "\u59dd",
  "\u7ef1",
  "\u5bee",
  "\u5a09",
  "\u6fee"
]);

function hasReplacementChar(text) {
  return [...String(text || "")].some((char) => char.charCodeAt(0) === 0xfffd);
}

function hasManyQuestionMarks(text) {
  return /\?{3,}/.test(String(text || ""));
}

function hasMojibakeLikeText(text) {
  let count = 0;
  for (const char of String(text || "")) {
    if (mojibakeChars.has(char)) count += 1;
  }
  return count >= 2;
}

function listProjectTextFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }
  walk(projectRoot);
  return files;
}

function scanTextFiles() {
  const issues = [];
  for (const file of listProjectTextFiles()) {
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const reasons = [];
      if (hasReplacementChar(line)) reasons.push("replacement_char");
      if (hasManyQuestionMarks(line)) reasons.push("many_question_marks");
      if (hasMojibakeLikeText(line)) reasons.push("mojibake_like_text");
      if (reasons.length) {
        issues.push({
          file: path.relative(projectRoot, file),
          line: index + 1,
          issue: reasons.join(","),
          preview: line.slice(0, 160)
        });
      }
    });
  }
  return issues;
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function auditEnvValues(values, source) {
  const issues = [];
  for (const [key, value] of Object.entries(values)) {
    if (hasReplacementChar(value) || hasManyQuestionMarks(value) || hasMojibakeLikeText(value)) {
      issues.push({ source, key, issue: "suspicious_text" });
    }
  }
  for (const key of booleanKeys) {
    const value = values[key];
    if (value && !/^(true|false)$/i.test(value)) {
      issues.push({ source, key, issue: "invalid_boolean" });
    }
  }
  if (values.RECIPIENT_CONFIG_BITABLE && values.RECIPIENT_CONFIG_BITABLE.split("|").length < 2) {
    issues.push({ source, key: "RECIPIENT_CONFIG_BITABLE", issue: "invalid_bitable_source_format" });
  }
  if (values.UPSTASH_REDIS_REST_URL && !/^https:\/\//i.test(values.UPSTASH_REDIS_REST_URL)) {
    issues.push({ source, key: "UPSTASH_REDIS_REST_URL", issue: "not_https_url" });
  }
  return issues;
}

function auditEnvFiles() {
  const issues = [];
  for (const file of listProjectTextFiles().filter((item) => path.extname(item).toLowerCase() === ".env")) {
    issues.push(...auditEnvValues(parseEnvText(fs.readFileSync(file, "utf8")), path.relative(projectRoot, file)));
  }
  return issues;
}

function auditLocalProductionEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return [];
  const values = parseEnvText(fs.readFileSync(envPath, "utf8"));
  return requiredProductionKeys
    .filter((key) => !values[key])
    .map((key) => ({ source: "implementation/.env", key, issue: "missing_required_key" }));
}

function auditTrackedFiles() {
  const issues = [];
  const files = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  for (const file of files) {
    const fullPath = path.join(repoRoot, file);
    const buffer = fs.readFileSync(fullPath);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    if (hasReplacementChar(text) || hasManyQuestionMarks(text)) {
      issues.push({ file: path.relative(projectRoot, fullPath), issue: "tracked_file_has_bad_encoding_marker" });
    }
  }
  return issues;
}

const result = {
  textFileIssues: scanTextFiles(),
  envFileIssues: auditEnvFiles(),
  localProductionEnvWarnings: auditLocalProductionEnv(),
  trackedFileIssues: auditTrackedFiles()
};
const issueCount = result.textFileIssues.length + result.envFileIssues.length + result.trackedFileIssues.length;

console.log(JSON.stringify({
  ok: issueCount === 0,
  issueCount,
  ...result
}, null, 2));

if (issueCount) process.exitCode = 1;
