import type { OrcaWorkerApi } from 'orca/worker'
import { MeegleService } from './meegle'
import { Handoff } from './handoff'
import { AppError } from './errors'
import { OrcaWorkspaces } from './orca'
import { CommentService } from './comments'
import { MultiWorkspace } from './multiws'
import type { Result } from './protocol'

async function result<T>(operation: () => Promise<T> | T): Promise<Result<T>> {
  try { return { ok: true, value: await operation() } }
  catch (error) {
    return { ok: false, code: error instanceof AppError ? error.code : 'action_failed', error: error instanceof AppError ? error.message : '操作失败，请检查 Orca 权限与本机环境。未显示原始输出。' }
  }
}
export default function activate(orca: OrcaWorkerApi): void {
  const meegle = new MeegleService(), handoff = new Handoff(orca.host), workspaces = new OrcaWorkspaces(orca.host), comments = new CommentService(meegle.cli, meegle)
  const multi = new MultiWorkspace(workspaces, workspaces)
  orca.panels.handle('meegle.auth', (_, ctx) => result(async () => ({ auth: await meegle.cli.auth(ctx.signal) })))
  orca.panels.handle('meegle.projects', (input, ctx) => result(() => meegle.projects(input.query, input.page, ctx.signal)))
  orca.panels.handle('meegle.types', (input, ctx) => result(() => meegle.types(input.projectKey, ctx.signal)))
  orca.panels.handle('meegle.items', (input, ctx) => result(() => meegle.items(input, ctx.signal)))
  orca.panels.handle('meegle.todos', (input, ctx) => result(() => meegle.todos(input.page, input.assetKey, ctx.signal)))
  orca.panels.handle('meegle.detail', (input, ctx) => result(() => meegle.detail(input.projectKey, input.id, ctx.signal)))
  orca.panels.handle('meegle.url', (input, ctx) => result(() => meegle.resolveUrl(input.url, ctx.signal)))
  orca.panels.handle('meegle.workspaces', () => result(() => handoff.workspaces()))
  orca.panels.handle('meegle.preview', (input, ctx) => result(async () => handoff.preview(await meegle.detail(input.projectKey, input.id, ctx.signal), ctx.panel.id)))
  orca.panels.handle('meegle.comments', (input, ctx) => result(() => comments.comments(input.projectKey, input.id, input.page, ctx.signal)))
  orca.panels.handle('meegle.mentions', (input, ctx) => result(() => comments.mentions(input, ctx.signal)))
  orca.panels.handle('meegle.statuses', (input, ctx) => result(() => meegle.statuses(input.projectKey, input.typeKey, ctx.signal)))
  orca.panels.handle('meegle.repos', () => result(() => workspaces.repos()))
  orca.panels.handle('meegle.workspaceRoot', () => result(() => multi.root()))
  orca.panels.handle('meegle.suggestName', (input, ctx) => result(async () => multi.suggestName(await meegle.detail(input.projectKey, input.id, ctx.signal))))
  orca.panels.handle('meegle.planWorkspace', input => result(() => multi.plan(input)))
  orca.panels.handle('meegle.createWorkspace', input => result(() => multi.create(input)))
  orca.panels.handle('meegle.openWorkspace', input => result(() => workspaces.open(input.workspaceId)))
  orca.panels.handle('meegle.launch', (input, ctx) => result(() => handoff.launch(input, ctx.panel.id)))
}
