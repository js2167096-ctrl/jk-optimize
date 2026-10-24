# JK Optimize — Relatório completo

Data: 21/10/2026 · Versão instalada neste PC: **0.1.7** · Último teste no Windows real: **22 de 22 cenários** · Testes unitários: **96 de 96**

Este relatório separa o que foi **testado de verdade** do que **não foi** e lista as limitações reais. Onde algo não pôde ser verificado, está escrito.

---

## 1. Resumo

| Entrega | Versão | Situação |
|---|---|---|
| Correção do erro 5 em serviços, motor de otimização para Windows e FiveM, revogação de keys | até 0.1.4 | Concluída e testada (parte que roda sem administrador) |
| Central de ajustes com interruptores reais, perfis Padrão/Ideal/Máximo, "Aplicar" e "Desativar todos" | 0.1.5 | Concluída e testada |
| Redesign preto e vermelho, janela arredondada, nova página inicial | 0.1.6 | Concluída; arrasto de borda com mouse real não verificado na última rodada |
| Menu lateral restaurado (7 itens originais + Suporte) | 0.1.7 | Concluída e testada |
| Agentes e skills do seu repositório instalados no Claude Code | — | 25 agentes e 140 skills instalados e descobertos |
| Planejador Haiku + skill de execução no modelo escolhido | — | Concluído e testado com modelos identificados nos registros |

---

## 2. Motor de otimização (especificação "Correção completa e motor avançado")

**Serviços e erro 5 (MDCoreSvc)**
- Novo módulo `src/main/security/protection.ts` classifica serviços como protegidos, essenciais, de segurança ou com dependentes. Detecta o `LaunchProtected` do Windows, o caminho do Defender e uma lista de nomes. Traduz códigos de erro do Windows (5, 1051 a 1062, 1072, 577) para mensagens claras.
- Os serviços protegidos saíram da lista modificável (ficam somente leitura). A operação rechecha a proteção do lado elevado e confere o estado final.
- Neste PC: **189 serviços modificáveis de 259**. Com `LaunchProtected`: wscsvc, AppIDSvc, DoSvc, sppsvc, AppXSvc, WdNisSvc, ClipSVC, SecurityHealthService, WaaSMedicSvc e WinDefend. O MDCoreSvc não existe neste computador, e a prévia o bloqueia.
- Nenhum modo contorna a proteção do Defender nem desativa mecanismos de segurança.

**Confirmações e notificações**: janela única "Confirmar operação / Deseja realmente executar esta ação? / Cancelar | Confirmar"; depois, notificação curta com o resultado real e "Detalhes" quando falha.

**Aba Otimização** concentra todas as ferramentas (sem novas abas principais).

**Limpeza real**: temporários com espaço recuperado medido no disco (antes e depois), lista de removidos e ignorados, caches de shaders e analisador de armazenamento.

**FiveM e desempenho**
- FPS & Frametime Lab com PresentMon: FPS médio, mediana, percentis, 1% e 0,1% low só com quadros suficientes, sessões, comparação com margem estatística, exportação JSON/CSV.
- Classificação de gargalos: CPU confirmado/provável, GPU confirmado/provável, pressão de memória, térmico/energético, externo/inconclusivo, dados insuficientes.
- Perfis gráficos do FiveM (ler, revisar, aplicar, restaurar), Game Boost (aplica ao abrir o FiveM e restaura ao fechar, registrando o que não reverteu), perfis do Windows, CPU Bottleneck Fixer, RAM Pressure Controller, Thermal & Power Controller.
- Nada é fabricado: sem PresentMon o FPS aparece "indisponível"; sem sensor, a temperatura aparece "sem sensor".

**Revogação de keys com autoridade**: lista de revogação assinada (Ed25519) com número de sequência (impede reutilizar lista antiga), verificação ao abrir e a cada 10 min, falha de rede **não** bloqueia, 7 dias sem verificação exige conexão, log só com o início do identificador.

---

## 3. Central de ajustes (v0.1.5)

- **20 ajustes** com interruptor ou seletor, cada um lendo e gravando uma configuração real: plano de energia, estado mínimo do processador, suspensão de USB, economia do PCI Express, aceleração do mouse, repetição do teclado, efeitos visuais, atraso de menus, dicas do Windows, ID de anúncio, apps em segundo plano, atraso de inicialização, Modo de Jogo, Game DVR, capturas da Game Bar e agendamento de GPU.
- Três estados por ajuste: valor atual lido do Windows, valor pendente e "Aplicado e conferido" (relido depois de gravar).
- **Padrão / Ideal / Máximo** são conjuntos diferentes e documentados no README; Padrão volta ao estado registrado na primeira leitura.
- **Aplicar ajustes selecionados**: só o que muda; informa "já configurado"; confere cada item; falha parcial não perde o histórico.
- **Desativar todos os ajustes**: restaura as alterações reversíveis do app, preserva o que foi mudado por fora e não diz "concluído" se algo falhou ou foi preservado.
- **Meus ajustes**: favoritos, perfis salvos validados (só ajustes do catálogo, sem comandos) e aviso do que já não corresponde ao perfil.
- Neste PC, Game DVR e capturas da Game Bar aparecem como indisponíveis porque uma política do sistema (`AllowGameDVR=0`) já os desativa; o app não altera políticas.

