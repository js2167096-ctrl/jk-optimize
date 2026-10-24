// Catálogo de jogos e emuladores da aba "Otimização para Jogos". Extensível: para incluir um jogo basta
// acrescentar um item abaixo (a detecção, os cartões e os perfis leem esta lista).
// Cada item descreve COMO ele pode ser reconhecido de verdade: identificador do Steam, nomes no Epic,
// entradas de desinstalação, pastas conhecidas e executáveis exatos. Nada é presumido: sem evidência, o estado é "não detectado".

export type GameCategory = 'Emuladores' | 'Competitivos' | 'Campanha e mundo aberto'

export const GAME_CATEGORIES: GameCategory[] = ['Emuladores', 'Competitivos', 'Campanha e mundo aberto']

/** Como os ajustes específicos do jogo são tratados. */
export type GameProfileKind =
  /** Arquivo de configurações gráficas conhecido e validado (FiveM / GTA V). */
  | 'fivem'
  | 'gta5'
  /** Emulador Android: perfis de sistema + recomendação de CPU/RAM; configurações do emulador não são alteradas. */
  | 'emulator'
  /** Sem formato de configuração validado: apenas ajustes gerais do Windows. */
  | 'system'

export interface GameDef {
  id: string
  name: string
  category: GameCategory
  kind: 'game' | 'emulator'
  /** Identificadores do Steam (appmanifest_<id>.acf). O primeiro também é usado para a capa. */
  steamAppIds?: number[]
  /** Expressão (sem barras) para o nome no manifesto do Steam, quando o id varia entre edições. */
  steamName?: string
  /** Expressões para o nome do jogo nos manifestos do Epic Games Launcher. */
  epic?: string[]
  /** Expressões para o DisplayName nas entradas de desinstalação do Windows. */
  uninstall?: string[]
  /** Pasta de metadados da Riot (ProgramData\Riot Games\Metadata\<id>). */
  riotMeta?: string
  /** Pastas conhecidas (aceitam %VARIÁVEIS%); só valem se um executável conhecido existir até 2 níveis abaixo. */
  dirs?: string[]
  /** Pastas que indicam uso/instalação mas não contêm executável verificável (detecção "provável"). */
  markers?: string[]
  /** Nomes EXATOS de executáveis do jogo. */
  exes: string[]
  /** Expressão que o caminho do executável precisa satisfazer (separa produtos que usam o mesmo .exe). */
  pathHint?: string
  launchers: string[]
  profile: GameProfileKind
  /** Jogo que roda dentro de emuladores Android (o estado depende deles). */
  viaEmulator?: boolean
  note?: string
  /** Cor de destaque do cartão sem capa. */
  accent: string
}

