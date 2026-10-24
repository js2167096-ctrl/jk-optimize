// Classificação central do que o JK Optimize pode ou não alterar, e tradução
// dos códigos de erro do Windows. Usada por serviços, processos e demais módulos.
// Ser administrador NÃO dá permissão universal: componentes protegidos pelo
// Windows (Protected Process Light), segurança e atualizações nunca são alterados.

/** Serviços essenciais, de segurança e de atualização (comparação sem diferenciar maiúsculas). */
export const PROTECTED_SERVICE_NAMES = new Set(
  [
    // núcleo do Windows
    'RpcSs', 'RpcEptMapper', 'DcomLaunch', 'LSM', 'SamSs', 'EventLog', 'PlugPlay', 'Power', 'ProfSvc', 'Schedule', 'Winmgmt',
    'CryptSvc', 'KeyIso', 'VaultSvc', 'gpsvc', 'CoreMessagingRegistrar', 'SystemEventsBroker', 'BrokerInfrastructure',
    'StateRepository', 'TimeBrokerSvc', 'UserManager', 'EventSystem', 'SENS', 'DeviceInstall', 'DispBrokerDesktopSvc',
    'TokenBroker', 'WpnService', 'FontCache', 'ShellHWDetection', 'Themes', 'camsvc', 'Appinfo', 'seclogon', 'TrustedInstaller',
    'msiserver', 'AppXSvc', 'ClipSVC', 'LicenseManager', 'InstallService', 'EntAppSvc', 'sppsvc', 'AppIDSvc',
    // rede e áudio básicos
    'Dhcp', 'Dnscache', 'nsi', 'NlaSvc', 'netprofm', 'LanmanWorkstation', 'Wcmsvc', 'WlanSvc', 'AudioSrv', 'AudioEndpointBuilder',
    // segurança (Defender, firewall, Central de Segurança)
    'WinDefend', 'WdNisSvc', 'WdBoot', 'WdFilter', 'MDCoreSvc', 'Sense', 'SecurityHealthService', 'wscsvc', 'SgrmBroker', 'MpsSvc',
    'BFE', 'webthreatdefsvc', 'webthreatdefusersvc', 'NgcSvc', 'NgcCtnrSvc', 'wlidsvc', 'Netlogon',
    // atualizações do Windows
    'wuauserv', 'UsoSvc', 'WaaSMedicSvc', 'BITS', 'DoSvc'
  ].map((s) => s.toLowerCase())
)

export interface ServiceFacts {
  name: string
  path: string | null
  /** Valor LaunchProtected do registro (> 0 = processo protegido pelo Windows). */
  launchProtected: number | null
  runningDependents: string[]
}

/** Motivo pelo qual o serviço não pode ser alterado, ou null se for modificável. */
export function serviceProtection(s: ServiceFacts): { reason: string; kind: 'protected' | 'essential' | 'security' | 'dependency' } | null {
  const lower = s.name.toLowerCase()
  if ((s.launchProtected ?? 0) > 0) {
    return { kind: 'protected', reason: 'Protegido pelo próprio Windows (processo protegido): nem o administrador pode alterá-lo.' }
  }
  if (/\\(windows defender|microsoft\\windows defender|windows defender advanced threat protection)\\/i.test(s.path ?? '') || /^(mdcoresvc|windefend|wdnissvc|sense)$/.test(lower)) {
    return { kind: 'security', reason: 'Componente do Microsoft Defender: protegido e necessário para a segurança.' }
  }
  if (PROTECTED_SERVICE_NAMES.has(lower)) {
    const security = /defend|security|wscsvc|mpssvc|bfe|sgrm|webthreat|wuauserv|usosvc|waasmedic|bits|dosvc/.test(lower)
    return {
      kind: security ? 'security' : 'essential',
      reason: security ? 'Segurança ou atualização do Windows: não é alterado pelo JK Optimize.' : 'Serviço essencial do Windows.'
    }
  }
  if (s.runningDependents.length > 0) {
    return { kind: 'dependency', reason: `Serviços em execução dependem dele: ${s.runningDependents.join(', ')}.` }
  }
  return null
}

