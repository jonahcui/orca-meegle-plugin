import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Detail, Page, PlanInput, WorkItem } from './protocol'
import { parseItems } from './meegle'
const ok = <T,>(value: T) => ({ ok: true as const, value })
const item: WorkItem = { id: '7', name: '账单验收', projectKey: 'p1', typeKey: 'custom', status: '开发中' }
const detail: Detail = { ...item, description: '不重复扣款', fields: [{ label: '验收', value: '并发只扣一次' }] }
const page: Page<WorkItem> = { items: [item], page: 1, total: 51, hasMore: true, certainty: 'known', sessionId: 's1', groupId: 'g1' }
const connected = () => ok({ auth: { authenticated: true, host: 'meegle.com' } })
const workspaces = () => ok({ workspaces: [{ id: 'w1', name: '开发空间', path: '/tmp/repo', branch: 'feature-demo', hostId: null }], truncated: false })
const table = { label: '工作项列表' }

test('logged-out panel provides safe connection instructions and no business calls', async () => {
  let business = 0
  const host = mockHost({ requests: { 'meegle.auth': () => ok({ auth: { authenticated: false, host: 'meegle.com' } }), 'meegle.todos': () => { business++; return ok(page) } } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /连接 Meegle/ }))
  assert.ok(view.find({ text: /meegle auth login --device-code --host meegle.com/ }))
  assert.equal(view.find(table), null); assert.equal(business, 0)
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('todos load on open, scroll loads more, click opens, linked workspace launches after confirm', async () => {
  let launches = 0
  const requested: number[] = []
  const host = mockHost({ requests: {
    'meegle.auth': connected,
    'meegle.todos': input => { requested.push(input.page); return ok({ ...page, items: [{ ...item, id: String(input.page * 10), rowKey: 'r' }], page: input.page, hasMore: input.page === 1 }) },
    'meegle.detail': () => ok(detail),
    'meegle.preview': () => ok({ previewId: 'pre1', prompt: '完整需求提示词', item: detail }),
    'meegle.workspaces': workspaces, 'meegle.repos': () => ok([]),
    'meegle.launch': input => { launches++; assert.equal(input.workspaceId, 'w1'); assert.equal(input.agent, 'codex'); return ok({ terminalId: 't1', workspaceName: '开发空间' }) }
  } })
  const link = { workspaceId: 'w1', name: '开发空间', path: '/tmp/repo', branch: 'feature-demo', linkedAt: 1 }
  const view = await mount(panel, { host, persisted: { plugin: { 'meegle.agent': 'codex', 'meegle.links': { 'p1:7': link } } } })
  // Todos are loaded completely so type/node filters cover all of them.
  assert.deepEqual(requested, [1, 2])
  const keys = view.rowsOf(table)
  assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 2)
  await view.selectRows(table, [keys[0]])
  assert.ok(view.find({ text: /不重复扣款/ }))
  assert.ok(view.find({ text: /已关联 开发空间/ }))
  await view.press({ text: '派 Agent 开发' })
  assert.ok(view.find({ text: /确认启动/ })); assert.equal(launches, 0)
  await view.press({ text: '确认启动' })
  assert.equal(launches, 1)
  assert.ok(view.find({ text: /终端 t1/ }))
  await view.press({ text: '← 返回列表' })
  assert.equal(view.rowsOf(table).length, 2)
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('unlinked item: link an existing workspace, open it, and unlink', async () => {
  const opened: string[] = []
  const host = mockHost({ requests: {
    'meegle.auth': connected, 'meegle.todos': () => ok({ ...page, hasMore: false }), 'meegle.detail': () => ok(detail), 'meegle.workspaces': workspaces,
    'meegle.repos': () => ok([{ id: 'r1', name: 'repo', path: '/tmp/repo' }]),
    'meegle.openWorkspace': input => { opened.push(input.workspaceId); return ok({ opened: true as const }) }
  } })
  const view = await mount(panel, { host })
  await view.activateRow(table, view.rowsOf(table)[0])
  assert.ok(view.find({ text: /关联工作区/ }))
  await view.select({ label: '关联方式' }, 'existing')
  await view.select({ label: '工作区' }, 'w1')
  await view.press({ text: '关联' })
  assert.deepEqual(Object.keys(view.persisted.plugin['meegle.links'] as object), ['p1:7'])
  await view.press({ text: '打开工作区' })
  assert.deepEqual(opened, ['w1'])
  await view.press({ text: '取消关联' })
  assert.deepEqual(view.persisted.plugin['meegle.links'], {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('multi-repo workspace: pick repos, AI name, pre-check, then create and link', async () => {
  const plans: PlanInput[] = [], creates: PlanInput[] = []
  let created = false
  const plan = (input: PlanInput) => ({ folder: `/w/${input.name}`, branch: input.name, problems: [], ok: true,
    repos: input.repoIds.map(id => ({ repoId: id, name: id, repoPath: `/src/${id}`, target: `/w/${input.name}/${id}`, base: 'origin/master', nodeModules: id === 'web', warnings: id === 'web' ? ['将链接主仓库的 node_modules'] : [], problems: [] })) })
  const host = mockHost({ requests: {
    'meegle.auth': connected, 'meegle.todos': () => ok({ ...page, hasMore: false }), 'meegle.detail': () => ok(detail), 'meegle.comments': () => ok({ comments: [], page: 1, totalPages: 1, total: 0 }),
    'meegle.workspaces': () => ok({ workspaces: created ? [{ id: 'w9', name: 'feature-bill-dedupe', path: '/w/feature-bill-dedupe', branch: null, hostId: null }] : [], truncated: false }),
    'meegle.repos': () => ok([{ id: 'api', name: 'api', path: '/src/api' }, { id: 'web', name: 'web', path: '/src/web' }]),
    'meegle.workspaceRoot': () => ok('/w'),
    'meegle.suggestName': () => ok({ name: 'feature-bill-dedupe', engine: 'Claude' }),
    'meegle.planWorkspace': input => { plans.push(input); return ok(plan(input)) },
    'meegle.createWorkspace': input => { creates.push(input); created = true; return ok({ workspace: { id: 'w9', name: 'feature-bill-dedupe', path: '/w/feature-bill-dedupe', branch: null, hostId: null }, created: input.repoIds }) }
  } })
  const view = await mount(panel, { host })
  await view.activateRow(table, view.rowsOf(table)[0])
  await view.toggle({ label: 'api' }); await view.toggle({ label: 'web' })
  await view.press({ text: 'AI 取名' })
  assert.equal(view.valueOf({ label: '名称 / 分支' }), 'feature-bill-dedupe')
  assert.ok(view.find({ text: /由本机 Claude/ }))
  assert.equal(view.find({ text: '创建并关联' })?.props.disabled, true)
  await view.press({ text: '预检' })
  assert.deepEqual(plans[0], { repoIds: ['api', 'web'], name: 'feature-bill-dedupe', root: '/w' })
  assert.ok(view.find({ text: /将链接主仓库的 node_modules/ }))
  // Editing after the check makes the plan stale: creating needs a fresh check.
  await view.type({ label: '名称 / 分支' }, '-v2')
  assert.equal(view.find({ text: '创建并关联' })?.props.disabled, true)
  await view.type({ label: '名称 / 分支' }, 'feature-bill-dedupe', { replace: true })
  await view.press({ text: '预检' })
  await view.press({ text: '创建并关联' })
  assert.deepEqual(creates, [{ repoIds: ['api', 'web'], name: 'feature-bill-dedupe', root: '/w' }])
  assert.equal((view.persisted.plugin['meegle.links'] as Record<string, { workspaceId: string }>)['p1:7'].workspaceId, 'w9')
  assert.deepEqual(view.persisted.plugin['meegle.repoIds'], ['api', 'web']); assert.equal(view.persisted.plugin['meegle.rootOverride'] ?? '', '')
  assert.ok(view.find({ text: /派 Agent 开发/ }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('pre-check conflicts block creation and are shown per repo', async () => {
  const host = mockHost({ requests: {
    'meegle.auth': connected, 'meegle.todos': () => ok({ ...page, hasMore: false }), 'meegle.detail': () => ok(detail), 'meegle.comments': () => ok({ comments: [], page: 1, totalPages: 1, total: 0 }),
    'meegle.workspaces': workspaces, 'meegle.repos': () => ok([{ id: 'api', name: 'api', path: '/src/api' }]), 'meegle.workspaceRoot': () => ok('/w'),
    'meegle.planWorkspace': () => ok({ folder: '/w/feature-meegle-7', branch: 'feature-meegle-7', ok: false, problems: ['目标目录已存在：/w/feature-meegle-7'],
      repos: [{ repoId: 'api', name: 'api', repoPath: '/src/api', target: '/w/feature-meegle-7/api', base: 'origin/master', nodeModules: false, warnings: [], problems: ['分支 feature-meegle-7 已存在'] }] })
  } })
  const view = await mount(panel, { host })
  await view.activateRow(table, view.rowsOf(table)[0])
  await view.toggle({ label: 'api' })
  await view.press({ text: '预检' })
  assert.ok(view.find({ text: /目标目录已存在/ })); assert.ok(view.find({ text: /分支 feature-meegle-7 已存在/ }))
  assert.equal(view.find({ text: '创建并关联' })?.props.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('todo type and node filters narrow rows locally', async () => {
  const items = [item, { ...item, id: '8', typeKey: 'issue', status: '测试', rowKey: 'b' }, { ...item, id: '9', rowKey: 'c', status: '测试' }]
  const host = mockHost({ requests: { 'meegle.auth': connected, 'meegle.todos': () => ok({ ...page, items, hasMore: false, total: 3 }) } })
  const view = await mount(panel, { host })
  await view.select({ label: '类型' }, 'custom')
  assert.equal(view.rowsOf(table).length, 2)
  await view.select({ label: '节点' }, '测试')
  assert.equal(view.rowsOf(table).length, 1)
  assert.ok(view.find({ text: /筛选已加载的 1\/3 条/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('auth expiry clears stale data and shows connection steps', async () => {
  const host = mockHost({ requests: { 'meegle.auth': connected, 'meegle.todos': () => ({ ok: false, code: 'unauthenticated', error: '登录已过期' }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /登录已过期/ }))
  assert.ok(view.find({ text: /连接 Meegle/ }))
  assert.equal(view.find(table), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('multiple todo nodes on the same work item render and open without duplicate keys', async () => {
  let opened = ''
  const rows = ['node-qa', 'node-dev', 'node-dev'].map((key, index) => ({ project_key: 'p1', node_info: { node_state_key: key, node_name: index === 0 ? '测试用例' : '开发' }, work_item_info: { work_item_id: 7, work_item_name: '同一需求' } }))
  const todos = parseItems({ list: rows, total: rows.length }, { projectKey: '', typeKey: '', page: 1 }, 'todo')
  const host = mockHost({ requests: { 'meegle.auth': connected, 'meegle.todos': () => ok(todos), 'meegle.workspaces': workspaces, 'meegle.detail': input => { opened = input.id; return ok(detail) } } })
  const view = await mount(panel, { host })
  const keys = view.rowsOf(table)
  assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 3)
  await view.activateRow(table, keys[1])
  assert.equal(opened, '7'); assert.ok(view.find({ text: /不重复扣款/ }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('empty and unknown pagination are distinguished', async () => {
  const host = mockHost({ requests: { 'meegle.auth': connected, 'meegle.todos': () => ok({ items: [], page: 1, hasMore: false, certainty: 'unknown' }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /没有进行中的待办/ }))
  assert.ok(view.find({ text: /未确认全量/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('local filter narrows loaded rows and pauses infinite scroll', async () => {
  const items = [item, { ...item, id: '8', name: '登录优化', rowKey: 'b' }]
  const host = mockHost({ requests: { 'meegle.auth': connected, 'meegle.todos': () => ok({ ...page, items, hasMore: false }) } })
  const view = await mount(panel, { host })
  await view.type({ label: '搜索' }, '登录')
  assert.equal(view.rowsOf(table).length, 1)
  assert.ok(view.find({ text: /筛选已加载的 1\/2 条/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('pasting a work item link opens its detail directly', async () => {
  const host = mockHost({ requests: {
    'meegle.auth': connected, 'meegle.todos': () => ok(page), 'meegle.workspaces': workspaces,
    'meegle.url': () => ok({ projects: [{ key: 'p1', name: '项目一' }], id: '7', host: 'meegle.com' }),
    'meegle.detail': input => { assert.equal(input.projectKey, 'p1'); return ok(detail) }
  } })
  const view = await mount(panel, { host })
  await view.type({ label: '搜索' }, 'https://meegle.com/x/story/detail/7', { submit: true })
  assert.ok(view.find({ text: /不重复扣款/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('participated view: choosing a space auto-picks its only type, loads, and keeps query session paging', async () => {
  const pages: { page: number; sessionId?: string; groupId?: string; typeKey: string; projectKey: string; status?: string }[] = []
  const host = mockHost({ requests: {
    'meegle.auth': connected, 'meegle.todos': () => ok(page),
    'meegle.projects': () => ok({ items: [{ key: 'p1', name: '项目一' }, { key: 'p2', name: '项目二' }], page: 1, hasMore: false, certainty: 'known' }),
    'meegle.types': () => ok([{ key: 'custom_incident', name: '自定义事故' }]),
    'meegle.statuses': () => ok([{ key: 'In development', name: 'In development' }]),
    'meegle.items': input => { pages.push(input); return ok({ ...page, items: [{ ...item, id: String(input.page) }], page: input.page, hasMore: input.page === 1 }) }
  } })
  const view = await mount(panel, { host })
  await view.select({ label: '视图' }, 'items')
  assert.equal(view.valueOf({ label: '空间' }), '')
  await view.select({ label: '空间' }, 'p2')
  assert.equal(view.valueOf({ label: '类型' }), 'custom_incident')
  assert.equal(pages[0].typeKey, 'custom_incident'); assert.equal(pages[0].projectKey, 'p2')
  await view.loadMore(table)
  assert.equal(pages[1].page, 2); assert.equal(pages[1].sessionId, 's1'); assert.equal(pages[1].groupId, 'g1')
  assert.equal(view.persisted.plugin['meegle.view'], 'items')
  await view.select({ label: '状态' }, 'In development')
  assert.equal(pages.at(-1)!.status, 'In development'); assert.equal(pages.at(-1)!.page, 1)
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('remembered space and type reopen straight into the list', async () => {
  let loaded = 0
  const host = mockHost({ requests: {
    'meegle.auth': connected,
    'meegle.projects': () => ok({ items: [{ key: 'p1', name: '项目一' }], page: 1, hasMore: false, certainty: 'known' }),
    'meegle.types': () => ok([{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }]),
    'meegle.statuses': () => ok([]),
    'meegle.items': input => { loaded++; assert.equal(input.projectKey, 'p2'); assert.equal(input.typeKey, 'b'); return ok({ ...page, hasMore: false }) }
  } })
  const view = await mount(panel, { host, persisted: { plugin: { 'meegle.view': 'items', 'meegle.project': { key: 'p2', name: '项目二' }, 'meegle.type': 'b' } } })
  assert.equal(loaded, 1)
  assert.equal(view.valueOf({ label: '空间' }), 'p2')
  assert.equal(view.rowsOf(table).length, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('detail shows comments tab with @我 marker and paging', async () => {
  const pages: number[] = []
  const comment = (id: string, mentionsMe = false) => ({ id, author: '李四', authorKey: 'u', createdAt: `2026-11-0${id} 10:00:00`, text: `评论${id}`, mentionsMe })
  const host = mockHost({ requests: {
    'meegle.auth': connected, 'meegle.todos': () => ok({ ...page, hasMore: false }), 'meegle.detail': () => ok(detail), 'meegle.workspaces': workspaces, 'meegle.repos': () => ok([]),
    'meegle.comments': input => { pages.push(input.page); return ok(input.page === 1 ? { comments: [comment('1', true)], page: 1, totalPages: 2, total: 2 } : { comments: [comment('2')], page: 2, totalPages: 2, total: 2 }) }
  } })
  const view = await mount(panel, { host })
  await view.activateRow(table, view.rowsOf(table)[0])
  await view.select({ label: '详情内容' }, 'comments')
  assert.ok(view.find({ text: /评论1/ })); assert.ok(view.find({ text: '@我' }))
  await view.press({ text: /加载更多评论/ })
  assert.deepEqual(pages, [1, 2]); assert.ok(view.find({ text: /评论2/ }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('@我 view scans, lists mentions and opens the comment tab', async () => {
  let scans: unknown[] = []
  const mention = { projectKey: 'p1', id: '7', name: '账单验收', comment: { id: 'c1', author: '李四', authorKey: 'u', createdAt: '2026-11-02 09:00:00', text: '@张三 请看 [文档](https://x)', mentionsMe: true } }
  const host = mockHost({ requests: {
    'meegle.auth': connected, 'meegle.todos': () => ok({ ...page, hasMore: false }), 'meegle.detail': () => ok(detail), 'meegle.workspaces': workspaces, 'meegle.repos': () => ok([]),
    'meegle.comments': () => ok({ comments: [mention.comment], page: 1, totalPages: 1, total: 1 }),
    'meegle.mentions': input => { scans.push(input); return ok({ mentions: [mention], scanned: 17, failed: 0, days: input.days, truncated: false }) }
  } })
  const view = await mount(panel, { host })
  await view.select({ label: '视图' }, 'mentions')
  assert.deepEqual(scans, [{ days: 30 }])
  assert.ok(view.find({ text: /已扫描 17 个工作项/ }))
  assert.ok(view.find({ text: /不是完整的通知列表/ }))
  await view.select({ label: '时间范围' }, '7')
  assert.deepEqual(scans.at(-1), { days: 7 }); assert.equal(view.persisted.plugin['meegle.mentionDays'], 7)
  const mentionTable = { label: '提及我的评论' }
  await view.activateRow(mentionTable, view.rowsOf(mentionTable)[0])
  assert.equal(view.valueOf({ label: '详情内容' }), 'comments')
  assert.ok(view.find({ text: /请看/ }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('opening the panel in a linked workspace shows its requirement; switching follows unless the person navigated', async () => {
  const opened: string[] = []
  const details: Record<string, Detail> = { '7': detail, '8': { ...detail, id: '8', name: '登录优化', description: '第二个需求' } }
  const host = mockHost({ requests: {
    'meegle.auth': connected, 'meegle.todos': () => ok({ ...page, hasMore: false }), 'meegle.workspaces': workspaces, 'meegle.repos': () => ok([]),
    'meegle.comments': () => ok({ comments: [], page: 1, totalPages: 1, total: 0 }),
    'meegle.detail': input => { opened.push(input.id); return ok(details[input.id]) }
  } })
  const links = {
    'p1:7': { workspaceId: 'w1', name: 'feature-bill', path: '/w/feature-bill', branch: null, linkedAt: 1, itemName: '账单验收' },
    'p1:8': { workspaceId: 'w2', name: 'repo-gateway', path: '/w/x/repo-gateway', branch: 'feature-login', linkedAt: 1 }
  }
  const view = await mount(panel, { host, persisted: { plugin: { 'meegle.links': links } } })
  await view.emit('workspace.changed', { context: { branch: '', displayName: 'feature-bill', terminals: [] } })
  assert.deepEqual(opened, ['7']); assert.ok(view.find({ text: /不重复扣款/ }))
  // Same name as a linked worktree but a different branch: not a match, so the panel goes back to the list.
  await view.emit('workspace.changed', { context: { branch: 'refs/heads/master', displayName: 'repo-gateway', terminals: [] } })
  assert.equal(view.find({ text: /不重复扣款/ }), null); assert.ok(view.find(table))
  await view.emit('workspace.changed', { context: { branch: 'refs/heads/feature-login', displayName: 'repo-gateway', terminals: [] } })
  assert.deepEqual(opened, ['7', '8']); assert.ok(view.find({ text: /第二个需求/ }))
  // The person goes back to the list: a banner offers the linked item instead of forcing it.
  await view.press({ text: '← 返回列表' })
  assert.ok(view.find({ text: /当前工作区「repo-gateway」关联了 1 条需求/ }))
  // Manually opening another requirement is never taken over by a focus change.
  await view.activateRow(table, view.rowsOf(table)[0])
  await view.emit('workspace.changed', { context: { branch: '', displayName: 'feature-bill', terminals: [] } })
  assert.equal(opened.at(-1), '7'); assert.equal(opened.length, 3)
  await view.emit('workspace.changed', { context: { branch: 'refs/heads/feature-login', displayName: 'repo-gateway', terminals: [] } })
  assert.equal(opened.length, 3)
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})