export const GAME_CATALOG: GameDef[] = [
  // ----- Emuladores
  { id: 'msi-app-player', name: 'MSI App Player', category: 'Emuladores', kind: 'emulator', uninstall: ['^MSI App Player'], dirs: ['%ProgramFiles%\\BlueStacks_msi5', '%ProgramFiles%\\BlueStacks_msi2'], exes: ['HD-Player.exe'], pathHint: 'BlueStacks_msi', launchers: ['MSI App Player'], profile: 'emulator', accent: '#e11d2e' },
  { id: 'bluestacks', name: 'BlueStacks', category: 'Emuladores', kind: 'emulator', uninstall: ['^BlueStacks(?!.*MSI)'], dirs: ['%ProgramFiles%\\BlueStacks_nxt', '%ProgramFiles%\\BlueStacks'], exes: ['HD-Player.exe'], pathHint: '\\\\BlueStacks(_nxt)?\\\\', launchers: ['BlueStacks'], profile: 'emulator', accent: '#3fbf3f' },
  { id: 'ldplayer', name: 'LDPlayer', category: 'Emuladores', kind: 'emulator', uninstall: ['^LDPlayer'], dirs: ['C:\\LDPlayer\\LDPlayer9', 'C:\\LDPlayer\\LDPlayer4.0', '%ProgramFiles%\\LDPlayer\\LDPlayer9', 'D:\\LDPlayer\\LDPlayer9'], exes: ['dnplayer.exe', 'LDPlayer.exe'], launchers: ['LDPlayer'], profile: 'emulator', accent: '#f5b400' },
  { id: 'gameloop', name: 'GameLoop', category: 'Emuladores', kind: 'emulator', uninstall: ['^GameLoop'], dirs: ['%ProgramFiles%\\TxGameAssistant', '%ProgramFiles(x86)%\\TxGameAssistant'], exes: ['AndroidEmulatorEx.exe', 'aow_exe.exe', 'AppMarket.exe'], launchers: ['GameLoop'], profile: 'emulator', accent: '#19a974' },
  { id: 'memu', name: 'MEmu Play', category: 'Emuladores', kind: 'emulator', uninstall: ['^MEmu'], dirs: ['%ProgramFiles%\\Microvirt\\MEmu', '%ProgramFiles(x86)%\\Microvirt\\MEmu'], exes: ['MEmu.exe', 'MEmuConsole.exe'], launchers: ['MEmu Play'], profile: 'emulator', accent: '#7c3aed' },
  { id: 'free-fire', name: 'Free Fire', category: 'Emuladores', kind: 'game', exes: [], launchers: ['BlueStacks', 'MSI App Player', 'LDPlayer', 'GameLoop', 'MEmu Play'], profile: 'emulator', viaEmulator: true, note: 'Roda dentro de um emulador Android: o JK Optimize não consegue confirmar a instalação do jogo dentro do emulador e não altera o jogo.', accent: '#ff7a00' },

  // ----- Competitivos e populares
  { id: 'fivem', name: 'FiveM', category: 'Competitivos', kind: 'game', exes: ['FiveM.exe'], launchers: ['FiveM'], profile: 'fivem', accent: '#f40552' },
  { id: 'gta5', name: 'Grand Theft Auto V', category: 'Competitivos', kind: 'game', steamAppIds: [271590], epic: ['^Grand Theft Auto V'], uninstall: ['^Grand Theft Auto V'], exes: ['GTA5.exe', 'GTA5_Enhanced.exe'], launchers: ['Rockstar Games Launcher', 'Steam', 'Epic Games'], profile: 'gta5', accent: '#3f9b3a' },
  { id: 'cs2', name: 'Counter-Strike 2', category: 'Competitivos', kind: 'game', steamAppIds: [730], exes: ['cs2.exe'], launchers: ['Steam'], profile: 'system', accent: '#f0a30a' },
  { id: 'valorant', name: 'Valorant', category: 'Competitivos', kind: 'game', riotMeta: 'valorant.live', uninstall: ['^VALORANT'], dirs: ['C:\\Riot Games\\VALORANT'], exes: ['VALORANT-Win64-Shipping.exe', 'VALORANT.exe'], launchers: ['Riot Client'], profile: 'system', note: 'O Vanguard (anticheat) não é tocado pelo JK Optimize.', accent: '#ff4655' },
  { id: 'lol', name: 'League of Legends', category: 'Competitivos', kind: 'game', riotMeta: 'league_of_legends.live', uninstall: ['^League of Legends'], dirs: ['C:\\Riot Games\\League of Legends'], exes: ['LeagueClient.exe', 'League of Legends.exe'], launchers: ['Riot Client'], profile: 'system', accent: '#c8aa6e' },
  { id: 'fortnite', name: 'Fortnite', category: 'Competitivos', kind: 'game', epic: ['^Fortnite$', '^Fortnite'], exes: ['FortniteClient-Win64-Shipping.exe'], launchers: ['Epic Games'], profile: 'system', accent: '#7a3cff' },
  { id: 'minecraft', name: 'Minecraft', category: 'Competitivos', kind: 'game', uninstall: ['^Minecraft Launcher', '^Minecraft'], dirs: ['%ProgramFiles(x86)%\\Minecraft Launcher', '%ProgramFiles%\\Minecraft Launcher'], markers: ['%APPDATA%\\.minecraft'], exes: ['MinecraftLauncher.exe', 'Minecraft.Windows.exe'], launchers: ['Minecraft Launcher'], profile: 'system', accent: '#5b8731' },
  { id: 'roblox', name: 'Roblox', category: 'Competitivos', kind: 'game', dirs: ['%LOCALAPPDATA%\\Roblox\\Versions'], exes: ['RobloxPlayerBeta.exe'], launchers: ['Roblox'], profile: 'system', accent: '#e2231a' },
  { id: 'apex', name: 'Apex Legends', category: 'Competitivos', kind: 'game', steamAppIds: [1172470], epic: ['^Apex Legends'], uninstall: ['^Apex Legends'], exes: ['r5apex.exe', 'r5apex_dx12.exe'], launchers: ['Steam', 'EA app', 'Epic Games'], profile: 'system', accent: '#da292a' },
  { id: 'pubg', name: 'PUBG: Battlegrounds', category: 'Competitivos', kind: 'game', steamAppIds: [578080], exes: ['TslGame.exe'], launchers: ['Steam'], profile: 'system', accent: '#f2a900' },
  { id: 'overwatch2', name: 'Overwatch 2', category: 'Competitivos', kind: 'game', steamAppIds: [2357570], uninstall: ['^Overwatch'], dirs: ['%ProgramFiles(x86)%\\Overwatch'], exes: ['Overwatch.exe'], launchers: ['Battle.net', 'Steam'], profile: 'system', accent: '#f99e1a' },
  { id: 'r6siege', name: 'Rainbow Six Siege', category: 'Competitivos', kind: 'game', steamAppIds: [359550], uninstall: ['Rainbow Six Siege'], exes: ['RainbowSix.exe', 'RainbowSix_Vulkan.exe'], launchers: ['Ubisoft Connect', 'Steam'], profile: 'system', accent: '#2f8cff' },
  { id: 'rocket-league', name: 'Rocket League', category: 'Competitivos', kind: 'game', steamAppIds: [252950], epic: ['^Rocket League'], exes: ['RocketLeague.exe'], launchers: ['Epic Games', 'Steam'], profile: 'system', accent: '#1d6fe0' },
  { id: 'ea-fc', name: 'EA SPORTS FC', category: 'Competitivos', kind: 'game', steamAppIds: [2669320, 2195250], steamName: '^EA SPORTS FC', uninstall: ['^EA SPORTS FC'], exes: ['FC26.exe', 'FC25.exe', 'FC24.exe'], launchers: ['EA app', 'Steam'], profile: 'system', accent: '#14d06f' },

  // ----- Campanha e mundo aberto
  { id: 'rdr2', name: 'Red Dead Redemption 2', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [1174180], epic: ['^Red Dead Redemption 2'], uninstall: ['^Red Dead Redemption 2'], exes: ['RDR2.exe'], launchers: ['Rockstar Games Launcher', 'Steam', 'Epic Games'], profile: 'system', accent: '#b3261e' },
  { id: 'gow', name: 'God of War', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [1593500], epic: ['^God of War$'], exes: ['GoW.exe'], launchers: ['Steam', 'Epic Games'], profile: 'system', accent: '#c0392b' },
  { id: 'gow-ragnarok', name: 'God of War Ragnarök', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [2322010], exes: ['GoWR.exe'], launchers: ['Steam'], profile: 'system', note: 'Aparece como instalado somente se a versão para PC estiver presente.', accent: '#4aa3df' },
  { id: 'cyberpunk', name: 'Cyberpunk 2077', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [1091500], epic: ['^Cyberpunk 2077'], uninstall: ['^Cyberpunk 2077'], exes: ['Cyberpunk2077.exe'], launchers: ['Steam', 'GOG', 'Epic Games'], profile: 'system', accent: '#fcee0a' },
  { id: 'forza5', name: 'Forza Horizon 5', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [1551360], dirs: ['C:\\XboxGames\\Forza Horizon 5\\Content'], exes: ['ForzaHorizon5.exe'], launchers: ['Steam', 'Microsoft Store'], profile: 'system', accent: '#ef4444' },
  { id: 'elden-ring', name: 'Elden Ring', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [1245620], exes: ['eldenring.exe'], launchers: ['Steam'], profile: 'system', accent: '#d4af37' },
  { id: 'hogwarts', name: 'Hogwarts Legacy', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [990080], epic: ['^Hogwarts Legacy'], exes: ['HogwartsLegacy.exe'], launchers: ['Steam', 'Epic Games'], profile: 'system', accent: '#8b5cf6' },
  { id: 'witcher3', name: 'The Witcher 3', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [292030], uninstall: ['^The Witcher 3'], exes: ['witcher3.exe'], launchers: ['Steam', 'GOG'], profile: 'system', accent: '#9a1f2b' },
  { id: 're4', name: 'Resident Evil 4', category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [2050650], exes: ['re4.exe'], launchers: ['Steam'], profile: 'system', accent: '#a11a1a' },
  { id: 'spiderman-remastered', name: "Marvel's Spider-Man Remastered", category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [1817070], epic: ['Spider-Man Remastered'], exes: ['Spider-Man.exe'], launchers: ['Steam', 'Epic Games'], profile: 'system', accent: '#e11d2e' },
  { id: 'spiderman-miles', name: "Marvel's Spider-Man: Miles Morales", category: 'Campanha e mundo aberto', kind: 'game', steamAppIds: [1817190], epic: ['Miles Morales'], exes: ['MilesMorales.exe'], launchers: ['Steam', 'Epic Games'], profile: 'system', accent: '#f43f5e' }
]

