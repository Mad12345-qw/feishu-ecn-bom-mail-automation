import { buildMailHtml, buildRecipientRoute, routeByAssemblyFactory } from "../src/workflow.js";

const sampleRecord = {
  "项目名称及项目编号": "PB2033",
  "版本号": "V 2.3",
  "项目品牌": "小米",
  "项目阶段": "MP",
  "发起人邮箱": "initiator@example.com",
  "项目经理邮箱": "pm@example.com",
  "组装工厂": "奥海",
  "BOM类型": "PCBA BOM",
  "变更记录": "增加微容替代料",
  "BOM释放附件下载链接": "PB2033_电子BOM_V10_20260609_BSMI.xlsx; PB2033_电子BOM_V10_20260609_CB.xlsx; PB2033_电子BOM_V10_20260609_PSE.xlsx",
  "ECN变更通知书附件": "ECO-PROJ-D-18-V1.7 量产产品设计变更通知书.xlsx"
};

const route = routeByAssemblyFactory(sampleRecord);
const recipientRoute = buildRecipientRoute(sampleRecord);
const html = buildMailHtml(sampleRecord);

console.log(JSON.stringify({
  route,
  recipientRoute,
  htmlPreview: html.slice(0, 500),
  htmlLength: html.length
}, null, 2));
