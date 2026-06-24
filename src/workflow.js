import crypto from "node:crypto";
import { config } from "./config.js";
import { downloadDirectUrlAttachment, downloadFeishuMediaWithUserFallback, exportFeishuDriveFile, feishuApi, sendFeishuChatText, sendFeishuMail } from "./feishuClient.js";

const processedEventIds = new Set();
const processedRecordFingerprints = new Set();
const recordStatusByKey = new Map();
const approvalFormFieldCache = new Map();
const contactEmailCache = new Map();
const serviceStartedAt = Date.now();

function getField(source, key) {
  const configured = config.fieldMapping[key] || key;
  const fieldNames = Array.isArray(configured) ? configured : [configured];
  for (const fieldName of [...fieldNames, key]) {
    const value = source[fieldName];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function getFieldValues(source, key) {
  const configured = config.fieldMapping[key] || key;
  const fieldNames = Array.isArray(configured) ? configured : [configured];
  const seen = new Set();
  const values = [];
  for (const fieldName of [...fieldNames, key]) {
    if (seen.has(fieldName)) continue;
    seen.add(fieldName);
    const value = source[fieldName];
    if (value !== undefined && value !== null && value !== "") values.push(value);
  }
  return values;
}

function normalizeEmailList(items) {
  return [...new Set(items
    .filter((item) => item !== undefined && item !== null)
    .map((item) => String(item).trim().toLowerCase())
    .filter((email) => /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)))];
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
    return { ok: false, reason: "缺少组装厂字段" };
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

export async function buildRecipientRoute(record) {
  const assemblyFactories = normalizeFactoryNames(getField(record, "assemblyFactory"));
  if (!assemblyFactories.length) {
    return { ok: false, reason: "缺少组装厂字段" };
  }

  let factoryRoute = {
    ok: true,
    assemblyFactory: assemblyFactories.join("、"),
    to: [],
    cc: []
  };
  if (config.includeFactoryRecipients) {
    factoryRoute = routeByAssemblyFactory(record);
    if (!factoryRoute.ok) return factoryRoute;
  }

  const dynamicResult = config.includeDynamicRecipients
    ? await resolveDynamicRecipientEmails(record)
    : { emails: [], errors: [] };
  const dynamicRecipients = normalizeEmailList(dynamicResult.emails);
  const fixedRecipients = normalizeEmailList(config.fixedRecipients);
  const factoryRecipients = config.includeFactoryRecipients ? normalizeEmailList(factoryRoute.to) : [];
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
    dynamicRecipientErrors: dynamicResult.errors,
    factoryRecipients,
    factoryRecipientsEnabled: config.includeFactoryRecipients,
    dynamicRecipientsEnabled: config.includeDynamicRecipients
  };
}

export function buildMailHtml(record) {
  const changeDescriptionRows = getChangeDescriptionRows(record);
  const bomRows = [
    ["项目名称及项目编号", getField(record, "projectNameOrCode")],
    ["版本号", getField(record, "version")],
    ["项目品牌", getField(record, "brand")],
    ["项目阶段", getField(record, "phase")],
    ["组装厂", getField(record, "assemblyFactory")],
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
  return `<!doctype html>
<html>
<body>
  <div style="font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;color:#1f2329;">
    <h2 style="margin:0 0 12px 0;font-size:20px;">米物BOM释放通知</h2>
    <p style="margin:0 0 20px 0;">收到信息请内部传达导入，并提供对应的生产导入执行佐证给到米物对接人员（不限于转化后的生产BOM等资料），如有疑问，请联系我司对应研发窗口。</p>

    ${buildSectionTable("BOM释放详情", bomRows)}
    ${buildSectionTable("关联ECN变更通知单详情", ecnRows)}
    ${buildChangeDescriptionTable(changeDescriptionRows)}

    <p style="color:#666;font-size:12px;margin-top:16px;">该邮件由系统自动发送，附件或链接仅供下载查看，不会开放飞书源文件编辑权限。</p>
  </div>
</body>
</html>`;
}

export async function processBusinessRecord(record, options = {}) {
  if (!record || !Object.keys(record).length) {
    return { status: "received_no_business_fields", reason: "事件已接收，但暂未解析到业务字段" };
  }

  const readinessRecord = options.readinessRecord || record;
  const routeRecord = options.routeRecord || record;
  const readiness = getRecordReadiness(readinessRecord);
  if (!readiness.ok) {
    return { status: "skipped_not_ready", reason: readiness.reason, approvalStatus: readiness.statusText };
  }

  const route = await buildRecipientRoute(routeRecord);
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
      dynamicRecipientErrors: route.dynamicRecipientErrors,
      factoryRecipients: route.factoryRecipients,
      factoryRecipientsEnabled: route.factoryRecipientsEnabled,
      feishuGroupSync: config.feishu.syncChatId ? "planned" : "not_configured",
      subject,
      attachments: attachmentRefs.map((ref) => ({
        name: ref.name,
        type: ref.type,
        fileToken: ref.fileToken,
        driveType: ref.driveType,
        fileExtension: ref.fileExtension,
        url: ref.url
      })),
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
    dynamicRecipientErrors: route.dynamicRecipientErrors,
    factoryRecipients: route.factoryRecipients,
    factoryRecipientsEnabled: route.factoryRecipientsEnabled,
    attachments: attachments.map((item) => ({ filename: item.filename, bytes: item.content.length })),
    result,
    groupSync
  };
}

export function createRecordFingerprint(sourceId, recordId, fields) {
  return crypto
    .createHash("sha256")
    .update(`${sourceId}:${recordId}:${JSON.stringify(fields || {})}`)
    .digest("hex");
}

function getBusinessSendStateKey(fields, fallbackSerialNumber = "") {
  const serialNumber = normalizeBusinessSerialNumber(
    fallbackSerialNumber
    || fields?.["申请编号"]
    || getField(fields || {}, "applicationNo")
  );
  if (serialNumber) return `business:bom:${serialNumber}`;

  const fallback = crypto
    .createHash("sha256")
    .update(JSON.stringify(fields || {}))
    .digest("hex");
  return `business:bom:unknown:${fallback}`;
}

function normalizeBusinessSerialNumber(value) {
  const text = valueToText(value).trim();
  const match = text.match(/\b\d{12}\b/);
  return match ? match[0] : text;
}

function maskBusinessKey(key) {
  const text = String(key || "");
  if (!text) return "";
  return text.replace(/business:bom:(\d{4})\d+(\d{3})/, "business:bom:$1***$2");
}

export async function syncConfiguredBitableRecords() {
  if (!config.bitable.sources.length) {
    return {
      status: "blocked",
      reason: "Missing BITABLE_SOURCES or BITABLE_APP_TOKEN/BITABLE_TABLE_ID"
    };
  }

  const sources = [];
  const results = [];
  const snapshots = [];
  for (const source of config.bitable.sources) {
    try {
      snapshots.push({
        source,
        items: await listBitableRecords(source)
      });
    } catch (error) {
      snapshots.push({
        source,
        error: error.message,
        items: []
      });
    }
  }

  const lookupRecords = snapshots
    .filter((snapshot) => !snapshot.error && isLookupSource(snapshot.source))
    .flatMap((snapshot) => snapshot.items.map((item) => ({
      source: snapshot.source,
      recordId: item.record_id || item.id || "",
      fields: item.fields || {}
    })));

  for (const snapshot of snapshots) {
    let sourceResult;
    if (snapshot.error) {
      sourceResult = {
        source: describeBitableSource(snapshot.source),
        total: 0,
        processed: 0,
        error: snapshot.error,
        results: []
      };
    } else if (!isTriggerSource(snapshot.source)) {
      sourceResult = {
        source: describeBitableSource(snapshot.source),
        total: snapshot.items.length,
        processed: 0,
        role: "lookup",
        results: []
      };
    } else {
      sourceResult = await syncBitableSource(snapshot.source, snapshot.items, lookupRecords);
    }

    sources.push(sourceResult);
    for (const item of sourceResult.results) {
      results.push({
        source: sourceResult.source,
        ...item
      });
    }
  }

  return {
    status: sources.some((source) => source.error) ? "partial" : "synced",
    sourceCount: sources.length,
    total: sources.reduce((sum, source) => sum + source.total, 0),
    processed: results.filter((item) => item.result).length,
    sources,
    results
  };
}

export async function syncConfiguredApprovalInstances() {
  if (!config.approval.bomApprovalCodes.length) {
    return {
      status: "blocked",
      reason: "Missing FEISHU_BOM_APPROVAL_CODES"
    };
  }

  const now = Date.now();
  const from = now - Math.max(1, config.approval.syncLookbackMinutes) * 60 * 1000;
  const queryStartFrom = now - Math.max(
    Math.max(1, config.approval.syncLookbackMinutes),
    Math.max(1, config.approval.queryStartLookbackMinutes || 0)
  ) * 60 * 1000;
  const sources = [];
  const results = [];

  for (const approvalCode of config.approval.bomApprovalCodes) {
    try {
      const instances = await queryApprovalInstances({
        approvalCode,
        startTimeFrom: queryStartFrom,
        startTimeTo: now
      });
      const sourceResults = [];
      for (const instance of instances) {
        if (!isApprovedStatus(instance.status)) {
          sourceResults.push({
            instanceCode: instance.instanceCode,
            serialNumber: instance.serialNumber,
            status: "skipped_not_approved",
            approvalStatus: instance.status
          });
          continue;
        }
        const completionWindow = getApprovalCompletionWindowState(instance, from);
        if (!completionWindow.ok) {
          sourceResults.push({
            instanceCode: instance.instanceCode,
            serialNumber: instance.serialNumber,
            status: completionWindow.status,
            approvalStatus: instance.status,
            endTime: instance.endTime
          });
          continue;
        }
        const result = await sendConfiguredApprovalInstance({ instanceCode: instance.instanceCode });
        sourceResults.push({
          instanceCode: instance.instanceCode,
          serialNumber: instance.serialNumber,
          result
        });
      }
      sources.push({
        approvalCode: maskToken(approvalCode),
        total: instances.length,
        processed: sourceResults.filter((item) => item.result?.result?.status === "sent").length,
        results: sourceResults
      });
      results.push(...sourceResults.map((item) => ({ approvalCode: maskToken(approvalCode), ...item })));
    } catch (error) {
      sources.push({
        approvalCode: maskToken(approvalCode),
        total: 0,
        processed: 0,
        error: error.message,
        results: []
      });
    }
  }

  return {
    status: sources.some((source) => source.error) ? "partial" : "synced",
    sourceCount: sources.length,
    processed: results.filter((item) => item.result?.result?.status === "sent").length,
    sources,
    results
  };
}

function getApprovalCompletionWindowState(instance, completedAfter) {
  const endTime = Number(instance.endTime || 0);
  if (!Number.isFinite(endTime) || endTime <= 0) {
    return { ok: false, status: "skipped_missing_completion_time" };
  }
  if (endTime < completedAfter) {
    return { ok: false, status: "skipped_outside_completion_window" };
  }
  return { ok: true, status: "inside_completion_window" };
}

export async function sendConfiguredBitableRecord({ sourceName = "", recordId = "", force = false } = {}) {
  if (!recordId) {
    return { status: "blocked", reason: "Missing recordId" };
  }

  const source = config.bitable.sources.find((item) => {
    return item.name === sourceName || item.tableId === sourceName || (!sourceName && isTriggerSource(item));
  });
  if (!source) {
    return { status: "blocked", reason: "未找到指定BOM触发表" };
  }
  if (!isTriggerSource(source)) {
    return { status: "blocked", reason: `${source.name} 不是邮件触发表`, source: describeBitableSource(source) };
  }

  const [item, lookupRecords] = await Promise.all([
    getBitableRecord(source, recordId),
    listConfiguredLookupRecords()
  ]);
  const fields = item.fields || {};
  const sourceId = getBitableSourceId(source);
  const recordKey = `${sourceId}:${recordId}`;
  const businessKey = getBusinessSendStateKey(fields);
  const fingerprint = createRecordFingerprint(sourceId, recordId, fields);

  if (!force) {
    const businessState = await readPersistentRecordState(businessKey);
    if (businessState?.status === "sent") {
      return {
        status: "skipped_business_sent",
        source: describeBitableSource(source),
        recordId,
        approvalStatus: getRecordReadiness(fields).statusText,
        businessKey: maskBusinessKey(businessKey)
      };
    }
    const persistentState = await readPersistentRecordState(recordKey);
    if (persistentState?.status === "sent") {
      return {
        status: "skipped_persisted_sent",
        source: describeBitableSource(source),
        recordId,
        approvalStatus: getRecordReadiness(fields).statusText,
        fingerprintChanged: persistentState.fingerprint !== fingerprint
      };
    }
  }

  const enrichedFields = await enrichTriggerRecord(fields, lookupRecords);
  const result = await processBusinessRecord(enrichedFields, {
    readinessRecord: fields,
    routeRecord: fields
  });
  if (result.status === "sent") {
    const sentState = {
      fingerprint,
      status: "sent",
      statusText: getRecordReadiness(fields).statusText,
      sentAt: new Date().toISOString(),
      sentBy: force ? "manual_force" : "manual"
    };
    await writePersistentRecordState(recordKey, sentState);
    await writePersistentRecordState(businessKey, {
      ...sentState,
      sourceKey: recordKey
    });
  }

  return {
    status: "processed",
    source: describeBitableSource(source),
    recordId,
    result
  };
}

export async function sendConfiguredApprovalInstance({ instanceCode = "", force = false } = {}) {
  if (!instanceCode) {
    return { status: "blocked", reason: "Missing instanceCode" };
  }

  const [approvalRecord, lookupRecords, triggerRecords] = await Promise.all([
    fetchApprovalInstanceRecord(instanceCode),
    listConfiguredLookupRecords(),
    listConfiguredTriggerRecords()
  ]);
  if (!isConfiguredBomApproval(approvalRecord)) {
    return {
      status: "skipped_non_bom_approval",
      source: {
        name: approvalRecord.approvalName,
        approvalCode: maskToken(approvalRecord.approvalCode),
        instanceCode: approvalRecord.instanceCode,
        serialNumber: approvalRecord.serialNumber,
        role: "approval_trigger"
      }
    };
  }
  if (!isApprovedStatus(approvalRecord.rawStatus)) {
    return {
      status: "skipped_final_status_not_approved",
      source: {
        name: approvalRecord.approvalName,
        instanceCode: approvalRecord.instanceCode,
        serialNumber: approvalRecord.serialNumber,
        role: "approval_trigger"
      },
      approvalStatus: approvalRecord.rawStatus,
      statusText: getRecordReadiness(approvalRecord.fields).statusText
    };
  }
  const recordKey = `approval:${approvalRecord.approvalCode || ""}:${approvalRecord.instanceCode}`;
  const businessKey = getBusinessSendStateKey(approvalRecord.fields, approvalRecord.serialNumber);
  const fingerprint = createRecordFingerprint("approval", approvalRecord.instanceCode, approvalRecord.fields);

  if (!force) {
    const businessState = await readPersistentRecordState(businessKey);
    if (businessState?.status === "sent") {
      return {
        status: "skipped_business_sent",
        source: {
          name: approvalRecord.approvalName,
          instanceCode: approvalRecord.instanceCode,
          serialNumber: approvalRecord.serialNumber,
          role: "approval_trigger"
        },
        businessKey: maskBusinessKey(businessKey)
      };
    }
    const persistentState = await readPersistentRecordState(recordKey);
    if (persistentState?.status === "sent") {
      return {
        status: "skipped_persisted_sent",
        source: {
          name: approvalRecord.approvalName,
          instanceCode: approvalRecord.instanceCode,
          serialNumber: approvalRecord.serialNumber,
          role: "approval_trigger"
        },
        fingerprintChanged: persistentState.fingerprint !== fingerprint
      };
    }
  }

  const approvalBaseFields = await mergeApprovalWithMatchingTriggerFields(approvalRecord, triggerRecords);
  const enrichedFields = await enrichTriggerRecord(approvalBaseFields, lookupRecords);
  const result = await processBusinessRecord(enrichedFields, {
    readinessRecord: approvalRecord.fields,
    routeRecord: enrichedFields
  });
  if (result.status === "sent") {
    const sentState = {
      fingerprint,
      status: "sent",
      statusText: getRecordReadiness(approvalRecord.fields).statusText,
      sentAt: new Date().toISOString(),
      sentBy: force ? "approval_manual_force" : "approval_manual"
    };
    await writePersistentRecordState(recordKey, sentState);
    await writePersistentRecordState(businessKey, {
      ...sentState,
      sourceKey: recordKey
    });
  }

  return {
    status: "processed",
    source: {
      name: approvalRecord.approvalName,
      instanceCode: approvalRecord.instanceCode,
      serialNumber: approvalRecord.serialNumber,
      role: "approval_trigger"
    },
    result
  };
}

export async function processApprovalInstanceEvent(eventBody) {
  const event = eventBody.event || eventBody;
  const instanceCode = event.instance_code || event.instanceCode || event.uuid || "";
  const approvalCode = event.approval_code || event.approvalCode || "";
  const status = event.status || event.instance_status || event.instanceStatus || event.approval_status || "";
  const eventType = getFeishuEventType(eventBody);
  const looksLikeApprovalEvent = /approval/i.test(String(eventType))
    || Boolean(instanceCode && (approvalCode || status));

  if (!looksLikeApprovalEvent || !instanceCode) return null;
  if (approvalCode && config.approval.bomApprovalCodes.length && !config.approval.bomApprovalCodes.includes(approvalCode)) {
    return {
      status: "skipped_non_bom_approval",
      reason: "审批定义不在BOM释放审批配置内",
      approvalCode: maskToken(approvalCode),
      instanceCode
    };
  }
  if (status && !isApprovedStatus(status)) {
    return {
      status: "skipped_not_approved",
      approvalStatus: status,
      approvalCode: maskToken(approvalCode),
      instanceCode
    };
  }

  return sendConfiguredApprovalInstance({ instanceCode });
}

async function listConfiguredLookupRecords() {
  const lookupRecords = [];
  for (const source of config.bitable.sources.filter(isLookupSource)) {
    const items = await listBitableRecords(source);
    lookupRecords.push(...items.map((item) => ({
      source,
      recordId: item.record_id || item.id || "",
      fields: item.fields || {}
    })));
  }
  return lookupRecords;
}

async function listConfiguredTriggerRecords() {
  const triggerRecords = [];
  for (const source of config.bitable.sources.filter(isTriggerSource)) {
    const items = await listBitableRecords(source);
    triggerRecords.push(...items.map((item) => ({
      source,
      recordId: item.record_id || item.id || "",
      fields: item.fields || {}
    })));
  }
  return triggerRecords;
}

async function listBitableRecords(source) {
  const items = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (pageToken) params.set("page_token", pageToken);

    const data = await feishuApi(
      `/bitable/v1/apps/${encodeURIComponent(source.appToken)}/tables/${encodeURIComponent(source.tableId)}/records?${params}`
    );
    const pageItems = data.data?.items || [];
    items.push(...await Promise.all(pageItems.map((item) => hydrateBitableRecord(source, item))));

    pageToken = data.data?.page_token || "";
    if (!data.data?.has_more) break;
  } while (pageToken);

  return items;
}

