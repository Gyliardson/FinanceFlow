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

---

**[Português (BR)](#português) | [English](#english)**

---

# Português

## Sobre o Projeto

O **FinanceFlow** é um sistema completo de gestão de contas a pagar, desenvolvido como aplicativo Android nativo com backend em nuvem. Ele permite ao usuário cadastrar contas avulsas e recorrentes, registrar receitas, acompanhar pagamentos com upload de comprovantes, receber notificações inteligentes e consultar insights financeiros gerados por Inteligência Artificial (Google Gemini).

O sistema também inclui módulos educacionais de Web Scraping (inativos em produção) que demonstram como automatizar a captura de boletos em diferentes arquiteturas web.

## Arquitetura

O sistema é dividido em duas frentes que se comunicam via API REST:

**Backend (Python / FastAPI)**
- API REST completa com endpoints para faturas, pagamentos, receitas, configurações e insights.
- Integração com Google Gemini para OCR de comprovantes e geração de análises financeiras.
- Supabase como banco de dados (PostgreSQL) e Storage para comprovantes.
- Deploy automatizado via Docker no Render.

**Mobile (React Native / Expo)**
- Aplicativo Android nativo com 7 telas dedicadas.
- Sistema de notificações push locais com mensagens progressivas antes do vencimento.
- Modo offline com cache local e indicador de status de rede.
- Atualizações OTA (Over-the-Air) via Expo EAS Update com GitHub Actions.

## Funcionalidades

### Gestão de Contas
- **Contas Avulsas:** Cadastro manual ou via OCR de faturas únicas.
- **Contas Recorrentes:** Templates mensais com geração automática de instâncias. O sistema calcula o próximo vencimento e evita criar faturas vencidas no momento do cadastro.
- **Histórico Detalhado:** Tela de detalhes com relacionamento automático entre faturas (por template ou descrição similar).

### Pagamentos
- **Pagamento com Comprovante:** Upload de imagem/PDF para o Supabase Storage com URL pública vinculada à fatura.
- **Pagamento Rápido:** Opção de marcar como pago sem anexar comprovante.
- **Validação via IA:** Motor de OCR (Google Gemini) que extrai valor, data e código de barras de documentos, com validação heurística cruzada (score de confiança).

### Financeiro
- **Controle de Receitas:** Cadastro de entradas (Salário, Extra, Ajuste Manual) com histórico completo.
- **Saldo Dinâmico:** Cálculo automático do saldo atual considerando receitas, pagamentos e reserva de emergência.
- **Sobra Estimada:** Projeção mensal que subtrai as contas pendentes do saldo disponível.

### Inteligência Artificial
- **Insights Financeiros:** Análise mensal gerada pelo Google Gemini com recomendações personalizadas sobre reserva de emergência e investimentos (CDB).
- **Cache Inteligente:** Insights são gerados uma vez por mês e armazenados no banco para evitar consumo desnecessário de API.
- **Atualização Manual:** Botão para forçar nova análise quando houver mudanças significativas.

### Reserva de Emergência
- **Meta Configurável:** O usuário define um objetivo financeiro para a reserva.
- **Alocação Incremental:** Possibilidade de guardar valores parciais a qualquer momento.
- **Barra de Progresso:** Visualização do percentual atingido em relação à meta.

### Notificações
- **Lembretes Antecipados:** Notificações automáticas T-3, T-2 e T-1 dias antes do vencimento (9h).
- **Alertas no Dia:** Três notificações progressivas no dia do vencimento (9h, 14h, 20h) com tom crescente de urgência.
- **Cancelamento Automático:** Ao registrar um pagamento, as notificações pendentes daquela fatura são canceladas.

### Resiliência
- **Modo Offline:** Cache local com AsyncStorage que exibe os últimos dados carregados quando não há conexão.
- **Indicador de Rede:** Banner visual informando o usuário quando está operando em modo offline, com botão para tentar reconectar.
- **Validação Rigorosa:** Limites de caracteres e valores enforced tanto no frontend quanto no backend (Pydantic).

### Módulos de Scraping (Educacionais)

O repositório inclui **4 exemplos práticos** de scrapers/coletores para demonstrar como automatizar a captura de faturas em diferentes cenários. **Estes módulos foram desenvolvidos com fins educacionais e de portfólio.** Quem clonar o projeto é encorajado a modificar ou criar novos scrapers conforme suas necessidades.

> [!WARNING]
> **Aviso sobre Hospedagem e Playwright:** Os scrapers baseados em navegador (TIM, DASMEI, Unopar) utilizam Playwright com `pyvirtualdisplay` para burlar bloqueios antibot. Isso exige infraestrutura com no mínimo 1GB a 2GB de RAM. Hospedagens na camada gratuita (como Render com 512MB) sofrerão Out of Memory. Esses módulos estão inativos no deploy de produção, mas são totalmente funcionais em ambientes com recursos adequados.

1. **DASMEI (Site Governamental):** Scraper que acessa o portal do Simples Nacional usando apenas CNPJ público, com navegação headless via Playwright.
2. **TIM Móvel (Portal Canvas/Flutter):** Automação completa para o Meu TIM usando `playwright-stealth`. Lida com logins, contorna banners e valida faturas via OCR da tela, superando os desafios do CanvasKit que oculta elementos do DOM.
3. **Unopar (Portal do Aluno):** Bot com navegação condicional para a área financeira. Busca boletos com desconto de pontualidade e copia automaticamente a chave "Pix Copia e Cola".
4. **IMAP / Email (Faturas PDF):** Módulo que acessa o provedor de e-mail via protocolo IMAP. Monitora mensagens com faturas em PDF, descriptografa PDFs protegidos por senha e extrai dados via OCR Gemini.

## Como Rodar

### Pré-requisitos

- [Python 3.10+](https://www.python.org/)
- [Node.js 20+](https://nodejs.org/)
- [Expo CLI](https://expo.dev/)
- Conta no [Supabase](https://supabase.com/)
- Chave de API do [Google Gemini](https://ai.google.dev/)

### Configuração do Ambiente

**1. Clone o repositório:**

```bash
git clone https://github.com/Gyliardson/FinanceFlow.git
cd FinanceFlow
```

**2. Banco de Dados (Supabase):**

Crie um projeto no Supabase e execute o script `backend/supabase_schema.sql` no SQL Editor para criar as tabelas e permissões.

**3. Backend:**

```bash
cd backend
python -m venv venv

# Windows:
venv\Scripts\activate
# Linux / macOS:
# source venv/bin/activate

pip install -r requirements.txt
```

Crie o arquivo `.env` na pasta `backend/` baseado no `.env.example`:

```env
SUPABASE_URL="sua-url-aqui"
SUPABASE_KEY="sua-chave-aqui"
SUPABASE_SERVICE_ROLE_KEY="sua-service-role-key"
GEMINI_API_KEY="sua-chave-gemini-aqui"
```

**4. Mobile:**

```bash
cd mobile
npm install
```

Crie o arquivo `.env` na pasta `mobile/` baseado no `.env.example`:

```env
EXPO_PUBLIC_API_URL="http://192.168.1.X:8000"
```

### Executando o Projeto

**Backend:**

```bash
cd backend
venv\Scripts\activate
uvicorn main:app --reload
```

**Mobile:**

```bash
cd mobile
npx expo start
```

## Guia de Deploy (v1.00)

Este projeto está configurado para deploy automatizado via GitHub.

### 1. Backend (Render)

O backend utiliza **Docker** para garantir consistência.

1. Crie um **Web Service** no [Dashboard do Render](https://dashboard.render.com).
2. Conecte este repositório do GitHub.
3. Configure o **Root Directory** para `backend`.
4. O Render detectará o `Dockerfile` automaticamente.
5. Adicione as **Environment Variables** no painel:
   - `ENVIRONMENT`: `production`
   - `PORT`: `8000`
   - `SUPABASE_URL`: (Seu URL do Supabase)
   - `SUPABASE_KEY`: (Sua Service Role Key)
   - `GOOGLE_API_KEY`: (Sua chave do Gemini)

> [!TIP]
> Este repositório inclui um arquivo `render.yaml` para deploy via Infrastructure-as-Code. O Render pode provisionar o serviço automaticamente a partir deste arquivo.

### 2. Frontend (Expo EAS)

O frontend utiliza **EAS Build/Update** com GitHub Actions para atualizações OTA.

1. Instale o EAS CLI: `npm install -g eas-cli`
2. Rode `eas login` e `eas build:configure` na pasta `mobile`.
3. Obtenha seu **EXPO_TOKEN** no painel da Expo.
4. No GitHub: Vá em **Settings > Secrets and variables > Actions** e adicione:
   - `EXPO_TOKEN`: (Seu token da Expo)
5. Ao dar `push` na branch `main` (com mudanças em `mobile/`), o GitHub Actions disparará um **EAS Update** automaticamente para todos os APKs instalados.

> [!TIP]
> Para gerar o APK inicial, rode: `eas build --platform android --profile production`

---

# English

## About the Project

**FinanceFlow** is a full-stack bill management system, built as a native Android application with a cloud-hosted backend. It allows the user to register one-time and recurring bills, track income, manage payments with receipt uploads, receive smart push notifications, and consult AI-powered financial insights generated by Google Gemini.

The system also includes educational Web Scraping modules (inactive in production) that demonstrate how to automate invoice capture across different web architectures.

## Architecture

The system is split into two main components that communicate via REST API:

**Backend (Python / FastAPI)**
- Full REST API with endpoints for bills, payments, incomes, settings, and insights.
- Google Gemini integration for receipt OCR and financial analysis generation.
- Supabase as the database (PostgreSQL) and Storage for receipt files.
- Automated deployment via Docker on Render.

**Mobile (React Native / Expo)**
- Native Android application with 7 dedicated screens.
- Local push notification system with progressive messages before due dates.
- Offline mode with local cache and network status indicator.
- OTA (Over-the-Air) updates via Expo EAS Update with GitHub Actions.

## Features

### Bill Management
- **One-time Bills:** Manual registration or OCR-assisted creation of individual invoices.
- **Recurring Bills:** Monthly templates with automatic instance generation. The system calculates the next due date and avoids creating overdue bills at registration time.
- **Detailed History:** Detail screen with automatic bill relationship tracking (by template or similar description).

### Payments
- **Payment with Receipt:** Image/PDF upload to Supabase Storage with a public URL linked to the bill.
- **Quick Payment:** Option to mark as paid without attaching a receipt.
- **AI Validation:** OCR engine (Google Gemini) that extracts amount, date, and barcode from documents, with cross-referencing heuristic validation (confidence score).

### Financial
- **Income Tracking:** Register entries (Salary, Extra, Manual Adjustment) with full history.
- **Dynamic Balance:** Automatic balance calculation considering income, payments, and emergency fund reserves.
- **Estimated Surplus:** Monthly projection subtracting pending bills from available balance.

### Artificial Intelligence
- **Financial Insights:** Monthly AI-generated analysis by Google Gemini with personalized recommendations on emergency reserves and investments (CDB).
- **Smart Caching:** Insights are generated once per month and stored in the database to avoid unnecessary API consumption.
- **Manual Refresh:** Button to force a new analysis when significant changes occur.

### Emergency Fund
- **Configurable Goal:** The user defines a financial target for the reserve.
- **Incremental Allocation:** Ability to save partial amounts at any time.
- **Progress Bar:** Visualization of the percentage achieved relative to the goal.

### Notifications
- **Early Reminders:** Automatic notifications T-3, T-2, and T-1 days before the due date (9 AM).
- **Due-Day Alerts:** Three progressive notifications on the due date (9 AM, 2 PM, 8 PM) with increasing urgency.
- **Automatic Cancellation:** When a payment is registered, all pending notifications for that bill are cancelled.

### Resilience
- **Offline Mode:** Local cache with AsyncStorage that displays the last loaded data when there is no connection.
- **Network Indicator:** Visual banner informing the user when operating in offline mode, with a retry button to reconnect.
- **Strict Validation:** Character and value limits enforced on both frontend and backend (Pydantic).

### Scraping Modules (Educational)

The repository includes **4 practical examples** of scrapers/collectors to demonstrate how to automate invoice capture in different scenarios. **These modules were developed for educational and portfolio purposes.** Anyone cloning the project is encouraged to modify or create new scrapers according to their needs.

> [!WARNING]
> **Hosting and Playwright Notice:** Browser-based scrapers (TIM, DASMEI, Unopar) use Playwright with `pyvirtualdisplay` to bypass antibot protections. This requires infrastructure with at least 1GB to 2GB of RAM. Free-tier hosting (such as Render with 512MB) will suffer Out of Memory errors. These modules are inactive in production deploy but fully functional in environments with adequate resources.

1. **DASMEI (Government Portal):** Scraper that accesses the Simples Nacional portal using only a public CNPJ, with headless navigation via Playwright.
2. **TIM Mobile (Canvas/Flutter Portal):** Full automation for Meu TIM using `playwright-stealth`. Handles logins, bypasses banners, and validates invoices via screen OCR, overcoming CanvasKit challenges that hide DOM elements.
3. **Unopar (Student Portal):** Bot with conditional navigation to the financial area. Searches for early-payment discount boletos and automatically copies the "Pix Copy and Paste" key.
4. **IMAP / Email (PDF Invoices):** Module that accesses the email provider via IMAP protocol. Monitors messages containing PDF invoices, decrypts password-protected PDFs, and extracts data via Gemini OCR.

## How to Run

### Prerequisites

- [Python 3.10+](https://www.python.org/)
- [Node.js 20+](https://nodejs.org/)
- [Expo CLI](https://expo.dev/)
- [Supabase](https://supabase.com/) Account
- [Google Gemini](https://ai.google.dev/) API Key

### Environment Setup

**1. Clone the repository:**

```bash
git clone https://github.com/Gyliardson/FinanceFlow.git
cd FinanceFlow
```

**2. Database (Supabase):**

Create a project on Supabase, then run the script `backend/supabase_schema.sql` in the SQL Editor to create all tables and permissions.

**3. Backend:**

```bash
cd backend
python -m venv venv

# Windows:
venv\Scripts\activate
# Linux / macOS:
# source venv/bin/activate

pip install -r requirements.txt
```

Create the `.env` file in `backend/` based on `.env.example`:

```env
SUPABASE_URL="your-supabase-url"
SUPABASE_KEY="your-supabase-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
GEMINI_API_KEY="your-gemini-api-key"
```

**4. Mobile:**

```bash
cd mobile
npm install
```

Create the `.env` file in `mobile/` based on `.env.example`:

```env
EXPO_PUBLIC_API_URL="http://192.168.1.X:8000"
```

### Running the Project

**Backend:**

```bash
cd backend
venv\Scripts\activate
uvicorn main:app --reload
```

**Mobile:**

```bash
cd mobile
npx expo start
```

## Deploy Guide (v1.00)

This project is configured for automated deployment via GitHub.

### 1. Backend (Render)

The backend uses **Docker** for consistent deployments.

1. Create a **Web Service** on the [Render Dashboard](https://dashboard.render.com).
2. Connect this GitHub repository.
3. Set the **Root Directory** to `backend`.
4. Render will auto-detect the `Dockerfile`.
5. Add the **Environment Variables**:
   - `ENVIRONMENT`: `production`
   - `PORT`: `8000`
   - `SUPABASE_URL`: (Your Supabase URL)
   - `SUPABASE_KEY`: (Your Service Role Key)
   - `GOOGLE_API_KEY`: (Your Gemini API Key)

> [!TIP]
> This repository includes a `render.yaml` file for Infrastructure-as-Code deployment. Render can auto-provision the service directly from this file.

### 2. Frontend (Expo EAS)

The frontend uses **EAS Build/Update** with GitHub Actions for OTA updates.

1. Install EAS CLI: `npm install -g eas-cli`
2. Run `eas login` and `eas build:configure` inside the `mobile` folder.
3. Get your **EXPO_TOKEN** from the Expo dashboard.
4. On GitHub: Go to **Settings > Secrets and variables > Actions** and add:
   - `EXPO_TOKEN`: (Your Expo token)
5. On every `push` to the `main` branch (with changes in `mobile/`), GitHub Actions will trigger an **EAS Update** to all installed APKs.

> [!TIP]
> To generate the initial APK, run: `eas build --platform android --profile production`

---

## Project Structure | Estrutura do Projeto

```
FinanceFlow/
|-- backend/
|   |-- main.py                 # FastAPI application (all routes)
|   |-- ai_service.py           # Google Gemini integration (OCR + Insights)
|   |-- database.py             # Supabase client configuration
|   |-- scheduler.py            # Automated scraping scheduler (inactive)
|   |-- supabase_schema.sql     # Database schema (PostgreSQL)
|   |-- Dockerfile              # Production container
|   |-- requirements.txt        # Python dependencies
|   |-- .env.example            # Environment variables template
|   |-- *_scraper.py            # Educational scraping modules (4 modules)
|   +-- migrations/             # Database migration scripts
|
|-- mobile/
|   +-- src/
|       |-- screens/
|       |   |-- HomeScreen.tsx          # Main dashboard with tabs and filters
|       |   |-- DetailScreen.tsx        # New bill creation with OCR
|       |   |-- RecurringBillScreen.tsx  # Recurring bill template creation
|       |   |-- PaymentScreen.tsx       # Payment with receipt upload
|       |   |-- BillHistoryScreen.tsx   # Bill details and payment history
|       |   |-- IncomeScreen.tsx        # Income management
|       |   +-- InsightsScreen.tsx      # AI insights and emergency fund
|       |-- components/
|       |   +-- NetworkStatus.tsx       # Offline mode indicator
|       |-- services/
|       |   |-- api.ts                  # Axios HTTP client
|       |   +-- NotificationService.ts  # Push notification scheduling
|       +-- navigation/
|           +-- AppNavigator.tsx        # Stack navigation setup
|
|-- .github/workflows/
|   +-- deploy-frontend.yml    # GitHub Actions (EAS Update)
|
|-- assets/                    # Banner and branding assets
|-- render.yaml                # Render IaC deployment config
|-- LICENSE                    # FinanceFlow Public License v1.00
+-- README.md
```

## API Endpoints

| Method | Route | Description | Descrição |
|--------|-------|-------------|-----------|
| `GET` | `/health` | Health check | Verificação de saúde |
| `GET` | `/bills` | List all bills | Listar todas as faturas |
| `GET` | `/bills/pending` | List pending bills | Listar faturas pendentes |
| `POST` | `/add-bill` | Create a new bill | Cadastrar nova fatura |
| `GET` | `/bills/{id}/detail` | Bill detail + history | Detalhes e histórico |
| `POST` | `/bills/{id}/pay` | Pay with receipt | Pagar com comprovante |
| `POST` | `/bills/{id}/pay-no-receipt` | Pay without receipt | Pagar sem comprovante |
| `GET` | `/recurring-bills` | List recurring templates | Listar templates recorrentes |
| `POST` | `/recurring-bills` | Create recurring template | Criar template recorrente |
| `POST` | `/recurring-bills/generate` | Generate monthly instances | Gerar instâncias mensais |
| `GET` | `/incomes` | List all incomes | Listar receitas |
| `POST` | `/incomes` | Register new income | Registrar nova receita |
| `GET` | `/settings` | Get user settings | Obter configurações |
| `POST` | `/settings` | Update user settings | Atualizar configurações |
| `GET` | `/insights` | Get AI financial insight | Obter insight (IA) |
| `POST` | `/insights/refresh` | Force new AI analysis | Forçar nova análise (IA) |
| `POST` | `/insights/reserve` | Add to emergency fund | Adicionar à reserva |
| `POST` | `/upload-receipt` | OCR document processing | Processar documento (OCR) |
| `POST` | `/validate-bill` | Heuristic bill validation | Validação heurística |

---

## Segurança | Security

Este repositório utiliza uma camada de **Segurança Estática (API Key)**. Todas as requisições entre o aplicativo e o servidor são validadas através de um header `X-API-KEY`. Esta chave é injetada automaticamente durante o build de produção via **EAS Secrets** e **GitHub Secrets**, garantindo que as credenciais nunca fiquem expostas no código público.

Este repositório está configurado para **não versionar** informações sensíveis. Arquivos como `.env` e diretórios de build/dependências (`node_modules`, `venv`) estão protegidos pelo `.gitignore`. Sempre utilize os arquivos `.env.example` como referência para configurar seu ambiente local.

This repository uses a **Static Security Layer (API Key)**. All requests between the app and the server are validated via an `X-API-KEY` header. This key is automatically injected during production builds via **EAS Secrets** and **GitHub Secrets**, ensuring credentials are never exposed in public code.

This repository is configured to **never version-control** sensitive data. Files such as `.env` and build/dependency directories (`node_modules`, `venv`) are protected by `.gitignore`. Always use the `.env.example` files as a reference to configure your local environment.

## Licença | License

Este projeto é licenciado sob a **FinanceFlow Public License - v1.00**.

This project is licensed under the **FinanceFlow Public License - v1.00**.

- **Uso Pessoal / Personal Use:** Totalmente livre para estudo e uso próprio. Atribuição é apreciada, mas opcional. / Entirely free for study and personal use. Attribution is appreciated but optional.
- **Uso Comercial / Commercial Use:** Permitido, desde que a **atribuição de créditos ao autor seja mantida** de forma visível. / Allowed, provided that **credit attribution to the author is maintained** visibly.
- **Isenção / Disclaimer:** O software é fornecido "como está". O autor não se responsabiliza por perdas ou danos. / The software is provided "as is". The author is not liable for losses or damages.

Para os termos completos em Português, Inglês ou Espanhol, acesse o arquivo [LICENSE](./LICENSE.md).

For the full terms in Portuguese, English, or Spanish, see the [LICENSE](./LICENSE.md) file.

---

Desenvolvido por / Developed by **Gyliardson Keitison**
[GitHub](https://github.com/Gyliardson) | [LinkedIn](https://www.linkedin.com/in/gyliardson-keitison)
