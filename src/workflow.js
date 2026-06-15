import crypto from "node:crypto";
import { config } from "./config.js";
import { feishuApi, sendFeishuMail } from "./feishuClient.js";

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

  return { ok: true, assemblyFactory: assemblyFactories.join("、"), to: normalizedTo, cc: normalizedCc };
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
    ["执行方式", getField(record, "executionMode")],
    ["变更原因", getField(record, "changeReason")],
    ["变更实施日期", getField(record, "changeImplementationDate")],
    ["变更实施日期或批次", getField(record, "changeImplementationDateOrBatch")]
  ];

  return `<!doctype html>
<html>
<body>
  <div style="font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;color:#1f2329;">
    <h2 style="margin:0 0 12px 0;font-size:20px;">米物BOM释放通知</h2>
    <p style="margin:0 0 20px 0;">收到信息请内部传达导入，并提供对应的生产导入执行佐证给到米物对接人员（不限于转化后的生产BOM等资料），如有疑问，请联系我司对应研发窗口。</p>

    ${buildSectionTable("BOM释放详情", bomRows)}
    ${buildSectionTable("关联ECN变更通知单详情", ecnRows)}

    <p style="color:#666;font-size:12px;margin-top:16px;">该邮件由系统自动发送，附件或链接仅供下载查看，不会开放飞书源文件编辑权限。</p>
  </div>
</body>
</html>`;
}

export async function processBusinessRecord(record) {
  if (!record || !Object.keys(record).length) {
    return { status: "received_no_business_fields", reason: "事件已接收，但暂未解析到业务字段" };
  }

  const route = routeByAssemblyFactory(record);
  if (!route.ok) {
    return { status: "blocked", reason: route.reason };
  }

  assertAllowedRecipients(route.to, route.cc);

  const project = valueToText(getField(record, "projectNameOrCode")) || "未命名项目";
  const version = valueToText(getField(record, "version")) || "";
  const subject = `米物BOM释放通知 - ${project}${version ? ` - ${version}` : ""}`;
  const html = buildMailHtml(record);

  if (config.emailDryRun) {
    return {
      status: "dry_run_ready",
      assemblyFactory: route.assemblyFactory,
      to: route.to,
      cc: route.cc,
      subject,
      htmlPreview: html.slice(0, 300)
    };
  }

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

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildSectionTable(title, rows) {
  const bodyRows = rows.map(([name, value]) => {
    return `<tr><td style="width:32%;font-weight:500;">${escapeHtml(name)}</td><td>${formatFieldHtml(value)}</td></tr>`;
  }).join("");

  return `
    <h3 style="margin:20px 0 8px 0;font-size:16px;">${escapeHtml(title)}</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;">
      <thead><tr><th align="left" style="width:32%;">名称</th><th align="left">内容</th></tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

function formatFieldHtml(value) {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) {
    return value.map(formatFieldHtml).filter(Boolean).join("<br>");
  }
  if (typeof value === "object") {
    const text = value.name || value.text || value.value || value.file_name || value.title || value.email || JSON.stringify(value);
    const href = value.url || value.link || value.tmp_url || value.download_url;
    if (href) {
      return `<a href="${escapeHtml(String(href))}">${escapeHtml(String(text || href))}</a>`;
    }
    return escapeHtml(String(text));
  }
  return escapeHtml(String(value));
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