async function hydrateBitableRecord(source, item) {
  if (item?.fields && Object.keys(item.fields).length) return item;

  const recordId = item?.record_id || item?.id || "";
  if (!recordId) return item;

  return getBitableRecord(source, recordId);
}

async function getBitableRecord(source, recordId) {
  const data = await feishuApi(
    `/bitable/v1/apps/${encodeURIComponent(source.appToken)}/tables/${encodeURIComponent(source.tableId)}/records/${encodeURIComponent(recordId)}`
  );
  return data.data?.record || {};
}

async function syncBitableSource(source, items, lookupRecords) {
  const sourceId = getBitableSourceId(source);
  const results = [];
  for (const item of items) {
    const fields = item.fields || {};
    const recordId = item.record_id || item.id || "";
    const recordKey = `${sourceId}:${recordId}`;

    if (!Object.keys(fields).length) {
      results.push({ recordId, status: "skipped_empty" });
      continue;
    }

    const readiness = getRecordReadiness(fields);
    const previousStatus = recordStatusByKey.get(recordKey) || "";
    const fingerprint = createRecordFingerprint(sourceId, recordId, fields);
    const businessKey = getBusinessSendStateKey(fields);
    if (processedRecordFingerprints.has(fingerprint)) {
      results.push({ recordId, status: "skipped_duplicate" });
      continue;
    }

    if (config.bitable.skipExistingOnStart && !bootstrappedBitableSources.has(sourceId)) {
      const recentReady = isRecentReadyDuringBootstrap(fields, readiness);
      if (!recentReady) {
        processedRecordFingerprints.add(fingerprint);
        recordStatusByKey.set(recordKey, readiness.statusText);
        results.push({ recordId, status: "skipped_baseline" });
        continue;
      }
    }

    if (readiness.ok && isReadyStatus(previousStatus)) {
      processedRecordFingerprints.add(fingerprint);
      recordStatusByKey.set(recordKey, readiness.statusText);
      results.push({ recordId, status: "skipped_already_ready", approvalStatus: readiness.statusText });
      continue;
    }

    try {
      const businessState = await readPersistentRecordState(businessKey);
      if (businessState?.status === "sent") {
        processedRecordFingerprints.add(fingerprint);
        recordStatusByKey.set(recordKey, readiness.statusText);
        results.push({
          recordId,
          status: "skipped_business_sent",
          approvalStatus: readiness.statusText,
          businessKey: maskBusinessKey(businessKey)
        });
        continue;
      }
      const persistentState = await readPersistentRecordState(recordKey);
      if (persistentState?.status === "sent") {
        processedRecordFingerprints.add(fingerprint);
        recordStatusByKey.set(recordKey, readiness.statusText);
        results.push({
          recordId,
          status: "skipped_persisted_sent",
          approvalStatus: readiness.statusText,
          fingerprintChanged: persistentState.fingerprint !== fingerprint
        });
        continue;
      }

      const enrichedFields = await enrichTriggerRecord(fields, lookupRecords);
      const result = await processBusinessRecord(enrichedFields, {
        readinessRecord: fields,
        routeRecord: fields
      });
      if (result.status !== "blocked") {
        processedRecordFingerprints.add(fingerprint);
        recordStatusByKey.set(recordKey, readiness.statusText);
      }
      if (result.status === "sent") {
        const sentState = {
          fingerprint,
          status: "sent",
          statusText: readiness.statusText,
          sentAt: new Date().toISOString()
        };
        await writePersistentRecordState(recordKey, sentState);
        await writePersistentRecordState(businessKey, {
          ...sentState,
          sourceKey: recordKey
        });
      }
      results.push({ recordId, result });
    } catch (error) {
      results.push({ recordId, status: "failed", error: error.message });
    }
  }

  bootstrappedBitableSources.add(sourceId);
  return {
    source: describeBitableSource(source),
    total: items.length,
    processed: results.filter((item) => item.result).length,
    results
  };
}

