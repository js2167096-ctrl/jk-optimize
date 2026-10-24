// Catálogo de tarefas predefinidas do executor. Somente tarefas listadas aqui
// podem ser executadas; os parâmetros são validados contra a especificação
// tanto no processo principal quanto no próprio executor.
import type { TaskDescriptor, TaskParamValue } from '@shared/types'

export const TASK_CATALOG: readonly TaskDescriptor[] = [
  {
    id: 'executor.self-check',
    name: 'Verificação do executor',
    description: 'Confirma que o processo do executor está ativo e informa versão, memória e nível de privilégio.',
    category: 'diagnostic',
    changesSystem: false,
    requiresElevation: false,
    params: []
  },
  {
    id: 'diagnostic.system-health',
    name: 'Diagnóstico do sistema',
    description:
      'Analisa espaço livre nos discos, uso de memória, tempo ligado, programas de inicialização e o tamanho da pasta temporária. Somente leitura: nada é alterado ou apagado.',
    category: 'diagnostic',
    changesSystem: false,
    requiresElevation: false,
    params: [
      { key: 'scanTemp', label: 'Medir a pasta temporária do usuário', type: 'boolean', default: true },
      { key: 'freeSpaceWarnPercent', label: 'Alertar quando o espaço livre for menor que (%)', type: 'integer', default: 10, min: 5, max: 50 }
    ]
  },
  {
    id: 'benchmark.standard',
    name: 'Benchmark padrão',
    description:
      'Mede CPU (1 thread e multi-thread, SHA-256), cópia de memória e disco sequencial (256 MB, arquivo temporário apagado ao final). Cargas fixas e reproduzíveis; não é teste de estresse.',
    category: 'diagnostic',
    changesSystem: false,
    requiresElevation: false,
    params: [{ key: 'includeDisk', label: 'Incluir teste de disco (grava 256 MB temporários)', type: 'boolean', default: true }]
  }
]

export function getTask(id: string): TaskDescriptor | undefined {
  return TASK_CATALOG.find((t) => t.id === id)
}

export class ParamError extends Error {}

export function validateParams(task: TaskDescriptor, raw: unknown): Record<string, TaskParamValue> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ParamError('Parâmetros inválidos.')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!task.params.some((p) => p.key === key)) throw new ParamError(`Parâmetro desconhecido: ${key}.`)
  }
  const out: Record<string, TaskParamValue> = {}
  for (const spec of task.params) {
    const value = input[spec.key] ?? spec.default
    switch (spec.type) {
      case 'boolean':
        if (typeof value !== 'boolean') throw new ParamError(`${spec.label}: verdadeiro/falso esperado.`)
        break
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max) {
          throw new ParamError(`${spec.label}: inteiro entre ${spec.min} e ${spec.max}.`)
        }
        break
      case 'enum':
        if (typeof value !== 'string' || !spec.options.some((o) => o.value === value)) {
          throw new ParamError(`${spec.label}: opção inválida.`)
        }
        break
    }
    out[spec.key] = value as TaskParamValue
  }
  return out
}
