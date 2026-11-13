import { assert, test } from 'orca/testing'
import { parseProjects, parseTypes, parseItems, parseDetail, MeegleService } from './meegle'
import { MeegleCli } from './cli'

test('reads dynamic space/type keys and refuses unknown data', () => {
  assert.deepEqual(parseProjects({ projects: [{ project_key: 'p1', name: 'Space', simple_name: 'sp' }], pagination: { has_more: false } }, 1).items,
    [{ key: 'p1', name: 'Space', simpleName: 'sp' }])
  assert.deepEqual(parseTypes({ work_item_types: [{ type_key: 'incident_custom', name: '事故' }] }), [{ key: 'incident_custom', name: '事故' }])
  assert.throws(() => parseProjects({ unexpected: [] }, 1), /响应/)
  assert.throws(() => parseTypes({ unexpected: [] }), /响应/)
})

test('MQL pagination preserves session and group, missing pagination is explicit', () => {
  const raw = { session_id: 's1', list: [{ group_infos: [{ group_id: 'g1', total: 51 }], work_items: [{ work_item_id: 7, name: '需求' }] }] }
  const page = parseItems(raw, { projectKey: 'p1', typeKey: 'incident_custom', page: 1 }, 'query')
  assert.equal(page.sessionId, 's1'); assert.equal(page.groupId, 'g1')
  assert.equal(page.hasMore, true); assert.equal(page.total, 51)
  assert.equal(page.items[0].projectKey, 'p1')
  const unknown = parseItems({ items: [] }, { projectKey: 'p1', typeKey: '', page: 1 }, 'todo')
  assert.equal(unknown.certainty, 'unknown'); assert.equal(unknown.hasMore, false)
  assert.throws(() => parseItems({ list: [{ group_infos: [{ group_id: '1' }, { group_id: '2' }], work_items: [] }] }, { projectKey: 'p', typeKey: 'x', page: 1 }, 'query'), /分组/)
})

test('detail retains description and custom fields for handoff', () => {
  const result = parseDetail({ work_item_id: '7', name: '需求', workitem_fields: [{ field_key: 'description', field_name: '描述', value: '**完成目标**' }, { field_key: 'custom', field_name: '验收条件', value: '保留我' }] }, 'p1')
  assert.equal(result.description, '**完成目标**')
  assert.ok(result.fields.some(f => f.value === '保留我'))
  assert.throws(() => parseDetail({ name: 'Missing ID' }, 'p1'), /响应/)
})

test('URL uses decoder and rejects mismatched authenticated host', async () => {
  const calls: string[][] = []
  const cli = new MeegleCli(async args => {
    calls.push(args)
    if (args[0] === 'url') return { url_kind: 'workitem_detail', host: 'project.feishu.cn', simple_name: 'space', work_item_id: '7' }
    return { authenticated: true, host: 'meegle.com' }
  })
  await assert.rejects(new MeegleService(cli).resolveUrl('https://project.feishu.cn/space/story/detail/7'), /站点/)
  assert.equal(calls[0][0], 'url'); assert.ok(!calls.some(args => args[0] === 'project'))
})

test('detail reads every field page and rejects repeated tokens', async () => {
  const requested: Record<string, unknown>[] = []
  const cli = { business: async (_command: string, params: Record<string, unknown>) => {
    requested.push(params)
    return params.page_token
      ? { work_item_id: '7', name: '需求', workitem_fields: [{ field_key: 'acceptance', field_name: '验收', value: '第二页' }] }
      : { work_item_id: '7', name: '需求', workitem_fields: [{ field_key: 'description', value: '第一页' }], next_page_token: 'acceptance' }
  } }
  const result = await new MeegleService(cli as never).detail('p1', '7')
  assert.equal(requested.length, 2); assert.equal(requested[1].page_token, 'acceptance')
  assert.equal(requested[0].page_size, 100)
  assert.ok(result.fields.some(field => field.value === '第二页'))
  const cycle = { business: async () => ({ work_item_id: '7', name: '需求', workitem_fields: [], next_page_token: 'same' }) }
  await assert.rejects(new MeegleService(cycle as never).detail('p1', '7'), /token 重复/)
})

