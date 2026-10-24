// Modelos iniciais de servidor. São dados puros: o plano gerado passa por validatePlan e por prévia antes de qualquer alteração.
import type { CategorySpec, OverwriteSpec, RoleSpec, ServerPlan } from './types.js'

const READ = ['ViewChannel', 'ReadMessageHistory'] as const
const TALK = ['ViewChannel', 'ReadMessageHistory', 'SendMessages'] as const

const ROLES = {
  dono: { key: 'dono', name: '👑 Dono', color: 0xe74c3c, hoist: true, permissions: ['ManageChannels', 'ManageMessages', 'ModerateMembers'] },
  dev: { key: 'dev', name: '🛠️ Dev', color: 0x3498db, hoist: true, permissions: ['AttachFiles', 'EmbedLinks'] },
  mod: { key: 'mod', name: '🛡️ Moderador', color: 0x2ecc71, hoist: true, permissions: ['ManageMessages', 'ModerateMembers'] },
  suporte: { key: 'suporte', name: '🎧 Suporte', color: 0x1abc9c, hoist: true, mentionable: true, permissions: ['ManageMessages'] },
  cliente: { key: 'cliente', name: '💎 Cliente JK', color: 0x9b59b6, hoist: true, permissions: [] },
  testador: { key: 'testador', name: '🧪 Testador', color: 0xf1c40f, permissions: [] },
  membro: { key: 'membro', name: '👥 Membro', color: 0x95a5a6, permissions: [] }
} satisfies Record<string, RoleSpec>

const STAFF = ['dono', 'dev', 'mod', 'suporte']

/** Só a equipe vê e escreve. */
const staffOnly = (roles: readonly string[] = STAFF): OverwriteSpec[] => [
  { role: 'everyone', deny: ['ViewChannel'] },
  ...roles.map((r): OverwriteSpec => ({ role: r, allow: [...TALK] }))
]

/** Todos leem; só a equipe escreve. */
const readOnly = (): OverwriteSpec[] => [
  { role: 'everyone', allow: [...READ], deny: ['SendMessages'] },
  ...STAFF.map((r): OverwriteSpec => ({ role: r, allow: ['SendMessages'] }))
]

/** Só clientes e equipe veem. */
const customersOnly = (): OverwriteSpec[] => staffOnly([...STAFF, 'cliente'])

const text = (name: string, topic?: string, overwrites?: OverwriteSpec[], slowmode?: number): CategorySpec['channels'][number] => ({
  name,
  type: 'text',
  ...(topic ? { topic } : {}),
  ...(overwrites ? { overwrites } : {}),
  ...(slowmode !== undefined ? { slowmode } : {})
})
const voice = (name: string): CategorySpec['channels'][number] => ({ name, type: 'voice' })

const BLOCKS = {
  info: (): CategorySpec => ({
    name: '📢｜INFORMAÇÕES',
    channels: [
      text('📜｜regras', 'Leia antes de participar.', readOnly()),
      text('📣｜anuncios', 'Avisos oficiais.', readOnly()),
      text('🆕｜novidades', 'Atualizações e versões do JK Optimize.', readOnly())
    ]
  }),
  compras: (): CategorySpec => ({
    name: '🛒｜COMPRAS',
    channels: [
      text('🛍️｜produtos', 'Catálogo de produtos e planos.', readOnly()),
      text('🧾｜como-comprar', 'Passo a passo da compra e da entrega.', readOnly())
    ]
  }),
  clientes: (): CategorySpec => ({
    name: '💎｜CLIENTES',
    overwrites: customersOnly(),
    channels: [
      text('💎｜area-clientes', 'Espaço exclusivo dos clientes.'),
      text('🔑｜ativacao-e-keys', 'Ajuda com ativação. Nunca poste sua key aqui.'),
      text('📥｜downloads', 'Instaladores e versões.', [{ role: 'cliente', allow: [...READ], deny: ['SendMessages'] }])
    ]
  }),
  suporte: (): CategorySpec => ({
    name: '🛠️｜SUPORTE',
    channels: [
      text('❓｜ajuda', 'Dúvidas gerais.', undefined, 5),
      text('🐞｜reportar-bugs', 'Descreva o problema, versão e passos para reproduzir.', undefined, 10),
      text('🎫｜abrir-ticket', 'Atendimento privado (o painel de tickets chega em uma fase futura).', readOnly())
    ]
  }),
  comunidade: (): CategorySpec => ({
    name: '💬｜COMUNIDADE',
    channels: [text('💬｜chat-geral', undefined, undefined, 5), text('💡｜ideias', 'Sugestões para o JK Optimize.'), text('📸｜midia', 'Prints e clipes.', undefined, 10)]
  }),
  equipe: (): CategorySpec => ({
    name: '🔐｜EQUIPE',
    overwrites: staffOnly(),
    channels: [text('🔐｜staff-chat'), text('🧪｜dev-chat'), text('📜｜logs-bot', 'Registros do bot.')]
  }),
  voz: (): CategorySpec => ({
    name: '🔊｜VOZ',
    channels: [voice('🔊 Sala Geral'), voice('🎧 Suporte por voz')]
  }),
  jogos: (): CategorySpec => ({
    name: '🎮｜JOGOS',
    channels: [text('🎮｜fps-e-configs', 'Resultados e ajustes de desempenho.', undefined, 5), text('🎬｜clipes', 'Mostre suas jogadas.', undefined, 10), text('🤝｜procurar-time')]
  }),
  premium: (): CategorySpec => ({
    name: '⭐｜PREMIUM',
    overwrites: customersOnly(),
    channels: [text('⭐｜premium-chat'), text('🎁｜beneficios', 'Vantagens do plano premium.', [{ role: 'cliente', allow: [...READ], deny: ['SendMessages'] }]), text('🚀｜acesso-antecipado', 'Testes de novas versões.')]
  }),
  posVenda: (): CategorySpec => ({
    name: '🤝｜PÓS-VENDA',
    overwrites: customersOnly(),
    channels: [text('🔁｜renovacoes'), text('📦｜entregas', 'Dúvidas sobre sua entrega.'), text('⭐｜avaliacoes', 'Conte como foi sua experiência.')]
  })
}

