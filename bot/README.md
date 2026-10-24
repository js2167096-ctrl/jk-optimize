# JK Optimize Bot

Serviço **independente** do app desktop: se o bot cair, o JK Optimize continua funcionando.
Este diretório tem o seu próprio `package.json`; nada do app principal foi alterado.

## Estado atual: Fases 1 e 2

Implementado e testado:

- Conexão real com o Discord via `discord.js` (intent `Guilds`, sem intents privilegiados).
- Slash commands: `/ping` (aberto) e `/diagnostico` (só dono do bot ou quem tem "Gerenciar Servidor").
- Verificação de permissões do bot no canal (básicas e de administração futura).
- Banco SQLite (`node:sqlite`) com migrações versionadas e trilha de auditoria.
- Logs em JSON com redação automática de tokens do Discord e keys `JKO1...`.
- Limite de uso por usuário (5 comandos / 10 s) e encerramento controlado (SIGINT/SIGTERM).
- Scripts: `doctor` (verificação inicial), `commands:deploy`, `invite`.

### Fase 2 — administração de servidores (implementada)

- `/servidor modelos` lista 6 modelos: clientes-jk, vendas-digitais, suporte-tecnico, comunidade-gamer, produto-premium, atendimento-pos-venda.
- `/servidor previa modelo:<m>` mostra o que seria criado, sem alterar nada.
- `/servidor aplicar modelo:<m>` mostra a prévia e só cria depois de você clicar em **Confirmar**.
  Apenas cria: o que já existe (mesmo nome) não é alterado e nada é apagado.
- `/servidor desfazer` apaga só o que o último lote criou (com confirmação). Categorias que ganharam canais de outras pessoas são mantidas.
- `/slowmode canal segundos` define o modo lento (0 a 21600).
- Cada item criado é gravado no banco na hora (tabelas `change_batches` e `change_items`) e toda ação é auditada.
- Os modelos nunca concedem Administrador, Gerenciar Servidor nem Gerenciar Cargos. **Dê Administrador ao seu cargo você mesmo, se quiser.**
- Para estes comandos o bot precisa do convite com permissões de administração: `npm run invite -- --admin` (autorize de novo no mesmo servidor).
- Limitações: os modelos ainda não são editáveis por comando (edite `src/servidor/templates.ts`); boas-vindas e moderação ainda não foram feitas; canais criados em categorias que já existiam recebem as permissões do modelo explicitamente.

**Ainda não implementado** (fases seguintes): boas-vindas, moderação, tickets, IA, integração de keys, loja/entrega e painel.

## Requisitos

Node.js 22.9 ou superior (testado no 24.20) e npm.

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
npm test        # compila e roda 33 testes (config, logs, banco, permissões, handler, modelos, diff, aplicar, desfazer, botões)
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
