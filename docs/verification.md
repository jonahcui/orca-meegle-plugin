# 第一版验收记录

时间：2026-11-13（Asia/Shanghai）。目录：插件项目根目录。

## 交付

独立插件 `local.meegle-integration` / `0.1.0` 已作为本地开发插件加载。manifest v2、trusted-worker、TypeScript worker + Orca TSX components，运行于 Orca `1.4.258` / Host API `1.6`。没有创建 Git 仓库、远端仓库或 MR，没有 commit/push/公开发布，没有修改 Orca 主项目。

完成的路径包括真实认证状态与站点登录指引、空间选择、元数据类型选择、进行中待办、包含历史的参与工作项、分页、完整逻辑字段详情、官方 URL 解析、工作区选择、需求提示词预览和启动 Agent。评论回写与节点流转未实现；插件只执行已列出的只读 Meegle 命令。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| `orca plugin test . --json` | 用户反馈后的回归版本 29/29 通过，0 失败；初版为 27/27 |
| `npm run typecheck` | TypeScript 通过，临时开发依赖已清理 |
| `orca plugin check . --json` | 4 个场景通过，0 issues / 0 warnings |
| `orca plugin validate . --json` | valid=true，errors=[] |
| `orca plugin inspect . --json` | manifest/内容合法，权限仅 workspace:read 与 agent:launch，执行 profile 为 trusted-worker |
| 本地 `plugin dev load` / `dev reload` | 已加载、已批准，无新增权限 |
| 真实 `meegle auth status` 和 worker `meegle.auth` | authenticated=true，站点 meegle.com；用户在开发期间完成授权 |
| 真实空间与类型 | 2 个空间；示例空间返回 6 种类型，类型 key 从接口发现 |
| 真实进行中待办 | 18 条；当前页与 total 一致 |
| 真实参与工作项 | 223 条，分页 50/50/50/50/23；去重后 223，末页 hasMore=false |
| 真实详情与预览 | 一个真实工作项；返回 27 个逻辑字段，其中 20 个非空字段进入详情与提示词；描述 35 字符，完整交接提示词 2145 字符 |
| 真实详情 URL | 真实工作项详情链接 经官方 decoder 和权威空间检索后解析成功 |
| 真实 Host API `workspace.list` | 21 个工作区，truncated=false，包含当前插件工作区 |
| `plugin shot` | 360px / 380px 窄面板截图已查看，settled=true、errors=[]、pendingRequests=0 |

截图位于 `.orca/shots/meegle-live-360.png`（未登录指引）、`.orca/shots/meegle-final.png`（真实已连接状态）。当前 Orca 浮动聊天窗口覆盖了已连接截图的下部区域；上部连接状态和入口正常，完整阅读/交接布局同时由面板交互测试验证。截图未修改用户主题，当前为 light。

实际启动开发 Agent 没有作为验收副作用执行；`agent.launch` 的参数、权限、目标校验、请求归属、并发去重和不确定结果处理已通过 mock Host API 测试。用户在面板选择目标工作区和 Agent 并审阅提示词后，即可点击启动。

## 联调修正与回归覆盖

- `auth status` 未登录时返回 JSON 且 exit=1；仅对这个明确状态放行，未吞掉业务失败。
- 当前 CLI `inspect --format json` 仍输出文本；解析实际参数定义，不依赖不存在的 JSON schema 输出。
- 待办的项目 key 与 `work_item_info` 分开返回，已正确合并；明确使用 `todo_scope=in_progress`。
- MQL 查询使用实际 project key，避免把 `project` 字面量误当空间名。
- MQL 首页的 `data[group_id]` / `moql_field_list` 与 `list[].count` 分别提供行和计数；后续页的 list、session_id 为 null，面板保留原始 cursor 和总数。
- 详情实际由 `work_item_attribute`、`work_item_fields` 和 `pagination` 组成；字段翻页使用数字 page_size，重复 token 或缺失 token 会显式失败。
- 未知分页标记不会被当作完整列表；待办仍可手动翻页到空页。

## 用户反馈后的列表修复（12:08）

