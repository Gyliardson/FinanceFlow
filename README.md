# FinanceFlow

> **Automação de Boletos e Notificações**

![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=for-the-badge&logo=fastapi)
![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)
![React Native](https://img.shields.io/badge/React_Native-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)
![Gemini](https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=google-gemini&logoColor=white)

## Sobre o Projeto

O **FinanceFlow** é um sistema completo desenvolvido para simplificar e automatizar a gestão de contas a pagar. Ele realiza a busca automática de boletos via web scraping, notifica o usuário diretamente no celular (Android) e permite a validação de pagamentos usando inteligência artificial (OCR) através do compartilhamento de comprovantes ou extratos bancários.

## Arquitetura

O sistema é dividido em duas partes principais que se comunicam via API REST:

1. **Backend (Python/FastAPI):**
   - Responsável por rodar rotinas de Web Scraping utilizando o Playwright para buscar boletos nas concessionárias/sistemas.
   - Integração com a API do Google Gemini para processar imagens e PDFs, extraindo dados como valores, datas de vencimento e linha digitável.
   - Comunica-se com o Supabase para armazenar dados (PostgreSQL) e arquivos (Storage).
   - Envia requisições de notificação Push para o aplicativo mobile.

2. **Mobile (React Native/Expo):**
   - Interface do usuário (App Android Nativo).
   - Exibe as faturas pendentes, histórico de pagamentos e recebe notificações push.
   - Permite ao usuário anexar comprovantes de pagamento, os quais são enviados ao backend para validação via IA.

## Funcionalidades

- **Scraping Automático:** Busca proativa de boletos nos sites sem intervenção do usuário.
- **Notificações Nativas:** Alertas push no Android para novos boletos e faturas próximas do vencimento.
- **Validação via IA:** Extração de dados (OCR) usando Google Gemini para automatizar a baixa de faturas pagas a partir do upload de comprovantes ou extratos.
- **Gestão Segura:** Arquitetura que não expõe dados sensíveis.

### Exemplos de Módulos de Scraping Educacionais
O repositório inclui **4 exemplos práticos** de Scrapers/Coletores para demonstrar como o sistema pode lidar com diferentes arquiteturas web e regras de negócios na hora de capturar faturas. **Estes exemplos foram desenvolvidos com fins educacionais e de demonstração do portfólio.** Quem realizar o clone/fork do projeto é encorajado a modificar, remover, ou criar novos scrapers que atendam às suas preferências bancárias e necessidades pessoais.

1. **DASMEI (Site Governamental / Playwright Headless)**: Scraper que fura sistemas restritos usando apenas CNPJ público, ignorando headers falsos e resolvendo navegação invisível.
2. **TIM Móvel (Portal com Canvas/Flutter)**: Automação completa para o app/web Meu TIM usando `playwright-stealth`. Lida com logins, contorna banners de cookies e valida faturas usando OCR inteligente da tela, superando os desafios do CanvasKit que oculta os elementos do DOM.
3. **Universidade Unopar (Portal do Aluno)**: Bot com navegação condicional. Foca no acesso da área financeira, buscando boletos com desconto de pontualidade e realizando a cópia automática da chave "Pix Copia e Cola" usando a área de transferência do browser.
4. **IMAP / Email (Faturas Vivo Fixo em PDF)**: Este módulo foge da web e entra direto no seu Provedor de E-mail (ex: Gmail) via protocolo IMAP. Monitora mensagens novas contendo faturas em PDF. Consegue **descriptografar nativamente** PDFs protegidos por senha (ex: 4 primeiros dígitos do CNPJ) e extrai o boleto em D-0 via OCR Gemini.

## Como Rodar

### Pré-requisitos
- [Python 3.10+](https://www.python.org/)
- [Node.js 18+](https://nodejs.org/)
- Conta no [Supabase](https://supabase.com/)
- Chave de API do [Google Gemini](https://ai.google.dev/)
- [Expo CLI](https://expo.dev/)

### Configuração do Ambiente

1. Clone o repositório:
```bash
git clone https://github.com/Gyliardson/NotificaContas.git financeflow
cd financeflow
```

2. **Banco de Dados (Supabase):**
- Crie um projeto no Supabase.
- Abra o painel **SQL Editor** na web e execute o script localizado em `backend/supabase_schema.sql` para criar a estrutura e permissões do banco.

3. **Backend:**
```bash
cd backend
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/macOS:
# source venv/bin/activate

pip install -r requirements.txt
playwright install
```

Crie o arquivo `.env` na pasta `backend` baseado no `.env.example` e preencha as chaves:
```env
SUPABASE_URL="sua-url-aqui"
SUPABASE_KEY="sua-chave-aqui"
GEMINI_API_KEY="sua-chave-gemini-aqui"
```

3. **Mobile:**
```bash
cd mobile
npm install
# ou yarn install
```
Crie o arquivo `.env` na pasta `mobile` baseado no `.env.example`.

### Executando o Projeto

- Backend:
```bash
cd backend
venv\Scripts\activate
uvicorn main:app --reload
```
- Mobile:
```bash
cd mobile
npx expo start
```

## Segurança

Este repositório está configurado para **não versionar** informações sensíveis. Arquivos como `.env` e diretórios de build/dependências (`node_modules`, `venv`) estão devidamente protegidos pelo `.gitignore`. Sempre utilize os arquivos `.env.example` como referência para configurar seu ambiente local.