test('query pagination uses the original session with numeric page parameters', async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = []
  const cli = { business: async (command: string, params: Record<string, unknown>) => {
    calls.push({ command, params }); return { session_id: 'original', total: 51, list: [{ group_infos: [{ group_id: 'g' }], work_items: [{ id: '9', name: '第二页' }] }] }
  } }
  const result = await new MeegleService(cli as never).items({ projectKey: 'p', typeKey: 'custom', page: 2, sessionId: 'original', groupId: 'g' })
  assert.equal(calls.length, 1); assert.equal(result.page, 2); assert.equal(result.hasMore, false)
  assert.deepEqual(calls[0].params, { project_key: 'p', session_id: 'original', group_pagination_list: [{ group_id: 'g', page_num: 2 }] })
})

test('unknown todo page size allows manual pagination until an empty page', () => {
  const result = parseItems({ items: [{ id: '7', name: '需求', project_key: 'p1' }], total: 3 }, { projectKey: '', typeKey: '', page: 1 }, 'todo')
  assert.equal(result.certainty, 'unknown')
  assert.equal(result.hasMore, true)
  const explicit = parseItems({ items: [{ id: '7', name: '需求', project_key: 'p1' }], pagination: { total: 3, page_size: 1 } }, { projectKey: '', typeKey: '', page: 1 }, 'todo')
  assert.equal(explicit.hasMore, true); assert.equal(explicit.certainty, 'known')
})

test('installed CLI todo envelope carries item info and project key at different levels', () => {
  const result = parseItems({ list: [{ project_key: 'p1', project_name: '空间', node_info: { node_name: '开发中' }, work_item_info: { work_item_id: 7, work_item_name: '需求', work_item_type_key: 'custom' } }], total: 1 }, { projectKey: '', typeKey: '', page: 1 }, 'todo')
  assert.equal(result.items[0].id, '7'); assert.equal(result.items[0].projectKey, 'p1')
  assert.equal(result.items[0].status, '开发中'); assert.equal(result.hasMore, false)
})

test('todo rows retain separate node identities without dropping repeated work items', () => {
  const row = (nodeKey?: string) => ({ project_key: 'p1', node_info: { node_name: '处理中', ...(nodeKey ? { node_state_key: nodeKey } : {}) }, work_item_info: { work_item_id: 7, work_item_name: '需求' } })
  const rows = [row('node-a'), row('node-b'), row('node-b'), row(), row()]
  const input = { projectKey: '', typeKey: '', page: 1 }
  const result = parseItems({ list: rows, total: rows.length }, input, 'todo')
  const keys = result.items.map(item => item.rowKey)
  assert.equal(result.items.length, 5); assert.equal(result.total, 5)
  assert.equal(result.hasMore, false)
  assert.ok(keys.every(key => typeof key === 'string' && key.length > 0))
  assert.equal(new Set(keys).size, 5)
  const reordered = parseItems({ list: [rows[1], rows[0]], total: 2 }, input, 'todo')
  assert.equal(reordered.items[0].rowKey, keys[1])
  assert.equal(reordered.items[1].rowKey, keys[0])
})

test('first MQL query uses authoritative project key, not a literal project alias', async () => {
  let mql = ''
  const cli = { business: async (command: string, params: Record<string, unknown>) => {
    if (command === 'workitem.meta-types') return [{ type_key: 'custom', name: '自定义' }]
    if (command === 'workitem.meta-fields') return { list: [{ field_key: 'name' }] }
    mql = String(params.mql)
    return { session_id: 's', list: [{ count: 0, group_infos: [{ group_id: '1' }], work_items: [] }] }
  } }
  await new MeegleService(cli as never).items({ projectKey: 'actual_key', typeKey: 'custom', page: 1 })
  assert.match(mql, /FROM `actual_key`\.`custom`/)
})