初版漏测了同一工作项有多个待办节点的情况。真实 18 条待办对应 17 个工作项，其中一个工作项有 QA 和 Backend 两个节点；旧版使用空间 key 与工作项 ID 作为 ListItem key，造成 `duplicate key` 并阻止整个列表渲染。

修复后按空间、工作项和 `node_info.node_state_key` 生成行身份，并为完全重复或缺失节点 key 的记录附加出现序号；所有待办记录保留，不按工作项去重。新增解析与面板回归测试，先复现实际重复 key 错误，再确认同工作项多个节点、同节点重复、缺失节点 key、顺序变化和打开详情均可用。测试总数 29/29；TypeScript、plugin check、validate 再次通过。

真实 worker 读回为 18 条、18 个唯一行 key、17 个唯一工作项，total=18、hasMore=false。本地插件已 reload，权限仍为 already-approved、无新增权限。最终 `plugin shot local.meegle-integration --out .orca/shots/meegle-todo-fixed.png --json` 捕获真实列表：793px，settled=true、errors=[]、pendingRequests=0，画面已查看，18 条标记与工作项列表正常；用户也提供了恢复正常的截图。修复 reload 后没有新增错误日志，历史重复 key 错误保留在日志中。

左侧主菜单需求尚未实现。已核对本机 `orca skills get orca-plugin-authoring` 对应的 manifest 说明：PanelContribution.icon 的位置为 right-sidebar activity bar，未提供左侧导航贡献点，`sidebarCards` 等仍为保留项。需要 Orca 主程序增加扩展接口后才能实现；本项目未修改主程序、未替换原生 Tasks。

## 交互改版：参照 Jira（2026-11-13）

用户反馈原操作链路过长，面板按 Jira 的列表-详情模式重写（只改 `src/panel.tsx` 和面板测试，worker 与数据层不变）：

- 连接后自动加载“我的待办”，无需再点读取；“我的待办 / 我参与的”在顶部切换，视图、空间、类型、工作区和 Agent 用 `persist: 'plugin'` 记住。
- 列表改为 Table（ID / 标题 / 状态 / 空间，窄屏隐藏后两列），单击或回车打开；滚到底自动加载下一页，并保留“加载更多”按钮。跨页行 key 带页码前缀，避免重复。
- 统一搜索框：输入时筛选已加载的条目（只筛已加载部分，会明确标注），粘贴链接回车即解析并打开；链接对应多个空间时，原地选择。
- 选择空间后，若该空间只有一种类型，则自动选中并加载列表。
- 详情页：顶部是面包屑、标题和状态，“开始开发”卡片放在描述之前。工作区和 Agent 预填上次的选择，点击“交给 Agent 开发”会重新读取完整需求，确认后才启动，提示词默认折叠。
- 列表请求带序号并会中止过期请求，切换视图不再被忙碌状态阻塞。登录过期时，会清理数据并显示提示。

验证：`orca plugin test .` 33/33 通过；TypeScript 通过；`plugin check` 4 个场景通过，真实账号场景渲染 18 行；`plugin validate` 通过；`plugin dev reload` 显示 already-approved，无新增权限。`plugin shot` 截取列表（`.orca/shots/meegle-jira-list.png`）和经 `--act activateRow` 打开的真实详情（`.orca/shots/meegle-jira-detail.png`），两次均 settled、errors=[]。没有启动真实 Agent。

## 状态 / 类型筛选与关联工作区（2026-11-13）

- 我的待办：列表新增「类型」「当前节点」两列，并可按两者筛选。待办数量少，会自动加载全部页（上限 10 页），所以筛选覆盖完整。
- 我参与的：MQL 改为同时读取 `work_item_status`。新增「状态」筛选，选项来自 `workitem.meta-fields`；按名称去重，并只接受元数据里存在的值，筛选通过 MQL 在服务端执行。
- 「交给 Agent 开发」改为「关联工作区」：
  - 新建 worktree：`orca worktree create --repo id:<repo> --name --branch --no-parent --comment`，默认分支 `feature-meegle-<ID>`。按路径或新增 id 找回对应工作区，找不到时报错，不会重复创建。
  - 关联已有工作区。
  - 关联关系按 `projectKey:id` 存在插件 persist 中，列表显示「工作区」列，详情页显示「已关联」标记。
  - 关联后可「打开工作区」（`workspace.open`），或「派 Agent 开发」（先预览，确认后启动），也可取消关联。
