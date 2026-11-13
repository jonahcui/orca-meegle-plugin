export class AppError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'AppError' }
}
export function problem(code: string, message: string): never { throw new AppError(code, message) }
export function required(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f]/.test(value)) problem('invalid_params', `${label}无效`)
  return value.trim()
}
export function pageNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) problem('invalid_params', '页码无效')
  return value
}
