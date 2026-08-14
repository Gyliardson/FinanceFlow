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
- Contas avulsas e recorrentes com proteção de idempotência no PostgreSQL.
- Receitas, saldo, reserva e projeções usando regras de dinheiro decimal exato.
- Pagamento com ou sem comprovante.
- Comprovantes em bucket **privado**, identificados por object path opaco e acessados por URL assinada temporária após autorização.
- OCR de documentos com structured output e validação local antes de qualquer confiança nos dados extraídos.
- Casos de OCR ilegível/baixa confiança exigem revisão manual em vez de persistência automática.
- Sessão mobile persistida em armazenamento seguro, refresh/logout e cache financeiro isolado por usuário.
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
- **PostgreSQL / Supabase** — persistência financeira e RLS.
- **Supabase Storage** — comprovantes privados.
- **Google GenAI** — provider de OCR/insights; testes críticos usam providers determinísticos.
- **Docker** — imagem de produção validada em CI.

### Mobile

- **React Native + Expo SDK 57**.
- Sessão Supabase com Bearer dinâmico para a API.
- Cache financeiro owner-scoped para modo offline.
- Expo Notifications para lembretes locais.
- EAS Update/Build para distribuição mobile quando credenciais externas estiverem configuradas.

## Regras de segurança e correção

- Usuário A não deve ler ou alterar recursos do Usuário B.
- Service-role não é distribuída ao cliente mobile.
- `owner_id`/RLS são boundaries de autorização no banco.
- Dinheiro não usa binary float em cálculos autoritativos.
- Instâncias recorrentes possuem garantia de unicidade no banco para retries/concurrency.
- Uploads são limitados e validados por conteúdo real, não somente pelo filename/MIME declarado.
- Comprovantes não possuem URL pública permanente.
- OCR é sugestão: structured output é revalidado localmente antes de uso.
- CI não depende de Gemini real nem de portais externos reais.

## Desenvolvimento

### Requisitos

- Python 3.10+.
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
- PostgreSQL real para recurring/idempotency e ownership/RLS;
- mobile TypeScript;
- contrato de autenticação/cache mobile;
- Expo Doctor/config/export smoke;
- build do container backend;
- npm audit com evidência preservada;
- Gitleaks/secret scan.

Para desenvolvimento local do backend:

```bash
cd backend
pytest -q
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
- One-time and recurring bills with PostgreSQL idempotency guarantees.
- Income, balances, reserves and projections using exact decimal-money rules.
- Receipt and receipt-less payment flows.
- Receipts stored in a **private** bucket and exposed only through short-lived authorized signed access.
- OCR with structured output plus local validation before extracted data is trusted.
- Unreadable/low-confidence OCR requires manual review instead of automatic persistence.
- Mobile secure session persistence, refresh/logout and owner-scoped offline financial cache.
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
- **PostgreSQL / Supabase** — financial persistence and RLS.
- **Supabase Storage** — private receipts.
- **Google GenAI** — OCR/insight provider; critical tests use deterministic providers.
- **Docker** — production image validated by CI.

### Mobile

- **React Native + Expo SDK 57**.
- Supabase session lifecycle and dynamic API Bearer token.
- Owner-scoped financial cache for offline operation.
- Expo Notifications for local reminders.
- EAS Build/Update when external credentials/infrastructure are configured.

## Security and correctness invariants

- User A must never read or mutate User B resources.
- Service-role credentials never belong in the mobile client.
- Database authorization is enforced through ownership/RLS.
- Authoritative money calculations avoid binary float.
- Recurring instances are protected by a database uniqueness boundary under retries/concurrency.
- Uploads are bounded and validated from actual content, not filename/MIME alone.
- Receipts do not have permanent public URLs.
- OCR output is untrusted until locally schema-validated.
- CI does not depend on live Gemini calls or real third-party portals.

## Development

### Requirements

- Python 3.10+.
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
- disposable PostgreSQL recurring/idempotency and ownership/RLS checks;
- mobile TypeScript;
- mobile auth/cache contract;
- Expo Doctor/config/web-export smoke;
- backend container build;
- npm audit evidence;
- Gitleaks secret scanning.

Backend locally:

```bash
cd backend
pytest -q
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
- Remote native builds and external deployment still depend on operator credentials/infrastructure where applicable.

## License

See [LICENSE.md](./LICENSE.md).

---

Developed by **Gyliardson Keitison**  
[GitHub](https://github.com/Gyliardson) | [LinkedIn](https://www.linkedin.com/in/gyliardson-keitison)