export const gameById = (id: string): GameDef | undefined => GAME_CATALOG.find((g) => g.id === id)

// ---------------------------------------------------------------------------
// Níveis de otimização (a abrangência dos ajustes; nunca uma promessa de FPS)
// ---------------------------------------------------------------------------

export type OptLevel = 'basic' | 'intermediate' | 'promax'

export const OPT_LEVELS: { id: OptLevel; name: string; apply: string; description: string }[] = [
  { id: 'basic', name: 'Otimização Básica', apply: 'Aplicar Otimização Básica', description: 'Ajustes essenciais para reduzir tarefas desnecessárias e preparar o Windows para jogar.' },
  { id: 'intermediate', name: 'Otimização Intermediária', apply: 'Aplicar Otimização Intermediária', description: 'Ajustes adicionais de sistema e jogo, selecionados conforme seu hardware e sua instalação.' },
  { id: 'promax', name: 'Otimização Pro Max', apply: 'Aplicar Otimização Pro Max', description: 'Perfil avançado e personalizado, com ajustes adicionais compatíveis com seu computador.' }
]

/** Valor de plano de energia: "@ideal" e "@max" são resolvidos pelo catálogo de ajustes conforme o hardware (notebook × desktop). */
export interface LevelTweak {
  id: string
  value: string
  why: string
  /** Só vale em computador sem bateria. */
  desktopOnly?: boolean
}

