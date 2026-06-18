# 飞书 ECN/BOM 邮件自动化服务

这是本项目的后端实施骨架，用于接收飞书事件，按组装厂匹配收件人，并通过客户飞书邮箱发送 ECN/BOM 通知邮件。

## 当前已包含

- 飞书事件回调入口：`POST /webhook/feishu`
- 健康检查：`GET /health`
- 本地联调发送入口：`POST /demo/send`
- ECN/BOM 邮件正文模板
- 支持 BOM 释放审批实例直接触发邮件，不依赖审批结果先落入多维表
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
FEISHU_BOM_APPROVAL_CODES
FEISHU_BOM_APPROVAL_NAMES
APPROVAL_SYNC_LOOKBACK_MINUTES
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
UPSTASH_FEISHU_USER_TOKEN_KEY
FIXED_RECIPIENTS
TEST_RECIPIENTS
INCLUDE_FACTORY_RECIPIENTS
INCLUDE_DYNAMIC_RECIPIENTS
READY_STATUS_VALUES
BITABLE_SOURCES
BITABLE_TRIGGER_SOURCE_NAMES
BITABLE_LOOKUP_SOURCE_NAMES
```

飞书邮箱 OAuth 授权信息推荐保存到 Upstash Redis，避免 Render 免费实例重启、重新部署后丢失授权。`UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 填 Upstash 控制台的 REST URL/Token；`UPSTASH_FEISHU_USER_TOKEN_KEY` 可保持默认 `feishu:user-token`。旧的 `FEISHU_USER_TOKEN_B64` 仍可作为迁移兜底，但不建议继续作为主方案。

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

正式触发推荐使用 BOM 释放审批实例，而不是等待 BOM 多维表落库。审批通过事件会直接触发邮件；如果事件偶发漏推，可用审批实例同步兜底：

```text
FEISHU_BOM_APPROVAL_CODES=客户BOM释放审批的 approval_code
FEISHU_BOM_APPROVAL_NAMES=BOM释放审批
APPROVAL_SYNC_LOOKBACK_MINUTES=30
```

审批兜底同步入口：

```text
https://你的-render-service.onrender.com/sync/approvals?token=你的VerificationToken
```

`/sync/bitable` 仅作为历史兼容和多维表排查使用，不建议作为正式唯一触发源。

切换正式表时建议先设置：

```text
BITABLE_SKIP_EXISTING_ON_START=true
```

这样服务重启后的第一轮同步只建立历史数据基线，不会把正式表里的存量记录批量发出。客户后续新增或修改记录时再触发邮件。

试运行阶段保持：

```text
SAFE_TEST_MODE=true
INCLUDE_FACTORY_RECIPIENTS=false
INCLUDE_DYNAMIC_RECIPIENTS=false
READY_STATUS_VALUES=已通过,审批通过,完成,已完成,已发布
```

飞书群同步需要客户自建应用具备“发送消息”相关权限，并且应用机器人已加入目标群。固定收件人用英文逗号配置在 `FIXED_RECIPIENTS`，发起人和项目经理邮箱默认从多维表字段中自动提取；如需试运行阶段只发固定对接人，可设置 `INCLUDE_DYNAMIC_RECIPIENTS=false`。正式发送前必须能识别组装厂字段并匹配到组装厂地址表；否则系统会暂停发送。

正式切换工厂收件人时，再改为：

```text
INCLUDE_FACTORY_RECIPIENTS=true
```

历史漏发记录不要用全表同步补发，使用单条记录检查/补发入口。默认情况下，如果该记录已成功发送过，接口会跳过，不会重复发信：

```text
https://你的-render-service.onrender.com/debug/send-bitable-record?token=你的VerificationToken&source=触发表tableId&recordId=记录ID
```

例如 `source` 可填写 BOM 触发表的 `tableId`，`recordId` 填对应多维表格记录 ID。

只有确认需要人工强制补发时，才追加：

```text
&force=true
```