// ---------------------------------------------------------------------------
// Processos
// ---------------------------------------------------------------------------

export const CRITICAL_PROCESSES = new Set(
  [
    'system', 'idle', 'registry', 'memory compression', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso',
    'svchost', 'dwm', 'fontdrvhost', 'sihost', 'explorer', 'ctfmon', 'spoolsv', 'audiodg', 'msmpeng', 'nissrv', 'mpdefendercoreservice',
    'mdcoresvc', 'securityhealthservice', 'securityhealthsystray', 'wudfhost', 'runtimebroker', 'searchindexer', 'conhost', 'taskhostw',
    'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost', 'systemsettings', 'jk optimize'
  ].map((n) => n.toLowerCase())
)

export function processProtection(name: string, path: string | null, sessionId: number, mySession: number, ownPid: number, pid: number): string | null {
  const lower = name.toLowerCase()
  if (pid === ownPid || pid <= 4) return 'Processo do sistema ou do próprio JK Optimize.'
  if (CRITICAL_PROCESSES.has(lower)) return 'Processo crítico do Windows.'
  if (sessionId === 0) return 'Serviço do sistema (sessão 0).'
  if (sessionId !== mySession) return 'Pertence a outra sessão de usuário.'
  if (path && /^[a-z]:\\windows\\system32\\/i.test(path) && !/\\(notepad|mspaint|calc|write|charmap|snippingtool)\.exe$/i.test(path)) {
    return 'Componente do Windows em System32.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Códigos de erro do Windows
// ---------------------------------------------------------------------------

export type WinErrorKind = 'access-denied' | 'not-found' | 'dependency' | 'protected' | 'disabled' | 'timeout' | 'unexpected'

const WIN_ERRORS: Record<number, { kind: WinErrorKind; message: string }> = {
  5: { kind: 'access-denied', message: 'Acesso negado (código 5): o Windows protege este item, mesmo para administradores.' },
  1051: { kind: 'dependency', message: 'Outros serviços em execução dependem deste (código 1051).' },
  1052: { kind: 'unexpected', message: 'O serviço não aceita este comando (código 1052).' },
  1053: { kind: 'timeout', message: 'O serviço não respondeu a tempo (código 1053).' },
  1056: { kind: 'unexpected', message: 'O serviço já está em execução (código 1056).' },
  1058: { kind: 'disabled', message: 'O serviço está desativado e não pode ser iniciado (código 1058).' },
  1060: { kind: 'not-found', message: 'O serviço não existe neste computador (código 1060).' },
  1061: { kind: 'unexpected', message: 'O serviço não pode aceitar comandos agora (código 1061).' },
  1062: { kind: 'unexpected', message: 'O serviço não está em execução (código 1062).' },
  1072: { kind: 'unexpected', message: 'O serviço foi marcado para exclusão (código 1072).' },
  577: { kind: 'protected', message: 'Assinatura/proteção do Windows impediu a operação (código 577).' }
}

export function explainWinError(code: number | null | undefined): { kind: WinErrorKind; message: string } {
  if (code === null || code === undefined || code === 0) return { kind: 'unexpected', message: 'Falha inesperada.' }
  return WIN_ERRORS[code] ?? { kind: 'unexpected', message: `O Windows retornou o código ${code}.` }
}

/** Extrai o código Win32 de textos como "FALHA 5:" (sc.exe) ou "(Exception from HRESULT: 0x80070005)". */
export function winErrorFromText(text: string): number | null {
  const sc = /FALHA\s+(\d+)|FAILED\s+(\d+)/i.exec(text)
  if (sc) return Number(sc[1] ?? sc[2])
  const hr = /0x8007([0-9a-f]{4})/i.exec(text)
  if (hr) return parseInt(hr[1], 16)
  if (/acesso negado|access is denied|access denied/i.test(text)) return 5
  return null
}