---

## 4. Redesign preto e vermelho (v0.1.6) e menu restaurado (v0.1.7)

- Paleta centralizada em `src/renderer/styles/tokens.css`; componentes (cards, botões, interruptor único, abas, notificações) usam só esses tokens.
- **Janela sem moldura do Windows**, transparente, cantos externos de 14 px, borda fina e botões próprios de minimizar, maximizar/restaurar e fechar. Maximizada, fica sem cantos. Novos canais `window:*` na lista permitida de IPC, com validação.
- No Windows o Electron não deixa redimensionar janelas transparentes pela borda do sistema (`isResizable` falso, verificado). Por isso há alças próprias nas bordas (mínimo 1024 × 680).
- **Página inicial** com banner (arte local em SVG, sem imagens remotas), hardware real detectado (Ryzen 3 PRO 3200G, Radeon Vega 8, 14 GB, 223 GB), Recursos em Destaque que levam às seções existentes, coluna direita (redes, "Potencialize seu PC" e identidade) e página **Suporte**.
- **Causa do sumiço das abas**: no redesign agrupei Monitoramento, Executor, Chaves e Administração dentro de "Ferramentas". As telas e rotas estavam intactas; só o menu deixou de listá-las. Agora o menu lê a lista completa na ordem pedida; Administração só aparece para o proprietário.

---

## 5. Agentes e skills do seu repositório

- Clonado em pasta isolada; 16.774 arquivos (201 MB), com muitas cópias.
- Varredura antes de instalar: nenhum hook no cabeçalho de agentes ou skills; os comandos com cara de risco (`curl | sh`, `rm -rf`, `.ssh`) eram exemplos de documentação.
- **Instalado**: 25 agentes e 140 skills em `~/.claude`, sem sobrescrever nada. Eles já aparecem nas sessões.
- **Não instalado de propósito**: o `settings.json` do pacote, que redireciona todo o Claude Code para `http://localhost:20128/v1` (um "9Router"), troca todos os modelos por `imperion-dev` e libera Python/PowerShell/Node/npm sem confirmação, com caminhos de outro computador. O `CLAUDE.md` e as regras também ficaram de fora.
- 20 skills têm o campo `name` com espaços e maiúsculas (ex.: "Hooks Automation"), diferente do nome da pasta. É cosmético; pode atrapalhar chamá-las pelo nome.
- Custo a considerar: as 140 descrições e os 25 agentes ocupam contexto em toda sessão nova.

---

## 6. Planejador Haiku + execução no modelo escolhido

- Referência: `Zihao-Wu06/claude-code-orchestrate`, licença **CC BY-NC 4.0** (só uso não comercial, com atribuição). **Nada foi copiado**; escrevi do zero e aproveitei só a ideia. Não executei o `install.sh` nem o `peer.sh` deles.
- Criados (únicos arquivos): `~/.claude/agents/planner-haiku.md` (`model: claude-haiku-5-5`, ferramentas `Read, Glob, Grep`) e `~/.claude/skills/plan-then-execute/SKILL.md`.
- Nenhuma variável global força o modelo dos subagentes; seu modelo principal não foi alterado; nenhum hook foi tocado.
- **Testes reais** (sessão nova do app, lendo `message.model` dos registros):
  - planejador: 5 mensagens em `claude-haiku-5-5`;
  - principal: 20 mensagens em `claude-sonnet-5-5`, antes e depois do planejamento;
  - tarefa do arquivo temporário: 1 chamada ao planejador, execução e verificação pelo principal;
  - pergunta simples: 0 chamadas ao planejador;
  - integridade: só os 2 arquivos novos; o `settings.json` não foi alterado por mim.
- Desativar: apagar `~/.claude/agents/planner-haiku.md` e a pasta `~/.claude/skills/plan-then-execute`.

---

## 7. O que foi realmente testado

