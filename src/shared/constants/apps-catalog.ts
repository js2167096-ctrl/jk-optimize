// Catálogo da aba Aplicativos: só páginas oficiais de download do desenvolvedor ou fabricante.
// Nada é baixado nem executado pelo JK Optimize: o botão abre a página no navegador padrão.
// Os endereços são conferidos por `node scripts/validar-links.mjs` (respondem com sucesso, sem redirecionar para outro domínio).

export type AppCategory = 'Navegadores' | 'Compactação' | 'Jogos' | 'Comunicação' | 'Utilitários' | 'Produtividade e IA' | 'Drivers e hardware'

export interface CatalogApp {
  id: string
  category: AppCategory
  name: string
  /** Aproximadamente três linhas, em português. */
  description: string
  /** Página oficial de download (https). */
  url: string
  /** Termos extras da pesquisa (sinônimos, siglas), sem acento. */
  keywords?: string
}

export const APP_CATEGORIES: AppCategory[] = ['Navegadores', 'Compactação', 'Jogos', 'Comunicação', 'Utilitários', 'Produtividade e IA', 'Drivers e hardware']

export const APP_CATALOG: CatalogApp[] = [
  { id: 'chrome', category: 'Navegadores', name: 'Google Chrome', description: 'Navegador do Google, rápido e com sincronização de favoritos e senhas pela conta Google. Recebe atualizações de segurança automáticas e tem a maior biblioteca de extensões.', url: 'https://www.google.com/chrome/' },
  { id: 'firefox', category: 'Navegadores', name: 'Mozilla Firefox', description: 'Navegador de código aberto da Mozilla, com foco em privacidade e proteção contra rastreamento. Boa alternativa leve, com extensões próprias e perfis separados.', url: 'https://www.firefox.com/download/' },
  { id: 'brave', category: 'Navegadores', name: 'Brave', description: 'Navegador baseado no Chromium que bloqueia anúncios e rastreadores por padrão. Compatível com as extensões do Chrome e com bom consumo de memória.', url: 'https://brave.com/download/' },
  { id: '7zip', category: 'Compactação', name: '7-Zip', description: 'Compactador gratuito e de código aberto que abre ZIP, RAR, 7z e muitos outros formatos. Leve, sem anúncios e muito usado para instalar mods e pacotes de jogos.', url: 'https://www.7-zip.org/download.html' },
  { id: 'winrar', category: 'Compactação', name: 'WinRAR', description: 'Compactador tradicional para criar e extrair arquivos RAR e ZIP, com reparo de arquivos danificados. O uso contínuo depende da licença do fabricante.', url: 'https://www.win-rar.com/download.html' },
  { id: 'steam', category: 'Jogos', name: 'Steam', description: 'Plataforma da Valve para comprar, instalar e atualizar jogos de PC. Inclui biblioteca na nuvem, salvamentos sincronizados e comunidade.', url: 'https://store.steampowered.com/about/' },
  { id: 'epic', category: 'Jogos', name: 'Epic Games Launcher', description: 'Loja e lançador da Epic Games, necessário para Fortnite e para os jogos gratuitos oferecidos toda semana. Gerencia instalações e atualizações.', url: 'https://store.epicgames.com/download' },
  { id: 'discord', category: 'Comunicação', name: 'Discord', description: 'Aplicativo de voz, vídeo e texto para comunidades e amigos. Muito usado em servidores de jogos, com chamadas de baixa latência e compartilhamento de tela.', url: 'https://discord.com/download' },
  { id: 'whatsapp', category: 'Comunicação', name: 'WhatsApp', description: 'Versão oficial para Windows do mensageiro. Sincroniza conversas com o celular e permite enviar mensagens, arquivos e fazer chamadas pelo computador.', url: 'https://www.whatsapp.com/download' },
  { id: 'powertoys', category: 'Utilitários', name: 'Microsoft PowerToys', description: 'Conjunto de utilitários da Microsoft para o Windows: organizador de janelas, renomeação em lote, seletor de cores e atalhos personalizados.', url: 'https://learn.microsoft.com/windows/powertoys/install' },
  { id: 'acrobat', category: 'Utilitários', name: 'Adobe Acrobat Reader', description: 'Leitor de PDF da Adobe, com anotações, formulários e assinatura de documentos. Opção oficial para abrir qualquer PDF com fidelidade.', url: 'https://get.adobe.com/br/reader/' },
  { id: 'sumatra', category: 'Utilitários', name: 'SumatraPDF', description: 'Leitor de PDF, ePub e quadrinhos extremamente leve e rápido, de código aberto. Boa escolha para computadores mais simples.', url: 'https://www.sumatrapdfreader.org/download-free-pdf-viewer' },
  { id: 'vlc', category: 'Utilitários', name: 'VLC media player', description: 'Reprodutor de vídeo e áudio gratuito que abre praticamente qualquer formato sem precisar de codecs extras. Também converte e transmite mídia.', url: 'https://www.videolan.org/vlc/', keywords: 'video musica audio player filmes' },
  { id: 'notepadpp', category: 'Utilitários', name: 'Notepad++', description: 'Editor de texto e de código leve, com abas, destaque de sintaxe e busca avançada. Substitui o Bloco de Notas para edição de configurações.', url: 'https://notepad-plus-plus.org/downloads/' },
  { id: 'obs', category: 'Utilitários', name: 'OBS Studio', description: 'Software gratuito para gravar a tela e transmitir ao vivo, com cenas, fontes de captura de jogo e mixagem de áudio.', url: 'https://obsproject.com/download', keywords: 'video gravacao live stream transmissao captura' },
  { id: 'nvidia-driver', category: 'Drivers e hardware', name: 'Drivers NVIDIA GeForce', description: 'Página oficial da NVIDIA para baixar o driver de vídeo correto da sua GeForce. Informe o modelo e o Windows e escolha a versão Game Ready ou Studio.', url: 'https://www.nvidia.com/Download/index.aspx' },
  { id: 'amd-driver', category: 'Drivers e hardware', name: 'Drivers AMD Radeon', description: 'Central oficial de downloads da AMD para placas de vídeo Radeon e processadores com gráficos integrados. Inclui o AMD Software: Adrenalin Edition.', url: 'https://www.amd.com/en/support/download/drivers.html' },
  { id: 'intel-driver', category: 'Drivers e hardware', name: 'Drivers Intel', description: 'Centro de downloads oficial da Intel para drivers gráficos, de rede e de chipset. Também oferece o assistente que detecta o que precisa de atualização.', url: 'https://www.intel.com/content/www/us/en/download-center/home.html' },
  { id: 'hwinfo', category: 'Drivers e hardware', name: 'HWiNFO', description: 'Ferramenta de informações e sensores do hardware, com temperaturas, tensões e velocidades em tempo real. Útil para conferir o computador após formatar.', url: 'https://www.hwinfo.com/download/' },
  { id: 'cpuz', category: 'Drivers e hardware', name: 'CPU-Z', description: 'Utilitário gratuito da CPUID que identifica processador, placa-mãe, memória e placa de vídeo. Confirma o hardware e as frequências reais.', url: 'https://www.cpuid.com/softwares/cpu-z.html' },
  { id: 'edge', category: 'Navegadores', name: 'Microsoft Edge', description: 'Navegador da Microsoft baseado no Chromium, integrado ao Windows. Compatível com extensões do Chrome, com sincronização pela conta Microsoft e modo de eficiência.', url: 'https://www.microsoft.com/edge/download', keywords: 'navegador browser internet' },
  { id: 'riot', category: 'Jogos', name: 'Riot Client', description: 'Lançador oficial da Riot Games para VALORANT, League of Legends e outros jogos da empresa. Gerencia a conta, as instalações e as atualizações.', url: 'https://www.riotgames.com/', keywords: 'valorant league of legends lol launcher' },
  { id: 'everything', category: 'Produtividade e IA', name: 'Everything', description: 'Pesquisa instantânea de arquivos e pastas por nome em discos NTFS, com resultados na hora enquanto você digita. Leve e gratuito.', url: 'https://www.voidtools.com/', keywords: 'busca procurar arquivos pesquisa' },
  { id: 'claude', category: 'Produtividade e IA', name: 'Claude', description: 'Assistente de IA para conversar, trabalhar com arquivos e realizar tarefas de programação com recursos compatíveis com sua conta.', url: 'https://claude.com/download', keywords: 'ia inteligencia artificial assistente chat anthropic claude code programacao' },
  { id: 'canva', category: 'Produtividade e IA', name: 'Canva', description: 'Crie designs, apresentações, posts e materiais gráficos com ferramentas de edição intuitivas.', url: 'https://www.canva.com/download/', keywords: 'design arte grafico apresentacao posts edicao' },
  { id: 'pinterest', category: 'Produtividade e IA', name: 'Pinterest', description: 'Descubra e organize ideias, referências visuais e inspirações para projetos, decoração e design.', url: 'https://www.pinterest.com/', keywords: 'design inspiracao referencias imagens decoracao' },
  { id: 'sharex', category: 'Utilitários', name: 'ShareX', description: 'Ferramenta gratuita de código aberto para capturar a tela, gravar vídeo e GIF, anotar imagens e enviar o resultado para onde você quiser.', url: 'https://getsharex.com/', keywords: 'captura print screenshot gravacao video gif tela' },
  { id: 'revo', category: 'Utilitários', name: 'Revo Uninstaller', description: 'Desinstalador que remove programas e também os restos que eles deixam no registro e nos arquivos. Há versão gratuita e versão paga.', url: 'https://www.revouninstaller.com/', keywords: 'desinstalar remover programas limpeza' },
  { id: 'crystaldiskinfo', category: 'Drivers e hardware', name: 'CrystalDiskInfo', description: 'Mostra a saúde, a temperatura e os dados S.M.A.R.T. de HDs e SSDs. Ajuda a perceber um disco com problemas antes de perder arquivos.', url: 'https://crystalmark.info/en/software/crystaldiskinfo/', keywords: 'disco hd ssd saude smart temperatura' },
  { id: 'nvidia-app', category: 'Drivers e hardware', name: 'NVIDIA App', description: 'Aplicativo oficial da NVIDIA para manter os drivers GeForce atualizados e ajustar jogos, captura e opções da placa de vídeo em um só lugar.', url: 'https://www.nvidia.com/en-us/software/nvidia-app/', keywords: 'driver placa de video geforce gpu' }
]

export function catalogApp(id: string): CatalogApp | undefined {
  return APP_CATALOG.find((a) => a.id === id)
}

/** Minúsculas e sem acentos: "video" encontra "vídeo" e "IA" encontra "ia". */
export const foldText = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Pesquisa por nome, descrição, categoria e palavras-chave; texto vazio devolve o catálogo inteiro. */
export function searchApps(text: string, list: CatalogApp[] = APP_CATALOG): CatalogApp[] {
  const q = foldText(text)
  return q ? list.filter((a) => foldText(`${a.name} ${a.description} ${a.category} ${a.keywords ?? ''}`).includes(q)) : list
}