const bootstrappedBitableSources = new Set();

function getBitableSourceId(source) {
  return `${source.appToken}:${source.tableId}`;
}

function describeBitableSource(source) {
  return {
    name: source.name,
    appToken: maskToken(source.appToken),
    tableId: source.tableId,
    role: isTriggerSource(source) ? "trigger" : "lookup"
  };
}

function isTriggerSource(source) {
  return config.bitable.triggerSourceNames.includes(source.name);
}

function isLookupSource(source) {
  return config.bitable.lookupSourceNames.includes(source.name) || !isTriggerSource(source);
}

async function enrichTriggerRecord(triggerFields, lookupRecords) {
  const enrichedTriggerFields = await enrichFieldsFromApprovalForm(triggerFields);
  const relatedRecords = findRelatedLookupRecords(enrichedTriggerFields, lookupRecords);
  if (!relatedRecords.length) return enrichedTriggerFields;

  const merged = {};
  const lookupSourceIds = [];
  for (const related of relatedRecords) {
    const relatedFields = await enrichFieldsFromApprovalForm(related.fields);
    if (relatedFields?.SourceID) lookupSourceIds.push(relatedFields.SourceID);
    Object.assign(merged, omitBomOwnedFields(relatedFields));
  }

  return {
    ...merged,
    __lookupSourceIDs: lookupSourceIds,
    ...enrichedTriggerFields
  };
}

