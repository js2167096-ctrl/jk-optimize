// Otimização 2: quais ajustes do catálogo real aparecem em cada seção, e o que cada "script importante" executa.
// Cada ajuste é lido do Windows e conferido depois de aplicado (tweaks.apply); as ações têm preview e confirmação.

export type Win2Section = 'basic' | 'power' | 'cleanup' | 'disable' | 'scripts' | 'booster' | 'security'

export const WIN2_SECTIONS: { id: Win2Section; label: string }[] = [
  { id: 'basic', label: 'Otimizar Windows' },
  { id: 'power', label: 'Plano de energia' },
  { id: 'cleanup', label: 'Limpeza Windows' },
  { id: 'disable', label: 'Desativar Windows' },
  { id: 'scripts', label: 'Scripts importantes' },
  { id: 'booster', label: 'Booster Robusta' },
  { id: 'security', label: 'Segurança' }
]

/** Ajustes de cada seção (ids do catálogo `tweaks.catalog`). */
export const WIN2_TWEAKS: Record<'basic' | 'disable', string[]> = {
  basic: ['bgApps', 'bgAppsPolicy', 'transparency', 'minAnimate', 'taskbarAnim', 'activityFeed', 'startSuggestions', 'windowsSuggestions', 'tips', 'bluetooth', 'cortana', 'notifications', 'startupDelay'],
  disable: ['bgApps', 'bgAppsPolicy', 'gameBar', 'gameDvr', 'appCapture', 'gameDvrPolicy', 'hibernation', 'fastStartup', 'adId', 'netThrottle', 'qosLimit', 'lastAccess', 'startSuggestions', 'telemetry', 'diagTrack', 'transparency', 'notifications', 'indexing', 'storageSense', 'silentCleanup']
}

/** Funções que já existem em outras categorias da Otimização, com o atalho para elas. */
export type ScriptStep = { kind: 'tweaks'; changes: Record<string, string> } | { kind: 'action'; actionId: string; params: unknown } | { kind: 'disk'; drives: 'C' | 'all' }

export interface Win2Script {
  id: string
  /** Nome como aparece na referência. */
  name: string
  /** O que ele faz de verdade neste app. */
  does: string
  step: ScriptStep
  /** Esclarecimento quando o nome da referência permite mais de uma interpretação. */
  ambiguity?: string
}

const tw = (changes: Record<string, string>): ScriptStep => ({ kind: 'tweaks', changes })

