# JK Optimize Bot

Serviço **independente** do app desktop: se o bot cair, o JK Optimize continua funcionando.
Este diretório tem o seu próprio `package.json`; nada do app principal foi alterado.

## Estado atual: Fase 1 (fundação)

Implementado e testado:

- Conexão real com o Discord via `discord.js` (intent `Guilds`, sem intents privilegiados).
- Slash commands: `/ping` (aberto) e `/diagnostico` (só dono do bot ou quem tem "Gerenciar Servidor").
- Verificação de permissões do bot no canal (básicas e de administração futura).
- Banco SQLite (`node:sqlite`) com migrações versionadas e trilha de auditoria.
- Logs em JSON com redação automática de tokens do Discord e keys `JKO1...`.
- Limite de uso por usuário (5 comandos / 10 s) e encerramento controlado (SIGINT/SIGTERM).
- Scripts: `doctor` (verificação inicial), `commands:deploy`, `invite`.

**Ainda não implementado** (fases seguintes): administração de cargos/canais/modelos, boas-vindas,
moderação, tickets, IA, integração de keys, loja/entrega e painel. Nada disso responde a comandos ainda.

## Requisitos

Node.js 22.5 ou superior (testado no 24.20) e npm.

## Passo a passo

1. **Criar a aplicação:** <https://discord.com/developers/applications> → *New Application*.
2. Em **Bot**: clique em *Reset Token* e copie o token (nunca o compartilhe nem o coloque no chat ou no git).
   Não ative os *Privileged Gateway Intents* — a Fase 1 não precisa deles.
3. Em **General Information**: copie o *Application ID*.
4. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` e, se quiser,
   `BOT_OWNER_IDS` (seu ID de usuário) e `DISCORD_DEV_GUILD_ID` (servidor de testes).
5. `npm install`
6. `npm run doctor` — valida o `.env`, o banco e a autenticação no Discord.
7. `npm run invite` — imprime o link para convidar o bot (permissões mínimas).
   Use `npm run invite -- --admin` quando for usar os módulos de administração (Fase 2+):
   pede Gerenciar Cargos, Canais, Mensagens e Castigar Membros — **nunca** Administrador.
   Abra o link, escolha o servidor e autorize.
8. `npm run commands:deploy` — registra os slash commands (instantâneo no servidor de testes;
   globalmente pode levar até 1 hora).
9. `npm start` — liga o bot.

## Desenvolvimento

```
npm run typecheck
npm test        # compila e roda 19 testes (config, logs, banco, permissões, handler)
```

## Segurança

- Tokens só em variáveis de ambiente (`.env` está no `.gitignore`).
- Toda ação administrativa é auditada na tabela `audit_log` (quem, o quê, resultado).
- Não há comando que execute shell ou código recebido do Discord.

## Licenciamento do JK Optimize (importante para a Fase 4)

Análise do app atual (`src/main/security/*`):

- A key é um token `JKO1.<payload>.<assinatura Ed25519>`, verificado **offline** com a chave pública embutida.
- A chave **privada** do proprietário fica cifrada em `owner-keys/owner-key.jkokey` (senha em outro arquivo);
  ela é a única capaz de emitir keys e **não pode** ir para o bot nem para hospedagem não confiável.
- A revogação é uma lista assinada (`jk-revocations.json`) publicada em HTTPS (`LICENSE_AUTHORITY_URL`,
  hoje `null`). Não existe backend, banco de pedidos, produtos ou API de licenças.

Consequência: `/key criar`, `/key revogar` etc. exigirão um **serviço emissor** em ambiente confiável que guarde a
chave privada, exponha uma API autenticada ao bot e publique a lista de revogação. Isso será desenhado na Fase 4
reaproveitando `license.ts` e `license-authority.ts`, sem alterar o formato das keys existentes.