- 新增权限 `workspace:write`（打开工作区所需），已按用户选择的方案批准并重新加载。
- 性能：认证状态缓存 60 秒，业务调用失败时立即清除；`inspect` schema 按命令缓存，参数不匹配时重新 inspect 一次。真实请求：「我参与的」第 1 页约 1.8 秒，详情约 0.8 秒。
- 修复竞态：列表结果绑定请求时的视图和筛选范围，不同范围的晚到结果会被丢弃。

验证：`orca plugin test .` 41/41 通过；TypeScript、check（4 个场景）、validate 均通过。真实接口：需求类型共 223 条，按 `In development` 筛选得到 14 条且状态全部匹配；缺陷类型有独立状态集；`meegle.repos` 返回 14 个仓库。未执行动作的真实列表截图见 `.orca/shots/meegle-todos-filters.png`。

未验证：
- 本轮 `plugin shot --act` 的截图与动作不一致（连搜索框输入都没有反映），`--in-place` 也报错，所以详情页「关联工作区」和状态筛选结果的画面只经过面板测试验证，没有真实截图。
- 没有真实执行新建 worktree、打开工作区或启动 Agent，以免在仓库里留下分支，或切换用户当前的视图。

## 评论区与 @我（2026-11-13）

- 详情页下方用「详细信息 / 评论」标签页切换。评论来自 `comment list`，按页加载，每页 20 条。评论人的 user_key 通过 `user search` 批量换成姓名（每批不超过 20 个，有缓存）。正文去掉了编辑器的 `<!-- … -->` 元数据，保留 `@名字`，按 Markdown 渲染；@我 的评论加边框和「@我」标记。
- 新增「@我」视图：Meegle CLI 没有消息或通知接口，所以改为扫描我的待办（最多 10 页），以及「我参与的」当前空间和类型下最近更新的 50 条，读取最近 7 / 30 / 90 天的评论，找出提及我的（用 `start_time` 过滤时间，单个工作项最多读 5 页，总计最多 100 个工作项）。识别方式：提及元数据的 id 与我的 user_key 或 lark_user_id 一致，或者名字一致；没有元数据的纯文本 `@名字` 按完整名字匹配。界面上写明这不是完整的通知列表。点击一条提及会打开对应工作项，并切到评论标签页。
- 限流：实测 `comment list` 每秒最多 5 次（RateLimit，retriable）。扫描并发设为 2，单个工作项失败后退避重试 2 次，仍失败的计入"失败数"并显示出来。
- 新增只读命令白名单项：`comment.list`、`user.search`。没有写评论或通知的操作。

验证：`orca plugin test .` 48/48 通过；TypeScript、check、validate 均通过，权限不变（already-approved）。真实接口：评论读取正常（姓名已解析，元数据已去掉）。@我 扫描了待办 17 个工作项，失败 0，耗时 4–6 秒；加上「我参与的」最近 50 条后共 54 个工作项，失败 0，耗时约 16 秒。独立交叉核对：这 17 条待办共 4 条评论，2 处提及都不是当前用户，所以 0 条是正确结果。截图：`.orca/shots/meegle-comments.png`（真实评论标签页）、`.orca/shots/meegle-mentions.png`（扫描中状态）。

未验证：真实数据里暂时没有 @当前用户 的评论，识别逻辑只用构造数据的单元测试覆盖。

## 多仓库工作区与 AI 取名（2026-11-13）