export const WIN2_SCRIPTS: Win2Script[] = [
  { id: 'timestamp', name: 'Desativar_TimeStamp', does: 'Desativa o registro de data do último acesso a arquivos no NTFS (fsutil behavior disablelastaccess).', step: tw({ lastAccess: 'off' }), ambiguity: 'O nome admite duas leituras: o último acesso do NTFS (implementado) ou os carimbos de tempo TCP, que já vêm desativados no Windows e por isso não têm ajuste.' },
  { id: 'anim', name: 'Desativar Animações', does: 'Desativa a animação de janelas ao minimizar/maximizar e as animações da barra de tarefas.', step: tw({ minAnimate: 'off', taskbarAnim: 'off' }) },
  { id: 'diag', name: 'Desativar Diagnóstico e Telemetria', does: 'Define a política de diagnóstico no mínimo permitido e desativa o serviço DiagTrack.', step: tw({ telemetry: 'off', diagTrack: 'off' }) },
  { id: 'dvr', name: 'Desativar DVR de jogo', does: 'Bloqueia a gravação em segundo plano (Game DVR) por política do sistema.', step: tw({ gameDvr: 'off', appCapture: 'off', gameDvrPolicy: 'off' }) },
  { id: 'dvr1', name: 'Desativar Game DVR 1', does: 'Desativa GameDVR_Enabled (HKCU\\System\\GameConfigStore).', step: tw({ gameDvr: 'off' }) },
  { id: 'dvr2', name: 'Desativar Game DVR 2', does: 'Desativa AppCaptureEnabled (HKCU\\...\\GameDVR).', step: tw({ appCapture: 'off' }) },
  { id: 'index', name: 'Desativar Indexação', does: 'Define o serviço Windows Search como Desativado e o para.', step: tw({ indexing: 'off' }) },
  { id: 'net', name: 'Desativar Limitação de Rede', does: 'Remove o limite de pacotes do agendador multimídia (NetworkThrottlingIndex).', step: tw({ netThrottle: 'off' }) },
  { id: 'autoclean', name: 'Desativar limpeza de disco automática', does: 'Desativa o Sensor de Armazenamento e a tarefa SilentCleanup.', step: tw({ storageSense: 'off', silentCleanup: 'off' }) },
  { id: 'notif', name: 'Desativar Notificação', does: 'Desativa as notificações pop-up de aplicativos.', step: tw({ notifications: 'off' }) },
  { id: 'bg', name: 'Desativar_Apps_Segundo_Plano', does: 'Bloqueia aplicativos em segundo plano (ajuste do usuário no Windows 10 e política do sistema).', step: tw({ bgApps: 'off', bgAppsPolicy: 'off' }) },
  { id: 'gamebar', name: 'Desativar_GameBar_e_XboxDVR', does: 'Desativa a Xbox Game Bar, as capturas e o Game DVR.', step: tw({ gameBar: 'off', gameDvr: 'off', appCapture: 'off' }) },
  { id: 'hib', name: 'Desativar_Hibernacao', does: 'Desativa a hibernação (remove o hiberfil.sys e a Inicialização Rápida).', step: tw({ hibernation: 'off' }) },
  { id: 'adid', name: 'Desativar_ID_Publicidade_Apps', does: 'Desativa o ID de publicidade dos aplicativos.', step: tw({ adId: 'off' }) },
  { id: 'qos', name: 'Desativar_Limitacao_Largura_Banda_QoS', does: 'Grava a política NonBestEffortLimit=0 do Agendador de Pacotes QoS.', step: tw({ qosLimit: 'off' }) },
  { id: 'startsug', name: 'Desativar_Sugestoes_Menu_Iniciar', does: 'Desativa as sugestões e anúncios do menu Iniciar.', step: tw({ startSuggestions: 'off' }) },
  { id: 'telbasic', name: 'Desativar_Telemetria_Windows_Basica', does: 'Limita a coleta ao nível Básico (necessário) e desativa experiências personalizadas e pedidos de feedback.', step: tw({ telemetry: 'basic', tailored: 'off', feedbackPrompts: 'off' }) },
  { id: 'transp', name: 'Desativar_Transparencias_e_Efeitos_AcRilicos', does: 'Desativa transparência e efeitos acrílicos.', step: tw({ transparency: 'off' }) },
  { id: 'defragc', name: 'Desfragmentar_Disco_C', does: 'Otimiza a unidade C: pelo tipo de mídia (TRIM em SSD, desfragmentação em HDD).', step: { kind: 'disk', drives: 'C' } },
  { id: 'defragall', name: 'Desfragmentar_Todos_Discos', does: 'Otimiza todas as unidades fixas NTFS pelo tipo de mídia.', step: { kind: 'disk', drives: 'all' } },
  { id: 'idle', name: 'Forcar_Limpeza_Tarefas_Ociosas_Memoria', does: 'Executa agora as tarefas ociosas do Windows (ProcessIdleTasks) e mede a memória livre.', step: { kind: 'action', actionId: 'memory.idleTasks', params: {} } },
  { id: 'systemp', name: 'Limpar_Arquivos_Temporarios_Sistema', does: 'Remove arquivos antigos de C:\\Windows\\Temp (administrador).', step: { kind: 'action', actionId: 'cleanup.extra.clean', params: { targets: ['temp-system'] } } }
]

/** Booster Robusta: ajustes avançados compatíveis com o perfil de jogos, em lote e individualmente selecionáveis. */
export const WIN2_BOOSTER: { id: string; value: string; why: string }[] = [
  { id: 'gameDvr', value: 'off', why: 'Evita a gravação contínua em segundo plano.' },
  { id: 'appCapture', value: 'off', why: 'Evita capturas automáticas da Game Bar.' },
  { id: 'gameBar', value: 'off', why: 'Evita a abertura acidental da Game Bar durante o jogo.' },
  { id: 'transparency', value: 'off', why: 'Menos efeitos de composição na interface do Windows.' },
  { id: 'minAnimate', value: 'off', why: 'Janelas minimizam/maximizam sem animação.' },
  { id: 'notifications', value: 'off', why: 'Sem pop-ups sobre o jogo.' },
  { id: 'bgApps', value: 'off', why: 'Menos aplicativos da Store consumindo recursos em segundo plano.' },
  { id: 'bgAppsPolicy', value: 'off', why: 'Mesmo ajuste como política (vale também no Windows 11).' },
  { id: 'startSuggestions', value: 'off', why: 'Sem sugestões e anúncios no menu Iniciar.' },
  { id: 'windowsSuggestions', value: 'off', why: 'Sem sugestões e instalação silenciosa de aplicativos.' },
  { id: 'netThrottle', value: 'off', why: 'Remove o limite de pacotes multimídia da rede; efeito não medido.' },
  { id: 'lastAccess', value: 'off', why: 'Menos gravações no disco.' }
]
