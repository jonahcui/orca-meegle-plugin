# Meegle Integration Implementation Plan

**Goal:** 交付可运行的独立侧边栏，覆盖连接指引、分页阅读、详情及经预览的工作区派工。

**Architecture:** Orca TSX 面板通过有类型的请求调用 TypeScript worker；worker 用安全参数数组调用官方 Meegle CLI，并用 Host API 启动工作区 Agent。

**Tech Stack:** TypeScript、Orca 1.4.258 / Host API 1.6、node:test / orca/testing。

**Spec:** [design.md](design.md)。本任务明确要求单 agent 直接实现，测试和自查均由当前 worker 完成。保持普通 Folder Workspace，不强行初始化 Git。

## Global Constraints

- 作为独立项目开发；不修改 Orca 主项目。第一版阶段不发布、不 push。
- 业务请求先认证、后 inspect；不读取凭证文件，不写业务数据。
- 不硬编码空间或 story 类型；不把不明响应归为空集合。
- 仅使用版本匹配 API，派工前选择并预览，避免重复点击启动。

## Review Focus

1. 未登录、认证过期、CLI 缺失时必须阻止业务请求。
2. 分页缺少总数/session 或多分组时不得静默截断。
3. URL 主机不匹配与空间歧义必须显式处理。
4. 切换空间、页码和详情时不能显示过期请求结果。
5. 派工失败允许重试；回执不应被误认为业务完成。

## 实施步骤

- [x] 1. CLI 与数据适配：先写认证拦截、参数数组、分页、未知响应及 URL 夹具测试；验证失败后实现 `cli.ts` / `meegle.ts` / `protocol.ts`。
- [x] 2. 派工：先写选择校验、需求提示词、重复派工和 Host API 测试；实现 `handoff.ts` / `worker.ts`。
- [x] 3. TSX 面板：先写未登录、空态、错误、分页到详情及预览启动测试；实现 `panel.tsx` 与 check scenarios。
- [x] 4. 验证与交付：运行完整 plugin test、TypeScript、plugin check、validate、inspect；权限可审阅后加载本地插件，用 plugin shot 查看最终画面，记录真实联调缺口。

## 执行记录

四项任务均由当前 worker 独立完成。按指定任务保持普通 Folder Workspace，没有初始化 Git、创建 helper worker 或修改其他项目；自查结合真实接口联调，发现的问题均补充回归测试后修正，详见 verification.md。
