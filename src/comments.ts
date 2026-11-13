import type { MeegleCli } from './cli'
import { unwrap } from './cli'
import { pageNumber, problem, required } from './errors'
import type { MeegleService } from './meegle'
import type { Comment, CommentPage, Mention, MentionInput, MentionScan, WorkItem } from './protocol'

type Obj = Record<string, unknown>
function obj(raw: unknown): Obj { return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Obj : {} }
function str(raw: unknown): string | undefined { return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined }

export interface Me { userKey: string; ids: Set<string>; names: string[] }
const MENTION = /<!--\s*mention:(\{[\s\S]*?\})\s*-->/g
const MAX_SCAN_ITEMS = 100
const SCAN_PAGES_PER_ITEM = 5
/** `comment list` is rate limited to 5 QPS per tenant tool; stay below it and retry. */
const SCAN_CONCURRENCY = 2
const SCAN_RETRIES = 2

/** Mention metadata ids and names in a rich-text comment (`@名字<!-- mention:{…} -->`). */
export function mentionTargets(content: string): { ids: string[]; names: string[] } {
  const ids: string[] = [], names: string[] = []
  for (const match of content.matchAll(MENTION)) {
    let meta: Obj = {}
    try { meta = obj(JSON.parse(match[1])) } catch { continue }
    const id = str(meta.id)
    if (id) ids.push(id)
    for (const name of [meta.cn_name, meta.en_name]) if (typeof name === 'string' && name) names.push(name)
  }
  return { ids, names }
}
/** Readable Markdown: editor metadata comments removed, `@名字` kept. */
export function commentText(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
}
export function mentionsMe(content: string, me: Me): boolean {
  const targets = mentionTargets(content)
  if (targets.ids.some(id => me.ids.has(id) || me.ids.has(id.replace(/^lark_user_id_/, '')))) return true
  // Fallback for plain `@名字` without metadata (older comments); match a whole name only.
  const text = commentText(content)
  return me.names.some(name => targets.names.includes(name) || new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w\\u4e00-\\u9fff])`).test(text))
}

export function parseComments(raw: unknown, page: number): { comments: Omit<Comment, 'author' | 'mentionsMe'>[]; content: string[]; totalPages: number; total: number } {
  const root = obj(unwrap(raw))
  const list = root.comments ?? root.list ?? root.items
  if (!Array.isArray(list)) problem('invalid_response', '评论响应结构无法识别')
  const pagination = obj(root.pagination)
  const total = Number(pagination.total ?? list.length), totalPages = Number(pagination.total_pages ?? page)
  const content: string[] = []
  const comments = list.map(value => {
    const c = obj(value), id = str(c.comment_id ?? c.id), raw = typeof c.content === 'string' ? c.content : ''
    if (!id) problem('invalid_response', '评论缺少 ID')
    content.push(raw)
    const fileUrl = str(c.file_url)
    return { id, authorKey: str(c.creator) ?? '', createdAt: str(c.created_at) ?? '', text: commentText(raw), ...(fileUrl && /^https?:\/\//.test(fileUrl) ? { fileUrl } : {}) }
  })
  return { comments, content, totalPages: Number.isSafeInteger(totalPages) && totalPages > 0 ? totalPages : page, total: Number.isSafeInteger(total) ? total : comments.length }
}

export class CommentService {
  private me?: Promise<Me>
  private names = new Map<string, string>()
  constructor(private cli: MeegleCli, private meegle: MeegleService, private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

  private async whoAmI(signal?: AbortSignal): Promise<Me> {
    this.me ??= this.cli.business('user.search', { user_keys: ['current_login_user()'] }, signal).then(raw => {
      const user = obj((Array.isArray(unwrap(raw)) ? unwrap(raw) as unknown[] : [])[0])
      const userKey = str(user.user_key)
      if (!userKey) problem('invalid_response', '无法确认当前用户，不能判断 @我')
      const ids = new Set([userKey, str(user.lark_user_id), str(user.out_id)].filter((v): v is string => Boolean(v)))
      const names = [user.name_cn, user.name_en, user.username].filter((v): v is string => typeof v === 'string' && v.length > 0)
      this.names.set(userKey, str(user.name_cn) ?? str(user.name_en) ?? userKey)
      return { userKey, ids, names }
    }).catch(error => { this.me = undefined; throw error })
    return this.me
  }
  /** user_key → display name, resolved 20 at a time and cached for the worker's life. */
  private async resolve(keys: string[], projectKey: string, signal?: AbortSignal): Promise<void> {
    const missing = [...new Set(keys)].filter(key => key && !this.names.has(key))
    for (let i = 0; i < missing.length; i += 20) {
      const batch = missing.slice(i, i + 20)
      try {
        const users = unwrap(await this.cli.business('user.search', { user_keys: batch, project_key: projectKey }, signal))
        for (const value of Array.isArray(users) ? users : []) {
          const user = obj(value), key = str(user.user_key)
          if (key) this.names.set(key, str(user.name_cn) || str(user.name_en) || str(user.username) || key)
        }
      } catch { /* Names are cosmetic: fall back to the key below. */ }
    }
  }
  private async page(projectKey: string, id: string, page: number, signal?: AbortSignal, since?: number): Promise<CommentPage> {
    const raw = await this.cli.business('comment.list', { project_key: projectKey, work_item_id: id, page_num: page, ...(since ? { start_time: since } : {}) }, signal)
    const parsed = parseComments(raw, page), me = await this.whoAmI(signal)
    await this.resolve(parsed.comments.map(c => c.authorKey), projectKey, signal)
    return {
      comments: parsed.comments.map((c, i) => ({ ...c, author: this.names.get(c.authorKey) ?? c.authorKey, mentionsMe: mentionsMe(parsed.content[i], me) })),
      page, totalPages: parsed.totalPages, total: parsed.total
    }
  }
  async comments(projectKey: string, id: string, page: number, signal?: AbortSignal): Promise<CommentPage> {
    return this.page(required(projectKey, '空间'), required(id, '工作项 ID'), pageNumber(page), signal)
  }
  /** Scans comments on my todos (and optionally recent participated items) for mentions of me. */
  async mentions(input: MentionInput, signal?: AbortSignal): Promise<MentionScan> {
    if (![7, 30, 90].includes(input.days)) problem('invalid_params', '时间范围无效')
    const since = this.now() - input.days * 86_400_000
    const targets = new Map<string, Pick<WorkItem, 'projectKey' | 'id' | 'name'>>()
    for (let page = 1; page <= 10; page++) {
      const todos = await this.meegle.todos(page, '', signal)
      for (const item of todos.items) targets.set(`${item.projectKey}:${item.id}`, item)
      if (!todos.hasMore || !todos.items.length) break
    }
    if (input.projectKey && input.typeKey) {
      const recent = await this.meegle.items({ projectKey: input.projectKey, typeKey: input.typeKey, page: 1 }, signal)
      for (const item of recent.items) targets.set(`${item.projectKey}:${item.id}`, item)
    }
    const items = [...targets.values()].slice(0, MAX_SCAN_ITEMS)
    const mentions: Mention[] = []
    let failed = 0, next = 0
    const worker = async () => {
      while (next < items.length && !signal?.aborted) {
        const item = items[next++], found: Mention[] = []
        let done = false
        for (let attempt = 0; attempt <= SCAN_RETRIES && !done && !signal?.aborted; attempt++) {
          if (attempt) await this.sleep(1000 * attempt)
          found.length = 0
          try {
            for (let page = 1; page <= SCAN_PAGES_PER_ITEM; page++) {
              const result = await this.page(item.projectKey, item.id, page, signal, since)
              for (const comment of result.comments) if (comment.mentionsMe) found.push({ projectKey: item.projectKey, id: item.id, name: item.name, comment })
              if (page >= result.totalPages) break
            }
            done = true
          } catch { /* rate limit or transient error: retry below */ }
        }
        if (done) mentions.push(...found)
        else failed++
      }
    }
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker))
    mentions.sort((a, b) => b.comment.createdAt.localeCompare(a.comment.createdAt))
    return { mentions, scanned: items.length - failed, failed, days: input.days, truncated: targets.size > MAX_SCAN_ITEMS }
  }
}