- **96 testes unitários** (licenças, diário de alterações, registro de operações, autorização de IPC, regras de proteção, estatísticas de quadros, classificação de gargalos, controladores, perfis gráficos, Game Boost, revogação, central de ajustes e outros).
- **22 cenários no Windows real** (app aberto numa pasta de dados isolada, conferindo o sistema por fora com PowerShell): troca e reversão de plano de energia, Modo de Jogo, inicialização, prioridade de processos, proteções, DNS e latência, limpeza, benchmark, overlay, histórico, serviços protegidos, perfil de Windows, FPS Lab sem PresentMon, controladores, as 8 rotas do menu com destaque, a página inicial e seus atalhos, a janela, a central de ajustes (valores da interface × registro/powercfg, lote, divergência externa preservada, "Desativar todos", fluxo completo pela interface, perfis) e as 25 seções com 47 abas.
- Typecheck dos dois lados, build e instalação assinada da atualização.

---

## 8. Achados sobre este computador

- **WinDefend, SysMain e Spooler** estavam com início desativado (Start=4), por alguma ferramenta anterior. O JK Optimize não mexe nisso.
- O `gta5_settings.xml` do FiveM já está no mínimo (ScreenWidth=1100, ScreenHeight=1080, VSync=0): o perfil de Desempenho gráfico quase não muda nada.
- **Sem sensor de temperatura** exposto ao Windows; **PresentMon não instalado**; Windows 10 build 19045.

---

## 9. Problemas encontrados e corrigidos (inclusive meus)

- **Barras invertidas** perdidas em edições feitas por script (caminhos do registro, expressões regulares): corrigido usando edição de arquivo.
- Janela **não diminuía** de tamanho: o Electron informa como mínimo o tamanho atual em janelas não redimensionáveis; agora o mínimo é fixo em 1024 × 680.
- Interruptores do Game Boost **sem texto visível**: corrigido no componente único.
- GUID errado do estado mínimo do processador, achado pelo teste real; corrigido.
- CPU Fixer com 15 s dava poucas amostras: mínimo de 20 s.
- **Eu disparei duas rodadas de teste ao mesmo tempo** (duas vezes), misturando resultados. Passei a conferir que nada está rodando antes de iniciar.
- Várias falhas intermitentes eram do **teste**, que esperava 1,5 a 9 s por telas que levam mais; agora espera pela tela.
- Cuidado com o mouse real: ver limitações.

---

## 10. Limitações e pendências reais

1. **Arrasto da borda com o mouse real**: na última rodada o Windows entregou o ponteiro a outra janela (o app do Claude estava por trás), então ficou "não verificado". Funcionou em três rodadas anteriores (1280→1430, 1200→1350, 1200→1351). Verificados: as 8 alças existem, o canal `window:set-bounds` redimensiona e as larguras 1024/1280/1600 não têm sobreposição. Em 16 ciclos de maximizar, restaurar e redimensionar no app, todos deram certo.
2. **Operações com administrador (UAC) não foram executadas nos testes**: alterar serviços, SFC/DISM, ponto de restauração, reinício de adaptador, HKLM e o agendamento de GPU. Foram testadas só até a prévia e os bloqueios.
3. **Autoridade de revogação não configurada**: é preciso hospedar a lista assinada em HTTPS e rodar `npm run owner:autoridade -- <url>`. Sem isso, revogações só chegam em novas versões.
4. **Redes sociais**: Discord, TikTok e YouTube aparecem desabilitados ("Link ainda não configurado"). Os endereços ficam em `src/shared/constants/links.ts`; não inventei nenhum.
5. **Imagem de referência do redesign não veio anexada**: segui a descrição em texto. Pode haver diferenças visuais em relação à imagem.
6. **Janela transparente**: não tem a sombra nativa do Windows.
7. **Nome**: logo e textos de marca dizem "JK Optimizer"; o nome do app instalado continua "JK Optimize".
8. **Cartões de hardware**: em 1280 px ficam 2×2 para não cortar os nomes; a faixa de quatro em linha aparece a partir de 1536 px.
9. **Planejador Haiku**: o teste usou tarefa pequena e não mede economia real em tarefas grandes.
10. Não há lint configurado; a verificação estática é o TypeScript em modo estrito.

---

## 11. Como operar

- **Atualizar o app instalado**: `scripts\atualizar-assinado.cmd <senha>` (gera o instalador assinado e instala por cima; o log fica em `release\atualizar-log.txt`).
- **Testes**: `npm test` (unitários) e `scripts\e2e\run-integration.cmd <senha>` (Windows real; log em `.e2e-shots\log.txt`, capturas na mesma pasta). Rode **uma rodada por vez**. `JKO_E2E_ONLY=trecho` roda só os cenários cujo nome contém o trecho.
- **Dados reais do usuário**: os testes usam `JKO_USER_DATA_DIR` e nunca tocam em `%APPDATA%\JK Optimize`.
- **README.md** descreve os módulos, a central de ajustes (com a tabela dos perfis), a arquitetura, as permissões e a política de revogação.
