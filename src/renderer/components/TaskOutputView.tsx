import type { DetailTone, TaskRunRecord } from '@shared/types'
import { formatDateTime } from '@shared/format'
import { Badge, cx, Notice } from './ui'

const TONE_TEXT: Record<DetailTone, string> = {
  neutral: 'text-fg',
  ok: 'text-optimize',
  warn: 'text-alert',
  error: 'text-danger'
}

export function TaskOutputView({ record, compact }: { record: TaskRunRecord; compact?: boolean }) {
  return (
    <div className="space-y-4">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-subtle">
          <Badge tone={record.ok ? 'ok' : 'error'}>{record.ok ? 'Sucesso' : 'Falha'}</Badge>
          <span>{formatDateTime(record.startedAt)}</span>
          <span>·</span>
          <span>{(record.durationMs / 1000).toFixed(1)} s</span>
        </div>
      )}
      {record.error && <Notice tone="error" title="A tarefa falhou">{record.error.message}</Notice>}
      {record.output && (
        <>
          {record.output.summary && <p className="text-[13px] font-medium text-fg">{record.output.summary}</p>}
          <div className={cx('grid gap-3', !compact && 'xl:grid-cols-2')}>
            {record.output.sections.map((section) => (
              <div key={section.title} className="rounded-control border border-line bg-elevated p-3">
                <h4 className="mb-2 text-[11px] font-semibold tracking-wider text-subtle uppercase">{section.title}</h4>
                <dl className="space-y-1.5">
                  {section.rows.map((row, i) => (
                    <div key={`${row.label}-${i}`} className="flex justify-between gap-4 text-[12px]">
                      <dt className="shrink-0 text-muted">{row.label}</dt>
                      <dd className={cx('selectable min-w-0 text-right break-words', TONE_TEXT[row.tone ?? 'neutral'])}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
