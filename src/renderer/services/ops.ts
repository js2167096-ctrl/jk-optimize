import type { ActionDescriptor, ActionOutcome, ActionPreview, ChangeRecord, LogEntry, LogQuery } from '@shared/types/ops'
import { api, call } from './api'

export const newJobId = () => crypto.randomUUID()

export function query<T>(id: string, params?: unknown, jobId?: string): Promise<T> {
  return call(api.ops.query<T>(id, params ?? {}, jobId))
}

export const ops = {
  actions: () => call<ActionDescriptor[]>(api.ops.actions()),
  preview: (actionId: string, params: unknown) => call<ActionPreview>(api.ops.preview(actionId, params)),
  execute: (previewId: string, confirmed: boolean, jobId?: string) => call<ActionOutcome>(api.ops.execute(previewId, confirmed, jobId)),
  revert: (changeId: string, force: boolean) => call<ChangeRecord>(api.ops.revert(changeId, force)),
  cancel: (jobId: string) => call<boolean>(api.ops.cancel(jobId)),
  changes: () => call<ChangeRecord[]>(api.ops.changes()),
  logs: (q: LogQuery) => call<LogEntry[]>(api.ops.logs(q))
}