async function mergeApprovalWithMatchingTriggerFields(approvalRecord, triggerRecords) {
  const matched = findMatchingTriggerRecordForApproval(approvalRecord, triggerRecords);
  if (!matched) return approvalRecord.fields;

  const triggerFields = await enrichFieldsFromApprovalForm(matched.fields || {});
  return {
    ...approvalRecord.fields,
    ...triggerFields,
    SourceID: approvalRecord.fields?.SourceID || triggerFields.SourceID || "",
    "申请状态": approvalRecord.fields?.["申请状态"] || triggerFields["申请状态"] || "",
    "申请编号": approvalRecord.fields?.["申请编号"] || triggerFields["申请编号"] || approvalRecord.serialNumber || "",
    "发起时间": approvalRecord.fields?.["发起时间"] || triggerFields["发起时间"] || "",
    "完成时间": approvalRecord.fields?.["完成时间"] || triggerFields["完成时间"] || "",
    "审批流程": approvalRecord.fields?.["审批流程"] || triggerFields["审批流程"] || "",
    __matchedTriggerSourceID: getBitableSourceId(matched.source),
    __matchedTriggerRecordID: matched.recordId
  };
}

function findMatchingTriggerRecordForApproval(approvalRecord, triggerRecords) {
  const serialNumber = normalizeBusinessSerialNumber(
    approvalRecord.serialNumber || approvalRecord.fields?.["申请编号"] || ""
  );
  if (!serialNumber) return null;

  return triggerRecords.find((record) => {
    const fields = record.fields || {};
    const recordSerialNumber = normalizeBusinessSerialNumber(
      fields["申请编号"]
      || getField(fields, "applicationNo")
      || fields["审批编号"]
      || fields["单号"]
    );
    return recordSerialNumber === serialNumber;
  }) || null;
}

async function enrichFieldsFromApprovalForm(fields) {
  const instanceCode = extractApprovalInstanceCodeFromSourceId(fields?.SourceID || "");
  if (!instanceCode) return fields;

  if (!approvalFormFieldCache.has(instanceCode)) {
    approvalFormFieldCache.set(instanceCode, fetchApprovalFormFields(instanceCode));
  }

  try {
    const formFields = await approvalFormFieldCache.get(instanceCode);
    return mergeFieldsWithoutBlankOverwrite(fields, formFields);
  } catch {
    return fields;
  }
}

function mergeFieldsWithoutBlankOverwrite(baseFields, extraFields) {
  const merged = { ...(baseFields || {}) };
  for (const [fieldName, value] of Object.entries(extraFields || {})) {
    if (hasFieldValue(merged[fieldName]) && !hasFieldValue(value)) continue;
    if (hasFieldValue(merged[fieldName]) && isRelationCandidateField(fieldName)) continue;
    merged[fieldName] = value;
  }
  return merged;
}

function hasFieldValue(value) {
  return value !== undefined && value !== null && value !== "" && valueToText(value) !== "";
}

async function fetchApprovalFormFields(instanceCode) {
  const record = await fetchApprovalInstanceRecord(instanceCode);
  return record.fields;
}

async function fetchApprovalInstanceRecord(instanceCode) {
  const data = await feishuApi(`/approval/v4/instances/${encodeURIComponent(instanceCode)}`);
  const instance = data.data || {};
  const statusText = approvalStatusToReadyText(instance.status);
  const fields = {
    ...approvalFormToFields(parseApprovalForm(instance.form)),
    SourceID: instance.instance_code || instanceCode,
    "发起人": {
      user_id: instance.user_id || "",
      open_id: instance.open_id || ""
    },
    "申请状态": statusText,
    "申请编号": instance.serial_number || "",
    "发起时间": instance.start_time || "",
    "完成时间": instance.end_time || "",
    "审批流程": instance.approval_name || ""
  };

  return {
    approvalCode: instance.approval_code || "",
    approvalName: instance.approval_name || "",
    instanceCode: instance.instance_code || instanceCode,
    serialNumber: instance.serial_number || "",
    rawStatus: instance.status || "",
    fields
  };
}

async function queryApprovalInstances({ approvalCode, startTimeFrom, startTimeTo }) {
  const instances = [];
  let pageToken = "";

  for (let page = 0; page < 20; page += 1) {
    const body = {
      approval_code: approvalCode,
      instance_start_time_from: String(startTimeFrom),
      instance_start_time_to: String(startTimeTo),
      page_size: 100,
      locale: "zh-CN",
      ...(pageToken ? { page_token: pageToken } : {})
    };
    const data = await feishuApi("/approval/v4/instances/query", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const pageInstances = data.data?.instance_list || [];
    instances.push(...pageInstances);
    const nextPageToken = data.data?.page_token
      || data.data?.pageToken
      || data.data?.next_page_token
      || data.data?.nextPageToken
      || "";
    const hasMore = Boolean(data.data?.has_more || data.data?.hasMore || nextPageToken);
    if (!hasMore || !nextPageToken) break;
    pageToken = nextPageToken;
  }

  return instances.map(normalizeQueriedApprovalInstance).filter((item) => item.instanceCode);
}

function normalizeQueriedApprovalInstance(item) {
  const instance = item.instance || item;
  return {
    instanceCode: item.instance_code || instance.code || instance.instance_code || "",
    serialNumber: item.serial_number || instance.serial_id || instance.serial_number || "",
    status: item.status || instance.status || "",
    startTime: item.start_time || instance.start_time || "",
    endTime: item.end_time || instance.end_time || ""
  };
}

function isConfiguredBomApproval(approvalRecord) {
  if (config.approval.bomApprovalCodes.length
    && !config.approval.bomApprovalCodes.includes(approvalRecord.approvalCode)) {
    return false;
  }
  if (config.approval.bomApprovalNames.length
    && !config.approval.bomApprovalNames.includes(approvalRecord.approvalName)) {
    return false;
  }
  return true;
}

function isApprovedStatus(status) {
  const text = String(status || "").trim().toUpperCase();
  return text === "APPROVED" || text === "APPROVE" || text === "PASS" || text === "PASSED" || text === "已通过";
}

function approvalStatusToReadyText(status) {
  const text = String(status || "").toUpperCase();
  if (text === "APPROVED") return "已通过";
  if (text === "REJECTED") return "已拒绝";
  if (text === "CANCELED" || text === "CANCELLED") return "已撤回";
  return status || "";
}

function approvalFormToFields(formItems) {
  const fields = {};
  for (const item of formItems) {
    if (!item?.name || item.type === "text") continue;
    if (item.type === "attachmentV2") {
      fields[item.name] = getApprovalAttachmentValue(item);
      continue;
    }
    if (item.type === "fieldList") {
      fields[item.name] = parseApprovalFieldListRows(item.value);
      continue;
    }
    fields[item.name] = getApprovalItemValue(item);
  }
  return fields;
}

function parseApprovalFieldListRows(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!Array.isArray(row)) return null;
      const mapped = {};
      for (const cell of row) {
        if (cell?.name) mapped[cell.name] = getApprovalItemValue(cell);
      }
      return mapped;
    })
    .filter((row) => row && Object.values(row).some((item) => valueToText(item)));
}

