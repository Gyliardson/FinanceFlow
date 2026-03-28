# Use a imagem Python slim oficial como base
FROM python:3.11-slim

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

# Copia o restante dos arquivos do backend para o diretório de trabalho
COPY . .

# Expõe a porta que o Render vai usar (será sobrescrita pela env PORT no runtime)
EXPOSE 8000

# Comando para iniciar a aplicação usando uvicorn
# O Render passa a porta via variável de ambiente $PORT
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
