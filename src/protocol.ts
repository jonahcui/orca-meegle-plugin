export interface AuthState { authenticated: boolean; host: string | null; reason?: string }
export interface Choice { key: string; name: string; simpleName?: string }
export interface WorkItem {
  id: string; name: string; projectKey: string; typeKey?: string; status?: string; url?: string;
  /** List row identity: a work item can have several todo nodes. Not a business ID. */
  rowKey?: string;
}
export interface Page<T> {
  items: T[]; page: number; total?: number; hasMore: boolean;
  certainty: 'known' | 'unknown'; sessionId?: string; groupId?: string;
}
export interface Detail extends WorkItem { description: string; fields: { label: string; value: string }[] }
export interface Workspace { id: string; name: string; path: string; branch: string | null; hostId: string | null; kind?: 'worktree' | 'folder' }
export interface Workspaces { workspaces: Workspace[]; truncated: boolean }
export interface Bootstrap { auth: AuthState }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code: string }
export interface ListInput { projectKey: string; typeKey: string; page: number; sessionId?: string; groupId?: string; total?: number; status?: string }
export interface LaunchInput { workspaceId: string; agent: string; previewId: string }
export interface Preview { previewId: string; prompt: string; item: Detail }
export interface LaunchReceipt { terminalId: string; workspaceName: string }
export interface Repo { id: string; name: string; path: string }
export interface PlanInput { repoIds: string[]; name: string; root: string }
export interface PlanRepo { repoId: string; name: string; repoPath: string; target: string; base: string; nodeModules: boolean; warnings: string[]; problems: string[] }
/** A multi-repo task folder: `<root>/<branch>/<repo>`, every repo on the same branch. */
export interface WorkspacePlan { folder: string; branch: string; repos: PlanRepo[]; problems: string[]; ok: boolean }
export interface Comment { id: string; author: string; authorKey: string; createdAt: string; text: string; mentionsMe: boolean; fileUrl?: string }
export interface CommentPage { comments: Comment[]; page: number; totalPages: number; total: number }
export interface Mention { projectKey: string; id: string; name: string; comment: Comment }
/** `@我` is a scan of comments on the listed work items, not Meegle's message inbox. */
export interface MentionScan { mentions: Mention[]; scanned: number; failed: number; days: number; truncated: boolean }
export interface MentionInput { days: number; projectKey?: string; typeKey?: string }
/** A work item ↔ Orca workspace link, kept by the panel. */
export interface Link { workspaceId: string; name: string; path: string; branch: string | null; linkedAt: number; itemName?: string }

declare module 'orca' {
  interface PluginRequests {
    'meegle.auth': { output: Result<Bootstrap> }
    'meegle.projects': { input: { query: string; page: number }; output: Result<Page<Choice>> }
    'meegle.types': { input: { projectKey: string }; output: Result<Choice[]> }
    'meegle.items': { input: ListInput; output: Result<Page<WorkItem>> }
    'meegle.todos': { input: { page: number; assetKey: string }; output: Result<Page<WorkItem>> }
    'meegle.detail': { input: { projectKey: string; id: string }; output: Result<Detail> }
    'meegle.url': { input: { url: string }; output: Result<{ projects: Choice[]; id: string; host: string }> }
    'meegle.workspaces': { output: Result<Workspaces> }
    'meegle.preview': { input: { projectKey: string; id: string }; output: Result<Preview> }
    'meegle.launch': { input: LaunchInput; output: Result<LaunchReceipt> }
    'meegle.comments': { input: { projectKey: string; id: string; page: number }; output: Result<CommentPage> }
    'meegle.mentions': { input: MentionInput; output: Result<MentionScan> }
    'meegle.statuses': { input: { projectKey: string; typeKey: string }; output: Result<Choice[]> }
    'meegle.repos': { output: Result<Repo[]> }
    'meegle.workspaceRoot': { output: Result<string> }
    'meegle.suggestName': { input: { projectKey: string; id: string }; output: Result<{ name: string; engine: string }> }
    'meegle.planWorkspace': { input: PlanInput; output: Result<WorkspacePlan> }
    'meegle.createWorkspace': { input: PlanInput; output: Result<{ workspace: Workspace; created: string[] }> }
    'meegle.openWorkspace': { input: { workspaceId: string }; output: Result<{ opened: true }> }
  }
}
