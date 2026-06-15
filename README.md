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
```

试运行阶段保持：

```text
SAFE_TEST_MODE=true
```

飞书群同步需要客户自建应用具备“发送消息”相关权限，并且应用机器人已加入目标群。固定收件人用英文逗号配置在 `FIXED_RECIPIENTS`，发起人和项目经理邮箱从多维表字段中自动提取。