function getApprovalItemValue(item) {
  if (item?.type === "connect" && item?.ext?.serialIDs) return item.ext.serialIDs;
  if (item?.type === "contact") return getApprovalContactValue(item);
  if (item?.option?.text) return item.option.text;
  return item?.value ?? "";
}

function getApprovalContactValue(item) {
  const userIds = Array.isArray(item.value) ? item.value : [item.value].filter(Boolean);
  const openIds = Array.isArray(item.open_ids) ? item.open_ids : [];
  return userIds.map((userId, index) => ({
    user_id: userId,
    open_id: openIds[index] || ""
  }));
}

function getApprovalAttachmentValue(item) {
  const urls = Array.isArray(item.value) ? item.value : [item.value].filter(Boolean);
  const names = getApprovalAttachmentNames(item, urls.length);
  return urls.map((url, index) => ({
    url,
    name: names[index] || item.name || "attachment"
  }));
}

function omitBomOwnedFields(fields) {
  const protectedKeys = [
    "projectNameOrCode",
    "version",
    "brand",
    "phase",
    "approvalStatus",
    "initiator",
    "projectManager",
    "assemblyFactory",
    "bomType",
    "changeLog",
    "bomAttachments",
    "previousBomAttachment"
  ];
  const aliases = new Set(protectedKeys.flatMap((key) => {
    const configured = config.fieldMapping[key] || key;
    return Array.isArray(configured) ? configured : [configured];
  }));
  return Object.fromEntries(Object.entries(fields || {}).filter(([fieldName]) => !aliases.has(fieldName)));
}

function findRelatedLookupRecords(triggerFields, lookupRecords) {
  const triggerCandidates = getRelationCandidates(triggerFields);
  if (!triggerCandidates.length) return [];
  const triggerTokens = getEmbeddedRelationTokens(triggerFields);

  return lookupRecords.filter((lookupRecord) => {
    const lookupTokens = getEmbeddedRelationTokens(lookupRecord.fields);
    if (triggerTokens.some((token) => lookupTokens.includes(token))) return true;

    const lookupCandidates = getRelationCandidates(lookupRecord.fields);
    return triggerCandidates.some((triggerValue) => {
      return lookupCandidates.some((lookupValue) => relationMatches(triggerValue, lookupValue));
    });
  });
}

function getRelationCandidates(fields) {
  const directValues = [
    getField(fields, "ecnNumber"),
    fields["关联审批字段"],
    fields["关联ECN"],
    fields["ECN关联"],
    fields["关联ECN审批"],
    fields["ECN关联审批"],
    fields["关联ECR审批"],
    fields["SourceID"],
    fields["申请编号"]
  ];

  const rawValues = directValues
    .concat(collectRelationCandidateValues(fields))
    .concat(collectEmbeddedRelationValues(fields));

  return [...new Set(rawValues
    .flatMap((value) => {
      const text = valueToText(value);
      return [
        ...text.split(/[、,，;；\n\r]/),
        ...extractRelationTokens(text)
      ];
    })
    .map(normalizeRelationValue)
    .filter((value) => value.length >= 4))];
}

function collectRelationCandidateValues(fields) {
  return Object.entries(fields || {})
    .filter(([fieldName]) => isRelationCandidateField(fieldName))
    .map(([, value]) => value);
}

function isRelationCandidateField(fieldName) {
  const name = String(fieldName || "");
  return /ECN|ECR|SourceID/i.test(name)
    || name.includes("关联")
    || name.includes("申请编号")
    || name.includes("审批编号");
}

function collectEmbeddedRelationValues(fields) {
  return getEmbeddedRelationTokens(fields);
}

function getEmbeddedRelationTokens(fields) {
  return [...new Set(Object.values(fields || {}).flatMap((value) => {
    const text = valueToText(value);
    return extractRelationTokens(text);
  }).map(normalizeRelationValue).filter(Boolean))];
}

function extractRelationTokens(text) {
  const value = String(text || "");
  const decoded = decodeMaybeBase64(value);
  const values = decoded === value ? [value] : [value, decoded];
  return values.flatMap((item) => [
    ...(item.match(/\b\d{12,}\b/g) || []),
    ...(item.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []),
    ...(item.match(/\b(?:ECN|ECR)-[A-Z0-9][A-Z0-9._-]*/gi) || [])
  ]);
}

function relationMatches(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 8 && right.includes(left)) return true;
  if (right.length >= 8 && left.includes(right)) return true;
  return false;
}

function normalizeRelationValue(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[，。；;、]/g, "");
}