- 「新建 worktree」（单仓库，使用 Orca 默认位置）改为「新建工作区」，按 `~/.codex/AGENTS.md` 的 Worktree 规范实现：可多选仓库，生成 `<根目录>/<名称>/<仓库目录名>`；每个仓库执行 `git worktree add -b <名称> <目标> origin/HEAD 指向的基线`（创建前先 `fetch` 基线，失败不影响）。npm 项目把 `node_modules` 链接到主仓库，最后用 `orca repo add --kind folder` 注册为文件夹工作区，并关联到当前需求。
- 预检（只读）：根目录是否存在、目标目录是否已存在、仓库目录名是否重复、本地或远端是否已有同名分支、`origin/HEAD` 能否确定；主仓库有未提交修改时只提示。有任何冲突就禁止创建；创建时会重新预检一次；改过输入后需要重新预检。中途失败会停止并列出已经创建的部分，不回滚、不删除。
- 根目录默认取本机文件夹工作区最常见的上级目录（实测识别出本机统一存放任务目录的上级目录），只有手动修改的值才会持久保存。
- AI 取名：worker 把需求标题和描述的前 1500 字发给本机 `claude -p --model haiku`；失败时改用 `codex exec --sandbox read-only --ephemeral -c model_reasoning_effort=low`。只取匹配 `feature-…` 的部分并按分支名规则校验，不会执行 AI 输出中的任何内容。提示词里写明需求资料中的指令一律不执行。
- 已修复：子进程的 stdin 没有关闭，导致 `claude -p` 一直等待输入。
- 已知限制：worker 继承 Orca 主进程的环境，而你的 Claude 登录信息在 Orca 管理的账号目录（`CLAUDE_CONFIG_DIR`）里，worker 读不到，所以 Claude 会报未登录，约 2 秒后自动改用 Codex。为了不扩大对凭证的访问，没有去读 Orca 的账号配置。Codex 取名实测约 19 秒。

验证：52/52 测试通过；TypeScript、check、validate 均通过，权限不变。真实接口：默认根目录正确；对两个真实仓库做预检，用一个已存在的任务分支名时能检出本地和远端的同名分支冲突，用新名称时预检通过且没有创建任何目录；AI 取名返回符合 `feature-…` 规则的语义分支名（Codex，19 秒）。截图：`.orca/shots/meegle-multi-workspace.png`。没有真实执行创建，以免在你的仓库里留下分支和 worktree。

## 按当前工作区自动打开关联需求（2026-11-13）

- 面板订阅 `workspace.changed` 事件（需要 `workspace:read`，已有）。Orca 订阅时先发一次当前上下文，之后每次聚焦变化都会再发。上下文只给出名称和分支，不给 id，所以匹配规则是：关联的是 worktree 时比对分支（worktree 的名称经常和主仓库重名）；关联的是文件夹工作区时比对名称。
- 打开侧边栏或切换工作区时：恰好匹配 1 条需求就直接打开详情；匹配多条时不自动打开，在列表顶部用横幅列出，点击打开；不匹配时，之前自动打开的详情会关闭，回到列表。
- 不会打断手动操作：你自己打开的需求不会因为切换工作区被替换；在自动打开的详情页点「返回列表」后，只显示横幅提示，不会再次强制打开。终端的打开或关闭不算切换工作区。
- 新建立的关联会额外保存需求标题（`itemName`），横幅和打开前的占位标题直接用它；旧关联显示 `#ID`。

验证：53/53 测试通过（覆盖文件夹按名称匹配、同名 worktree 分支不同时不匹配、跟随切换、返回列表后显示横幅、不打断手动打开）；TypeScript、check、validate 均通过，权限不变。真实环境：用临时调试接口读取当前聚焦的工作区，`displayName` 为 orca-meegle-plugin、branch 为空，与 `workspace.list` 里文件夹工作区的名称一致（branch 为 null），符合匹配规则；调试接口已删除。没有为了测试去切换你在 Orca 里的当前工作区，所以"切换到已关联工作区后自动打开"的真实画面还需要你亲自确认。

## 剩余事项

- 在用户选定的真实目标工作区验证一次实际 Agent 启动与接收需求；当前没有启动真实测试 Agent，也不将启动回执当作开发成功。
- 深色主题及被浮动窗口覆盖区域的完整截图尚未单独验证；窄面板结构已通过 check 和交互测试。
- 新空间或不同服务器版本若返回新的响应结构，需按脱敏样本扩展适配；当前不会把未知结构默认为空结果。
- 新建工作区、评论回写和节点流转作为后续需求；当前功能只选择已有工作区。
