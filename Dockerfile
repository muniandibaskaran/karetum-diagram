# KareTum Diagram - AI-powered diagram tool
# Runs the Node server (static files + AI API proxy)

FROM node:20-alpine

WORKDIR /app

# Copy the webapp (server.js serves this directory)
COPY src/main/webapp/ /app/

# API keys are provided at runtime via environment variables (see .env.example).
# Do NOT bake secrets into the image.

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/ >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
