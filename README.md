# FinanceFlow

<p align="center">
  <img src="assets/banner.png" alt="FinanceFlow Banner" width="100%">
</p>

> **Automated & Intelligent Financial Management | Controle Financeiro Automatizado & Inteligente**

![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=for-the-badge&logo=fastapi)
![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![React Native](https://img.shields.io/badge/React_Native-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)
![Gemini](https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=google-gemini&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)

[![FinanceFlow Deploy](https://github.com/Gyliardson/FinanceFlow/actions/workflows/deploy-frontend.yml/badge.svg)](https://github.com/Gyliardson/FinanceFlow/actions/workflows/deploy-frontend.yml)

**[Português](#português) | [English](#english)**

---

# Português

## Visão geral

O **FinanceFlow** é um aplicativo mobile de gestão financeira pessoal com backend FastAPI. O projeto cobre contas avulsas e recorrentes, receitas, pagamentos, comprovantes privados, notificações, operação offline com isolamento por usuário e recursos de IA para OCR/insights.

A arquitetura de produção usa **Supabase Auth** como identidade, PostgreSQL/RLS para isolamento por usuário e Storage privado para comprovantes. Valores financeiros autoritativos usam semântica decimal exata no backend e no banco.

## Estado das capacidades

### Produção

- API FastAPI com autenticação Bearer baseada em sessão Supabase.
- RLS/ownership por usuário para tabelas financeiras.
- Criação de conta avulsa, receita, adição à reserva e criação de template recorrente com protocolo durável de `Idempotency-Key` no PostgreSQL.
- Instâncias geradas de recorrência protegidas separadamente por unicidade `(parent_bill_id, due_date)` no banco.
- Receitas, saldo, reserva e projeções usando regras de dinheiro decimal exato.
- Pagamento com ou sem comprovante.
- Pagamento com comprovante reconcilia resultados ambíguos de banco antes de qualquer cleanup do objeto; exception de transporte não é tratada como prova de rollback.
- Comprovantes em bucket **privado**, identificados por object path opaco e acessados por URL assinada temporária após autorização.
- OCR de documentos com structured output e validação local antes de qualquer confiança nos dados extraídos.
- Casos de OCR ilegível/baixa confiança exigem revisão manual em vez de persistência automática.
- Sessão mobile persistida em armazenamento seguro, refresh/logout e cache financeiro isolado por usuário.
- Mutações financeiras pendentes persistem `Idempotency-Key` **e o payload original** em storage seguro owner-scoped, sobrevivendo a timeout, lost response, reconnect, restart e passagem da meia-noite sem reconstruir silenciosamente a intenção.
- Preparação de mutações usa um snapshot coerente de sessão (token + owner + geração), falhando fechado se a conta mudar antes do envio.
- Datas financeiras `YYYY-MM-DD` usam o calendário IANA `America/Sao_Paulo`; UTC slicing não é usado para semantics DATE-only.
- Notificações locais de vencimento.
- Expo SDK 57 / React Native 0.86 com checks de TypeScript, Expo Doctor e export web no CI.

### Experimental e desabilitado por padrão

O repositório contém adapters de **DASMEI, TIM, Unopar e IMAP/PDF** para estudo de integrações com interfaces externas mutáveis. Eles **não fazem parte do runtime de produção** e exigem opt-in explícito por configuração.

Esses módulos seguem uma política fail-closed:

- não tentam contornar CAPTCHA, human verification, antifraude, paywall ou controles de acesso;
- não usam stealth plugins, fingerprints falsificados, coordenadas aleatórias ou “humanização” para esconder automação;
- interfaces que exigem verificação humana retornam estado bloqueado/indisponível;
- resultados financeiros só podem ser promovidos após validação estruturada de valor/data/código;
- não existe fallback de valor, data ou barcode inventado;
- screenshots/documentos autenticados não são persistidos por padrão;
- erros externos são sanitizados;
- IMAP usa critérios de remetente/assunto, leitura não destrutiva e `source_id` determinístico;
- o scheduler experimental apenas coleta candidatos e **não persiste registros financeiros** por conta própria.

Sites externos podem mudar sem aviso. Esses adapters são deliberadamente tratados como experimentais e podem retornar `blocked`, `unavailable` ou `error` em vez de tentar aumentar agressivamente a automação.

## Arquitetura

### Backend

- **FastAPI** — API e validação de domínio.
- **Supabase Auth** — identidade end-user.
- **PostgreSQL / Supabase** — persistência financeira, RLS e ledger transacional de idempotência.
- **Supabase Storage** — comprovantes privados.
- **Google GenAI** — provider de OCR/insights; testes críticos usam providers determinísticos.
- **Docker** — imagem de produção validada em CI.

### Mobile

- **React Native + Expo SDK 57**.
- Sessão Supabase com Bearer dinâmico para a API.
- Cache financeiro owner-scoped para modo offline.
- Pending financial mutations owner-scoped em `SecureStore`, preservando uma única identidade lógica (`Idempotency-Key` + payload original) enquanto o resultado estiver indeterminado.
- Snapshot coerente de sessão para mutation preparation, impedindo combinações owner/token de contas diferentes.
- Helper canônico de data financeira baseado em `America/Sao_Paulo`, separado de timestamps UTC reais.
- Expo Notifications para lembretes locais.
- EAS Update/Build para distribuição mobile quando credenciais externas estiverem configuradas.

## Regras de segurança e correção

- Usuário A não deve ler ou alterar recursos do Usuário B.
- Service-role não é distribuída ao cliente mobile.
- `owner_id`/RLS são boundaries de autorização no banco.
- Dinheiro não usa binary float em cálculos autoritativos.
- Para `POST /add-bill`, `POST /incomes`, `POST /insights/reserve` e `POST /recurring-bills`, a identidade durável de replay no servidor é `auth.uid() + operation type + Idempotency-Key`.
- O PostgreSQL deriva o fingerprint canônico a partir dos próprios parâmetros; o cliente não envia fingerprint confiável nem `owner_id` ao RPC.
- Nessas quatro operações, claim da key, efeito financeiro e resultado durável pertencem à mesma transação PostgreSQL.
- Mesma key + mesmo payload retorna o resultado já comprometido sem repetir o efeito; mesma key + payload diferente falha fechado.
- Uma nova key representa uma nova intenção explícita e pode repetir conscientemente os mesmos valores de negócio após a intenção anterior estar resolvida.
- Enquanto uma intenção está indeterminada, o mobile persiste a key e o **payload original** antes do transporte e os reutiliza após timeout/network/5xx/reconnect/restart/background/foreground. Campos derivados não são silenciosamente recomputados para o retry.
- A identidade local não depende apenas de `owner + operation + canonicalPayload` reconstruído no momento do retry. Em renda, cruzar a meia-noite não transforma a mesma intenção ambígua em nova operação; a data original e a mesma key são reutilizadas.
- O pending store serializa read/modify/write por owner + operation, evitando perda last-writer-wins entre duas intenções diferentes concorrentes.
- Pending financial payload é estado privado: fica owner-scoped em `SecureStore`; o formato legado em AsyncStorage é migrado/removido. Outro usuário não recebe nem reutiliza payload/key de uma conta anterior.
- A preparação da mutação captura token + owner + geração de uma única sessão. Se a sessão muda antes do envio, a operação falha fechado.
- O calendário financeiro do produto é `America/Sao_Paulo`. Valores DATE-only (`YYYY-MM-DD`) não são derivados com `toISOString().split('T')[0]`, `toISOString().slice(0,10)` ou getters UTC.
- `toISOString()` continua válido quando o domínio exige um timestamp/instant UTC real; a proibição é específica a financial DATE-only semantics.
- Datas escolhidas pelo usuário (por exemplo, vencimento) são serializadas como componentes de calendário, sem round-trip por UTC.
- O runtime atual expõe apenas **adição** à reserva; não existe endpoint de decremento/saque. Qualquer futura retirada deverá usar o mesmo protocolo antes de ser disponibilizada.
- Instâncias recorrentes geradas possuem garantia de unicidade no banco para retries/concurrency; isso é separado da idempotência da criação do template recorrente.
- Uploads são limitados e validados por conteúdo real, não somente pelo filename/MIME declarado.
- Comprovantes não possuem URL pública permanente.
- Em pagamento com comprovante, cleanup ocorre somente depois de estado autoritativo provar que o objeto não está referenciado.
- OCR é sugestão: structured output é revalidado localmente antes de uso.
- CI não depende de Gemini real nem de portais externos reais.

Detalhes e casos de borda estão em [`backend/FINANCIAL_RULES.md`](backend/FINANCIAL_RULES.md).

## Desenvolvimento

### Requisitos

- Python **3.12**.
- Node.js **22.13+** para a baseline mobile atual.
- PostgreSQL/Supabase para desenvolvimento integrado.
- Expo CLI/EAS CLI apenas para fluxos mobile que os utilizem.

### Backend

```bash
cd backend
python -m venv venv
# Linux/macOS: source venv/bin/activate
# Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn runtime:create_app --factory --reload
```

Use `backend/.env.example` como referência. Segredos e service-role devem permanecer somente no servidor.

### Mobile

```bash
cd mobile
npm ci
npx expo start
```

Use `mobile/.env.example`. O cliente precisa apenas de variáveis públicas adequadas ao app, como URL da API, URL do projeto Supabase e publishable/anon key. Nunca coloque service-role no bundle.

## Testes e quality gates

Os workflows do repositório exercitam, conforme o escopo:

- backend pytest e compilação Python;
- `pip check` e `pip-audit`;
- PostgreSQL real para recurring/generated-child uniqueness e ownership/RLS;
- PostgreSQL 16 dedicado para replay, commit-then-response-loss equivalente, payload mismatch, isolamento entre owners e concorrência same-key das quatro mutações financeiras duráveis;
- mobile TypeScript;
- contrato de autenticação/cache, logical-intent identity e lifecycle de pending mutation no mobile;
- regressões determinísticas de retry de renda através da meia-noite, concorrência de duas pending mutations diferentes, restart e account switch;
- contrato de financial date-only em `America/Sao_Paulo`, incluindo UTC-next-day, meia-noite local, rollovers e guard estático contra UTC slicing em paths financeiros;
- teste de impacto autoritativo provando que `initial_balance_date = D` inclui renda/pagamento do próprio D e que um drift para D+1 muda o saldo;
- Expo Doctor/config/export smoke;
- build do container backend;
- npm audit com evidência preservada;
- Gitleaks/secret scan.

Para desenvolvimento local do backend:

```bash
cd backend
pytest -q
```

Para executar o contrato PostgreSQL de idempotência em um banco descartável compatível com o fixture do CI:

```bash
bash backend/financial_idempotency_probe.sh
```

Para verificação mobile:

```bash
cd mobile
npm ci
npx tsc --noEmit
npx expo-doctor
```

## Integrações experimentais

A flag `ENABLE_EXPERIMENTAL_INTEGRATIONS` deve permanecer desativada por padrão. Ativá-la não torna os adapters parte do produto suportado nem autoriza qualquer evasão de controle externo.

- **DASMEI:** Playwright normal; interrompe quando houver human verification ou interface incompatível.
- **TIM:** usa seletores semânticos quando disponíveis; interfaces Canvas sem boundary confiável são tratadas como indisponíveis, não operadas por coordenadas adivinhadas.
- **Unopar:** coleta somente quando uma navegação ordinária e validável for possível.
- **IMAP/PDF:** allowlist explícita, `BODY.PEEK`, PDF com MIME/assinatura/tamanho validados e retorno de candidatos sem persistência automática.
- **Scheduler:** collection-only e desabilitado no runtime de produção.

Não use credenciais reais, documentos financeiros reais ou screenshots autenticados como fixtures de CI.

## Deploy

O backend possui Dockerfile/Render configuration; o mobile possui configuração Expo/EAS. Provisionamento externo, credenciais e builds remotos devem ser configurados pelo operador. O CI valida o que pode ser reproduzido sem depender de credenciais de produção.

## Limitações atuais

- Portais externos não são garantidos nem gates de CI.
- Os adapters experimentais podem deixar de funcionar quando interfaces externas mudarem.
- Findings npm residuais de tooling/Expo permanecem visíveis quando não existe caminho compatível seguro; não são ocultados com `--force`/allowlist apenas para obter CI verde.
- O ledger server-side de idempotência ainda não possui cleanup automático; registros precisam durar no mínimo todo o período em que uma operação mobile pendente possa ser retomada.
- Enquanto uma operação mobile permanece indeterminada, uma nova submissão logicamente equivalente é tratada conservadoramente como retry da pending intent e reutiliza o payload original. Após conclusão/rejeição definitiva, os mesmos valores podem iniciar nova intenção com nova key.
- Não existe hoje retirada/decremento de reserva no produto; se essa mutação for adicionada, deverá adotar o mesmo boundary durável antes de ser exposta.
- Assets e builds nativos remotos dependem de infraestrutura/credenciais externas quando aplicável.

---

# English

## Overview

**FinanceFlow** is a mobile personal-finance application backed by FastAPI. It covers one-time and recurring bills, income, payments, private receipts, local notifications, per-user offline state, and AI-assisted OCR/financial insights.

The production architecture uses **Supabase Auth** for identity, PostgreSQL/RLS for user isolation, and private Storage for receipt documents. Authoritative money logic uses exact decimal semantics.

## Capability status

### Production

- FastAPI API protected by Supabase-session Bearer authentication.
- Per-user ownership/RLS for financial tables.
- Ordinary bill creation, income creation, reserve addition, and recurring-template creation protected by a durable PostgreSQL `Idempotency-Key` protocol.
- Generated recurring children protected separately by `(parent_bill_id, due_date)` database uniqueness.
- Income, balances, reserves and projections using exact decimal-money rules.
- Receipt and receipt-less payment flows.
- Receipt-backed payment reconciles ambiguous database outcomes before storage cleanup; a transport exception is not treated as proof of rollback.
- Receipts stored in a **private** bucket and exposed only through short-lived authorized signed access.
- OCR with structured output plus local validation before extracted data is trusted.
- Unreadable/low-confidence OCR requires manual review instead of automatic persistence.
- Mobile secure session persistence, refresh/logout and owner-scoped offline financial cache.
- Pending financial mutations persist both the `Idempotency-Key` and original payload in owner-scoped secure storage across timeout, lost response, reconnect, restart and midnight rollover.
- Financial mutation preparation uses one coherent authenticated-session snapshot (token + owner + generation) and fails closed on account change before transport.
- Financial date-only values use the `America/Sao_Paulo` IANA calendar rather than UTC slicing or the device-local timezone.
- Local due-date notifications.
- Expo SDK 57 / React Native 0.86 with TypeScript, Expo Doctor and web-export smoke checks.

### Experimental and disabled by default

DASMEI, TIM, Unopar and IMAP/PDF adapters remain portfolio/educational integrations for mutable third-party interfaces. They are **not part of the production runtime** and require explicit opt-in.

Their fail-closed policy is intentional:

- no CAPTCHA, human-verification, anti-fraud, paywall or access-control evasion;
- no stealth plugins, forged fingerprints or randomized “human” interaction used to conceal automation;
- human-verification states return blocked/unavailable outcomes;
- financial candidates require structured amount/date/barcode validation;
- no fabricated money/date/barcode fallback is accepted as success;
- authenticated screenshots/documents are not persisted by default;
- external errors are sanitized;
- IMAP collection is narrowed and non-destructive, with deterministic source IDs;
- the experimental scheduler collects candidates only and does not persist financial records.

External sites can change without notice. Explicit failure/degradation is preferred over increasingly aggressive browser automation.

## Architecture

### Backend

- **FastAPI** — API/domain validation.
- **Supabase Auth** — end-user identity.
- **PostgreSQL / Supabase** — financial persistence, RLS, and transactional idempotency ledger.
- **Supabase Storage** — private receipts.
- **Google GenAI** — OCR/insight provider; critical tests use deterministic providers.
- **Docker** — production image validated by CI.

### Mobile

- **React Native + Expo SDK 57**.
- Supabase session lifecycle and dynamic API Bearer token.
- Owner-scoped financial cache for offline operation.
- Owner-scoped pending financial mutations in `SecureStore`, preserving one logical identity (`Idempotency-Key` + original payload) while the outcome is indeterminate.
- Coherent session snapshot for financial request preparation, preventing cross-account owner/token mixtures.
- Canonical `America/Sao_Paulo` financial date helper, explicitly separated from real UTC timestamps.
- Expo Notifications for local reminders.
- EAS Build/Update when external credentials/infrastructure are configured.

## Security and correctness invariants

- User A must never read or mutate User B resources.
- Service-role credentials never belong in the mobile client.
- Database authorization is enforced through ownership/RLS.
- Authoritative money calculations avoid binary float.
- For `POST /add-bill`, `POST /incomes`, `POST /insights/reserve`, and `POST /recurring-bills`, durable server replay identity is `auth.uid() + operation type + Idempotency-Key`.
- PostgreSQL derives the canonical fingerprint from its mutation parameters; callers do not supply a trusted fingerprint or owner id.
- For those four operations, key claim, financial effect, and durable replay result share one PostgreSQL transaction.
- Same key + same logical payload replays the durable result without another effect; same key + different payload fails closed.
- A new key represents a new explicit operation after the prior intent has a definitive outcome, even if business values equal a previous operation.
- While an intent is indeterminate, mobile persists its key **and complete original payload before transport** and replays both after timeout/network/5xx/reconnect/restart/background/foreground. Derived fields are not silently rebuilt for transport retry.
- Local logical identity is not merely `owner + operation + canonicalPayload` recomputed at retry time. An income retry crossing midnight reuses the same pending key and original date.
- Pending-store read/modify/write is serialized per owner + operation so two different concurrent intents cannot erase one another through last-writer-wins storage races.
- Pending financial payload is private state: it is owner-scoped in `SecureStore`, and the legacy AsyncStorage representation is migrated/removed. Another account cannot inherit or reuse the previous account's key/payload.
- Financial mutation preparation captures token + owner + session generation from one coherent snapshot. If the session changes before transport, preparation fails closed.
- The product financial calendar is `America/Sao_Paulo`. DATE-only `YYYY-MM-DD` values must not be derived by slicing UTC timestamps (`toISOString().split('T')[0]`, `toISOString().slice(0,10)`, UTC getters, or equivalent).
- `toISOString()` remains valid when the domain requires an actual UTC timestamp/instant; the restriction is specific to financial DATE-only semantics.
- User-selected calendar dates are serialized from their calendar components rather than round-tripping through UTC.
- The current product exposes reserve **addition only**; no reserve-withdrawal/decrement endpoint exists. Any future decrement must adopt the same durable protocol before exposure.
- Generated recurring instances use a separate database uniqueness boundary under retries/concurrency.
- Uploads are bounded and validated from actual content, not filename/MIME alone.
- Receipts do not have permanent public URLs.
- Receipt cleanup occurs only after authoritative state proves the uploaded object is unreferenced.
- OCR output is untrusted until locally schema-validated.
- CI does not depend on live Gemini calls or real third-party portals.

See [`backend/FINANCIAL_RULES.md`](backend/FINANCIAL_RULES.md) for the detailed domain contract.

## Development

### Requirements

- Python **3.12**.
- Node.js **22.13+** for the current mobile baseline.
- PostgreSQL/Supabase for integrated development.

### Backend

```bash
cd backend
python -m venv venv
# Linux/macOS: source venv/bin/activate
# Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn runtime:create_app --factory --reload
```

Use `backend/.env.example`. Secrets and service-role credentials remain server-side only.

### Mobile

```bash
cd mobile
npm ci
npx expo start
```

Use `mobile/.env.example`. Only public client configuration belongs in the app bundle; never ship a service-role key.

## Tests and quality gates

Repository workflows cover, as applicable:

- backend pytest/Python compilation;
- `pip check` and `pip-audit`;
- disposable PostgreSQL recurring/generated-child and ownership/RLS checks;
- dedicated PostgreSQL 16 replay, ambiguous-response equivalent, payload-mismatch, owner-isolation and same-key concurrency proof for all four durable financial mutations;
- mobile TypeScript;
- mobile auth/cache/logical-intent/pending-operation lifecycle contracts;
- deterministic regressions for income retry across midnight, two different concurrent pending operations, restart and account switch;
- `America/Sao_Paulo` financial date-only contract covering UTC-next-day windows, local midnight, month/year rollover and an anti-regression guard against UTC slicing in financial paths;
- backend financial-impact regression proving an initial-balance boundary shift from D to D+1 changes same-day income/payment inclusion;
- Expo Doctor/config/web-export smoke;
- backend container build;
- npm audit evidence;
- Gitleaks secret scanning.

Backend locally:

```bash
cd backend
pytest -q
```

The PostgreSQL idempotency probe can be run against a disposable database compatible with the CI fixture:

```bash
bash backend/financial_idempotency_probe.sh
```

Mobile locally:

```bash
cd mobile
npm ci
npx tsc --noEmit
npx expo-doctor
```

## Experimental integrations

`ENABLE_EXPERIMENTAL_INTEGRATIONS` is disabled by default. Enabling it does not make the adapters production-supported and never authorizes bypassing external controls.

- **DASMEI:** ordinary Playwright behavior; stops on human verification or incompatible UI.
- **TIM:** semantic selectors where available; unsupported Canvas-only states fail closed instead of using guessed screen coordinates.
- **Unopar:** collection only when ordinary, verifiable navigation is possible.
- **IMAP/PDF:** explicit allowlist, `BODY.PEEK`, validated PDF MIME/signature/size, and candidate collection without automatic persistence.
- **Scheduler:** collection-only and not started by the production runtime.

Never use real financial documents, authenticated screenshots or production credentials as CI fixtures.

## Deployment

The backend includes Docker/Render configuration and the mobile app includes Expo/EAS configuration. External credentials and remote native builds are operator-managed. CI validates what can be reproduced without production credentials.

## Current limitations

- Third-party portals are not availability guarantees or CI gates.
- Experimental adapters can break when external interfaces change.
- Residual npm findings remain visible when the upstream Expo/tooling graph has no compatible safe upgrade path; they are not hidden with forced downgrades or blanket allowlists.
- The server idempotency ledger has no automatic cleanup yet; records must outlive the entire supported mobile pending-operation retry window.
- While a mobile operation remains indeterminate, a logically equivalent submission is conservatively treated as a retry of that pending intent and reuses its original payload. After definitive completion/rejection, equal business values can start a new intent with a new key.
- Reserve withdrawal/decrement is not currently a product endpoint; any future mutation of that class must use the durable protocol before exposure.
- Remote native builds and external deployment still depend on operator credentials/infrastructure where applicable.

## License

See [LICENSE.md](./LICENSE.md).

---

Developed by **Gyliardson Keitison**  
[GitHub](https://github.com/Gyliardson) | [LinkedIn](https://www.linkedin.com/in/gyliardson-keitison)
