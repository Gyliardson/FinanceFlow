# Use the same Python minor validated by canonical backend CI / clean-room checks
FROM python:3.12-slim@sha256:dd29372629eeba2dd003fd9e9d35a5b8236c44727875a0364254b5127af88e65

# Define o diretório de trabalho no container
WORKDIR /app

# Instala dependências do sistema necessárias para algumas libs Python (ex: multipart, cryptography)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copia o arquivo de requisitos para o diretório de trabalho
COPY requirements.txt .

# Instala as dependências Python
RUN pip install --no-cache-dir -r requirements.txt

# Cria uma identidade fixa e sem privilégios para o runtime. A porta 8000 não
# exige root e o processo não precisa escrever em diretórios do sistema.
RUN groupadd --gid 10001 financeflow \
    && useradd --uid 10001 --gid financeflow --create-home --shell /usr/sbin/nologin financeflow

# Copia o restante dos arquivos do backend para o diretório de trabalho e mantém
# o código legível/pertencente ao usuário que executará o servidor.
COPY --chown=financeflow:financeflow . .

# Expõe a porta que o Render vai usar (será sobrescrita pela env PORT no runtime)
EXPOSE 8000

# Reduz o blast radius de qualquer comprometimento do processo da aplicação.
USER financeflow

# Production composition root removes the legacy shared API-key middleware and
# installs verified Supabase Bearer auth + explicit CORS before the app starts.
CMD uvicorn runtime:create_app --factory --host 0.0.0.0 --port ${PORT:-8000}
