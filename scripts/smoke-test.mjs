import assert from "node:assert/strict";
import { buildMailHtml, buildRecipientRoute, collectAttachmentRefs, routeByAssemblyFactory } from "../src/workflow.js";

const sampleRecord = {
  "项目名称及项目编号": "PB2033",
  "版本号": "V 2.3",
  "项目品牌": "小米",
  "项目阶段": "MP",
  "发起人邮箱": "initiator@example.com",
  "项目经理邮箱": "pm@example.com",
  "组装厂": "奥海",
  "BOM类型": "PCBA BOM",
  "变更记录": "增加微容替代料",
  "BOM释放附件": [
    {
      "file_token": "mock_bom_file_token",
      "name": "PB2033_电子BOM_V10_20260609_BSMI.xlsx"
    }
  ],
  "ECN变更通知书附件": "ECO-PROJ-D-18-V1.7 量产产品设计变更通知书.xlsx"
};

const route = routeByAssemblyFactory(sampleRecord);
const recipientRoute = buildRecipientRoute(sampleRecord);
const html = buildMailHtml(sampleRecord);
const attachmentRefs = collectAttachmentRefs(sampleRecord);
const ecnOnlyRoute = routeByAssemblyFactory({ "执行单位": "奥海" });
const mixedRoute = routeByAssemblyFactory({ "组装厂": "奥海", "执行单位": "示例组装厂" });

assert.equal(route.ok, true);
assert.equal(route.assemblyFactory, "奥海");
assert.equal(attachmentRefs.length, 1);
assert.equal(attachmentRefs[0].fileToken, "mock_bom_file_token");
assert.equal(ecnOnlyRoute.ok, false);
assert.equal(mixedRoute.ok, true);
assert.equal(mixedRoute.assemblyFactory, "奥海");

console.log(JSON.stringify({
  route,
  recipientRoute,
  attachmentRefs,
  ecnOnlyRoute,
  mixedRoute,
  htmlPreview: html.slice(0, 500),
  htmlLength: html.length
}, null, 2));
