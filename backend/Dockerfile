# Exact CPython patch + immutable multi-platform index digest.
FROM python:3.12.13-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28

WORKDIR /app

# All runtime Python artifacts are selected by checked-in SHA256 locks. No compiler,
# apt package bootstrap, dependency resolution, or source distribution build is needed.
COPY requirements.txt requirements.lock requirements-pip-bootstrap.lock hermetic_python.py ./
RUN python hermetic_python.py \
    --pip-lock requirements-pip-bootstrap.lock \
    --requirements-lock requirements.lock \
    --direct-requirements requirements.txt \
    --expected-python 3.12.13 \
    --expected-initial-pip 25.0.1 \
    --expected-pip 26.2.1 \
    --label BACKEND_IMAGE

# Fixed unprivileged runtime identity; the application does not require root.
RUN groupadd --gid 10001 financeflow \
    && useradd --uid 10001 --gid financeflow --create-home --shell /usr/sbin/nologin financeflow

COPY --chown=financeflow:financeflow . .

EXPOSE 8000
USER financeflow

# Shell is used only for runtime PORT expansion and immediately execs Uvicorn, so
# Uvicorn is PID 1 and receives normal container lifecycle signals directly.
CMD ["sh", "-c", "exec uvicorn runtime:create_app --factory --host 0.0.0.0 --port \"${PORT:-8000}\""]