test('MQL response preserves data map alongside list metadata and typed fields', () => {
  const raw = { data: { 'group-1': [{ moql_field_list: [{ key: 'name', value_type: 'string_value', value: { string_value: '需求' } }, { key: 'work_item_id', value_type: 'long_value', value: { long_value: 7 } }] }] }, list: [{ count: 223, group_infos: [{ group_id: 'group-1', group_name: '' }] }], session_id: 's1', extra_info: null }
  const result = parseItems(raw, { projectKey: 'p1', typeKey: 'custom', page: 1 }, 'query')
  assert.equal(result.items[0].name, '需求'); assert.equal(result.items[0].id, '7')
  assert.equal(result.total, 223); assert.equal(result.sessionId, 's1'); assert.equal(result.groupId, 'group-1'); assert.equal(result.hasMore, true)
})

test('subsequent MQL page omits list and session metadata, retaining the original cursor and count', () => {
  const raw = { data: { '1': [{ moql_field_list: [{ key: 'name', value_type: 'string_value', value: { string_value: '尾页' } }, { key: 'work_item_id', value_type: 'long_value', value: { long_value: 9 } }] }] }, list: null, session_id: null, extra_info: null }
  const result = parseItems(raw, { projectKey: 'p1', typeKey: 'custom', page: 5, sessionId: 'original', groupId: '1', total: 201 }, 'query')
  assert.equal(result.items[0].id, '9'); assert.equal(result.sessionId, 'original')
  assert.equal(result.total, 201); assert.equal(result.hasMore, false); assert.equal(result.certainty, 'known')
})

test('installed CLI detail separates attributes, fields, and pagination', async () => {
  const raw = { pagination: { has_more: false, page_size: 100, total: 2 }, work_item_attribute: { work_item_id: '7', work_item_name: '需求', work_item_type: { key: 'custom', name: '自定义' }, work_item_status: { name: '开发中' }, owned_project: { key: 'p1' } }, work_item_fields: [{ key: 'description', name: '描述', value: '验收内容' }, { key: 'priority', name: '优先级', value: { name: 'P0' } }] }
  const result = await new MeegleService({ business: async () => raw } as never).detail('p1', '7')
  assert.equal(result.name, '需求'); assert.equal(result.description, '验收内容')
  assert.equal(result.typeKey, 'custom'); assert.equal(result.status, '开发中')
  assert.ok(result.fields.some(field => field.label === '优先级' && field.value === 'P0'))
  const incomplete = { ...raw, pagination: { has_more: true, total: 200, page_size: 100 } }
  await assert.rejects(new MeegleService({ business: async () => incomplete } as never).detail('p1', '7'), /翻页 token/)
})

test('status filter is validated against workflow metadata and selects real status', async () => {
  const mqls: string[] = []
  const statusField = { field_key: 'work_item_status', option: [{ option_id: 'a', option_name: 'Start' }, { option_id: 'b', option_name: 'Start' }, { option_id: 'c', option_name: 'In development' }] }
  const cli = { business: async (command: string, params: Record<string, unknown>) => {
    if (command === 'workitem.meta-types') return [{ type_key: 'story', name: '需求' }]
    if (command === 'workitem.meta-fields') return { list: [{ field_key: 'name' }, statusField] }
    mqls.push(String(params.mql))
    return { session_id: 's', data: { 1: [{ moql_field_list: [{ key: 'work_item_id', value_type: 'long_value', value: { long_value: 7 } }, { key: 'name', value_type: 'string_value', value: { string_value: '需求' } }, { key: 'work_item_status', value_type: 'key_label_value_list', value: { key_label_value_list: [{ key: 'c', label: 'In development' }] } }] }] }, list: [{ count: 1, group_infos: [{ group_id: '1' }] }] }
  } }
  const service = new MeegleService(cli as never)
  assert.deepEqual((await service.statuses('p', 'story')).map(s => s.name), ['Start', 'In development'])
  const result = await service.items({ projectKey: 'p', typeKey: 'story', page: 1, status: 'In development' })
  assert.match(mqls[0], /SELECT `work_item_id`, `name`, `work_item_status`/)
  assert.match(mqls[0], /AND `work_item_status` = 'In development'/)
  assert.equal(result.items[0].status, 'In development')
  await assert.rejects(service.items({ projectKey: 'p', typeKey: 'story', page: 1, status: 'Gone' }), /工作流/)
  await assert.rejects(service.items({ projectKey: 'p', typeKey: 'story', page: 1, status: "x' OR 1=1" }), /工作流|状态值/)
  assert.equal(mqls.length, 1)
})