const pick = (...keys: (keyof typeof ROLES)[]): RoleSpec[] => keys.map((k) => ({ ...ROLES[k], permissions: [...ROLES[k].permissions] }))

const RAW_TEMPLATES: readonly ServerPlan[] = [
  {
    id: 'clientes-jk',
    title: 'Clientes do JK Optimize',
    description: 'Informações, compras, área de clientes, suporte, comunidade, equipe e voz.',
    roles: pick('dono', 'dev', 'mod', 'suporte', 'cliente', 'testador', 'membro'),
    categories: [BLOCKS.info(), BLOCKS.compras(), BLOCKS.clientes(), BLOCKS.suporte(), BLOCKS.comunidade(), BLOCKS.equipe(), BLOCKS.voz()]
  },
  {
    id: 'vendas-digitais',
    title: 'Vendas digitais',
    description: 'Foco em catálogo, compras, entregas e pós-venda.',
    roles: pick('dono', 'mod', 'suporte', 'cliente', 'membro'),
    categories: [BLOCKS.info(), BLOCKS.compras(), BLOCKS.clientes(), BLOCKS.suporte(), BLOCKS.equipe()]
  },
  {
    id: 'suporte-tecnico',
    title: 'Suporte técnico',
    description: 'Servidor enxuto de ajuda, bugs e equipe de atendimento.',
    roles: pick('dono', 'dev', 'suporte', 'membro'),
    categories: [BLOCKS.info(), BLOCKS.suporte(), BLOCKS.equipe(), BLOCKS.voz()]
  },
  {
    id: 'comunidade-gamer',
    title: 'Comunidade gamer',
    description: 'Comunidade com jogos, clipes, procura de time e voz.',
    roles: pick('dono', 'mod', 'testador', 'membro'),
    categories: [BLOCKS.info(), BLOCKS.comunidade(), BLOCKS.jogos(), BLOCKS.voz(), BLOCKS.equipe()]
  },
  {
    id: 'produto-premium',
    title: 'Produto premium',
    description: 'Área premium para clientes, com acesso antecipado e suporte prioritário.',
    roles: pick('dono', 'dev', 'mod', 'suporte', 'cliente', 'membro'),
    categories: [BLOCKS.info(), BLOCKS.compras(), BLOCKS.premium(), BLOCKS.suporte(), BLOCKS.equipe()]
  },
  {
    id: 'atendimento-pos-venda',
    title: 'Atendimento e pós-venda',
    description: 'Entregas, renovações, avaliações e suporte a quem já comprou.',
    roles: pick('dono', 'mod', 'suporte', 'cliente', 'membro'),
    categories: [BLOCKS.info(), BLOCKS.posVenda(), BLOCKS.suporte(), BLOCKS.equipe()]
  }
]

/** Remove permissões que citam cargos que o modelo não cria (ex.: modelo sem Dev). */
function prune(plan: ServerPlan): ServerPlan {
  const keys = new Set(['everyone', ...plan.roles.map((r) => r.key)])
  const keep = (list: OverwriteSpec[] | undefined): OverwriteSpec[] | undefined => list?.filter((o) => keys.has(o.role))
  return {
    ...plan,
    categories: plan.categories.map((c) => ({
      ...c,
      overwrites: keep(c.overwrites),
      channels: c.channels.map((ch) => ({ ...ch, overwrites: keep(ch.overwrites) }))
    }))
  }
}

export const TEMPLATES: readonly ServerPlan[] = RAW_TEMPLATES.map(prune)

export function findTemplate(id: string): ServerPlan | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
