import crypto from "node:crypto";
import { config } from "./config.js";
import { downloadFeishuMedia, feishuApi, sendFeishuChatText, sendFeishuMail } from "./feishuClient.js";

const processedEventIds = new Set();
const processedRecordFingerprints = new Set();

function getField(source, key) {
  const configured = config.fieldMapping[key] || key;
  const fieldNames = Array.isArray(configured) ? configured : [configured];
  for (const fieldName of [...fieldNames, key]) {
    const value = source[fieldName];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
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
  const assemblyFactories = normalizeFactoryNames(getField(record, "assemblyFactory"));
  if (!assemblyFactories.length) {
    return { ok: false, reason: "缺少组装工厂字段" };
  }

  const missing = [];
  const to = [];
  const cc = [];
  for (const assemblyFactory of assemblyFactories) {
    const route = config.assemblyFactories[assemblyFactory];
    if (!route || route.enabled === false) {
      missing.push(assemblyFactory);
      continue;
    }
    to.push(...(route.to || []));
    cc.push(...(route.cc || []));
  }

  if (missing.length) {
    return { ok: false, reason: `未配置组装厂收件地址：${missing.join("、")}` };
  }

  const normalizedTo = normalizeEmailList(to);
  const normalizedCc = normalizeEmailList(cc);
  if (!normalizedTo.length) {
    return { ok: false, reason: `组装厂未配置主收件人：${assemblyFactories.join("、")}` };
  }

  return {
    ok: true,
    assemblyFactory: assemblyFactories.join("、"),
    to: normalizedTo,
    cc: normalizedCc
  };
}

export function buildRecipientRoute(record) {
  const factoryRoute = routeByAssemblyFactory(record);
  if (!factoryRoute.ok) return factoryRoute;

  const dynamicRecipients = normalizeEmailList([
    ...extractEmails(getField(record, "initiator")),
    ...extractEmails(getField(record, "projectManager"))
  ]);
  const fixedRecipients = normalizeEmailList(config.fixedRecipients);
  const factoryRecipients = normalizeEmailList(factoryRoute.to);
  const cc = normalizeEmailList(factoryRoute.cc);
  const to = normalizeEmailList([...fixedRecipients, ...dynamicRecipients, ...factoryRecipients]);

  if (!to.length) {
    return { ok: false, reason: "未配置任何收件人" };
  }

  return {
    ...factoryRoute,
    to,
    cc,
    fixedRecipients,
    dynamicRecipients,
    factoryRecipients
  };
}

export function buildMailHtml(record) {
  const bomRows = [
    ["项目名称及项目编号", getField(record, "projectNameOrCode")],
    ["版本号", getField(record, "version")],
    ["项目品牌", getField(record, "brand")],
    ["项目阶段", getField(record, "phase")],
    ["组装工厂", getField(record, "assemblyFactory")],
    ["BOM类型", getField(record, "bomType")],
    ["变更记录", getField(record, "changeLog")],
    ["BOM释放附件", getField(record, "bomAttachments")],
    ["上一个版本BOM释放附件", getField(record, "previousBomAttachment")]
  ];
  const ecnRows = [
    ["变更部门", getField(record, "changeDepartment")],
    ["ECN编号", getField(record, "ecnNumber")],
    ["ECN附件", getField(record, "ecnAttachments")],
    ["变更原因", getField(record, "changeReason")],
    ["变更实施日期", getField(record, "changeImplementationDate")]
  ];
  const changeDescriptionColumns = [
    ["变更前", getField(record, "changeBefore")],
    ["变更前补充描述", getField(record, "changeBeforeSupplement")],
    ["变更后", getField(record, "changeAfter")],
    ["变更后补充描述", getField(record, "changeAfterSupplement")],
    ["执行方式", getField(record, "executionMode")]
  ];

  return `<!doctype html>
<html>
<body>
  <div style="font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;color:#1f2329;">
    <h2 style="margin:0 0 12px 0;font-size:20px;">米物BOM释放通知</h2>
    <p style="margin:0 0 20px 0;">收到信息请内部传达导入，并提供对应的生产导入执行佐证给到米物对接人员（不限于转化后的生产BOM等资料），如有疑问，请联系我司对应研发窗口。</p>

    ${buildSectionTable("BOM释放详情", bomRows)}
    ${buildSectionTable("关联ECN变更通知单详情", ecnRows)}
    ${buildChangeDescriptionTable(changeDescriptionColumns)}

    <p style="color:#666;font-size:12px;margin-top:16px;">该邮件由系统自动发送，附件或链接仅供下载查看，不会开放飞书源文件编辑权限。</p>
  </div>
</body>
</html>`;
}

export async function processBusinessRecord(record) {
  if (!record || !Object.keys(record).length) {
    return { status: "received_no_business_fields", reason: "事件已接收，但暂未解析到业务字段" };
  }

  const route = buildRecipientRoute(record);
  if (!route.ok) {
    return { status: "blocked", reason: route.reason };
  }

  assertAllowedRecipients(route.to, route.cc);

  const project = valueToText(getField(record, "projectNameOrCode")) || "未命名项目";
  const version = valueToText(getField(record, "version")) || "";
  const subject = `米物BOM释放通知 - ${project}${version ? ` - ${version}` : ""}`;
  const html = buildMailHtml(record);
  const attachmentRefs = collectAttachmentRefs(record);

  if (config.emailDryRun) {
    return {
      status: "dry_run_ready",
      assemblyFactory: route.assemblyFactory,
      to: route.to,
      cc: route.cc,
      fixedRecipients: route.fixedRecipients,
      dynamicRecipients: route.dynamicRecipients,
      factoryRecipients: route.factoryRecipients,
      feishuGroupSync: config.feishu.syncChatId ? "planned" : "not_configured",
      subject,
      attachments: attachmentRefs.map(({ name, fileToken }) => ({ name, fileToken })),
      htmlPreview: html.slice(0, 300)
    };
  }

  const attachments = await downloadMailAttachments(attachmentRefs);
  const result = await sendFeishuMail({
    to: route.to,
    cc: route.cc,
    subject,
    html,
    attachments
  });
  const groupSync = await syncMailToFeishuGroup({ record, route, subject, attachments });

  return {
    status: "sent",
    assemblyFactory: route.assemblyFactory,
    to: route.to,
    cc: route.cc,
    fixedRecipients: route.fixedRecipients,
    dynamicRecipients: route.dynamicRecipients,
    factoryRecipients: route.factoryRecipients,
    attachments: attachments.map((item) => ({ filename: item.filename, bytes: item.content.length })),
    result,
    groupSync
  };
}

export function createRecordFingerprint(recordId, fields) {
  return crypto
    .createHash("sha256")
    .update(`${recordId}:${JSON.stringify(fields || {})}`)
    .digest("hex");
}

export async function syncConfiguredBitableRecords() {
  if (!config.bitable.appToken || !config.bitable.tableId) {
    return {
      status: "blocked",
      reason: "Missing BITABLE_APP_TOKEN or BITABLE_TABLE_ID"
    };
  }

  const data = await feishuApi(
    `/bitable/v1/apps/${encodeURIComponent(config.bitable.appToken)}/tables/${encodeURIComponent(config.bitable.tableId)}/records?page_size=100`
  );

  const items = data.data?.items || [];
  const results = [];

  for (const item of items) {
    const fields = item.fields || {};
    const recordId = item.record_id || item.id || "";

    if (!Object.keys(fields).length) {
      results.push({ recordId, status: "skipped_empty" });
      continue;
    }

    const fingerprint = createRecordFingerprint(recordId, fields);
    if (processedRecordFingerprints.has(fingerprint)) {
      results.push({ recordId, status: "skipped_duplicate" });
      continue;
    }

    processedRecordFingerprints.add(fingerprint);
    const result = await processBusinessRecord(fields);
    results.push({ recordId, result });
  }

  return {
    status: "synced",
    total: items.length,
    processed: results.filter((item) => item.result).length,
    results
  };
}

export function mapFeishuEventToRecord(eventBody) {
  const event = eventBody.event || eventBody;
  const fields = event.fields || event.record?.fields || event.form || event.data || {};
  return fields && typeof fields === "object" ? fields : {};
}

export function summarizeFeishuEvent(eventBody) {
  const header = eventBody.header || {};
  const event = eventBody.event || eventBody;
  const eventId = header.event_id || eventBody.uuid || event.uuid || event.instance_code || event.record_id || "";
  const eventType = header.event_type || eventBody.type || event.type || event.event_type || "";
  const record = mapFeishuEventToRecord(eventBody);

  return {
    eventId,
    eventType,
    topLevelKeys: Object.keys(eventBody || {}).slice(0, 20),
    eventKeys: Object.keys(event || {}).slice(0, 30),
    parsedFieldKeys: Object.keys(record || {}).slice(0, 30)
  };
}

export function isDuplicateEvent(eventId) {
  if (!eventId) return false;
  if (processedEventIds.has(eventId)) return true;
  processedEventIds.add(eventId);
  if (processedEventIds.size > 1000) {
    const first = processedEventIds.values().next().value;
    processedEventIds.delete(first);
  }
  return false;
}

function buildSectionTable(title, rows) {
  const bodyRows = rows.map(([name, value]) => {
    return `<tr><td style="width:32%;font-weight:500;">${escapeHtml(name)}</td><td>${formatFieldHtml(value, name)}</td></tr>`;
  }).join("");

  return `
    <h3 style="margin:20px 0 8px 0;font-size:16px;">${escapeHtml(title)}</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;">
      <thead><tr><th align="left" style="width:32%;">名称</th><th align="left">内容</th></tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

function buildChangeDescriptionTable(columns) {
  const headers = columns.map(([name]) => `<th align="left">${escapeHtml(name)}</th>`).join("");
  const values = columns.map(([name, value]) => `<td>${formatFieldHtml(value, name)}</td>`).join("");
  return `
    <h3 style="margin:20px 0 8px 0;font-size:16px;">变更描述</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;">
      <thead><tr>${headers}</tr></thead>
      <tbody><tr>${values}</tr></tbody>
    </table>`;
}

function formatFieldHtml(value, fieldName = "") {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) {
    return value.map((item) => formatFieldHtml(item, fieldName)).filter(Boolean).join("<br>");
  }
  if (typeof value === "number" && fieldName.includes("日期")) return formatDate(value);
  if (typeof value === "object") {
    const text = value.name || value.text || value.value || value.file_name || value.title || value.email || JSON.stringify(value);
    const fileToken = value.file_token || value.fileToken || value.token;
    if (fileToken) {
      return `${escapeHtml(String(text || "附件"))}（已作为邮件附件发送）`;
    }
    const href = value.url || value.link || value.tmp_url || value.download_url;
    if (href) {
      return `<a href="${escapeHtml(String(href))}">${escapeHtml(String(text || href))}</a>`;
    }
    return escapeHtml(String(text));
  }
  return escapeHtml(String(value));
}

function collectAttachmentRefs(record) {
  const refs = [
    ...extractAttachmentRefs(getField(record, "bomAttachments")),
    ...extractAttachmentRefs(getField(record, "ecnAttachments"))
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    if (!ref.fileToken || seen.has(ref.fileToken)) return false;
    seen.add(ref.fileToken);
    return true;
  });
}

function extractAttachmentRefs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(extractAttachmentRefs);
  if (typeof value === "object") {
    const fileToken = value.file_token || value.fileToken || value.token;
    if (!fileToken) return [];
    return [{
      fileToken,
      name: value.name || value.file_name || value.filename || "attachment"
    }];
  }
  return [];
}

async function downloadMailAttachments(attachmentRefs) {
  const attachments = [];
  for (const ref of attachmentRefs) {
    const media = await downloadFeishuMedia(ref.fileToken, ref.name);
    attachments.push(media);
  }
  return attachments;
}

async function syncMailToFeishuGroup({ record, route, subject, attachments }) {
  if (!config.feishu.syncChatId) {
    return { status: "skipped", reason: "FEISHU_SYNC_CHAT_ID not configured" };
  }

  try {
    const result = await sendFeishuChatText({
      chatId: config.feishu.syncChatId,
      text: buildGroupSyncText({ record, route, subject, attachments })
    });
    return { status: "sent", result };
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

function buildGroupSyncText({ record, route, subject, attachments }) {
  const lines = [
    "BOM/ECN邮件同步",
    `主题：${subject}`,
    "",
    "邮件内容摘要："
  ];

  const detailRows = [
    ["项目名称及项目编号", valueToText(getField(record, "projectNameOrCode"))],
    ["版本号", valueToText(getField(record, "version"))],
    ["项目品牌", valueToText(getField(record, "brand"))],
    ["项目阶段", valueToText(getField(record, "phase"))],
    ["组装工厂", route.assemblyFactory || valueToText(getField(record, "assemblyFactory"))],
    ["BOM类型", valueToText(getField(record, "bomType"))],
    ["变更记录", valueToText(getField(record, "changeLog"))],
    ["ECN编号", valueToText(getField(record, "ecnNumber"))],
    ["变更原因", valueToText(getField(record, "changeReason"))],
    ["变更前", valueToText(getField(record, "changeBefore"))],
    ["变更后", valueToText(getField(record, "changeAfter"))],
    ["执行方式", valueToText(getField(record, "executionMode"))]
  ];
  for (const [name, value] of detailRows) {
    if (value) lines.push(`${name}：${value}`);
  }

  lines.push("", `收件人：${route.to.join(", ")}`);
  if (route.cc.length) lines.push(`抄送：${route.cc.join(", ")}`);
  if (route.fixedRecipients.length) lines.push(`固定收件人：${route.fixedRecipients.join(", ")}`);
  if (route.dynamicRecipients.length) lines.push(`发起人/项目经理：${route.dynamicRecipients.join(", ")}`);
  if (route.factoryRecipients.length) lines.push(`组装厂收件人：${route.factoryRecipients.join(", ")}`);
  if (attachments.length) {
    lines.push(`附件：${attachments.map((item) => item.filename).join("、")}`);
  }
  return lines.join("\n");
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return escapeHtml(String(timestamp));
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeFactoryNames(value) {
  const text = valueToText(value);
  return [...new Set(text
    .split(/[、,，;；\n\r]/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function valueToText(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join("、");
  if (typeof value === "object") {
    return String(value.name || value.text || value.value || value.title || value.email || "");
  }
  return String(value);
}

function extractEmails(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(extractEmails);
  if (typeof value === "object") {
    return Object.values(value).flatMap(extractEmails);
  }
  return String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