export const LEVEL_TWEAKS: Record<OptLevel, LevelTweak[]> = {
  basic: [
    { id: 'gameMode', value: 'on', why: 'O Modo de Jogo prioriza o jogo em execução e evita reinícios do Windows Update durante a partida.' },
    { id: 'gameDvr', value: 'off', why: 'Impede a gravação contínua em segundo plano (consome CPU e GPU).' },
    { id: 'appCapture', value: 'off', why: 'Impede capturas automáticas da Xbox Game Bar durante o jogo.' },
    { id: 'powerPlan', value: '@ideal', why: 'Notebook: Equilibrado; desktop: Alto desempenho quando existir.' }
  ],
  intermediate: [
    { id: 'notifications', value: 'off', why: 'Sem pop-ups de aplicativos por cima do jogo.' },
    { id: 'bgApps', value: 'off', why: 'Menos aplicativos da Microsoft Store consumindo recursos em segundo plano (Windows 10).' },
    { id: 'transparency', value: 'off', why: 'Menos composição de efeitos na área de trabalho.' },
    { id: 'usbSuspend', value: 'off', why: 'Evita atrasos ao reativar mouse, teclado e headset.', desktopOnly: true }
  ],
  promax: [
    { id: 'powerPlan', value: '@max', why: 'Plano de maior desempenho que existe neste computador (Ultimate, se criado; senão Alto desempenho).' },
    { id: 'procMin', value: '@max', why: 'Mantém o processador pronto para acelerar (maior consumo e calor; a proteção térmica continua ativa).' },
    { id: 'pcieAspm', value: '@max', why: 'Mantém o link PCI Express sempre ativo (placa de vídeo / SSD NVMe).', desktopOnly: true },
    { id: 'minAnimate', value: 'off', why: 'Janelas minimizam e maximizam sem animação.' },
    { id: 'taskbarAnim', value: 'off', why: 'Sem animações da barra de tarefas.' },
    { id: 'mouseAccel', value: 'off', why: 'Aceleração do ponteiro desligada: movimento proporcional (muda a sensação do mouse).' }
  ]
}

export const LEVEL_ORDER: OptLevel[] = ['basic', 'intermediate', 'promax']

/** Ajustes de um nível: inclui os níveis anteriores. */
export function tweaksForLevel(level: OptLevel): LevelTweak[] {
  const out = new Map<string, LevelTweak>()
  for (const l of LEVEL_ORDER.slice(0, LEVEL_ORDER.indexOf(level) + 1)) for (const t of LEVEL_TWEAKS[l]) out.set(t.id, t)
  return [...out.values()]
}

/** Perfil gráfico do FiveM/GTA V por nível (null = só análise, sem gravar no arquivo). */
export function graphicsFor(level: OptLevel, integratedGpu: boolean): 'performance' | 'balanced' | null {
  if (level === 'basic') return null
  if (level === 'intermediate') return 'balanced'
  return integratedGpu ? 'performance' : 'balanced'
}

/** Endereço público da capa do Steam (imagem de cabeçalho da loja). */
export const steamCoverUrl = (appId: number) => `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`
