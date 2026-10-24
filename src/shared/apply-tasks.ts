// Estado final das tarefas da tela de aplicação. Função pura (testável): decide, para cada ajuste,
// se deu certo, falhou ou não foi executado, e classifica o resultado geral. O estado "ok" só vale
// quando o Windows, lido de novo depois da operação, mostra o valor desejado.

export type TaskState = 'wait' | 'run' | 'ok' | 'fail' | 'skip'

export interface ApplyTask {
  id: string
  name: string
  from: string
  to: string
  state: TaskState
  detail?: string
}

export interface OutcomeRow {
  label: string
  value: string
  tone?: string
}

export type ResultKind = 'success' | 'partial' | 'failure' | 'cancelled'

/**
 * @param okIds     ids cujo valor lido agora no Windows é o desejado (null = não foi possível reler)
 * @param failure   erro que impediu a operação de devolver resultado (ou null)
 */
export function settleTasks(tasks: ApplyTask[], rows: OutcomeRow[], okIds: Set<string> | null, failure: string | null): ApplyTask[] {
  return tasks.map((t): ApplyTask => {
    const row = rows.find((r) => r.label === t.name)
    if (okIds && okIds.has(t.id)) return { ...t, state: 'ok', detail: row?.value }
    if (row) return { ...t, state: row.tone === 'error' ? 'fail' : 'skip', detail: row.value }
    return { ...t, state: failure ? 'fail' : 'skip', detail: failure ?? 'Não executado' }
  })
}

export function classifyResult(tasks: ApplyTask[], cancelRequested: boolean): ResultKind {
  const ok = tasks.filter((t) => t.state === 'ok').length
  if (tasks.length > 0 && ok === tasks.length) return 'success'
  if (cancelRequested && ok === 0) return 'cancelled'
  if (ok > 0) return 'partial'
  return 'failure'
}

/** Ajustes aplicados com sucesso que só valem depois de reiniciar o Windows. */
export function restartNamesFor(tasks: ApplyTask[], needsRestart: (id: string) => boolean): string[] {
  return tasks.filter((t) => t.state === 'ok' && needsRestart(t.id)).map((t) => t.name)
}
