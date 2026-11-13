import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { AppError, problem, required } from './errors'
import type { Repo, Workspace } from './protocol'

/** Runs the Orca CLI with an argument array (no shell) and returns its `result`. */
export type OrcaRunner = (args: string[]) => Promise<unknown>
type Obj = Record<string, unknown>
function record(value: unknown): Obj { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {} }
const APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

export const runOrca: OrcaRunner = args => new Promise((resolve, reject) => {
  execFile(existsSync(APP_CLI) ? APP_CLI : 'orca', [...args, '--json'], { shell: false, encoding: 'utf8', timeout: 110000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    let parsed: unknown
    try { parsed = JSON.parse(stdout) } catch { /* reported below */ }
    const answer = record(parsed)
    if (answer.ok === true) return resolve(answer.result)
    // Orca's own error text (e.g. "branch already exists") is actionable and holds no credentials.
    const reason = typeof record(answer.error).message === 'string' ? String(record(answer.error).message).slice(0, 300) : ''
    reject(new AppError('orca_failed', reason ? `Orca 返回错误：${reason}` : error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? '未找到 Orca CLI。' : 'Orca CLI 执行失败或超时。'))
  })
})

/** Git branch name the person can edit; refuses option-like or ref-breaking input. */
export function branchName(value: string): string {
  const branch = required(value, '分支名')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || /\.\.|\/\/|\.lock$|\/$|\.$|@\{/.test(branch)) problem('invalid_params', '分支名无效：只用字母、数字、. _ - /，且不能以 - 开头')
  return branch
}
export function defaultBranch(id: string): string { return `feature-meegle-${id.replace(/[^A-Za-z0-9]/g, '')}` }

export class OrcaWorkspaces {
  constructor(private host: OrcaWorkerApi['host'], private run: OrcaRunner = runOrca) {}
  async list(): Promise<Workspace[]> {
    if (!this.host.has('workspace.list')) problem('unsupported_host', '当前 Orca 不支持列出工作区。')
    return (await this.host.call('workspace.list')).workspaces
  }
  async repos(): Promise<Repo[]> {
    const repos = record(await this.run(['repo', 'list'])).repos
    if (!Array.isArray(repos)) problem('invalid_response', 'Orca 仓库列表无法识别')
    return repos.map(record).filter(r => r.kind === 'git' && typeof r.id === 'string' && typeof r.path === 'string')
      .map(r => ({ id: String(r.id), name: String(r.displayName ?? r.name ?? r.path), path: String(r.path) }))
  }
  async open(workspaceId: string): Promise<{ opened: true }> {
    required(workspaceId, '工作区')
    if (!this.host.has('workspace.open')) problem('unsupported_host', '当前 Orca 不支持从插件打开工作区。')
    if (!(await this.list()).some(w => w.id === workspaceId)) problem('workspace_missing', '关联的工作区已不存在，请重新关联。')
    return this.host.call('workspace.open', { workspaceId })
  }
}
