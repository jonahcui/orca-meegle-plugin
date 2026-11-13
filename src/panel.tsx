import {
  atom, Badge, Box, Button, Callout, Card, Checkbox, CodeView, Collapsible, EmptyState, Field, Grid,
  Heading, IconButton, Input, KeyValue, Markdown, on, plugin, read, Row, Select, set,
  Skeleton, Stack, Tab, Table, Tabs, Text, type PanelContext, type TableColumn
} from 'orca'
import type { AuthState, Choice, CommentPage, Detail, LaunchReceipt, Link, MentionScan, Page, PlanInput, Preview, Repo, Result, WorkItem, WorkspacePlan, Workspaces } from './protocol'

type View = 'todos' | 'items' | 'mentions'
type ItemRow = WorkItem & { key: string }
interface ListState {
  /** The view and filter scope the rows belong to; rows from another scope are never shown. */
  scope: string
  rows: ItemRow[]; page: number; hasMore: boolean; total?: number
  certainty: 'known' | 'unknown'; sessionId?: string; groupId?: string
}
const ALL = 'all'
/** Todos are few; load them all (bounded) so type/status filters cover everything. */
const TODO_PAGE_LIMIT = 10

// Remembered between panel runs, like Jira keeps your last board, filter and assignee.
const view = atom<View>('meegle.view', 'todos', { persist: 'plugin' })
const project = atom<Choice | null>('meegle.project', null, { persist: 'plugin' })
const typeKey = atom('meegle.type', '', { persist: 'plugin' })
const assetKey = atom('meegle.asset', '', { persist: 'plugin' })
const lastAgent = atom('meegle.agent', '', { persist: 'plugin' })
const lastRepos = atom<string[]>('meegle.repoIds', [], { persist: 'plugin' })
/** Only a root the person typed is remembered; otherwise it follows where their folder workspaces live. */
const rootOverride = atom('meegle.rootOverride', '', { persist: 'plugin' })
const autoRoot = atom('')
/** Work item (`projectKey:id`) → linked Orca workspace. */
const links = atom<Record<string, Link>>('meegle.links', {}, { persist: 'plugin' })

const auth = atom<AuthState | null>(null)
const checking = atom(false)
const busy = atom('')
const error = atom('')
const site = atom('meegle.com')
const customSite = atom('')
const search = atom('')
const spaces = atom<Page<Choice> | null>(null)
const spaceQuery = atom('')
const types = atom<Choice[]>([])
const statuses = atom<Choice[]>([])
const statusFilter = atom(ALL)
const todoType = atom(ALL)
const list = atom<ListState | null>(null)
const listLoading = atom(false)
const opening = atom<Pick<WorkItem, 'id' | 'name' | 'projectKey'> | null>(null)
const detail = atom<Detail | null>(null)
const pendingUrl = atom<{ projects: Choice[]; id: string } | null>(null)
const preview = atom<Preview | null>(null)
const targets = atom<Workspaces | null>(null)
const repos = atom<Repo[] | null>(null)
const linkMode = atom('new')
const pickWorkspace = atom('')
const branch = atom('')
const repoFilter = atom('')
const plan = atom<{ input: string; value: WorkspacePlan } | null>(null)
const nameEngine = atom('')
const receipt = atom<LaunchReceipt | null>(null)
const detailTab = atom('fields')
const comments = atom<CommentPage | null>(null)
const commentsLoading = atom(false)
const mentionDays = atom('meegle.mentionDays', 30, { persist: 'plugin' })
const mentionScan = atom<MentionScan | null>(null)
const mentionLoading = atom(false)

let lifetime: AbortSignal | undefined
let listSeq = 0, detailSeq = 0
let listController: AbortController | undefined

function message(e: unknown): string { return e instanceof Error ? e.message : '操作失败，请重试。' }
function alive(): boolean { return !lifetime?.aborted }
function options(signal?: AbortSignal) { return { signal: signal ?? lifetime, timeoutMs: 120000 } }
function scoped(): AbortController {
  const controller = new AbortController()
  lifetime?.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}