function maskToken(value) {
  const text = String(value || "");
  if (text.length <= 10) return text ? "***" : "";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

async function readPersistentRecordState(recordKey) {
  if (!isUpstashConfigured()) return null;

  try {
    const data = await upstashRequest(`/get/${encodeURIComponent(getPersistentRecordStateKey(recordKey))}`);
    if (data.result === null || data.result === undefined || data.result === "") return null;
    return typeof data.result === "object" ? data.result : JSON.parse(String(data.result));
  } catch {
    return null;
  }
}

async function writePersistentRecordState(recordKey, state) {
  if (!isUpstashConfigured()) return;

  try {
    await upstashRequest(`/set/${encodeURIComponent(getPersistentRecordStateKey(recordKey))}`, {
      method: "POST",
      body: JSON.stringify(state)
    });
  } catch {
    // Persistent dedupe is a protection layer; a write failure should not make a sent mail look failed.
  }
}

function getPersistentRecordStateKey(recordKey) {
  const hash = crypto.createHash("sha256").update(recordKey).digest("hex");
  return `feishu:bitable-record-state:${hash}`;
}

function isUpstashConfigured() {
  return Boolean(config.upstash.redisRestUrl && config.upstash.redisRestToken);
}

async function upstashRequest(pathname, options = {}) {
  const baseUrl = config.upstash.redisRestUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${config.upstash.redisRestToken}`,
      "content-type": "text/plain; charset=utf-8",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.error) {
    const message = data.error || data.message || response.statusText;
    throw new Error(`Upstash Redis failed: ${message}`);
  }

  return data;
}

export function mapFeishuEventToRecord(eventBody) {
  const event = eventBody.event || eventBody;
  const fields = event.fields || event.record?.fields || event.form || event.data || {};
  return fields && typeof fields === "object" ? fields : {};
}

export function guardFeishuEventTriggerSource(eventBody) {
  const eventType = getFeishuEventType(eventBody);
  const eventSource = extractFeishuEventBitableSource(eventBody);
  const hasSource = eventSource.appTokens.length || eventSource.tableIds.length;
  const looksLikeBitableEvent = isBitableEvent(eventBody, eventType);

  if (!hasSource && !looksLikeBitableEvent) {
    return { ok: true, reason: "event_source_not_required" };
  }

  if (!hasSource) {
    return {
      ok: false,
      status: "skipped_unknown_bitable_source",
      reason: "无法确认事件来源为BOM触发表，已跳过发送"
    };
  }

  const matchedSource = config.bitable.sources.find((source) => eventSourceMatches(source, eventSource));
  if (!matchedSource) {
    return {
      ok: false,
      status: "skipped_unconfigured_bitable_source",
      reason: "事件来源表不在当前配置内，已跳过发送",
      eventSource
    };
  }

  if (!isTriggerSource(matchedSource)) {
    return {
      ok: false,
      status: "skipped_lookup_source",
      reason: `事件来源为${matchedSource.name}，该表仅用于带出ECN内容，不触发邮件`,
      source: describeBitableSource(matchedSource)
    };
  }

  return {
    ok: true,
    reason: "trigger_source_matched",
    source: describeBitableSource(matchedSource)
  };
}

export function summarizeFeishuEvent(eventBody) {
  const header = eventBody.header || {};
  const event = eventBody.event || eventBody;
  const eventId = header.event_id || eventBody.uuid || event.uuid || event.instance_code || event.record_id || "";
  const eventType = getFeishuEventType(eventBody);
  const record = mapFeishuEventToRecord(eventBody);

  return {
    eventId,
    eventType,
    topLevelKeys: Object.keys(eventBody || {}).slice(0, 20),
    eventKeys: Object.keys(event || {}).slice(0, 30),
    parsedFieldKeys: Object.keys(record || {}).slice(0, 30)
  };
}

function getFeishuEventType(eventBody) {
  const header = eventBody.header || {};
  const event = eventBody.event || eventBody;
  return header.event_type || eventBody.type || event.type || event.event_type || "";
}

function isBitableEvent(eventBody, eventType) {
  const event = eventBody.event || eventBody;
  return /bitable|base|record/i.test(String(eventType || ""))
    || Boolean(event.record || event.record_id || event.recordId || event.fields);
}

function extractFeishuEventBitableSource(eventBody) {
  return {
    appTokens: collectValuesByKeys(eventBody, ["app_token", "appToken", "base_token", "baseToken", "obj_token", "objToken"]),
    tableIds: collectValuesByKeys(eventBody, ["table_id", "tableId", "table_token", "tableToken"])
  };
}

function collectValuesByKeys(root, keys) {
  const normalizedKeys = new Set(keys.map(normalizeEventKey));
  const values = [];
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (normalizedKeys.has(normalizeEventKey(key))) {
        const text = valueToText(child).trim();
        if (text) values.push(text);
      }
      visit(child);
    }
  }

  visit(root);
  return [...new Set(values)];
}

function normalizeEventKey(key) {
  return String(key || "").toLowerCase().replace(/[_-]/g, "");
}

function eventSourceMatches(source, eventSource) {
  const appTokenMatched = !eventSource.appTokens.length || eventSource.appTokens.includes(source.appToken);
  const tableIdMatched = !eventSource.tableIds.length || eventSource.tableIds.includes(source.tableId);
  return appTokenMatched && tableIdMatched;
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

function getChangeDescriptionParts(record) {
  return getChangeDescriptionRows(record)[0] || {};
}

function getChangeDescriptionRows(record) {
  const explicit = normalizeChangeDescriptionRow({
    before: getField(record, "changeBefore"),
    beforeSupplement: getField(record, "changeBeforeSupplement"),
    after: getField(record, "changeAfter"),
    afterSupplement: getField(record, "changeAfterSupplement"),
    executionMode: getField(record, "executionMode")
  });
  const rows = getFieldValues(record, "changeDescription")
    .flatMap(parseChangeDescriptionValue)
    .filter((row) => Object.values(row).some((value) => valueToText(value)));

  if (rows.length) return rows;
  if (Object.values(explicit).some((value) => valueToText(value))) return [explicit];
  return [];
}

function parseChangeDescriptionValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    if (value.every((row) => Array.isArray(row))) {
      return value.map(parseApprovalFieldListRow).filter(Boolean);
    }
    if (value.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      return value.map(normalizeChangeDescriptionRow).filter((row) => Object.values(row).some((item) => valueToText(item)));
    }
    return value.flatMap(parseChangeDescriptionValue);
  }
  if (typeof value === "object") {
    return [normalizeChangeDescriptionRow(value)].filter((row) => Object.values(row).some((item) => valueToText(item)));
  }

  const rawText = String(value || "").trim();
  if (!rawText) return [];
  return parseChangeDescriptionTextRows(rawText);
}

function parseChangeDescriptionTextRows(rawText) {
  const rowTexts = splitChangeDescriptionTextRows(rawText);
  return rowTexts
    .map((rowText) => {
      const parsed = parseLabeledChangeDescription(rowText);
      return normalizeChangeDescriptionRow({
        before: parsed.before || (parsed.hasAny ? "" : rowText),
        beforeSupplement: parsed.beforeSupplement || "",
        after: parsed.after || "",
        afterSupplement: parsed.afterSupplement || "",
        executionMode: parsed.executionMode || ""
      });
    })
    .filter((row) => Object.values(row).some((item) => valueToText(item)));
}

function splitChangeDescriptionTextRows(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];
  const rows = text
    .split(/[;；]\s*(?=变更前\s*[:：])/)
    .map((row) => row.trim())
    .filter(Boolean);
  return rows.length ? rows : [text];
}

function parseApprovalFieldListRow(row) {
  if (!Array.isArray(row)) return null;
  const mapped = {};
  for (const item of row) {
    if (item?.name) mapped[item.name] = getApprovalItemValue(item);
  }
  return normalizeChangeDescriptionRow(mapped);
}

function normalizeChangeDescriptionRow(row) {
  return {
    before: pickChangeField(row, ["before", "变更前"]),
    beforeSupplement: pickChangeField(row, ["beforeSupplement", "变更前补充描述", "变更前描述补充"]),
    after: pickChangeField(row, ["after", "变更后"]),
    afterSupplement: pickChangeField(row, ["afterSupplement", "变更后补充描述", "变更后描述补充"]),
    executionMode: pickChangeField(row, ["executionMode", "执行方式"])
  };
}

function pickChangeField(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function parseLabeledChangeDescription(text) {
  const labels = [
    ["beforeSupplement", "变更前补充描述"],
    ["beforeSupplement", "变更前描述补充"],
    ["afterSupplement", "变更后补充描述"],
    ["afterSupplement", "变更后描述补充"],
    ["executionMode", "执行方式"],
    ["before", "变更前"],
    ["after", "变更后"]
  ];
  const labelLookup = new Map(labels.map(([key, label]) => [label, key]));
  const pattern = new RegExp(`(${labels.map(([, label]) => escapeRegExp(label)).join("|")})\\s*[:：]`, "g");
  const matches = [...text.matchAll(pattern)];
  const result = { hasAny: false };
  if (!matches.length) return result;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const label = match[1];
    const key = labelLookup.get(label);
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const value = text.slice(start, end).replace(/^[\s|｜;；,，]+|[\s|｜;；,，]+$/g, "");
    if (key && value) {
      result[key] = value;
      result.hasAny = true;
    }
  }

  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function buildChangeDescriptionTable(rows) {
  const columns = [
    ["变更前", "before"],
    ["变更前补充描述", "beforeSupplement"],
    ["变更后", "after"],
    ["变更后补充描述", "afterSupplement"],
    ["执行方式", "executionMode"]
  ];
  const displayRows = rows.length ? rows : [{}];
  const headers = columns.map(([name]) => `<th align="left">${escapeHtml(name)}</th>`).join("");
  const bodyRows = displayRows.map((row) => {
    const values = columns.map(([name, key]) => `<td>${formatFieldHtml(row[key], name)}</td>`).join("");
    return `<tr>${values}</tr>`;
  }).join("");
  return `
    <h3 style="margin:20px 0 8px 0;font-size:16px;">变更描述</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;">
      <thead><tr>${headers}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

function formatFieldHtml(value, fieldName = "") {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) {
    return value.map((item) => formatFieldHtml(item, fieldName)).filter(Boolean).join("<br>");
  }
  if (typeof value === "number" && fieldName.includes("日期")) return formatDate(value);
  if (typeof value === "string" && fieldName.includes("日期") && isParsableDateString(value)) return formatDate(value);
  if (typeof value === "object") {
    const text = value.name || value.text || value.value || value.file_name || value.title || value.email || JSON.stringify(value);
    const fileToken = value.file_token || value.fileToken || value.token;
    if (fileToken) {
      return `${escapeHtml(String(text || "附件"))}（已作为邮件附件发送）`;
    }
    const href = value.url || value.link || value.tmp_url || value.download_url;
    if (href) {
      if (isAttachmentLikeField(fieldName)) {
        return `${escapeHtml(String(text || "附件"))}（已作为邮件附件发送）`;
      }
      return `<a href="${escapeHtml(String(href))}">${escapeHtml(String(text || href))}</a>`;
    }
    return escapeHtml(String(text));
  }
  if (isAttachmentLikeField(fieldName) && extractAttachmentRefs(value).length) {
    return "已作为邮件附件发送";
  }
  return escapeHtml(String(value));
}

export function collectAttachmentRefs(record) {
  const bomApprovalInstanceCodes = getApprovalInstanceCodesFromSourceIds([record.SourceID]);
  const ecnApprovalInstanceCodes = getApprovalInstanceCodesFromSourceIds(record.__lookupSourceIDs || []);
  const refs = [
    ...getFieldValues(record, "bomAttachments").flatMap((value) => extractAttachmentRefs(value, {
      approvalInstanceCodes: bomApprovalInstanceCodes
    })),
    ...getFieldValues(record, "ecnAttachments").flatMap((value) => extractAttachmentRefs(value, {
      approvalInstanceCodes: ecnApprovalInstanceCodes
    }))
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    const key = ref.fileToken || ref.url || `${ref.type}:${ref.name}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractAttachmentRefs(value, context = {}) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractAttachmentRefs(item, context));
  if (typeof value === "object") {
    const fileToken = value.file_token || value.fileToken || value.token;
    const name = value.name || value.file_name || value.filename || value.title || value.text || "attachment";
    if (fileToken) {
      return [{
        type: "media",
        fileToken,
        name
      }];
    }
    const href = value.url || value.link || value.tmp_url || value.download_url;
    return href ? extractAttachmentRefsFromText(href, name, context) : [];
  }
  return extractAttachmentRefsFromText(value, "attachment", context);
}

function extractAttachmentRefsFromText(value, fallbackName = "attachment", context = {}) {
  const text = String(value || "");
  const urls = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
  return urls.flatMap((url) => createAttachmentRefsFromUrl(url, fallbackName, context));
}

function createAttachmentRefsFromUrl(rawUrl, fallbackName = "attachment", context = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const token = pathParts[pathParts.length - 1] || "";
  if (!token) return [];

  if (url.pathname.includes("/file/")) {
    return [{
      type: "media",
      fileToken: token,
      name: normalizeAttachmentFilename(fallbackName, "bin"),
      url: rawUrl
    }];
  }

  if (url.pathname.includes("/sheets/")) {
    return [{
      type: "export",
      driveToken: token,
      driveType: "sheet",
      fileExtension: "xlsx",
      name: normalizeAttachmentFilename(fallbackName, "xlsx"),
      url: rawUrl
    }];
  }

  if (url.pathname.includes("/drive/folder/")) {
    return [{
      type: "drive_folder",
      name: normalizeAttachmentFilename(fallbackName, "zip"),
      url: rawUrl
    }];
  }

  if (url.pathname.includes("/docx/")) {
    return [{
      type: "export",
      driveToken: token,
      driveType: "docx",
      fileExtension: "docx",
      name: normalizeAttachmentFilename(fallbackName, "docx"),
      url: rawUrl
    }];
  }

  if (url.pathname.includes("/approval/admin/previewAttachment")) {
    return [{
      type: "approval_preview",
      name: normalizeAttachmentFilename(fallbackName, "bin"),
      url: rawUrl,
      approvalInstanceCodes: context.approvalInstanceCodes || []
    }];
  }

  if (url.hostname.includes("internal-api-drive-stream.feishu.cn")
    && url.pathname.includes("/space/api/box/stream/download/authcode/")) {
    return [{
      type: "direct_download",
      name: normalizeAttachmentFilename(fallbackName, "bin"),
      url: rawUrl
    }];
  }

  return [];
}

function getApprovalInstanceCodesFromSourceIds(values) {
  const sourceIds = Array.isArray(values) ? values : [values];
  const codes = sourceIds
    .map(extractApprovalInstanceCodeFromSourceId)
    .filter(Boolean);
  return [...new Set(codes)];
}

function extractApprovalInstanceCodeFromSourceId(value) {
  const text = valueToText(value).trim();
  if (!text) return "";

  const decoded = decodeMaybeBase64(text);
  const parts = decoded.split(":");
  for (const part of parts) {
    const match = part.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/i);
    if (match) return match[1];
  }
  return "";
}

function decodeMaybeBase64(value) {
  if (value.includes(":")) return value;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.includes(":") ? decoded : value;
  } catch {
    return value;
  }
}

function normalizeAttachmentFilename(value, extension) {
  const text = valueToText(value).trim() || "attachment";
  const safe = text.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "attachment";
  return /\.[A-Za-z0-9]{2,8}$/.test(safe) ? safe : `${safe}.${extension}`;
}

function isAttachmentLikeField(fieldName) {
  return String(fieldName || "").includes("附件");
}

async function downloadMailAttachments(attachmentRefs) {
  const attachments = [];
  const downloadedRefs = new Set();
  const downloadedAttachmentHashes = new Set();
  const pushAttachment = (attachment) => {
    const hash = crypto
      .createHash("sha256")
      .update(attachment.content)
      .digest("hex");
    const key = `${attachment.filename}:${hash}`;
    if (downloadedAttachmentHashes.has(key)) return;
    downloadedAttachmentHashes.add(key);
    attachments.push(attachment);
  };

  for (const ref of attachmentRefs) {
    if (ref.type === "direct_download") {
      if (downloadedRefs.has(ref.url)) continue;
      downloadedRefs.add(ref.url);
      pushAttachment(await downloadDirectUrlAttachment(ref.url, ref.name));
      continue;
    }
    if (ref.type === "approval_preview") {
      const approvalRefs = await resolveApprovalPreviewAttachmentRefs(ref);
      for (const approvalRef of approvalRefs) {
        if (downloadedRefs.has(approvalRef.url)) continue;
        downloadedRefs.add(approvalRef.url);
        pushAttachment(await downloadDirectUrlAttachment(approvalRef.url, approvalRef.name));
      }
      continue;
    }
    if (ref.type === "drive_folder") {
      throw new Error(`飞书文件夹链接不能直接作为单个邮件附件发送，请改为具体文件链接或附件字段：${ref.url}`);
    }
    if (ref.type === "export") {
      const key = `export:${ref.driveType}:${ref.driveToken}:${ref.fileExtension}`;
      if (downloadedRefs.has(key)) continue;
      downloadedRefs.add(key);
      const attachment = await exportFeishuDriveFile({
        token: ref.driveToken,
        type: ref.driveType,
        fileExtension: ref.fileExtension,
        filename: ref.name
      });
      pushAttachment(attachment);
      continue;
    }
    const key = `media:${ref.fileToken}`;
    if (downloadedRefs.has(key)) continue;
    downloadedRefs.add(key);
    pushAttachment(await downloadFeishuMediaWithUserFallback(ref.fileToken, ref.name));
  }
  return attachments;
}

async function resolveApprovalPreviewAttachmentRefs(ref) {
  const instanceCodes = ref.approvalInstanceCodes || [];
  if (!instanceCodes.length) {
    throw new Error(`审批预览附件缺少审批实例 SourceID，无法下载：${ref.name}`);
  }

  const refs = [];
  for (const instanceCode of instanceCodes) {
    const data = await feishuApi(`/approval/v4/instances/${encodeURIComponent(instanceCode)}`);
    const formItems = parseApprovalForm(data.data?.form);
    for (const item of formItems) {
      if (item?.type !== "attachmentV2") continue;
      const urls = Array.isArray(item.value) ? item.value : [item.value].filter(Boolean);
      const names = getApprovalAttachmentNames(item, urls.length);
      urls.forEach((url, index) => {
        if (url) {
          refs.push({
            type: "direct_download",
            url,
            name: normalizeAttachmentFilename(names[index] || item.name || ref.name, "bin")
          });
        }
      });
    }
  }

  if (!refs.length) {
    throw new Error(`审批实例未找到可下载附件：${ref.name}`);
  }
  return refs;
}

function parseApprovalForm(form) {
  if (Array.isArray(form)) return form;
  if (!form) return [];
  try {
    const parsed = JSON.parse(form);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getApprovalAttachmentNames(item, count) {
  const fallback = item.name || "attachment";
  if (Array.isArray(item.ext)) {
    return item.ext.map((name) => valueToText(name) || fallback);
  }
  const ext = valueToText(item.ext).trim();
  if (!ext) return Array.from({ length: count }, (_, index) => count > 1 ? `${fallback}-${index + 1}` : fallback);
  if (count <= 1) return [ext];
  return Array.from({ length: count }, (_, index) => `${ext}-${index + 1}`);
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
  const changeDescriptionRows = getChangeDescriptionRows(record);
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
    ["组装厂", route.assemblyFactory || valueToText(getField(record, "assemblyFactory"))],
    ["BOM类型", valueToText(getField(record, "bomType"))],
    ["变更记录", valueToText(getField(record, "changeLog"))],
    ["ECN编号", valueToText(getField(record, "ecnNumber"))],
    ["变更原因", valueToText(getField(record, "changeReason"))]
  ];
  for (const [name, value] of detailRows) {
    if (value) lines.push(`${name}：${value}`);
  }
  changeDescriptionRows.forEach((row, index) => {
    const parts = [
      ["变更前", valueToText(row.before)],
      ["变更前补充描述", valueToText(row.beforeSupplement)],
      ["变更后", valueToText(row.after)],
      ["变更后补充描述", valueToText(row.afterSupplement)],
      ["执行方式", valueToText(row.executionMode)]
    ].filter(([, value]) => value);
    if (parts.length) {
      lines.push(`变更描述${changeDescriptionRows.length > 1 ? index + 1 : ""}：${parts.map(([name, value]) => `${name}：${value}`).join("；")}`);
    }
  });

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

function isParsableDateString(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(text) && !Number.isNaN(new Date(text).getTime());
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

function getRecordReadiness(record) {
  const statusText = valueToText(getField(record, "approvalStatus")).trim();
  if (!statusText) {
    return { ok: false, statusText, reason: "缺少审批/完成状态字段" };
  }
  if (!isReadyStatus(statusText)) {
    return { ok: false, statusText, reason: `状态未完成：${statusText}` };
  }
  return { ok: true, statusText };
}

function isRecentReadyDuringBootstrap(record, readiness) {
  if (!readiness.ok) return false;

  const timestamp = getRecordBusinessTimestamp(record);
  if (!timestamp) return false;

  const windowMs = Math.max(0, config.bitable.bootstrapRecentReadyWindowMinutes) * 60 * 1000;
  return timestamp >= serviceStartedAt - windowMs;
}

function getRecordBusinessTimestamp(record) {
  const candidates = [
    record["完成时间"],
    record["更新时间"],
    record["最后更新时间"],
    record["发起时间"],
    record["创建时间"]
  ];

  for (const value of candidates) {
    const timestamp = Number(valueToText(value));
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return 0;
}

function isReadyStatus(statusText) {
  const text = String(statusText || "").trim();
  if (!text) return false;
  return config.readyStatusValues.some((status) => text === status);
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

async function resolveDynamicRecipientEmails(record) {
  const values = [
    ...getFieldValues(record, "initiator"),
    ...getFieldValues(record, "projectManager")
  ];
  const emails = [
    ...values.flatMap(extractEmails),
    ...values.flatMap(extractMappedContactEmails)
  ];
  const errors = [];
  for (const ref of extractContactRefs(values)) {
    try {
      const email = await resolveContactEmail(ref);
      if (email) emails.push(email);
    } catch (error) {
      errors.push({ idType: ref.idType, id: maskContactId(ref.id), error: error.message });
    }
  }
  return { emails: normalizeEmailList(emails), errors };
}

function extractMappedContactEmails(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(extractMappedContactEmails);
  if (typeof value === "object") {
    const directValues = [
      value.user_id,
      value.open_id,
      value.union_id,
      value.name,
      value.text,
      value.value,
      value.title,
      value.en_name
    ];
    return [
      ...directValues.map(getMappedContactEmail).filter(Boolean),
      ...Object.values(value).flatMap(extractMappedContactEmails)
    ];
  }
  return [getMappedContactEmail(value)].filter(Boolean);
}

function extractContactRefs(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(extractContactRefs);
  if (typeof value === "object") {
    const refs = [];
    if (value.user_id) refs.push({ idType: "user_id", id: String(value.user_id) });
    if (value.open_id) refs.push({ idType: "open_id", id: String(value.open_id) });
    for (const [key, child] of Object.entries(value)) {
      if (key === "user_id" || key === "open_id" || key === "email") continue;
      refs.push(...extractContactRefs(child));
    }
    return refs;
  }
  const text = String(value).trim();
  if (!text || text.includes("@") || /^https?:\/\//i.test(text)) return [];
  return /^[A-Za-z0-9_-]{4,64}$/.test(text) ? [{ idType: "user_id", id: text }] : [];
}

async function resolveContactEmail(ref) {
  const cacheKey = `${ref.idType}:${ref.id}`;
  if (contactEmailCache.has(cacheKey)) return contactEmailCache.get(cacheKey);
  const data = await feishuApi(
    `/contact/v3/users/${encodeURIComponent(ref.id)}?user_id_type=${encodeURIComponent(ref.idType)}`
  );
  const user = data.data?.user || data.data || {};
  const email = normalizeEmailList([
    user.email,
    user.enterprise_email,
    getMappedContactEmail(ref.id),
    getMappedContactEmail(user.user_id),
    getMappedContactEmail(user.open_id),
    getMappedContactEmail(user.union_id)
  ])[0] || "";
  contactEmailCache.set(cacheKey, email);
  return email;
}

function getMappedContactEmail(id) {
  const key = String(id || "").trim();
  return key ? config.contactEmailMap[key] || "" : "";
}

function maskContactId(id) {
  const text = String(id || "");
  if (text.length <= 4) return text;
  return `${text.slice(0, 2)}...${text.slice(-2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
