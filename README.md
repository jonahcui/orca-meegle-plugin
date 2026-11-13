# Meegle for Orca

独立 Orca 侧边栏插件。使用官方 Meegle CLI 读取需求，再把经过预览的完整需求交给用户选择的 Orca 工作区中的 Codex 或 Claude。

插件 ID：`local.meegle-integration`，版本 `0.1.0`。适配 Orca `1.4.258` / Host API `1.6`，无需构建步骤，也没有运行时 npm 依赖。

## 使用

1. 在 Orca 右侧边栏打开 **Meegle**。未登录时选择站点，按面板中的命令在本机终端登录，再点击“重新检查连接”。
2. **我的待办**：打开即加载全部进行中的待办，可按类型和当前节点筛选。**我参与的**：选择空间、类型和状态（状态选项来自工作流元数据，在服务端用 MQL 筛选），滚动时自动加载下一页。搜索框可筛选已加载的条目，也可以粘贴 Meegle 详情链接后按回车直接打开。
3. **@我**：扫描我的待办，以及「我参与的」当前空间和类型中最近更新的 50 条，找出最近 7、30 或 90 天内提及我的评论。Meegle CLI 没有消息中心接口，所以这不是完整的通知列表。
4. **详情**：显示描述、详细信息和评论（评论人显示姓名，@我 的评论会高亮）。
5. **关联工作区**：
   - **新建工作区**：可多选仓库，生成 `<根目录>/<名称>/<仓库>`。每个仓库从 `origin/HEAD` 在同名分支上建 git worktree，npm 项目链接主仓库的 `node_modules`，再注册为 Orca 文件夹工作区。名称可点「AI 取名」，由本机 `claude -p`（失败时改用 `codex exec`）根据需求生成。先预检，确认目录、分支没有冲突后才能创建；绝不覆盖或回滚已有内容。
   - **关联已有**：选择已有工作区。
   - 关联后可「打开工作区」，或「派 Agent 开发」（重新读取完整需求并预览提示词，确认后才启动）。
6. 在已关联的工作区里打开侧边栏，会直接显示该需求的详情；切换工作区时跟随切换，但不会打断你手动打开的需求。

CLI 默认从 `~/.local/bin/meegle` 读取，不存在时从 Orca worker 的 `PATH` 查找。凭证始终由 CLI 管理，插件不读取凭证文件、不保存 token，也不把原始 CLI 输出写入日志。只调用白名单内的只读 Meegle 命令，每个参数都要先通过 `inspect` 的 schema 校验。

同一预览的重复点击会复用启动结果；启动结果不明确时，先检查目标工作区的终端，避免重复启动。预览有效期 15 分钟，worker 重启后需要重新准备。

## 本地开发与验证

本项目没有运行时依赖，**不要在插件根目录执行 npm install**：该版 Orca 会检查所有插件文件并拒绝 npm 生成的 symlink。`npm run typecheck` 会按 `tooling/package-lock.json` 将开发依赖临时安装到系统临时目录，完成后清理。

```sh
npm run setup       # 用本机 Orca 生成 .orca/types
npm run typecheck
npm test
npm run check
npm run validate

/Applications/Orca.app/Contents/Resources/bin/orca plugin inspect . --json
/Applications/Orca.app/Contents/Resources/bin/orca plugin dev load . --json
/Applications/Orca.app/Contents/Resources/bin/orca plugin open local.meegle-integration --panel meegle-integration --json
/Applications/Orca.app/Contents/Resources/bin/orca plugin shot local.meegle-integration --width 360 --json
```

首次加载会列出实际权限并返回审批指纹。只有在用户已授权这个插件及其访问范围时，才能使用返回的 `--approve` 参数。需要的权限为：trusted worker 本机执行（调用 meegle、git、Orca CLI 和本机 AI CLI）、`workspace:read`、`workspace:write`（打开工作区）、`agent:launch`。没有请求终端读写或密钥存储权限。

查看 [设计](docs/design.md)、[实现计划](docs/implementation-plan.md) 和 [验收记录](docs/verification.md)。

## 文件

- `src/cli.ts`：用参数数组调用进程（不经过 shell）、认证缓存、命令白名单和 inspect schema 校验。
- `src/meegle.ts`：空间、类型、状态、字段、MQL 分页、待办、详情和 URL 解析。
- `src/comments.ts`：评论、评论人姓名解析、@我 识别，以及考虑限流的提及扫描。
- `src/orca.ts` / `src/multiws.ts`：Orca 仓库与工作区，多仓库任务目录的预检与创建，AI 取名。
- `src/handoff.ts`：需求提示词、与面板绑定的预览，以及重复启动保护。
- `src/worker.ts` / `src/protocol.ts`：worker 请求与共享契约。
- `src/panel.tsx`：Orca TSX components 和 atom 状态；不使用 React DOM 或 Hooks。
- `src/*.test.*` / `src/panel.check.ts`：夹具测试与检查场景（夹具均为构造数据）。

## 当前边界

只读取 Meegle，不写评论、不流转节点，不向原生 Tasks 列表注册任务源。

当前 Orca 版本的 `PanelContribution` 只支持右侧活动栏，没有左侧导航贡献点，所以没有左侧主菜单入口。
