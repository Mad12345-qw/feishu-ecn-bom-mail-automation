import assert from "node:assert/strict";
import { buildMailHtml, buildRecipientRoute, collectAttachmentRefs, routeByAssemblyFactory } from "../src/workflow.js";

const sampleRecord = {
  "__lookupSourceIDs": [
    Buffer.from("7550642638681538579:2F212E75-2721-4610-9EA0-50FF2B2CC46F-1:4fffa3e5f4d76a539ecec0f08ac37f83:1", "utf8").toString("base64")
  ],
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
  "BOM释放附件链接": "https://rcnriirbjrdb.feishu.cn/sheets/WSRKsNz5shBAljtY246cSbNYnus https://rcnriirbjrdb.feishu.cn/file/IF8cbIU9rov7irx9WGqcs42knDb",
  "ECN变更通知书附件": {
    "link": "https://www.feishu.cn/approval/admin/previewAttachment?key=mock_preview_key",
    "text": "1 个附件"
  },
  "发起人部门": "项目部",
  "变更部门": "供应链部",
  "变更描述": "变更前:C415,C419原来只有1个替代料 | 变更后:C415,C419增加多1个替代料 | 执行方式:立即变更;\n\n变更前:TEST测试审批发送邮件功能变更前2 | 变更后:TEST测试审批发送邮件功能变更后2 | 执行方式:其他;\n\n变更前:TEST测试审批发送邮件功能变更前3 | 变更后:TEST测试审批发送邮件功能变更后3 | 执行方式:其他"
};

const route = routeByAssemblyFactory(sampleRecord);
const recipientRoute = buildRecipientRoute(sampleRecord);
const html = buildMailHtml(sampleRecord);
const attachmentRefs = collectAttachmentRefs(sampleRecord);
const ecnOnlyRoute = routeByAssemblyFactory({ "执行单位": "奥海" });
const mixedRoute = routeByAssemblyFactory({ "组装厂": "奥海", "执行单位": "示例组装厂" });

assert.equal(route.ok, true);
assert.equal(route.assemblyFactory, "奥海");
assert.equal(attachmentRefs.length, 4);
assert.equal(attachmentRefs[0].fileToken, "mock_bom_file_token");
assert.equal(attachmentRefs[1].type, "export");
assert.equal(attachmentRefs[1].driveType, "sheet");
assert.equal(attachmentRefs[2].type, "media");
assert.equal(attachmentRefs[2].fileToken, "IF8cbIU9rov7irx9WGqcs42knDb");
assert.equal(attachmentRefs[3].type, "approval_preview");
assert.deepEqual(attachmentRefs[3].approvalInstanceCodes, ["2F212E75-2721-4610-9EA0-50FF2B2CC46F"]);
assert.equal(ecnOnlyRoute.ok, false);
assert.equal(mixedRoute.ok, true);
assert.equal(mixedRoute.assemblyFactory, "奥海");
assert.equal(html.includes("组装厂"), true);
assert.equal(html.includes("供应链部"), true);
assert.equal(html.includes("项目部"), false);
assert.equal(html.includes("C415,C419原来只有1个替代料"), true);
assert.equal(html.includes("C415,C419增加多1个替代料"), true);
assert.equal(html.includes("TEST测试审批发送邮件功能变更前2"), true);
assert.equal(html.includes("TEST测试审批发送邮件功能变更后2"), true);
assert.equal(html.includes("TEST测试审批发送邮件功能变更前3"), true);
assert.equal(html.includes("TEST测试审批发送邮件功能变更后3"), true);
assert.equal(html.includes("立即变更"), true);

console.log(JSON.stringify({
  route,
  recipientRoute,
  attachmentRefs,
  ecnOnlyRoute,
  mixedRoute,
  htmlPreview: html.slice(0, 500),
  htmlLength: html.length
}, null, 2));
