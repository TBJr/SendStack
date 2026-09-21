FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SENDSTACK_HOST=0.0.0.0 \
    SENDSTACK_PORT=8080 \
    SENDSTACK_DB_PATH=/app/data/sendstack.db

WORKDIR /app
COPY app /app/app
RUN mkdir -p /app/data && useradd --create-home --uid 10001 sendstack && chown -R sendstack:sendstack /app

USER sendstack
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"]

CMD ["python3", "app/server.py"]
