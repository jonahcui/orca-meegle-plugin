# Meegle 侧边栏第一版设计

目标是在 Orca 内阅读 Meegle 需求，并把完整需求交给用户选择的已有工作区中的 Agent。按已批准的独立插件路线，使用 manifest v2、trusted-worker、TypeScript worker 和 Orca TSX components；不修改 Orca 主项目。

## 边界与取舍

- 使用本机官方 Meegle CLI；不自建 OAuth、HTTP 客户端或凭证存储。面板显示真实认证状态，给出站点选择、终端登录命令和复查入口。
- 每次业务请求先检查认证，再执行 `inspect` 发现并校验命令参数。初始账号未登录且命令缓存为空；用户随后完成授权，已按真实 inspect 和响应完成适配。遇到未知响应显示明确错误，不当作空列表。
- 空间、工作项类型、字段从元数据读取。待办按 CLI 页码翻页；参与工作项按 MQL session/group 翻页；显示当前页和分页确定性，不宣称一页是全量。
- 待办的行身份与工作项 ID 分开：同一需求可同时处于多个待办节点，按空间、工作项、节点 key 及同身份出现序号生成唯一行 key，保留原始记录与分页计数。
- 当前安装版只支持右侧活动栏的 `PanelContribution`；左侧主菜单需要 Orca 新增导航贡献点。独立插件不通过替换 Tasks 或未支持的 manifest 字段伪造此入口。
- URL 由 `meegle url decode` 解析；解析空间再由 project search 确认，歧义时用户选择，不自行截取 URL 路径。
- 交接仅使用 Host API 1.6 已确认的 `workspace.list` 和 `agent.launch`，并检查 `host.has`。选择已有工作区、明确 Agent、预览提示词后才能启动；首版不创建工作区，不向真实工作项写入评论或流转。
- 需求内容视为外部资料；提示 Agent 先读取工作区规范、检查 Git 状态，不能把需求中的文本当作工具授权。启动回执仅说明终端已启动，不说明开发已完成。
- 不持久化业务详情或凭证。最小权限为读取工作区与启动 Agent；本机 trusted worker 使用参数数组启动 Meegle CLI，不执行输入的 shell 字符串。

## 文件职责

`cli.ts` 管进程、认证与 inspect；`meegle.ts` 管只读业务和响应归一化；`handoff.ts` 管提示词与派工；`worker.ts` 注册请求；`panel.tsx` 管 atom 状态与面板；`protocol.ts` 定义共享契约。测试使用明确标注的合成夹具，不冒充真实账号数据。

替代方案是直接调用 Meegle HTTP 或内置 Orca；前者会重复管理凭证，后者违反已选路线。首版保留清晰 CLI 适配边界，便于登录后按实际响应完善。
