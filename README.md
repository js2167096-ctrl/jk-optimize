# JK Optimize

Aplicativo desktop para Windows de diagnóstico, otimização e monitoramento, com executor de tarefas isolado, diário de alterações reversíveis e licenciamento por chaves assinadas.

Todas as funções executam operações reais e conferem o resultado. Quando um sensor, comando, permissão ou ferramenta não existe no computador, a tela mostra "indisponível" e nunca um valor inventado.

## Requisitos

- Windows 10 1803+ ou Windows 11 (x64)
- Node.js 20 ou superior (testado com Node.js 24 LTS)
- Windows PowerShell 5.1 (já vem com o Windows)
- Opcional: [PresentMon](https://github.com/GameTechDev/PresentMon) (Intel, código aberto) para medir FPS e frametime
- Opcional: driver NVIDIA com `nvidia-smi` para temperatura de GPUs NVIDIA

## Instalação e primeira configuração

```powershell
npm install
npm install-scripts approve electron esbuild electron-winstaller   # npm 11+ bloqueia scripts de instalação
npm rebuild electron esbuild electron-winstaller
npm run owner:init                                                  # uma única vez: identidade do proprietário
```

O `owner:init` gera um par de chaves Ed25519. A chave **privada**, cifrada com a sua senha, fica em `owner-keys/owner-key.jkokey`: nunca distribua esse arquivo e faça backup dele. A chave **pública** vai em `src/main/security/license-public-key.ts`. Comandos auxiliares:

| Comando | O que faz |
|---|---|
| `npm run owner:instalar` | Copia a chave do proprietário para o app instalado neste PC (não precisa escolher o arquivo no app) |
| `npm run owner:senha` | Troca a senha do `.jkokey` (variáveis `JKO_OLD_PASSPHRASE` e `JKO_NEW_PASSPHRASE`) |

No PowerShell, use `npm.cmd` em vez de `npm` se a política de execução bloquear o `npm.ps1`.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Abre o app com recarga automática |
| `npm run typecheck` | Verifica os tipos (processo principal, preload e interface) |
| `npm test` | Testes automatizados (unitários e de integração com o PowerShell real) |
| `npm run test:windows` | Teste de integração real no Windows (ver abaixo) |
| `npm run build` | Typecheck + build de produção em `out/` |
| `npm run dist` | Build + instalador NSIS em `release/<versão>/` |
| `npm run atualizar` | Sobe a versão, gera o instalador e **atualiza direto o app instalado neste PC** |

## Módulos

Cada tela usa o mesmo fluxo para tudo o que altera o sistema: **pré-visualização** (recursos afetados, valor atual e valor pretendido, avisos, risco, se é reversível e se pede administrador) → **confirmação** → execução com progresso → **resultado conferido**. Alterações reversíveis guardam o estado anterior e aparecem na **Central de restauração**.

O menu lateral tem cinco entradas: **Início**, **Otimização**, **Ferramentas** (abas Monitoramento, Executor, Chaves e Administração), **Configurações** e **Suporte**. **Todas as ferramentas de otimização ficam dentro da aba Otimização**, que tem navegação lateral própria (com busca) em três grupos:

| Grupo | Seções |
|---|---|
| **Básico** | Ajustes rápidos do Windows · Limpeza temporária (medida, com lista de removidos/ignorados) · Inicialização de aplicativos · Perfil de energia · Mouse e teclado · Efeitos visuais · Game Mode · Configurações básicas de jogos (inclui perfis do Windows para jogos) |
| **Avançado** | CPU e processadores lógicos (CPU Bottleneck Fixer) · GPU e configurações gráficas · Memória e processos (RAM Pressure Controller) · Energia e diagnóstico térmico (Thermal & Power Controller) · Dispositivos e USB · Inicialização avançada · Serviços opcionais e dependências (protegidos ficam somente leitura) · Diagnóstico e restauração |
| **Otimização** | FiveM Performance Engine (detecção, gargalos, análise gráfica, memória, arquivos, perfis de inicialização) · Game Boost automático · Perfis gráficos · FPS & Frametime Lab · Input Lag Optimizer · Otimização de armazenamento · Ajustes de rede compatíveis · Perfis personalizados (Meus ajustes) · Histórico de alterações |

### Central de ajustes (interruptores reais)

Cada ajuste mostra o **valor atual lido do Windows**, o **valor pendente** escolhido na interface e, depois de aplicar, **"Aplicado e conferido"** (o valor é relido no Windows). Nada muda no sistema só por mexer no interruptor. Ajustes não suportados mostram o motivo e só aquele controle fica desabilitado.

| Ajuste | Onde grava | Padrão | Ideal | Máximo |
|---|---|---|---|---|
| Perfil de energia | powercfg /setactive | perfil-base | Alto desempenho (Equilibrado em notebook) | Desempenho Máximo (ou Alto desempenho) |
| Estado mínimo do processador (tomada) | powercfg, plano ativo | perfil-base | 5% | 100% em desktop; 5% em notebook |
| Suspensão seletiva de USB (tomada) | powercfg, plano ativo | perfil-base | mantém | desativada em desktop |
| Economia de energia do PCI Express (tomada) | powercfg, plano ativo | perfil-base | mantém | desligada em desktop |
| Aceleração do mouse | SystemParametersInfo (+ HKCU) | perfil-base | desativada | desativada |
| Atraso / velocidade de repetição do teclado | SystemParametersInfo | perfil-base | mantém / rápida | curto / rápida |
| Transparência · animação de janelas · conteúdo ao arrastar · animações da barra | HKCU / SystemParametersInfo | perfil-base | mantidos ativados | desativados (conteúdo ao arrastar mantido) |
| Atraso para abrir menus | SystemParametersInfo | perfil-base | 200 ms | 100 ms |
| Dicas do Windows · ID de anúncio | HKCU | perfil-base | desativados | desativados |
| Aplicativos em segundo plano (Windows 10) | HKCU | perfil-base | mantém | bloqueados |
| Atraso dos aplicativos de inicialização | HKCU | perfil-base | mantém | sem atraso |
| Modo de Jogo | HKCU | perfil-base | ativado | ativado |
| Game DVR · capturas da Game Bar | HKCU (respeita política do sistema) | perfil-base | DVR desativado | ambos desativados |
| Agendamento de GPU por hardware | HKLM com UAC (vale após reiniciar) | perfil-base | mantém | ativado, se a GPU/driver oferecer |

- **Perfil-base (Padrão)**: o valor de cada ajuste na primeira vez que a central leu este computador. **Atualizar** relê tudo do Windows.
- **Aplicar ajustes selecionados**: aplica só os pendentes que mudam algo ("já configurado" é informado), na ordem certa (plano de energia antes das configurações do plano), confere cada um e registra sucesso e falha separadamente. Uma única confirmação; execuções duplicadas são impedidas.
- **Desativar todos os ajustes**: pergunta "Deseja desativar todos os ajustes aplicados pelo JK Optimize?" e restaura, da mais recente para a mais antiga, todas as alterações reversíveis feitas pelo app (ajustes, perfis, inicialização, serviços, gráficos do FiveM…). O que foi alterado depois por você ou por outro programa é **preservado** e informado; o resumo nunca diz "concluído" se algo falhou ou foi preservado. Nunca desativa serviços, Defender, firewall, atualizações ou drivers.
- **Meus ajustes**: favoritos (estrela em cada ajuste), perfis personalizados salvos localmente (só ajustes do catálogo e valores validados; nada de comandos), indicação das configurações que já não correspondem ao perfil salvo, e histórico com restauração.


| Outras abas | Funções |
|---|---|
| **Monitoramento** | Overlay transparente (sem injeção), alertas configuráveis de temperatura, memória e disco com intervalo mínimo, histórico persistente com retenção e gráficos |
| **Executor** | Tarefas do executor isolado, catálogo de ações (risco, permissões, reversão), ações rápidas, central de restauração, logs pesquisáveis e verificação de integridade dos backups |
| **Configurações** | Inicialização com o Windows, interface, atualizador com manifesto assinado |
| **Administração** | Sessão do proprietário, status da autoridade de licenças (última verificação, falhas de rede, "Verificar agora"), chaves emitidas e lista de revogação assinada |

### Emblema oficial

- Fonte: o PNG da pasta `imagem referencia` (`Emblema*.png`, 1254 × 1254 px, 32 bits com transparência real). **O original nunca é alterado** (o gerador só o lê).
- `scripts/analisar-emblema.ps1` mede dimensões, alfa, caixa do conteúdo, respiro, manchas e bordas. `scripts/gerar-logo.ps1` prepara as versões: limpa o ruído de alfa (1 a 3), normaliza o corpo opaco (250 a 254 viram 255), recentraliza com respiro igual nos quatro lados e reduz em espaço pré-multiplicado, sem ampliar nem redesenhar. Saídas: `src/renderer/assets/brand/jk-emblem.png` (768 px) e `jk-emblem-128.png`; `build/icon.ico` (16 a 256 px, com transparência) e `build/icon.png`.
- Onde aparece: banner do Dashboard e telas de carregamento, ativação, desbloqueio e configuração (emblema grande + nome); menu lateral e barra superior (emblema pequeno); painel de identidade em Suporte; ícone do executável, do instalador, dos atalhos (área de trabalho e Menu Iniciar usam o ícone do `.exe`) e da barra de tarefas.
- O nome em texto continua **JK Optimize** (azul elétrico e prata); o emblema não traz texto.
- `scripts/atualizar.mjs` atualiza o cache de ícones do Windows depois de instalar. Se um atalho antigo ainda mostrar o ícone anterior, reiniciar o Explorer resolve.

### Temas, Dashboard, Monitoramento e aplicação animada

- **Temas**: azul (padrão, preto e azul-marinho com destaque azul elétrico) e vermelho (preto e vermelho), escolhidos em Configurações › Interface. Todas as cores estão em `src/renderer/styles/tokens.css`; o tema vermelho fica em `[data-theme='red']`. O nome do aplicativo é **JK Optimize** em toda a interface.
- **Dashboard**: índice de otimização = critérios atendidos ÷ avaliados (`src/shared/optimization-index.ts`): plano de energia sem economia agressiva, Modo de Jogo, até 15 programas na inicialização, memória comprometida abaixo de 85%, processador sem limitação, pelo menos 15% de espaço livre e Executor ativo. Critério sem dado aparece como "Indisponível" e não entra na conta. Recomendações vêm dos critérios reprovados; resultados recentes vêm do diário real. O inventário completo de hardware continua em Otimização › Diagnóstico e restauração. Links sociais só aparecem quando configurados em `src/shared/constants/links.ts`.
- **Monitoramento › Visão geral**: CPU e processadores lógicos, GPU e memória gráfica, RAM, temperaturas e frequências, processos, armazenamento, rede, plano de energia, FiveM, Executor e resultados recentes, usando o amostrador único existente; o que não tem fonte aparece como "Indisponível".
- **Aplicação animada**: depois de "Deseja aplicar os ajustes selecionados?", a tela mostra as etapas reais (verificando, aplicando cada item, conferindo) com progresso real, falha e cancelamento sem travar. O estado final de cada ajuste só é "concluído" se o Windows, lido de novo, mostra o valor desejado. Ajustes que exigem reinício (agendamento de GPU) oferecem "Reiniciar agora" (com confirmação de que aplicativos abertos podem ser interrompidos, reinício em 30 s e cancelável) ou "Reiniciar depois". O computador nunca reinicia sozinho.

### Identidade visual e janela

- Paleta preto e vermelho centralizada em `src/renderer/styles/tokens.css` (fundo, painéis, cards, bordas, vermelho principal `#FF1835` e de destaque `#FF293F`, textos e estados). Os componentes usam apenas esses tokens.
- **Início**: banner com arte local (`src/renderer/assets/hero-robot.svg`, sem imagens remotas), cartões de hardware com dados reais do Windows, recursos em destaque que abrem seções existentes, indicador de estado real e coluna direita (redes, "Potencialize seu PC" e identidade).
- **Redes sociais**: os endereços ficam em `src/shared/constants/links.ts`. Enquanto estiverem vazios, os cartões aparecem desabilitados ("Link ainda não configurado").
- **Janela**: sem moldura nativa e transparente, com cantos externos arredondados (14 px) e borda fina; maximizada, fica sem cantos. Minimizar, maximizar/restaurar e fechar são botões próprios (canais `window:*` da lista permitida). No Windows o Electron não permite redimensionar janelas transparentes pela borda do sistema, então as bordas têm alças próprias que redimensionam com o mouse (mínimo 1024 × 680).

## Arquitetura

```
src/
  main/
    index.ts, target.ts        Janela, endurecimento de segurança, URL/preload da interface
    ipc.ts                     Lista permitida de canais e verificação de acesso por canal
    ops/
      registry.ts              Registro de consultas e ações: prévia obrigatória, confirmação,
                               exclusão mútua, cancelamento, diário e logs
      journal.ts               Diário de alterações + backups write-once com SHA-256
      log.ts, redact.ts        Logs NDJSON com retenção e remoção de segredos
      params.ts                Validação de parâmetros
    modules/                   cleanup, power, performance, sampler, processes, startup, services,
                               apps, network, windows, fivem, presentmon, monitoring, updater
    services/
      powershell.ts            Scripts PowerShell FIXOS; dados entram por stdin em JSON
      elevated.ts              Componente privilegiado: um script fixo por operação, com UAC pontual
      dpapi.ts, store.ts, ...  Proteção de dados do Windows, persistência
    executor/                  Processo separado (utilityProcess): tarefas, benchmark
    security/                  Acesso, licenças, chave do proprietário, manifesto de atualização
  preload/index.ts             Ponte mínima e tipada (window.jk)
  renderer/                    Interface React + Tailwind (tokens em styles/tokens.css)
  shared/                      Tipos e constantes compartilhados
tests/                         Testes automatizados (empacotados com esbuild)
scripts/                       owner-init, owner-senha, owner-instalar, atualizar, testes, e2e
```

### Segurança

- `contextIsolation` ligado, `nodeIntegration` desligado, `sandbox` ligado. O renderer não tem acesso a Node, `ipcRenderer` ou shell.
- O renderer só pede operações **registradas** pelo identificador. O processo principal confere a origem da chamada, o nível de acesso (`protected`/`owner`) e valida todos os parâmetros. Campos desconhecidos são recusados.
- Nenhum comando é montado a partir de texto da interface. Os scripts PowerShell são constantes no código e vão via `-EncodedCommand`. Os dados validados entram por stdin em JSON. Há teste que tenta injetar comandos por parâmetro.
- **Elevação**: cada operação administrativa abre o UAC naquele momento e roda **um** script fixo, com parâmetros num arquivo JSON temporário revalidados pelo próprio script. O app não fica elevado.
- **Pré-visualização obrigatória**: a execução usa o `previewId` de uso único (válido por 10 minutos). Risco diferente de "nenhum" exige confirmação explícita, e o estado é revalidado antes de executar.
- **Reversão**: o backup é gravado uma única vez (sem sobrescrita) com SHA-256. Antes de reverter, a integridade é conferida e o estado atual validado; se o estado mudou, só reverte com "forçar".
- Bloqueados por regra: processos críticos (lsass, csrss, Defender…), processos de outras sessões e da sessão 0, serviços essenciais e de segurança (Defender, firewall, Windows Update…) e serviços com `LaunchProtected` (como o MDCoreSvc do Defender), que ficam fora da lista modificável. Um "acesso negado" (erro 5) é explicado com o código, sem tentar contornar a proteção, pacotes Appx do sistema, prioridade Tempo real, exclusão fora das pastas autorizadas, links e junctions.
- Logs sem segredos (chaves, senhas e tokens são removidos), com retenção de 14 dias.

## Permissões

**Sem administrador:** tudo o que é leitura; plano de energia existente; Modo de Jogo e capturas (HKCU); inicialização do usuário; prioridade e encerramento de processos da própria sessão; temporários do usuário; caches de shaders; cache e configurações do FiveM; Appx do usuário; cache DNS; latência; benchmark; overlay; alertas; histórico.

**Pedem administrador (UAC no momento da ação):** alteração de serviços (e ponto de restauração junto, opcional), SFC/DISM, criação de ponto de restauração, reinício de adaptador de rede, inicialização da máquina (HKLM e pasta comum), limpeza de `C:\Windows\Temp` com administrador, indicadores detalhados de disco/SMART, remoção do plano Ultimate criado (na reversão, se o Windows exigir), PresentMon se o usuário não estiver no grupo "Performance Log Users".

## Testes

- `npm test`: **109 testes** (licenças e chave do proprietário; segurança de exclusão com junctions, idade mínima e cancelamento; diário, integridade e adulteração de backups; registro de operações: prévia obrigatória, confirmação, exclusão mútua, bloqueio, cancelamento, reversão com estado divergente; autorização do IPC: origem não confiável, sem ativação, sem proprietário, lista exata de canais; interpretadores de powercfg, netsh, eventos, SFC/DISM, PresentMon, settings.xml; regras de proteção de processos, serviços e Appx; estatísticas de latência e CSV; amostrador de telemetria; diagnóstico por evidências; alertas, histórico e configurações; manifesto de atualização assinado; e PowerShell real: códigos de saída, CLIXML, injeção por parâmetro e cancelamento; motor de otimização: proteção de serviços e erro 5, 1% low com mínimo de quadros, comparação de sessões com margem estatística, classificação de gargalos inclusive sem sensores e sem FPS, CPU Fixer, pressão de memória, achados térmicos, perfis gráficos, Game Boost e lista de revogação assinada com anti-rollback e política offline; central de ajustes: leitura com valor ausente/personalizado, indisponibilidade isolada, perfis Padrão/Ideal/Máximo distintos e conforme o hardware, plano de aplicação com "já configurado"/não suportado/ordem, validação de entrada e perfis salvos sem valores perigosos).
- `npm run test:windows` (com `JKO_TEST_OWNER_PASSPHRASE`, ou `scripts\e2e\run-integration.cmd <senha>`): abre o app numa **pasta de dados isolada** e executa no Windows real, conferindo o sistema por fora com PowerShell. Cenários: troca e reversão do plano de energia; Modo de Jogo; entrada de inicialização de teste; prioridade e fechamento de um Bloco de Notas de teste; bloqueio de processos críticos e serviços essenciais; limpeza do cache DNS e latência; análise de limpeza; benchmark; overlay e histórico; diário, logs e backups; serviços protegidos (WinDefend/MDCoreSvc); perfil de Windows aplicado e restaurado; sessão do FPS Lab sem PresentMon; controladores de RAM, térmico/energia e CPU; central de ajustes: valores da interface comparados com o registro e o powercfg, aplicação em lote conferida no Windows, alteração externa preservada por "Desativar todos", interruptor → pendente → aplicar → conferido → restaurado pela interface, perfis Padrão/Ideal/Máximo; abertura de todas as telas e de **cada seção e aba interna da Otimização**, com busca e capturas em `.e2e-shots/`.

## Limitações conhecidas

- **FPS e frametime** dependem do PresentMon configurado pelo usuário (FiveM → Instalação). Sem ele ficam "indisponíveis": nunca são estimados pelo uso da GPU. Na versão 2.x a captura contínua do overlay usa `--output_stdout`; versões antigas podem não suportar.
- **Temperatura**: só aparece onde o Windows expõe zonas térmicas, ou com `nvidia-smi`. Muitos desktops, incluindo o computador de desenvolvimento (AMD Vega 8), não expõem nenhum sensor; nesse caso a tela mostra "Sensor não disponível".
- **Nome da GPU por adaptador**: o contador do Windows identifica adaptadores por LUID. O nome só é associado quando há uma única GPU física com memória dedicada em uso; nos demais casos aparece o LUID.
- **Overlay** não aparece sobre jogos em tela cheia exclusiva (limitação do Windows). Funciona em modo janela ou tela cheia sem bordas.
- **Atualizador**: não há servidor padrão. Configure uma URL HTTPS ou uma pasta com o `jk-update.json` assinado (gerado por `npm run atualizar` com `JKO_OWNER_PASSPHRASE`) e o instalador.
- **Licenças e revogação**: a verificação da key é offline (assinatura Ed25519). Para revogar em outros computadores, o proprietário exporta a **lista de revogação assinada** (Chaves emitidas → Exportar revogações), publica num endereço HTTPS e configura com `npm run owner:autoridade -- <url>` (depois `npm run atualizar`). Política: o app consulta a lista ao abrir e a cada 10 minutos; uma key revogada é bloqueada na próxima verificação (não há bloqueio instantâneo de computador desconectado); falha de rede **não** bloqueia; sem verificação bem-sucedida por 7 dias, a ativação passa a exigir conexão. A lista tem sequência crescente (lista antiga é recusada) e o log registra só o início do identificador. Sem autoridade configurada, revogações chegam só em novas versões.
- **Operações sem reversão** (informadas na prévia): limpezas de arquivos e caches, encerramento de processos, remoção de Appx, desinstalação de programas, SFC/DISM, ponto de restauração, limpeza do cache DNS e reinício de adaptador.
- **Não testado em hardware real** neste projeto: execução das operações que pedem administrador (serviços, SFC/DISM, ponto de restauração, reinício de adaptador, HKLM). Elas exigem clicar no UAC e foram testadas apenas até a pré-visualização e os bloqueios. Também não foram testados FPS com PresentMon (não instalado) nem sensores de temperatura (ausentes nesta máquina).
- **Janela transparente** (necessária para os cantos arredondados no Windows 10): o Windows marca a janela como não redimensionável (`isResizable` falso, verificado), então o redimensionamento é feito pelas alças próprias das bordas e o tamanho mínimo é aplicado pelo app; a sombra nativa da janela não aparece.
- Não há lint configurado no projeto; a verificação estática é feita pelo TypeScript em modo estrito.

## Central de Otimização, Aplicativos e GPU

- **Aba Otimização**: contém somente a categoria **Otimização 2** (as demais categorias antigas foram removidas da interface; os serviços de sistema compartilhados continuam no processo principal).
- **Aplicativos**: `src/shared/constants/apps-catalog.ts` (só páginas oficiais). `node scripts/validar-links.mjs` confere os links.

## Tela de carregamento e inicialização

- **Imagem aprovada:** `imagem referencia/Tela de Carregamento JK Optimize.png` (intacta). `scripts/gerar-carregamento.ps1` cria a base derivada (`carregamento-base.png`) removendo só os elementos dinâmicos (barra, %, etapa e linha de estado); o resto é idêntico pixel a pixel.
- **Barra real:** `src/shared/boot.ts` define 7 etapas com pesos; cada uma só conta quando termina (recursos, configurações, licença, acesso, identificação, executor e primeiro quadro da interface). Sem temporizador. O processo principal avisa cada etapa por evento (`app:boot-progress`).
- **Prazos:** licença 4 s, identificação 3 s, executor 6 s; passado o prazo o painel abre e o estado real continua sendo atualizado. Medido: painel em cerca de 2 s.
- **Testes:** `scripts/e2e/run-inicializacao.cmd <senha>` (tempo até o painel, barra, fidelidade visual, sensores indisponíveis e consumo). Variáveis só de teste: `JKO_E2E_BOOT_DELAY_MS`, `JKO_E2E_NO_SAMPLER`.

## Otimização 2 (ajustes avançados do Windows)

Categoria **Otimização 2** na aba Otimização, com sete seções: Otimizar Windows, Plano de energia, Limpeza Windows, Desativar Windows, Scripts importantes, Booster Robusta e Segurança.

- **Catálogo real**: todos os ajustes ficam em `src/main/modules/tweaks.ts` (`ADVANCED_TWEAKS`) e seguem o ciclo estado inicial → valor anterior guardado → gravação → nova leitura → interface atualizada → restauração pelo Histórico. Quais ajustes aparecem em cada seção e o que cada "script importante" executa estão em `src/shared/constants/windows2.ts`.
- **Administrador**: ajustes de HKLM, serviços, hibernação, NTFS e tarefa agendada vão para um lote único (`src/main/modules/elevops.ts`): um só pedido do Windows (UAC) por lote, lista fixa de chaves, serviços (`bthserv`, `DiagTrack`, `WSearch`) e tarefas permitidas. Se o UAC for recusado, os ajustes elevados não são aplicados e os demais continuam.
- **Limpeza ampliada** (`cleanup-extra.ts`): temporários, Prefetch (só com Prefetch ativo), logs e relatórios de erro, cache de miniaturas do Explorador e INetCache; espaço liberado medido pelo espaço livre da unidade.
- **Unidades e tarefas ociosas** (`advanced.ts`): `disk.optimize` (TRIM em SSD, desfragmentação em HDD, escolhidos pela mídia real) e `memory.idleTasks` (`ProcessIdleTasks`, ponto de entrada interno do Windows sem documentação pública).
- **Segurança**: `security.status` apenas consulta Defender, firewall, SmartScreen e UAC. O JK Optimize não altera essas proteções.
- **Tela de progresso** (`components/OperationProgress.tsx`): logo oficial, função atual, estado de cada função, progresso por etapas reais, erros, ignorados, resultado e reinicialização necessária. Nunca reinicia o computador sozinho.
- Teste real: `scripts/e2e/windows-integration.mjs` (cenários "Otimização 2"); a limpeza real roda com `JKO_E2E_FAKE_LOCAL=1`, que aponta TEMP/LOCALAPPDATA do app de teste para uma pasta descartável.
