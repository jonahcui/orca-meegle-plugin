import { MeegleCli, unwrap } from './cli'
import { pageNumber, problem, required } from './errors'
import type { Choice, Detail, ListInput, Page, WorkItem } from './protocol'

type Obj = Record<string, unknown>
function obj(raw: unknown): Obj { return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Obj : {} }
function str(raw: unknown): string | undefined { return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined }
function list(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw
  const value = obj(raw)
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as unknown[]
  problem('invalid_response', 'Meegle 响应结构尚未适配，无法确认列表。请提供脱敏响应以完成联调。')
}
function count(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}
function paging<T>(raw: unknown, items: T[], page: number, defaultSize?: number): Page<T> {
  const r = obj(raw), p = obj(r.pagination), g = obj(r.page_info)
  const total = count(p.total ?? r.total ?? r.total_count ?? g.total)
  const hasMore = p.has_more ?? r.has_more ?? g.has_more
  const size = count(p.page_size ?? r.page_size ?? g.page_size) ?? defaultSize
  const canCount = total !== undefined && size !== undefined && size > 0
  const completeFirstPage = page === 1 && total === items.length
  return {
    items, page, ...(total === undefined ? {} : { total }),
    hasMore: typeof hasMore === 'boolean' ? hasMore : canCount ? page * size < total : !completeFirstPage && items.length > 0,
    certainty: typeof hasMore === 'boolean' || canCount || completeFirstPage ? 'known' : 'unknown'
  }
}
export function parseProjects(raw: unknown, page: number): Page<Choice> {
  raw = unwrap(raw)
  const items = list(raw, ['projects', 'project_list', 'list', 'items']).map(value => {
    const p = obj(value), key = str(p.project_key ?? p.key), name = str(p.name ?? p.project_name)
    if (!key || !name) problem('invalid_response', '空间响应缺少 key 或名称')
    const simpleName = str(p.simple_name)
    return { key, name, ...(simpleName ? { simpleName } : {}) }
  })
  return paging(raw, items, page, 50)
}
export function parseTypes(raw: unknown): Choice[] {
  return list(unwrap(raw), ['work_item_types', 'work_item_type_list', 'types', 'list', 'items']).map(value => {
    const type = obj(value), key = str(type.type_key ?? type.work_item_type_key ?? type.key), name = str(type.name ?? type.type_name)
    if (!key || !name) problem('invalid_response', '类型响应缺少 key 或名称')
    return { key, name }
  })
}
function label(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(label).filter(Boolean).join('、')
  const v = obj(value)
  return str(v.label ?? v.name ?? v.text) ?? JSON.stringify(value)
}
function parseItem(raw: unknown, projectKey: string, typeKey = ''): WorkItem {
  const original = obj(raw), embedded = obj(original.work_item ?? original.work_item_info)
  const columns: Obj = {}
  if (Array.isArray(original.moql_field_list)) {
    for (const value of original.moql_field_list) {
      const field = obj(value), key = str(field.key), valueType = str(field.value_type)
      if (key) columns[key] = valueType ? obj(field.value)[valueType] : field.value
    }
  }
  const r = { ...original, ...embedded, ...columns }
  const id = str(r.work_item_id ?? r.id), name = str(r.name ?? r.work_item_name ?? r.title)
  if (!id || !name) problem('invalid_response', '工作项响应缺少 ID 或名称')
  const key = str(r.project_key) ?? projectKey
  if (!key) problem('invalid_response', '待办缺少空间 key，无法可靠打开详情')
  const status = label(r.work_item_status ?? r.status ?? obj(original.node_info).node_name), url = str(r.url ?? r.work_item_url)
  return { id, name, projectKey: key, typeKey: str(r.work_item_type_key ?? r.type_key) ?? typeKey, ...(status ? { status } : {}), ...(url && /^https?:\/\//.test(url) ? { url } : {}) }
}
export function parseItems(raw: unknown, input: ListInput, mode: 'query' | 'todo'): Page<WorkItem> {
  raw = unwrap(raw)
  const root = obj(raw)
  let base = raw, group: Obj = {}
  if (mode === 'query' && Array.isArray(root.list)) {
    const groups = root.list as unknown[]
    if (groups.length > 1) problem('unsupported_groups', '查询返回多个分组，当前面板未适配，已停止以避免遗漏。')
    if (groups.length === 0) return paging(raw, [], input.page)
    const groupBase = obj(groups[0]), infos = groupBase.group_infos
    if (Array.isArray(infos) && infos.length > 1) problem('unsupported_groups', '查询返回多个分组，已停止以避免遗漏。')
    group = Array.isArray(infos) ? obj(infos[0]) : groupBase
    const groupId = str(group.group_id) ?? input.groupId
    const rows = groupId ? obj(root.data)[groupId] : undefined
    base = Array.isArray(rows) ? { ...groupBase, items: rows } : groupBase
    if (groupBase.count !== undefined) group.total = groupBase.count
  }
  if (mode === 'query' && !Array.isArray(root.list) && input.groupId) {
    const data = obj(root.data)
    if (Object.keys(data).length > 1) problem('unsupported_groups', '分页返回多个分组，已停止以避免遗漏。')
    if (Array.isArray(data[input.groupId])) base = { items: data[input.groupId] }
  }
  const occurrences = new Map<string, number>()
  const items = list(base, ['work_items', 'work_item_list', 'rows', 'items', 'todo_list', 'list']).map(rawItem => {
    const item = parseItem(rawItem, input.projectKey, input.typeKey)
    const nodeKey = mode === 'todo' ? str(obj(obj(rawItem).node_info).node_state_key) ?? '' : ''
    const identity = JSON.stringify([item.projectKey, item.id, nodeKey])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    // Preserve every source record, including repeated/missing node IDs, while
    // keeping distinct todo nodes stable when their order changes.
    return { ...item, rowKey: JSON.stringify([identity, occurrence]) }
  })
  const result = paging({ ...obj(base), ...root, ...(group.total !== undefined ? { total: group.total } : input.total !== undefined ? { total: input.total } : {}) }, items, input.page, mode === 'query' ? 50 : undefined)
  const sessionId = str(root.session_id) ?? input.sessionId
  const groupId = str(group.group_id) ?? input.groupId
  if (sessionId) result.sessionId = sessionId
  if (groupId) result.groupId = groupId
  if (mode === 'query' && result.hasMore && (!sessionId || !groupId)) problem('pagination_missing', '分页响应缺少 session/group，无法可靠读取下一页。')
  return result
}
export function parseDetail(raw: unknown, projectKey: string): Detail {
  raw = unwrap(raw)
  const root = obj(raw), data = Object.keys(obj(root.work_item)).length ? obj(root.work_item) : root
  const attributes = obj(data.work_item_attribute)
  const item = parseItem({ ...attributes, ...data, work_item_type_key: obj(attributes.work_item_type).key ?? data.work_item_type_key }, projectKey)
  const values = data.workitem_fields ?? data.work_item_fields ?? data.fields ?? []
  if (!Array.isArray(values)) problem('invalid_response', '详情字段响应无法识别')
  const fields = values.map(value => {
    const field = obj(value)
    return { label: label(field.field_name ?? field.name ?? field.field_key ?? field.key), value: label(field.value ?? field.field_value) }
  }).filter(field => field.label && field.value)
  const description = label(data.description) || label(values.map(obj).find(f => (f.field_key ?? f.key) === 'description')?.value)
  return { ...item, description, fields }
}
export function statusOptions(fields: unknown[]): Choice[] {
  const field = fields.map(obj).find(f => (f.field_key ?? f.key) === 'work_item_status')
  const options = Array.isArray(field?.option) ? field.option : Array.isArray(field?.options) ? field.options : []
  const names = new Set<string>()
  for (const option of options) {
    const name = str(obj(option).option_name ?? obj(option).label ?? obj(option).name)
    if (name) names.add(name)
  }
  return [...names].map(name => ({ key: name, name }))
}
function literal(value: string): string {
  if (!value || /['\\\u0000-\u001f]/.test(value) || value.length > 200) problem('invalid_params', '状态值无效')
  return "'" + value + "'"
}
function identifier(key: string): string {
  if (!key || /[`\u0000-\u001f.]/.test(key)) problem('invalid_params', '工作项类型 key 无效')
  return '`' + key + '`'
}

export class MeegleService {
  constructor(public cli = new MeegleCli()) {}
  async projects(query: string, page: number, signal?: AbortSignal): Promise<Page<Choice>> {
    const params = { ...(query.trim() ? { project_key: required(query, '空间') } : {}), page_num: pageNumber(page) }
    return parseProjects(await this.cli.business('project.search', params, signal), page)
  }
  async types(projectKey: string, signal?: AbortSignal): Promise<Choice[]> {
    return parseTypes(await this.cli.business('workitem.meta-types', { project_key: required(projectKey, '空间') }, signal))
  }
  /** Workflow status options of a type, from metadata. Names repeat across stages; keep each once. */
  async statuses(projectKey: string, typeKey: string, signal?: AbortSignal): Promise<Choice[]> {
    const raw = await this.cli.business('workitem.meta-fields', { project_key: required(projectKey, '空间'), work_item_type: required(typeKey, '类型'), page_num: 1, field_keys: ['work_item_status'] }, signal)
    return statusOptions(list(raw, ['fields', 'field_list', 'list', 'items']))
  }
  async items(input: ListInput, signal?: AbortSignal): Promise<Page<WorkItem>> {
    const projectKey = required(input.projectKey, '空间'), typeKey = required(input.typeKey, '类型'), page = pageNumber(input.page)
    let params: Obj = { project_key: projectKey }
    if (page > 1) {
      params = { ...params, session_id: required(input.sessionId ?? '', '分页会话'), group_pagination_list: [{ group_id: required(input.groupId ?? '', '分页分组'), page_num: page }] }
    } else {
      const types = await this.types(projectKey, signal)
      if (!types.some(type => type.key === typeKey)) problem('type_changed', '所选工作项类型已不可用，请刷新类型列表。')
      const fieldsRaw = await this.cli.business('workitem.meta-fields', { project_key: projectKey, work_item_type: typeKey, page_num: 1, field_keys: ['name', 'work_item_status'] }, signal)
      const fields = list(fieldsRaw, ['fields', 'field_list', 'list', 'items'])
      if (!fields.some(f => ['name', '名称'].includes(label(obj(f).field_key ?? obj(f).key)))) problem('metadata_missing', '元数据未确认 name 字段，已停止查询。')
      const hasStatus = fields.some(f => label(obj(f).field_key ?? obj(f).key) === 'work_item_status')
      let where = 'array_contains(all_participate_persons(), current_login_user())'
      if (input.status) {
        if (!statusOptions(fields).some(option => option.key === input.status)) problem('status_changed', '所选状态已不在该类型的工作流中，请刷新筛选。')
        where += ' AND `work_item_status` = ' + literal(input.status)
      }
      params.mql = 'SELECT `work_item_id`, `name`' + (hasStatus ? ', `work_item_status`' : '') + ' FROM ' + identifier(projectKey) + '.' + identifier(typeKey) + ' WHERE ' + where + ' ORDER BY `updated_at` DESC'
    }
    return parseItems(await this.cli.business('workitem.query', params, signal), input, 'query')
  }
  async todos(page: number, assetKey: string, signal?: AbortSignal): Promise<Page<WorkItem>> {
    return parseItems(await this.cli.business('mywork.todo', { action: 'todo', todo_scope: 'in_progress', page_num: pageNumber(page), ...(assetKey.trim() ? { asset_key: required(assetKey, '工作区 key') } : {}) }, signal), { projectKey: '', typeKey: '', page }, 'todo')
  }
  async detail(projectKey: string, id: string, signal?: AbortSignal): Promise<Detail> {
    const params = { project_key: required(projectKey, '空间'), work_item_id: required(id, '工作项 ID'), fields: ['_all'], page_size: 100 }
    let raw: Obj = {}, fields: unknown[] = [], token: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 30; page++) {
      const response = obj(await this.cli.business('workitem.get', { ...params, ...(token ? { page_token: token } : {}) }, signal))
      const data = Object.keys(obj(response.work_item)).length ? obj(response.work_item) : response
      raw = { ...raw, ...data }
      const nextFields = data.workitem_fields ?? data.work_item_fields ?? data.fields
      if (!Array.isArray(nextFields)) problem('invalid_response', '详情响应缺少字段集合，无法确认需求完整性。')
      fields.push(...nextFields)
      token = str(response.next_page_token ?? data.next_page_token ?? obj(response.pagination).next_page_token)
      if (!token) {
        if (response.has_more === true || data.has_more === true || obj(response.pagination).has_more === true) problem('pagination_missing', '详情还有字段但缺少翻页 token')
        return parseDetail({ ...raw, workitem_fields: fields }, projectKey)
      }
      if (seen.has(token)) problem('pagination_cycle', '详情分页 token 重复，已停止')
      seen.add(token)
    }
    problem('too_large', '详情字段超过 30 页，请在 Meegle 中确认需求范围后再交接。')
  }
  async resolveUrl(url: string, signal?: AbortSignal): Promise<{ projects: Choice[]; id: string; host: string }> {
    if (!/^https:\/\//i.test(url) || url.length > 4096) problem('invalid_params', '请输入完整 HTTPS 工作项详情链接')
    const decoded = obj(await this.cli.decode(url, signal))
    if (decoded.url_kind !== 'workitem_detail') problem('invalid_url', '链接不是可读取的工作项详情页，请使用详情链接。')
    const host = required(str(decoded.host) ?? '', '链接站点'), id = required(str(decoded.work_item_id) ?? '', '工作项 ID')
    const simpleName = required(str(decoded.simple_name) ?? '', '空间名称')
    const auth = await this.cli.auth(signal)
    if (!auth.authenticated) problem('unauthenticated', '请先登录 Meegle，再点击“重新检查连接”。')
    if (auth.host?.toLowerCase() !== host.toLowerCase()) problem('host_mismatch', `链接站点为 ${host}，请先使用此站点登录。`)
    const projects = await this.projects(simpleName, 1, signal)
    // Do not silently pick a partial or ambiguous result set.
    if (projects.hasMore || projects.certainty === 'unknown' && projects.items.length >= 50) problem('ambiguous_space', '空间结果不完整，请通过空间搜索选择权威空间后按 ID 打开。')
    if (!projects.items.length) problem('project_missing', '当前账号没有找到链接中的空间')
    return { projects: projects.items, id, host }
  }
}
