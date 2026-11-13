import { assert, test } from 'orca/testing'
import { CommentService, commentText, mentionsMe, mentionTargets, parseComments, type Me } from './comments'
import { AppError } from './errors'

// Synthetic fixtures shaped like `meegle comment list`; no account data.
const me: Me = { userKey: '7000000000000000001', ids: new Set(['7000000000000000001', '42']), names: ['张三', 'Zhang San'] }
const at = (name: string, id: string) => `@${name}<!-- mention:{"id":"${id}","cn_name":"${name}","en_name":"","blockType":"AT_USER_BLOCK"} -->`

test('mention metadata and plain @name identify me; metadata is stripped from text', () => {
  const content = `请看 ${at('李四', '7000000000000000002')} 和 ${at('张三', '7000000000000000001')}<!-- linkPreview -->`
  assert.deepEqual(mentionTargets(content).ids, ['7000000000000000002', '7000000000000000001'])
  assert.equal(mentionsMe(content, me), true)
  assert.equal(commentText(content), '请看 @李四 和 @张三')
  assert.equal(mentionsMe(`抄送 ${at('李四', '7000000000000000002')}`, me), false)
  assert.equal(mentionsMe('旧评论 @张三 看一下', me), true)
  assert.equal(mentionsMe('@张三丰 不是我', me), false)
  assert.equal(mentionsMe(`${at('Z', 'lark_user_id_42')}`, me), true)
})

test('comment pages parse pagination and refuse unknown shapes', () => {
  const page = parseComments({ comments: [{ comment_id: '1', content: 'hi', created_at: '2026-11-01 10:00:00', creator: 'u1', file_url: '' }], pagination: { page_num: 1, total: 21, total_pages: 2 } }, 1)
  assert.equal(page.totalPages, 2); assert.equal(page.total, 21); assert.equal(page.comments[0].authorKey, 'u1')
  assert.equal(parseComments({ comments: [], pagination: { total: 0, total_pages: 0 } }, 1).totalPages, 1)
  assert.throws(() => parseComments({ nope: true }, 1), /评论/)
})

function fakeCli(options: { failFirst?: Set<string> } = {}) {
  const calls: { command: string; params: Record<string, unknown> }[] = []
  const failed = new Set<string>()
  const cli = { business: async (command: string, params: Record<string, unknown>) => {
    calls.push({ command, params })
    if (command === 'user.search') {
      const keys = params.user_keys as string[]
      if (keys[0] === 'current_login_user()') return [{ user_key: me.userKey, lark_user_id: 42, name_cn: '张三', name_en: 'Zhang San' }]
      return keys.map(key => ({ user_key: key, name_cn: `用户${key.slice(-1)}` }))
    }
    const id = String(params.work_item_id)
    if (options.failFirst?.has(id) && !failed.has(id)) { failed.add(id); throw new AppError('remote_error', 'rate limit') }
    const content = id === 'a' ? `${at('张三', me.userKey)} 请处理` : '无关评论'
    return { comments: [{ comment_id: `${id}-1`, content, created_at: id === 'a' ? '2026-11-02 09:00:00' : '2026-11-01 09:00:00', creator: 'u2' }], pagination: { total: 1, total_pages: 1 } }
  } }
  return { cli, calls }
}
const meegle = {
  todos: async () => ({ items: [{ id: 'a', name: '需求A', projectKey: 'p' }, { id: 'b', name: '需求B', projectKey: 'p' }, { id: 'a', name: '需求A', projectKey: 'p' }], page: 1, hasMore: false, certainty: 'known' as const }),
  items: async () => ({ items: [{ id: 'c', name: '需求C', projectKey: 'p' }], page: 1, hasMore: false, certainty: 'known' as const })
}

test('comments resolve author names and flag mentions of me', async () => {
  const { cli } = fakeCli()
  const page = await new CommentService(cli as never, meegle as never).comments('p', 'a', 1)
  assert.equal(page.comments[0].author, '用户2'); assert.equal(page.comments[0].mentionsMe, true)
  assert.equal(page.comments[0].text, '@张三 请处理')
})

test('mention scan dedupes items, includes participated items, retries rate limits, filters by time', async () => {
  const { cli, calls } = fakeCli({ failFirst: new Set(['b']) })
  const service = new CommentService(cli as never, meegle as never, () => 10 * 86_400_000, async () => {})
  const scan = await service.mentions({ days: 7, projectKey: 'p', typeKey: 'story' })
  assert.equal(scan.scanned, 3); assert.equal(scan.failed, 0)
  assert.deepEqual(scan.mentions.map(m => m.id), ['a'])
  assert.equal(calls.filter(c => c.command === 'comment.list' && c.params.work_item_id === 'b').length, 2)
  assert.ok(calls.filter(c => c.command === 'comment.list').every(c => c.params.start_time === 3 * 86_400_000))
  await assert.rejects(service.mentions({ days: 3 }), /时间范围/)
})

test('items still failing after retries are counted, not hidden', async () => {
  const cli = { business: async (command: string, params: Record<string, unknown>) => {
    if (command === 'user.search') return [{ user_key: me.userKey, name_cn: '张三' }]
    if (params.work_item_id === 'b') throw new AppError('remote_error', 'rate limit')
    return { comments: [], pagination: { total: 0, total_pages: 0 } }
  } }
  const scan = await new CommentService(cli as never, meegle as never, Date.now, async () => {}).mentions({ days: 30 })
  assert.equal(scan.failed, 1); assert.equal(scan.scanned, 1)
})
