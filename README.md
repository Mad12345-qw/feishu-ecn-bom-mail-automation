# 飞书 ECN/BOM 邮件自动化服务

这是本项目的后端实施骨架，用于接收飞书事件，按组装厂匹配收件人，并通过客户飞书邮箱发送 ECN/BOM 通知邮件。

## 当前已包含

- 飞书事件回调入口：`POST /webhook/feishu`
- 健康检查：`GET /health`
- 本地联调发送入口：`POST /demo/send`
- ECN/BOM 邮件正文模板
- 组装厂到收件邮箱的路由表
- 固定收件人 + 发起人/项目经理 + 组装厂多选收件人的合并去重
- 邮件发送后同步一条通知到指定飞书群
- 支持配置多张飞书多维表格作为同步来源
- 支持 BOM 释放表作为唯一触发源，ECN 表仅作为关联内容查询源
- 组装厂收件路由只读取 BOM 释放表的 `组装厂/组装工厂` 字段，不使用 ECN 表的 `执行单位`
- `BOM释放附件` 字段中的飞书附件会下载后作为邮件附件发送
- 仅在记录状态达到完成/审批通过，并成功匹配组装厂收件地址后发送
- 安全试运行模式，只允许发送到指定测试邮箱
- 发送事件日志：`logs/events.jsonl`

## 需要客户提供

- 飞书企业自建应用的 `App ID` 和 `App Secret`
- 飞书邮箱发件账号或邮箱 ID
- ECN 审批 / BOM 释放审批或多维表格字段
- 组装厂与收件邮箱地址表
- 测试收件邮箱

## 配置步骤

1. 复制 `.env.example` 为 `.env`
2. 复制 `config/assembly-factories.example.json` 为 `config/assembly-factories.json`
3. 复制 `config/field-mapping.example.json` 为 `config/field-mapping.json`
4. 按客户实际字段修改配置
5. 启动服务

```powershell
npm start
```

## 本地检查

```powershell
npm run check
node src/server.js
```

打开：

```text
http://localhost:8787/health
```

## 试运行保护

默认 `SAFE_TEST_MODE=true`。在该模式下，系统只允许发送到 `.env` 里的 `TEST_RECIPIENTS`。进入正式验收前，不要关闭该限制。

## 飞书开放平台配置

客户飞书企业自建应用中，需要将事件回调地址配置为：

```text
https://你的公网服务域名/webhook/feishu
```

本地开发时可以用内网穿透工具暴露 `localhost:8787`。

## Render 部署

本项目已包含 `render.yaml`。部署到 Render Web Service 后，Render 会提供自带 HTTPS 的 `onrender.com` 地址，可直接作为飞书事件回调地址：

```text
https://你的-render-service.onrender.com/webhook/feishu
```

Render 环境变量里需要填写：

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_VERIFICATION_TOKEN
FEISHU_SENDER_MAILBOX_ID
FEISHU_SYNC_CHAT_ID
FIXED_RECIPIENTS
TEST_RECIPIENTS
INCLUDE_FACTORY_RECIPIENTS
READY_STATUS_VALUES
BITABLE_SOURCES
BITABLE_TRIGGER_SOURCE_NAMES
BITABLE_LOOKUP_SOURCE_NAMES
```

如果客户有多张正式表，优先使用 `BITABLE_SOURCES`，格式为：

```text
app_token|table_id|表名;app_token|table_id|表名
```

当前推荐角色配置：

```text
BITABLE_TRIGGER_SOURCE_NAMES=正式表1
BITABLE_LOOKUP_SOURCE_NAMES=正式表2
```

系统只会把 `BITABLE_TRIGGER_SOURCE_NAMES` 中的表作为邮件触发表；ECN 表只用于按 ECN 编号、关联审批、SourceID、申请编号等字段补充邮件内容和附件，不会因为 ECN 表自身变化直接发送邮件。

切换正式表时建议先设置：

```text
BITABLE_SKIP_EXISTING_ON_START=true
```

这样服务重启后的第一轮同步只建立历史数据基线，不会把正式表里的存量记录批量发出。客户后续新增或修改记录时再触发邮件。

试运行阶段保持：

```text
SAFE_TEST_MODE=true
INCLUDE_FACTORY_RECIPIENTS=true
READY_STATUS_VALUES=已通过,审批通过,完成,已完成,已发布
```

飞书群同步需要客户自建应用具备“发送消息”相关权限，并且应用机器人已加入目标群。固定收件人用英文逗号配置在 `FIXED_RECIPIENTS`，发起人和项目经理邮箱从多维表字段中自动提取。正式发送前必须能识别组装厂字段并匹配到组装厂地址表；否则系统会暂停发送。
