import { config } from "./config.js";
import { sendFeishuMail } from "./feishuClient.js";

function getField(source, key) {
  const fieldName = config.fieldMapping[key] || key;
  return source[fieldName] ?? source[key] ?? "";
}

function normalizeEmailList(items) {
  return [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

function assertAllowedRecipients(to, cc) {
  if (!config.safeTestMode) return;
  const all = normalizeEmailList([...to, ...cc]);
  const allowed = new Set(config.testRecipients);
  const blocked = all.filter((email) => !allowed.has(email));
  if (blocked.length) {
    throw new Error(`Safe test mode blocked recipient(s): ${blocked.join(", ")}`);
  }
}

export function routeByAssemblyFactory(record) {
  const assemblyFactory = String(getField(record, "assemblyFactory")).trim();
  if (!assemblyFactory) {
    return { ok: false, reason: "缺少组装工厂字段" };
  }

  const route = config.assemblyFactories[assemblyFactory];
  if (!route || route.enabled === false) {
    return { ok: false, reason: `未配置组装厂收件地址：${assemblyFactory}` };
  }

  const to = normalizeEmailList(route.to || []);
  const cc = normalizeEmailList(route.cc || []);
  if (!to.length) {
    return { ok: false, reason: `组装厂未配置主收件人：${assemblyFactory}` };
  }

  return { ok: true, assemblyFactory, to, cc };
}

export function buildMailHtml(record) {
  const rows = [
    ["项目名称及项目编号", getField(record, "projectNameOrCode")],
    ["版本号", getField(record, "version")],
    ["项目品牌", getField(record, "brand")],
    ["项目阶段", getField(record, "phase")],
    ["组装工厂", getField(record, "assemblyFactory")],
    ["BOM类型", getField(record, "bomType")],
    ["变更记录", getField(record, "changeLog")],
    ["BOM释放附件下载链接", getField(record, "bomAttachments")],
    ["上一个版本BOM释放记录", getField(record, "previousBomRecord")],
    ["ECN变更通知书附件", getField(record, "ecnAttachments")]
  ];

  const bodyRows = rows.map(([name, value]) => {
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(String(value || ""))}</td></tr>`;
  }).join("");

  return `<!doctype html>
<html>
<body>
  <p>您好，以下为本次 BOM 释放 / ECN 变更通知信息，请查收。</p>
  <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;">
    <thead><tr><th align="left">名称</th><th align="left">内容</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <p style="color:#666;font-size:12px;">该邮件由系统自动发送，附件或链接仅供下载查看，不会开放飞书源文件编辑权限。</p>
</body>
</html>`;
}

export async function processBusinessRecord(record) {
  const route = routeByAssemblyFactory(record);
  if (!route.ok) {
    return { status: "blocked", reason: route.reason };
  }

  assertAllowedRecipients(route.to, route.cc);

  const project = getField(record, "projectNameOrCode") || "未命名项目";
  const version = getField(record, "version") || "";
  const subject = `BOM释放通知 - ${project}${version ? ` - ${version}` : ""}`;
  const html = buildMailHtml(record);

  const result = await sendFeishuMail({
    to: route.to,
    cc: route.cc,
    subject,
    html
  });

  return {
    status: "sent",
    assemblyFactory: route.assemblyFactory,
    to: route.to,
    cc: route.cc,
    result
  };
}

export function mapFeishuEventToRecord(eventBody) {
  const event = eventBody.event || eventBody;
  const fields = event.fields || event.record?.fields || event.form || event.data || {};
  return fields && typeof fields === "object" ? fields : {};
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