function linkKey(item: Pick<WorkItem, 'projectKey' | 'id'>): string { return `${item.projectKey}:${item.id}` }
function defaultBranch(id: string): string { return `feature-meegle-${id.replace(/[^A-Za-z0-9]/g, '')}` }
function resetList(): void { listSeq++; listController?.abort(); set(list, null); set(listLoading, false) }
/** The focused Orca workspace, from `workspace.changed` (Orca gives a name and branch, not an id). */
type Focus = { branch: string; displayName: string } | null
const focus = atom<Focus>(null)
/** The work item the panel opened by itself for the focused workspace; manual navigation clears it. */
const autoOpened = atom('')
type FocusMatch = { key: string; projectKey: string; id: string; link: Link }
function focusMatches(): FocusMatch[] {
  const current = read(focus)
  if (!current) return []
  const branchName = current.branch.replace(/^refs\/heads\//, '')
  // A worktree is identified by its branch (names repeat across checkouts); a folder by its name.
  return Object.entries(read(links)).filter(([, link]) => link.branch
    ? Boolean(branchName) && link.branch.replace(/^refs\/heads\//, '') === branchName
    : link.name === current.displayName).map(([key, link]) => { const cut = key.lastIndexOf(':'); return { key, projectKey: key.slice(0, cut), id: key.slice(cut + 1), link } })
}
function applyFocus(): void {
  if (!read(auth)?.authenticated) return
  const matches = focusMatches(), showing = read(detail) ?? read(opening)
  // Never take over a requirement the person opened themselves.
  if (showing && read(autoOpened) !== linkKey(showing)) return
  if (matches.length === 1) {
    const match = matches[0]
    if (showing && linkKey(showing) === match.key) return
    set(autoOpened, match.key)
    void openItem({ projectKey: match.projectKey, id: match.id, name: match.link.itemName ?? `#${match.id}` })
  } else if (showing) { closeDetail() }
}
function closeDetail(): void {
  detailSeq++; set(autoOpened, '')
  set(opening, null); set(detail, null); set(preview, null); set(receipt, null)
}
function clearBusiness(): void {
  resetList(); closeDetail(); set(spaces, null); set(types, []); set(statuses, []); set(pendingUrl, null)
}
function unwrap<T>(answer: Result<T>): T {
  if (answer.ok) return answer.value
  if (answer.code === 'unauthenticated') {
    // Clearing bumps the list/detail sequence, so the caller would drop this message as stale.
    set(auth, { authenticated: false, host: read(auth)?.host ?? null }); clearBusiness(); set(error, answer.error)
  }
  throw new Error(answer.error)
}
/** Detail-side actions: one at a time, never blocks the list. */
async function act(label: string, action: () => Promise<void>): Promise<void> {
  if (read(busy)) return
  set(busy, label); set(error, '')
  try { await action() }
  catch (e) { if (alive()) set(error, message(e)) }
  finally { if (alive()) set(busy, '') }
}

// ── Connection ───────────────────────────────────────────────────────────
async function checkConnection(): Promise<void> {
  if (read(checking)) return
  set(checking, true); set(error, '')
  try {
    const result = unwrap(await plugin.request('meegle.auth', undefined, options()))
    set(auth, result.auth)
    if (result.auth.host) {
      if (['meegle.com', 'project.feishu.cn'].includes(result.auth.host)) set(site, result.auth.host)
      else { set(site, 'custom'); set(customSite, result.auth.host) }
    }
    clearBusiness()
    if (result.auth.authenticated) { void enterView(read(view)); applyFocus() }
  } catch (e) { if (alive()) set(error, message(e)) }
  finally { if (alive()) set(checking, false) }
}
export function setup(ctx: PanelContext): void {
  lifetime = ctx.signal
  // Orca sends the current context first, then every focus change.
  ctx.subscriptions.push(on('workspace.changed', ({ context }) => {
    const previous = read(focus)
    set(focus, context ? { branch: context.branch, displayName: context.displayName } : null)
    if (previous?.displayName !== context?.displayName || previous?.branch !== context?.branch) applyFocus()
  }))
  void checkConnection()
}

// ── List (filters + infinite scroll) ─────────────────────────────────────
function scopeReady(): boolean { return read(view) === 'todos' || (read(view) === 'items' && Boolean(read(project) && read(typeKey))) }
function scopeId(): string {
  return read(view) === 'todos' ? JSON.stringify(['todos', read(assetKey)]) : JSON.stringify(['items', read(project)?.key ?? '', read(typeKey), read(statusFilter)])
}
function currentList(): ListState | null { const value = read(list); return value && value.scope === scopeId() ? value : null }
async function loadList(more = false): Promise<void> {
  const previous = currentList()
  if (more && (!previous?.hasMore || read(listLoading))) return
  if (!scopeReady()) { if (read(view) !== 'mentions') resetList(); return }
  if (!more) { listController?.abort(); set(list, null) }
  const seq = ++listSeq, controller = scoped(), todos = read(view) === 'todos', scope = scopeId()
  listController = controller
  set(listLoading, true); set(error, '')
  const page = more && previous ? previous.page + 1 : 1
  let next = false
  try {
    const space = read(project), status = read(statusFilter)
    const answer = todos
      ? await plugin.request('meegle.todos', { page, assetKey: read(assetKey) }, options(controller.signal))
      : await plugin.request('meegle.items', { projectKey: space?.key ?? '', typeKey: read(typeKey), page,
        ...(status !== ALL ? { status } : {}),
        ...(more && previous ? { sessionId: previous.sessionId, groupId: previous.groupId, total: previous.total } : {}) }, options(controller.signal))
    if (seq !== listSeq || scope !== scopeId()) return
    const value = unwrap(answer)
    // Keys are unique across loaded pages, even if the same todo shifts between pages.
    const rows = value.items.map((item, index) => ({ ...item, key: `${page}:${item.rowKey ?? JSON.stringify([item.projectKey, item.id, index])}` }))
    set(list, {
      scope, rows: more && previous ? [...previous.rows, ...rows] : rows, page, hasMore: value.hasMore,
      total: value.total ?? previous?.total, certainty: value.certainty, sessionId: value.sessionId, groupId: value.groupId
    })
    next = todos && value.hasMore && value.items.length > 0 && page < TODO_PAGE_LIMIT
  } catch (e) { if (seq === listSeq && alive()) set(error, message(e)) }
  finally { if (seq === listSeq && alive()) set(listLoading, false) }
  if (next && seq === listSeq && scope === scopeId()) await loadList(true)
}
async function enterView(next: View): Promise<void> {
  set(view, next); set(search, ''); set(statusFilter, ALL); set(todoType, ALL); resetList()
  if (next === 'todos') return loadList()
  if (next === 'mentions') return read(mentionScan) ? undefined : scanMentions()
  if (!read(spaces)) await loadSpaces('')
  const space = read(project)
  if (space) await loadTypes(space.key)
  return loadList()
}
async function loadSpaces(query: string, page = 1): Promise<void> {
  try {
    const value = unwrap(await plugin.request('meegle.projects', { query, page }, options()))
    set(spaces, value); set(spaceQuery, query)
  } catch (e) { if (alive()) set(error, message(e)) }
}
async function loadTypes(key: string): Promise<void> {
  try {
    const value = unwrap(await plugin.request('meegle.types', { projectKey: key }, options()))
    if (read(project)?.key !== key) return
    set(types, value)
    if (!value.some(t => t.key === read(typeKey))) set(typeKey, value.length === 1 ? value[0].key : '')
    await loadStatuses()
  } catch (e) { if (alive()) { set(types, []); set(error, message(e)) } }
}
async function loadStatuses(): Promise<void> {
  set(statuses, []); set(statusFilter, ALL)
  const space = read(project), type = read(typeKey)
  if (!space || !type) return
  try {
    const value = unwrap(await plugin.request('meegle.statuses', { projectKey: space.key, typeKey: type }, options()))
    if (read(project)?.key === space.key && read(typeKey) === type) set(statuses, value)
  } catch (e) { if (alive()) set(error, message(e)) }
}
async function chooseProject(key: string): Promise<void> {
  const choice = spaceOptions().find(p => p.key === key) ?? null
  set(project, choice); set(types, []); set(statuses, []); resetList()
  if (!choice) return
  await loadTypes(choice.key)
  await loadList()
}
async function chooseType(key: string): Promise<void> { set(typeKey, key); resetList(); await loadStatuses(); await loadList() }
async function chooseStatus(value: string): Promise<void> { set(statusFilter, value); if (read(view) === 'items') await loadList() }
function spaceOptions(): Choice[] {
  const loaded = read(spaces)?.items ?? [], current = read(project)
  return current && !loaded.some(p => p.key === current.key) ? [current, ...loaded] : loaded
}
function distinct(values: (string | undefined)[]): string[] { return [...new Set(values.filter((v): v is string => Boolean(v)))].sort() }

// ── Detail, workspace link & handoff ─────────────────────────────────────
async function openItem(item: Pick<WorkItem, 'id' | 'name' | 'projectKey'>, tab = 'fields'): Promise<void> {
  if (read(autoOpened) !== linkKey(item)) set(autoOpened, '')
  const seq = ++detailSeq
  set(opening, item); set(detail, null); set(preview, null); set(receipt, null); set(error, '')
  set(branch, defaultBranch(item.id)); set(pickWorkspace, ''); set(plan, null); set(nameEngine, ''); set(detailTab, tab); set(comments, null)
  void loadWorkspaces(); void loadRepos(); void loadComments(item, seq)
  try {
    const value = unwrap(await plugin.request('meegle.detail', { projectKey: item.projectKey, id: item.id }, options()))
    if (seq === detailSeq) set(detail, value)
  } catch (e) { if (seq === detailSeq && alive()) { set(opening, null); set(error, message(e)) } }
}
async function loadComments(item: Pick<WorkItem, 'id' | 'projectKey'>, seq = detailSeq, more = false): Promise<void> {
  const previous = read(comments)
  if (more && (!previous || previous.page >= previous.totalPages || read(commentsLoading))) return
  const page = more && previous ? previous.page + 1 : 1
  set(commentsLoading, true)
  try {
    const value = unwrap(await plugin.request('meegle.comments', { projectKey: item.projectKey, id: item.id, page }, options()))
    if (seq !== detailSeq) return
    set(comments, more && previous ? { ...value, comments: [...previous.comments, ...value.comments] } : value)
  } catch (e) { if (seq === detailSeq && alive()) set(error, `评论读取失败：${message(e)}`) }
  finally { if (seq === detailSeq && alive()) set(commentsLoading, false) }
}
async function scanMentions(): Promise<void> {
  if (read(mentionLoading)) return
  set(mentionLoading, true); set(error, '')
  try {
    const space = read(project), type = read(typeKey)
    set(mentionScan, unwrap(await plugin.request('meegle.mentions', { days: read(mentionDays), ...(space && type ? { projectKey: space.key, typeKey: type } : {}) }, options())))
  } catch (e) { if (alive()) set(error, message(e)) }
  finally { if (alive()) set(mentionLoading, false) }
}
function openRow(key: string | undefined): void {
  const row = currentList()?.rows.find(r => r.key === key)
  if (row) void openItem(row)
}
async function loadWorkspaces(force = false): Promise<void> {
  if (read(targets) && !force) return
  try { set(targets, unwrap(await plugin.request('meegle.workspaces', undefined, options()))) }
  catch (e) { if (alive()) set(error, message(e)) }
}
async function loadRepos(force = false): Promise<void> {
  if (read(repos) && !force) return
  try {
    const value = unwrap(await plugin.request('meegle.repos', undefined, options()))
    set(repos, value)
    set(lastRepos, read(lastRepos).filter(id => value.some(r => r.id === id)))
    if (!read(autoRoot)) set(autoRoot, unwrap(await plugin.request('meegle.workspaceRoot', undefined, options())))
  } catch (e) { if (alive()) set(error, message(e)) }
}
function saveLink(item: Detail, workspace: { id: string; name: string; path: string; branch: string | null }): void {
  set(links, { ...read(links), [linkKey(item)]: { workspaceId: workspace.id, name: workspace.name, path: workspace.path, branch: workspace.branch, linkedAt: Date.now(), itemName: item.name } })
}
function unlink(item: Detail): void {
  const next = { ...read(links) }
  delete next[linkKey(item)]
  set(links, next); set(preview, null); set(receipt, null)
}
async function linkExisting(item: Detail): Promise<void> {
  const workspace = read(targets)?.workspaces.find(w => w.id === read(pickWorkspace))
  if (workspace) saveLink(item, workspace)
}
function effectiveRoot(): string { return read(rootOverride).trim() || read(autoRoot) }
function planInput(): PlanInput { return { repoIds: read(lastRepos), name: read(branch).trim(), root: effectiveRoot() } }
function currentPlan(): WorkspacePlan | null { const value = read(plan); return value && value.input === JSON.stringify(planInput()) ? value.value : null }
function toggleRepo(id: string, on: boolean): void {
  const ids = read(lastRepos).filter(r => r !== id)
  set(lastRepos, on ? [...ids, id] : ids)
}
async function suggestName(item: Detail): Promise<void> {
  await act('AI 取名', async () => {
    const value = unwrap(await plugin.request('meegle.suggestName', { projectKey: item.projectKey, id: item.id }, options()))
    set(branch, value.name); set(nameEngine, value.engine)
  })
}
async function checkPlan(): Promise<void> {
  await act('预检', async () => {
    const input = planInput()
    set(plan, { input: JSON.stringify(input), value: unwrap(await plugin.request('meegle.planWorkspace', input, options())) })
  })
}
async function createWorkspace(item: Detail): Promise<void> {
  if (!currentPlan()?.ok) return
  await act('创建工作区', async () => {
    const result = unwrap(await plugin.request('meegle.createWorkspace', planInput(), options()))
    saveLink(item, result.workspace); set(plan, null)
    await loadWorkspaces(true)
  })
}
async function openWorkspace(link: Link): Promise<void> {
  await act('打开工作区', async () => { unwrap(await plugin.request('meegle.openWorkspace', { workspaceId: link.workspaceId }, options())) })
}
async function submitSearch(value: string): Promise<void> {
  const text = value.trim()
  if (!/^https?:\/\//i.test(text)) return
  await act('解析链接', async () => {
    const result = unwrap(await plugin.request('meegle.url', { url: text }, options()))
    set(search, '')
    if (result.projects.length === 1) { set(pendingUrl, null); await openItem({ projectKey: result.projects[0].key, id: result.id, name: `#${result.id}` }) }
    else set(pendingUrl, { projects: result.projects, id: result.id })
  })
}
async function startHandoff(): Promise<void> {
  const item = read(detail)
  if (!item) return
  await act('准备需求', async () => {
    // Re-read the full requirement so the agent never gets a stale copy.
    const prepared = unwrap(await plugin.request('meegle.preview', { projectKey: item.projectKey, id: item.id }, options()))
    set(detail, prepared.item); set(preview, prepared)
  })
}
async function confirmLaunch(link: Link): Promise<void> {
  const prepared = read(preview)
  if (!prepared || read(receipt)) return
  await act('启动 Agent', async () => {
    set(receipt, unwrap(await plugin.request('meegle.launch', { previewId: prepared.previewId, workspaceId: link.workspaceId, agent: read(lastAgent) }, options())))
  })
}

// ── Views ────────────────────────────────────────────────────────────────
const AGENTS = [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]
function columns(todos: boolean): TableColumn[] {
  return [
    { key: 'id', label: 'ID', width: 'sm' },
    { key: 'name', label: '标题', minWidth: 'md' },
    { key: 'status', label: todos ? '当前节点' : '状态', width: 'md', hideBelow: 'sm' },
    ...(todos ? [{ key: 'type', label: '类型', width: 'xs', hideBelow: 'md' } as TableColumn] : []),
    { key: 'workspace', label: '工作区', width: 'sm', hideBelow: 'md' }
  ]
}

function Connection() {
  const host = read(site) === 'custom' ? read(customSite).trim() : read(site)
  const valid = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
  return <Stack gap="md">
    <Card title="连接 Meegle" description="使用官方 CLI 登录，凭证由 CLI 管理。">
      <Stack gap="sm">
        <Select label="登录站点" value={read(site)} options={[
          { value: 'meegle.com', label: 'Meegle · meegle.com' },
          { value: 'project.feishu.cn', label: '飞书项目 · project.feishu.cn' },
          { value: 'custom', label: '自定义站点' }
        ]} onChange={value => set(site, value)} disabled={read(checking)} />
        {read(site) === 'custom' && <Input label="站点域名" value={read(customSite)} placeholder="project.example.com" invalid={!valid} onChange={v => set(customSite, v.toLowerCase())} />}
        <Text size="sm">1. 在本机终端执行以下登录命令。</Text>
        {valid ? <CodeView label="登录命令" language="sh" code={`meegle auth login --device-code --host ${host}`} wrap /> : <Text tone="warning">请输入有效域名，再查看登录命令。</Text>}
        <Text size="sm">2. 按 CLI 提示完成浏览器授权。</Text>
        <Text size="sm">3. 返回此处重新检查连接。</Text>
        <Button icon="refresh" onPress={checkConnection} disabled={read(checking)}>重新检查连接</Button>
      </Stack>
    </Card>
  </Stack>
}

function Filters() {
  const space = read(project), loadedSpaces = read(spaces), rows = currentList()?.rows ?? []
  const all = (label: string, values: { value: string; label: string }[]) => [{ value: ALL, label }, ...values]
  return <Tabs label="视图" value={read(view)} onChange={v => void enterView(v === 'items' || v === 'mentions' ? v : 'todos')}>
    <Tab value="todos" label="我的待办" icon="check">
      <Stack gap="sm">
        <Grid columns={2} minItemWidth="sm" gap="sm">
          <Select label="类型" value={read(todoType)} options={all('全部类型', distinct(rows.map(r => r.typeKey)).map(t => ({ value: t, label: t })))} onChange={v => set(todoType, v)} />
          <Select label="节点" value={read(statusFilter)} options={all('全部节点', distinct(rows.map(r => r.status)).map(s => ({ value: s, label: s })))} onChange={v => void chooseStatus(v)} />
        </Grid>
        <Collapsible title="高级：工作台范围">
          <Input label="Asset key（可选）" value={read(assetKey)} placeholder="仅 CLI 要求时填写 Asset_xxx" onChange={v => set(assetKey, v)} onSubmit={() => loadList()} />
        </Collapsible>
      </Stack>
    </Tab>
    <Tab value="items" label="我参与的" icon="layers">
      <Stack gap="sm">
        <Grid columns={3} minItemWidth="sm" gap="sm">
          <Select label="空间" value={space?.key ?? ''} placeholder="选择空间" options={spaceOptions().map(p => ({ value: p.key, label: p.name }))} onChange={v => void chooseProject(v)} />
          <Select label="类型" value={read(typeKey)} placeholder={space ? '选择类型' : '先选空间'} disabled={!space || !read(types).length} options={read(types).map(t => ({ value: t.key, label: t.name }))} onChange={v => void chooseType(v)} />
          <Select label="状态" value={read(statusFilter)} disabled={!read(statuses).length} options={all('全部状态', read(statuses).map(s => ({ value: s.key, label: s.name })))} onChange={v => void chooseStatus(v)} />
        </Grid>
        {loadedSpaces && (loadedSpaces.hasMore || read(spaceQuery)) && <Input type="search" label="搜索空间" labelHidden placeholder="没找到空间？输入名称或 key 回车搜索" value={read(spaceQuery)} onChange={v => set(spaceQuery, v)} onSubmit={v => void loadSpaces(v.trim())} />}
      </Stack>
    </Tab>
    <Tab value="mentions" label="@我" icon="bell">
      <Stack gap="xs">
        <Row gap="sm" align="end" wrap>
          <Select label="时间范围" value={String(read(mentionDays))} disabled={read(mentionLoading)} options={[{ value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]} onChange={v => { set(mentionDays, Number(v)); void scanMentions() }} />
          <Button icon="refresh" variant="outline" disabled={read(mentionLoading)} onPress={scanMentions}>{read(mentionLoading) ? '扫描中…' : '重新扫描'}</Button>
        </Row>
        <Text size="xs" muted>{`扫描我的待办${space && read(typeKey) ? `，以及「${space.name}」中我参与的最近 50 条` : ''}的评论，找出提及我的。Meegle CLI 没有消息中心接口，这里不是完整的通知列表。`}</Text>
      </Stack>
    </Tab>
  </Tabs>
}

function FocusBanner() {
  const matches = focusMatches(), current = read(focus)
  if (!current || !matches.length) return null
  return <Callout tone="accent" icon="link" title={`当前工作区「${current.displayName}」关联了 ${matches.length} 条需求`}>
    <Stack gap="xs">{matches.map(m => <Row key={m.key} justify="between" gap="sm">
      <Text size="sm" truncate>{`#${m.id} ${m.link.itemName ?? ''}`}</Text>
      <Button size="sm" variant="outline" onPress={() => { set(autoOpened, m.key); void openItem({ projectKey: m.projectKey, id: m.id, name: m.link.itemName ?? `#${m.id}` }) }}>打开</Button>
    </Row>)}</Stack>
  </Callout>
}

function Issues() {
  const current = currentList(), loading = read(listLoading), filter = read(search).trim().toLowerCase()
  const todos = read(view) === 'todos', type = read(todoType), node = read(statusFilter)
  const isUrl = /^https?:\/\//i.test(filter), pending = read(pendingUrl), linked = read(links)
  const narrowed = Boolean(filter && !isUrl) || (todos && (type !== ALL || node !== ALL))
  const rows = (current?.rows ?? []).filter(r =>
    (!filter || isUrl || r.name.toLowerCase().includes(filter) || r.id.includes(filter)) &&
    (!todos || ((type === ALL || r.typeKey === type) && (node === ALL || r.status === node))))
  return <Stack gap="sm">
    <Input type="search" label="搜索" labelHidden value={read(search)} placeholder="筛选标题 / ID，或粘贴 Meegle 链接回车打开" disabled={Boolean(read(busy))} onChange={v => { set(search, v); set(pendingUrl, null) }} onSubmit={v => void submitSearch(v)} />
    {pending && <Callout tone="warning" title="链接对应多个空间">
      <Select label="选择链接所属空间" value="" placeholder="选择空间" options={pending.projects.map(p => ({ value: p.key, label: `${p.name} · ${p.key}` }))} onChange={v => { set(pendingUrl, null); void openItem({ projectKey: v, id: pending.id, name: `#${pending.id}` }) }} />
    </Callout>}
    <FocusBanner />
    <Filters />
    {read(view) === 'mentions' ? <Mentions /> : !scopeReady() ? <EmptyState title="选择空间和类型" description="选好后自动列出你参与的工作项。" icon="layers" />
      : !current && loading ? <Skeleton lines={6} label="加载工作项" />
      : current && !current.rows.length ? <EmptyState title={todos ? '没有进行中的待办' : '没有符合条件的工作项'} description={current.certainty === 'unknown' ? '服务端未提供明确分页标记，未确认全量，请在 Meegle 中核对。' : '可以切换视图、调整筛选或刷新。'} icon="check" />
      : current && <Stack gap="xs">
        <Row justify="between">
          <Text size="xs" muted>{narrowed ? `筛选已加载的 ${rows.length}/${current.rows.length} 条` : `已加载 ${current.rows.length} 条`}{current.total !== undefined ? ` · 共 ${current.total} 条` : ''}{loading ? ' · 加载中…' : ''}</Text>
          <IconButton icon="refresh" label="刷新列表" size="sm" variant="ghost" disabled={loading} onPress={() => loadList()} />
        </Row>
        <Table label="工作项列表" columns={columns(todos)} maxHeight="lg" selectionMode="single" selected={[]} loading={loading}
          hasMore={current.hasMore && !narrowed} onLoadMore={() => void loadList(true)}
          onSelectionChange={({ keys }) => openRow(keys[0])} onRowAction={({ key }) => openRow(key)}
          emptyText="没有匹配的工作项"
          rows={rows.map(r => ({ key: r.key, cells: { id: r.id, name: r.name, status: r.status ?? '', type: r.typeKey ?? '', workspace: linked[linkKey(r)]?.name ?? '' } }))} />
        {current.hasMore && !loading && <Button size="sm" variant="ghost" onPress={() => loadList(true)}>加载更多</Button>}
        {current.hasMore && narrowed && <Text size="xs" muted>筛选只作用于已加载的条目；还有更多未加载。</Text>}
        {current.certainty === 'unknown' && current.hasMore && <Text size="xs" tone="warning">服务端未提供明确分页标记，未确认全量；加载到空页为止。</Text>}
      </Stack>}
  </Stack>
}

function excerpt(text: string): string {
  const plain = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~|-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return plain.length > 80 ? plain.slice(0, 80) + '…' : plain
}
function Mentions() {
  const scan = read(mentionScan), loading = read(mentionLoading), filter = read(search).trim().toLowerCase()
  if (!scan) return loading ? <Skeleton lines={5} label="扫描评论" /> : <EmptyState title="还没有扫描" description="点击重新扫描。" icon="bell" />
  const rows = scan.mentions.map((m, index) => ({ m, key: String(index) }))
    .filter(({ m }) => !filter || m.name.toLowerCase().includes(filter) || m.id.includes(filter) || m.comment.text.toLowerCase().includes(filter))
  return <Stack gap="xs">
    <Text size="xs" muted>{`已扫描 ${scan.scanned} 个工作项 · 最近 ${scan.days} 天 · 找到 ${scan.mentions.length} 条提及${loading ? ' · 扫描中…' : ''}`}</Text>
    {scan.failed > 0 && <Text size="xs" tone="warning">{`${scan.failed} 个工作项的评论读取失败（可能被限流），结果可能不完整，可稍后重新扫描。`}</Text>}
    {scan.truncated && <Text size="xs" tone="warning">工作项超过 100 个，只扫描了前 100 个。</Text>}
    {!scan.mentions.length ? <EmptyState title="没有提及我的评论" description={`最近 ${scan.days} 天，扫描范围内没有 @我 的评论。`} icon="bell" />
      : <Table label="提及我的评论" maxHeight="lg" selectionMode="single" selected={[]}
        columns={[{ key: 'time', label: '时间', width: 'md' }, { key: 'item', label: '工作项', minWidth: 'md' }, { key: 'author', label: '评论人', width: 'sm', hideBelow: 'sm' }, { key: 'text', label: '内容', minWidth: 'md', hideBelow: 'md' }]}
        onSelectionChange={({ keys }) => { const hit = rows.find(r => r.key === keys[0]); if (hit) void openItem(hit.m, 'comments') }}
        onRowAction={({ key }) => { const hit = rows.find(r => r.key === key); if (hit) void openItem(hit.m, 'comments') }}
        rows={rows.map(({ m, key }) => ({ key, cells: { time: m.comment.createdAt, item: `#${m.id} ${m.name}`, author: m.comment.author, text: excerpt(m.comment.text) } }))} />}
  </Stack>
}

function Comments({ item }: { item: Detail }) {
  const page = read(comments), loading = read(commentsLoading)
  if (!page) return loading ? <Skeleton lines={3} label="读取评论" /> : <Text muted size="sm">评论未加载。</Text>
  if (!page.comments.length) return <EmptyState title="暂无评论" icon="file-text" />
  return <Stack gap="sm">
    {page.comments.map(c => <Box key={c.id} border={c.mentionsMe ? 'accent' : true} radius="md" padding="sm">
      <Stack gap="xs">
        <Row gap="sm" wrap>
          <Text weight="semibold" size="sm">{c.author}</Text>
          <Text size="xs" muted>{c.createdAt}</Text>
          {c.mentionsMe && <Badge tone="accent">@我</Badge>}
          {c.fileUrl && <Badge>含附件</Badge>}
        </Row>
        {c.text ? <Markdown content={c.text} /> : <Text size="sm" muted>（无文字内容）</Text>}
      </Stack>
    </Box>)}
    {page.page < page.totalPages && <Button size="sm" variant="ghost" disabled={loading} onPress={() => loadComments(item, detailSeq, true)}>{loading ? '加载中…' : `加载更多评论（${page.comments.length}/${page.total}）`}</Button>}
  </Stack>
}

function NewWorkspace({ item }: { item: Detail }) {
  const working = Boolean(read(busy)), repoList = read(repos), chosen = read(lastRepos), filter = read(repoFilter).trim().toLowerCase()
  const checked = currentPlan(), name = read(branch).trim()
  const visible = (repoList ?? []).filter(r => chosen.includes(r.id) || !filter || r.name.toLowerCase().includes(filter))
  return <Stack gap="sm">
    <Field label={`仓库 · 已选 ${chosen.length}`} description="可多选；每个仓库会在同一个分支上建 worktree，放进同一个任务目录。">
      <Stack gap="xs">
        {(repoList?.length ?? 0) > 6 && <Input type="search" label="筛选仓库" labelHidden placeholder="筛选仓库" value={read(repoFilter)} onChange={v => set(repoFilter, v)} />}
        {!repoList ? <Skeleton lines={3} label="读取仓库" /> : <Box border radius="md" padding="sm" maxHeight={240} scroll="y">
          <Stack gap="xs">{visible.map(r => <Checkbox key={r.id} label={r.name} description={r.path} checked={chosen.includes(r.id)} disabled={working} onChange={on => toggleRepo(r.id, on)} />)}</Stack>
        </Box>}
      </Stack>
    </Field>
    <Row gap="sm" align="end">
      <Box grow><Input label="名称 / 分支" value={read(branch)} disabled={working} onChange={v => { set(branch, v); set(nameEngine, '') }} /></Box>
      <Button icon="bot" variant="outline" disabled={working} onPress={() => suggestName(item)}>{read(busy) === 'AI 取名' ? '取名中…' : 'AI 取名'}</Button>
    </Row>
    {read(nameEngine) && <Text size="xs" muted>{`由本机 ${read(nameEngine)} 根据需求标题和描述生成，可修改。`}</Text>}
    <Collapsible title={`位置：${effectiveRoot() || '加载中…'}/${name || '…'}`}>
      <Input label="任务目录的上级目录" value={effectiveRoot()} disabled={working} onChange={v => set(rootOverride, v)} />
    </Collapsible>
    {checked && <Stack gap="xs">
      {checked.problems.map(p => <Text key={p} size="sm" tone="danger">{p}</Text>)}
      {checked.repos.map(r => <Box key={r.repoId} border={r.problems.length ? 'danger' : true} radius="md" padding="sm">
        <Stack gap="xs">
          <Row gap="sm" wrap><Text weight="semibold" size="sm">{r.name}</Text><Text size="xs" muted>{`${r.base || '?'} → ${checked.branch}`}</Text></Row>
          <Text size="xs" muted>{r.target}</Text>
          {r.problems.map(p => <Text key={p} size="xs" tone="danger">{p}</Text>)}
          {r.warnings.map(w => <Text key={w} size="xs" tone="warning">{w}</Text>)}
        </Stack>
      </Box>)}
    </Stack>}
    <Row gap="sm" wrap>
      <Button variant="outline" icon="check" disabled={working || !chosen.length || !name || !effectiveRoot()} onPress={checkPlan}>{read(busy) === '预检' ? '检查中…' : '预检'}</Button>
      <Button tone="accent" icon="add" disabled={working || !checked?.ok} onPress={() => createWorkspace(item)}>{read(busy) === '创建工作区' ? '创建中…' : '创建并关联'}</Button>
    </Row>
    {!checked && chosen.length > 0 && name && <Text size="xs" muted>先预检：检查目录、分支是否已存在，不会改动任何内容。</Text>}
  </Stack>
}

function LinkSetup({ item }: { item: Detail }) {
  const working = Boolean(read(busy)), workspaces = read(targets)
  const picked = workspaces?.workspaces.find(w => w.id === read(pickWorkspace))
  return <Card title="关联工作区" description="为这条需求建立开发工作区，之后可直接打开或派 Agent。">
    <Tabs label="关联方式" value={read(linkMode)} onChange={v => set(linkMode, v)}>
      <Tab value="new" label="新建工作区" icon="branch">
        <NewWorkspace item={item} />
      </Tab>
      <Tab value="existing" label="关联已有" icon="link">
        <Stack gap="sm">
          <Select label="工作区" value={read(pickWorkspace)} placeholder={workspaces ? '选择工作区' : '加载中…'} disabled={!workspaces || working} options={(workspaces?.workspaces ?? []).map(w => ({ value: w.id, label: `${w.name}${w.branch ? ` · ${w.branch}` : ''}${w.hostId ? ' · 远程' : ''}` }))} onChange={v => set(pickWorkspace, v)} />
          {picked && <Text size="xs" muted>{picked.path}</Text>}
          {workspaces?.truncated && <Text size="xs" tone="warning">工作区列表未完整返回，请在 Orca 中确认目标工作区。</Text>}
          <Button tone="accent" icon="link" disabled={working || !picked} onPress={() => linkExisting(item)}>关联</Button>
        </Stack>
      </Tab>
    </Tabs>
  </Card>
}

function Development({ item }: { item: Detail }) {
  const link = read(links)[linkKey(item)]
  if (!link) return <LinkSetup item={item} />
  const working = Boolean(read(busy)), workspaces = read(targets), prepared = read(preview), launched = read(receipt)
  const missing = Boolean(workspaces && !workspaces.truncated && !workspaces.workspaces.some(w => w.id === link.workspaceId))
  const chosenAgent = AGENTS.find(a => a.value === read(lastAgent))
  return <Card title="开发工作区">
    <Stack gap="sm">
      <KeyValue items={[{ label: '工作区', value: link.name }, { label: '分支', value: link.branch ?? '文件夹工作区', code: true }, { label: '路径', value: link.path }]} />
      {missing && <Callout tone="warning" title="关联的工作区已不存在">它可能已被删除，请取消关联后重新关联。</Callout>}
      <Row gap="sm" wrap>
        <Button icon="open-external" variant="outline" disabled={working || missing} onPress={() => openWorkspace(link)}>打开工作区</Button>
        <Button variant="ghost" tone="danger" disabled={working} onPress={() => unlink(item)}>取消关联</Button>
      </Row>
      {launched ? <Callout tone="success" title="Agent 已启动" icon="check">
        <Text>工作区 {launched.workspaceName} · 终端 {launched.terminalId}</Text>
        <Text size="sm">开发结果请在工作区查看；此回执仅表示 Agent 终端已启动。</Text>
      </Callout> : !missing && <Stack gap="sm">
        <Row gap="sm" align="end" wrap>
          <Select label="Agent" value={read(lastAgent)} placeholder="选择 Agent" disabled={Boolean(prepared) || working} options={AGENTS} onChange={v => set(lastAgent, v)} />
          {!prepared && <Button tone="accent" icon="play" disabled={working || !chosenAgent} onPress={startHandoff}>{read(busy) === '准备需求' ? '准备中…' : '派 Agent 开发'}</Button>}
        </Row>
        {prepared && <Stack gap="sm">
          <Callout tone="accent" title="确认启动" icon="agent">
            <Text size="sm">将在「{link.name}」启动 {chosenAgent?.label ?? '未选择'}，发送下方完整需求。</Text>
          </Callout>
          <Collapsible title="查看发送给 Agent 的提示词">
            <CodeView label="需求交接预览" code={prepared.prompt} wrap maxHeight="lg" />
          </Collapsible>
          <Row gap="sm">
            <Button tone="accent" icon="play" disabled={working || !chosenAgent} onPress={() => confirmLaunch(link)}>{read(busy) === '启动 Agent' ? '启动中…' : '确认启动'}</Button>
            <Button variant="ghost" disabled={working} onPress={() => set(preview, null)}>取消</Button>
          </Row>
        </Stack>}
      </Stack>}
    </Stack>
  </Card>
}

function IssueView() {
  const item = read(detail), head = item ?? read(opening)
  if (!head) return null
  const spaceName = spaceOptions().find(p => p.key === head.projectKey)?.name ?? head.projectKey
  const typeName = item?.typeKey ? read(types).find(t => t.key === item.typeKey)?.name ?? item.typeKey : ''
  const link = read(links)[linkKey(head)]
  return <Stack gap="md">
    <Row justify="between">
      <Button variant="ghost" size="sm" disabled={Boolean(read(busy))} onPress={closeDetail}>← 返回列表</Button>
      {item && <IconButton icon="refresh" label="重新读取需求" size="sm" variant="ghost" disabled={Boolean(read(busy))} onPress={() => openItem(item)} />}
    </Row>
    <Stack gap="xs">
      <Text size="xs" muted>{spaceName}{typeName ? ` / ${typeName}` : ''} / #{head.id}</Text>
      <Heading level={2}>{item?.name ?? head.name}</Heading>
      <Row gap="xs" wrap>
        {item?.status && <Badge tone="accent">{item.status}</Badge>}
        {link && <Badge tone="success">{`已关联 ${link.name}`}</Badge>}
      </Row>
    </Stack>
    {!item ? <Skeleton lines={5} label="读取完整需求" /> : <Stack gap="md">
      <Development item={item} />
      <Card title="描述">
        {item.description ? <Markdown content={item.description} /> : <Text muted>未返回描述，请核对下方字段并在 Meegle 中确认验收条件。</Text>}
      </Card>
      <Tabs label="详情内容" value={read(detailTab)} onChange={v => set(detailTab, v)}>
        <Tab value="fields" label={`详细信息 · ${item.fields.length}`} icon="info">
          <KeyValue label="详细信息" items={item.fields} />
        </Tab>
        <Tab value="comments" label={`评论${read(comments) ? ` · ${read(comments)!.total}` : ''}`} icon="file-text">
          <Comments item={item} />
        </Tab>
      </Tabs>
    </Stack>}
  </Stack>
}

export default function Panel() {
  const connection = read(auth)
  return <Box padding="md"><Stack gap="md">
    <Row justify="between">
      <Row gap="sm"><Heading>Meegle</Heading><Badge tone={connection?.authenticated ? 'success' : 'neutral'}>{connection?.authenticated ? '已连接' : connection ? '未连接' : '检查中'}</Badge></Row>
      <Row gap="xs">
        {connection?.host && <Text size="xs" muted>{connection.host}</Text>}
        <IconButton icon="refresh" label="刷新连接状态" tooltip="重新检查登录并重新加载" disabled={read(checking)} onPress={checkConnection} />
      </Row>
    </Row>
    {read(error) && <Callout tone="danger" title="操作未完成"><Text size="sm">{read(error)}</Text></Callout>}
    {!connection ? (read(checking) ? <Skeleton lines={3} label="检查连接状态" /> : <Button onPress={checkConnection}>重试连接检查</Button>)
      : !connection.authenticated ? <Connection />
      : read(opening) || read(detail) ? <IssueView /> : <Issues />}
  </Stack></Box>
}
