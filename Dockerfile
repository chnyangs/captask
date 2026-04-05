FROM node:22-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install backend deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install frontend deps + build
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm install
COPY frontend/ ./frontend/
RUN cd frontend && npx vite build

# Copy server
COPY server.mjs ./

# Data directory for sessions, messages, totp, projects
RUN mkdir -p /app/data
VOLUME /app/data

# Default env
ENV PORT=3456
ENV NODE_ENV=production

EXPOSE 3456

# Start — use data dir for persistence files
CMD ["node", "server.mjs"]
