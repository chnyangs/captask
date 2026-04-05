import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { spawn, execSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  watchFile,
  renameSync,
  unlinkSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { randomBytes, randomUUID, createHmac } from "crypto";
import { homedir } from "os";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════
// Config — all tunables from env vars with sensible defaults
// ═══════════════════════════════════════════════════════

const DATA_DIR = process.env.CAPTASK_DATA_DIR || __dirname;
const SESSION_TTL_MS = parseInt(process.env.CAPTASK_SESSION_TTL_MS || String(30 * 24 * 60 * 60 * 1000), 10);
const SESSION_TOKEN_TTL = parseInt(process.env.CAPTASK_TOKEN_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const MAX_PROMPT_LENGTH = parseInt(process.env.CAPTASK_MAX_PROMPT || "100000", 10);
const MAX_BUFFER_SIZE = parseInt(process.env.CAPTASK_MAX_BUFFER || String(10 * 1024 * 1024), 10);
const TASK_TIMEOUT_MS = parseInt(process.env.CAPTASK_TASK_TIMEOUT_MS || String(30 * 60 * 1000), 10);
const MAX_STREAM_CHUNK = parseInt(process.env.CAPTASK_MAX_STREAM_CHUNK || String(1024 * 1024), 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.CAPTASK_RATE_WINDOW_MS || "10000", 10);
const RATE_LIMIT_MAX_TASKS = parseInt(process.env.CAPTASK_RATE_MAX_TASKS || "5", 10);
const MAX_OUTPUT_BUFFER = parseInt(process.env.CAPTASK_MAX_OUTPUT_BUFFER || "200", 10);
const MAX_MESSAGES_PER_SESSION = parseInt(process.env.CAPTASK_MAX_MESSAGES || "200", 10);

// ═══════════════════════════════════════════════════════
// Structured logger
// ═══════════════════════════════════════════════════════

const LOG_FORMAT = process.env.CAPTASK_LOG_FORMAT || "text"; // "json" or "text"

function log(level, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  if (LOG_FORMAT === "json") {
    const stream = level === "error" || level === "fatal" ? process.stderr : process.stdout;
    stream.write(JSON.stringify(entry) + "\n");
  } else {
    const prefix = `[${entry.ts}] ${level.toUpperCase()}`;
    const extra = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    const stream = level === "error" || level === "fatal" ? process.stderr : process.stdout;
    stream.write(`${prefix}: ${msg}${extra}\n`);
  }
}

log.info = (msg, meta) => log("info", msg, meta);
log.warn = (msg, meta) => log("warn", msg, meta);
log.error = (msg, meta) => log("error", msg, meta);
log.fatal = (msg, meta) => log("fatal", msg, meta);

// ═══════════════════════════════════════════════════════
// #14 — Preflight: check claude binary is available
// ═══════════════════════════════════════════════════════

try {
  execSync("which claude", { stdio: "ignore" });
} catch {
  log.fatal("'claude' binary not found in PATH. Install Claude Code first.");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════
// Project config (hot-reloadable) — #9 validate on load
// ═══════════════════════════════════════════════════════
const PROJECTS_FILE = join(DATA_DIR, "projects.json");

function loadConfig() {
  const raw = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
  for (const p of raw.projects) {
    if (!p.id || typeof p.id !== "string")
      throw new Error("Invalid project: missing 'id'");
    if (!p.path || typeof p.path !== "string")
      throw new Error(`Project '${p.id}' missing 'path'`);
    p.path = resolve(p.path);
  }
  return raw;
}

if (!existsSync(PROJECTS_FILE)) {
  writeFileSync(PROJECTS_FILE, JSON.stringify({ projects: [] }, null, 2) + "\n");
  log.info("Created empty projects.json — add projects via the web UI");
}
let config = loadConfig();
let projectsMap = new Map(config.projects.map((p) => [p.id, p]));

watchFile(PROJECTS_FILE, { interval: 2000 }, () => {
  try {
    config = loadConfig();
    projectsMap = new Map(config.projects.map((p) => [p.id, p]));
    log.info("Reloaded projects.json");
  } catch (err) {
    log.error("Failed to reload projects.json", { error: err.message });
  }
});

function saveConfig() {
  const tmpFile = PROJECTS_FILE + ".tmp";
  try {
    writeFileSync(tmpFile, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpFile, PROJECTS_FILE);
  } catch (err) {
    log.error("Failed to save projects.json", { error: err.message });
    throw err;
  }
  projectsMap = new Map(config.projects.map((p) => [p.id, p]));
}

function expandPath(p) {
  if (p.startsWith("~/") || p === "~") return join(homedir(), p.slice(1));
  return resolve(p);
}

function addProject({ name, path: rawPath, description }) {
  const p = {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    name: name.trim().slice(0, 100),
    path: expandPath(rawPath.trim()),
    description: (description || "").trim().slice(0, 200),
    quickPrompts: [
      { id: randomUUID(), label: "Review", prompt: "Review the recent changes and suggest improvements" },
      { id: randomUUID(), label: "Test", prompt: "Run the tests and fix any failures" },
      { id: randomUUID(), label: "Build", prompt: "Build the project and fix any errors" },
      { id: randomUUID(), label: "Status", prompt: "Give me a brief status of this project" },
    ],
  };
  if (!p.id || !p.name || !p.path) throw new Error("Invalid project fields");
  if (projectsMap.has(p.id)) throw new Error(`Project '${p.id}' already exists`);
  if (!existsSync(p.path)) throw new Error(`Path does not exist: ${p.path}`);
  config.projects.push(p);
  saveConfig();
  return p;
}

function removeProject(projectId) {
  const idx = config.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) throw new Error("Project not found");
  config.projects.splice(idx, 1);
  saveConfig();
  // Clean up sessions for this project
  delete sessionStore[projectId];
  saveSessionStore();
}

function updateProject(projectId, updates) {
  const p = config.projects.find((p) => p.id === projectId);
  if (!p) throw new Error("Project not found");
  if (updates.name) p.name = updates.name.trim().slice(0, 100);
  if (updates.path) {
    const resolved = expandPath(updates.path.trim());
    if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
    p.path = resolved;
  }
  if (updates.description !== undefined)
    p.description = updates.description.trim().slice(0, 200);
  saveConfig();
  return p;
}

function getProjectsList() {
  return config.projects.map(({ id, name, description, path, quickPrompts }) => ({
    id,
    name,
    description,
    path,
    quickPrompts: quickPrompts || [],
    hasSession: !!getActiveSession(id),
  }));
}

// ═══════════════════════════════════════════════════════
// Auth — Username/Password + TOTP
// ═══════════════════════════════════════════════════════

const AUTH_FILE = join(DATA_DIR, ".auth.json");

function hashPwd(password, salt) {
  return createHmac("sha256", salt).update(password).digest("hex");
}

function loadAuth() {
  try {
    if (existsSync(AUTH_FILE)) {
      return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return null;
}

function saveAuthData(data) {
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

let authData = loadAuth();
// authData: { username, passwordHash, salt } or null (needs setup)

const TOTP_FILE = join(DATA_DIR, ".totp-secret.json");
let totpSecret = null;
let totpEnabled = false;

function loadTOTP() {
  try {
    if (existsSync(TOTP_FILE)) {
      const data = JSON.parse(readFileSync(TOTP_FILE, "utf-8"));
      if (data.secret && data.verified) {
        totpSecret = data.secret;
        totpEnabled = true;
        return;
      }
      if (data.secret && !data.verified) {
        // Setup started but not verified yet
        totpSecret = data.secret;
        totpEnabled = false;
        return;
      }
    }
  } catch {
    // ignore
  }
  // Generate new secret
  const totp = new OTPAuth.TOTP({
    issuer: "CapTask",
    label: authData?.username || "admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
  totpSecret = totp.secret.base32;
  totpEnabled = false;
  writeFileSync(
    TOTP_FILE,
    JSON.stringify({ secret: totpSecret, verified: false }, null, 2)
  );
}

loadTOTP();

function getTOTP() {
  return new OTPAuth.TOTP({
    issuer: "CapTask",
    label: authData?.username || "admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(totpSecret),
  });
}

function verifyTOTPCode(code) {
  const totp = getTOTP();
  const delta = totp.validate({ token: code, window: 2 });
  return delta !== null;
}

function confirmTOTPSetup(code) {
  if (verifyTOTPCode(code)) {
    totpEnabled = true;
    writeFileSync(
      TOTP_FILE,
      JSON.stringify({ secret: totpSecret, verified: true }, null, 2)
    );
    return true;
  }
  return false;
}

function verifyCredentials(username, password) {
  if (!authData) return { ok: false, reason: "Account not set up" };
  if (username !== authData.username)
    return { ok: false, reason: "Invalid username or password" };
  const hash = hashPwd(password, authData.salt);
  if (hash !== authData.passwordHash)
    return { ok: false, reason: "Invalid username or password" };
  return { ok: true };
}

function verifyAuth(username, password, totpCode) {
  const cred = verifyCredentials(username, password);
  if (!cred.ok) return cred;
  if (totpEnabled) {
    if (!totpCode) return { ok: false, reason: "totp_required" };
    if (!verifyTOTPCode(totpCode))
      return { ok: false, reason: "Invalid TOTP code" };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════
// Session persistence — #3 atomic writes, #4 error notify
// ═══════════════════════════════════════════════════════

const SESSION_FILE = join(DATA_DIR, ".sessions.json");

function loadSessionStore() {
  try {
    if (existsSync(SESSION_FILE)) {
      const raw = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
      const store = {};
      for (const [key, val] of Object.entries(raw)) {
        if (typeof val === "string") {
          store[key] = {
            active: 0,
            sessions: [
              {
                id: randomUUID(),
                claudeSessionId: val,
                name: "Session 1",
                createdAt: Date.now(),
              },
            ],
          };
        } else if (val && Array.isArray(val.sessions)) {
          val.sessions = val.sessions.filter(
            (s) =>
              s &&
              typeof s.id === "string" &&
              typeof s.createdAt === "number"
          );
          if (val.sessions.length > 0) {
            val.active = Math.min(
              Math.max(0, val.active || 0),
              val.sessions.length - 1
            );
            store[key] = val;
          }
        }
      }
      return store;
    }
  } catch (err) {
    log.error("Failed to load .sessions.json", { error: err.message });
    try {
      if (existsSync(SESSION_FILE)) {
        renameSync(SESSION_FILE, SESSION_FILE + ".bak");
        log.warn("Backed up corrupt .sessions.json to .sessions.json.bak");
      }
    } catch {
      // ignore
    }
  }
  return {};
}

// #3 — Atomic write: write to temp file then rename
let lastSaveError = null;

function saveSessionStore() {
  const tmpFile = join(
    dirname(SESSION_FILE),
    `.sessions.tmp.${process.pid}`
  );
  try {
    writeFileSync(tmpFile, JSON.stringify(sessionStore, null, 2));
    renameSync(tmpFile, SESSION_FILE);
    lastSaveError = null;
  } catch (err) {
    lastSaveError = err.message;
    log.error("Failed to save sessions", { error: err.message });
    try {
      if (existsSync(tmpFile))
        writeFileSync(tmpFile, "", { flag: "w" });
    } catch {
      // ignore
    }
  }
}

const sessionStore = loadSessionStore();

// #11 — Purge expired sessions on startup
function purgeExpiredSessions() {
  const now = Date.now();
  let purged = 0;
  for (const [projectId, entry] of Object.entries(sessionStore)) {
    const before = entry.sessions.length;
    entry.sessions = entry.sessions.filter(
      (s) => now - s.createdAt < SESSION_TTL_MS
    );
    purged += before - entry.sessions.length;
    if (entry.sessions.length === 0) {
      delete sessionStore[projectId];
    } else {
      entry.active = Math.min(entry.active, entry.sessions.length - 1);
    }
  }
  if (purged > 0) {
    log.info("Purged expired sessions", { count: purged });
    saveSessionStore();
  }
}
purgeExpiredSessions();

function getActiveSession(projectId) {
  const entry = sessionStore[projectId];
  if (!entry || !entry.sessions?.length) return null;
  return entry.sessions[entry.active] || null;
}

function getActiveClaudeSessionId(projectId) {
  return getActiveSession(projectId)?.claudeSessionId || null;
}

function setClaudeSessionId(projectId, claudeSessionId) {
  const entry = sessionStore[projectId];
  if (entry?.sessions?.[entry.active]) {
    entry.sessions[entry.active].claudeSessionId = claudeSessionId;
    saveSessionStore();
  }
}

function createNewSession(projectId, name) {
  if (!sessionStore[projectId]) {
    sessionStore[projectId] = { active: 0, sessions: [] };
  }
  const entry = sessionStore[projectId];
  const session = {
    id: randomUUID(),
    claudeSessionId: null,
    name:
      (name || "").slice(0, 100) ||
      `Session ${entry.sessions.length + 1}`,
    createdAt: Date.now(),
  };
  entry.sessions.push(session);
  entry.active = entry.sessions.length - 1;
  saveSessionStore();
  return session;
}

function switchSession(projectId, sessionId) {
  const entry = sessionStore[projectId];
  if (!entry) return false;
  const idx = entry.sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return false;
  entry.active = idx;
  saveSessionStore();
  return true;
}

function deleteSession(projectId, sessionId) {
  const entry = sessionStore[projectId];
  if (!entry) return false;
  const idx = entry.sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return false;
  entry.sessions.splice(idx, 1);
  if (entry.sessions.length === 0) {
    delete sessionStore[projectId];
  } else {
    entry.active = Math.min(entry.active, entry.sessions.length - 1);
  }
  saveSessionStore();
  deleteSessionMessages(projectId, sessionId);
  return true;
}

function getSessionList(projectId) {
  const entry = sessionStore[projectId];
  if (!entry || !entry.sessions?.length)
    return { active: null, sessions: [] };
  return {
    active: entry.sessions[entry.active]?.id || null,
    sessions: entry.sessions.map(({ id, name, createdAt }) => ({
      id,
      name,
      createdAt,
    })),
  };
}

// ═══════════════════════════════════════════════════════
// Message persistence — server-side message store
// ═══════════════════════════════════════════════════════

const MESSAGES_FILE = join(DATA_DIR, ".messages.json");

function loadMessageStore() {
  try {
    if (existsSync(MESSAGES_FILE)) {
      return JSON.parse(readFileSync(MESSAGES_FILE, "utf-8"));
    }
  } catch (err) {
    log.error("Failed to load .messages.json", { error: err.message });
    try {
      if (existsSync(MESSAGES_FILE)) {
        renameSync(MESSAGES_FILE, MESSAGES_FILE + ".bak");
      }
    } catch { /* ignore */ }
  }
  return {};
}

let messagesDirty = false;
const messageStore = loadMessageStore(); // { "projectId:sessionId": [...messages] }

let lastMessageSaveError = null;

function saveMessageStore() {
  const tmpFile = join(dirname(MESSAGES_FILE), `.messages.tmp.${process.pid}`);
  try {
    writeFileSync(tmpFile, JSON.stringify(messageStore));
    renameSync(tmpFile, MESSAGES_FILE);
    messagesDirty = false;
    lastMessageSaveError = null;
  } catch (err) {
    lastMessageSaveError = err.message;
    log.error("Failed to save messages", { error: err.message });
    // Notify all connected sockets
    for (const [sock] of socketSessionMap) {
      safeSend(sock, { type: "save_error", message: err.message });
    }
  }
}

// Debounced save — write at most every 5 seconds
let messageSaveTimer = null;
function debouncedSaveMessages() {
  messagesDirty = true;
  if (!messageSaveTimer) {
    messageSaveTimer = setTimeout(() => {
      messageSaveTimer = null;
      if (messagesDirty) saveMessageStore();
    }, 5000);
  }
}

function msgStoreKey(projectId, sessionId) {
  return `${projectId}:${sessionId}`;
}

function appendMessage(projectId, sessionId, msg) {
  if (!sessionId) return;
  const key = msgStoreKey(projectId, sessionId);
  if (!messageStore[key]) messageStore[key] = [];
  messageStore[key].push(msg);
  // Cap
  if (messageStore[key].length > MAX_MESSAGES_PER_SESSION) {
    messageStore[key] = messageStore[key].slice(-MAX_MESSAGES_PER_SESSION);
  }
  debouncedSaveMessages();
}

function getMessages(projectId, sessionId) {
  if (!sessionId) return [];
  return messageStore[msgStoreKey(projectId, sessionId)] || [];
}

function deleteSessionMessages(projectId, sessionId) {
  delete messageStore[msgStoreKey(projectId, sessionId)];
  debouncedSaveMessages();
}

// Track which sockets are viewing which session, for broadcasting
const socketSessionMap = new Map(); // socket -> { projectId, sessionId }

function broadcastToSession(projectId, sessionId, data, excludeSocket) {
  for (const [sock, viewing] of socketSessionMap) {
    if (
      viewing.projectId === projectId &&
      viewing.sessionId === sessionId &&
      sock !== excludeSocket
    ) {
      safeSend(sock, data);
    }
  }
}

// ═══════════════════════════════════════════════════════
// Concurrency & limits
// ═══════════════════════════════════════════════════════

const projectRunningTasks = new Map(); // Map<projectId, Map<sessionId, Set<taskId>>>

// ═══════════════════════════════════════════════════════
// Global task registry — tasks survive socket disconnects
// ═══════════════════════════════════════════════════════

// taskId -> { child, projectId, socket (mutable), outputBuffer[], status, error }
const globalTasks = new Map();

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function safeSend(socket, data) {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(data));
  } catch {
    // socket already closed
  }
}

// #7 — Schema validators
function validateTaskMsg(msg) {
  if (typeof msg.projectId !== "string" || !msg.projectId)
    return "Missing projectId";
  if (typeof msg.taskId !== "string" || !msg.taskId)
    return "Missing taskId";
  if (typeof msg.prompt !== "string" || !msg.prompt.trim())
    return "Missing prompt";
  return null;
}

function validateSessionMsg(msg) {
  if (typeof msg.projectId !== "string" || !msg.projectId)
    return "Missing projectId";
  return null;
}

// ═══════════════════════════════════════════════════════
// Claude subprocess runner
// ═══════════════════════════════════════════════════════

// Send a message to the task's current socket AND buffer it for reattach
function taskSend(taskId, data) {
  const task = globalTasks.get(taskId);
  if (!task) return;
  // Buffer output (capped)
  if (task.outputBuffer.length >= MAX_OUTPUT_BUFFER) {
    task.outputBuffer.shift();
  }
  task.outputBuffer.push(data);
  // Send to live socket if connected
  if (task.socket) {
    safeSend(task.socket, data);
  }

  // Persist message and broadcast to other devices viewing this session
  const sessionId = getActiveSession(task.projectId)?.id;
  if (sessionId && (data.type === "task_stream" || data.type === "task_done" || data.type === "task_error" || data.type === "task_cancelled")) {
    const msg = { type: data.type, text: data.text || data.message, taskId, ts: Date.now() };
    appendMessage(task.projectId, sessionId, msg);
    broadcastToSession(task.projectId, sessionId, {
      type: "session_message",
      projectId: task.projectId,
      sessionId,
      message: msg,
    }, task.socket);
  }
}

function runClaude(project, prompt, taskId, socket, sessionId) {
  // #9 — Snapshot project config at task start
  const proj = { ...project };

  const allowedTools = proj.allowedTools || [
    "Read",
    "Edit",
    "Write",
    "Bash",
    "Glob",
    "Grep",
    "Agent",
  ];

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    ...allowedTools,
  ];

  if (proj.skipPermissions !== false) {
    args.push("--dangerously-skip-permissions");
  }

  // Project memory: inject system prompt for CLAUDE.md awareness
  const memoryPrompt = [
    "You have a project memory file at CLAUDE.md in the project root.",
    "At the START of each task, read CLAUDE.md if it exists to understand project context, conventions, and prior decisions.",
    "At the END of each task, update CLAUDE.md with any important new findings:",
    "- Architectural decisions made",
    "- Bugs found and how they were fixed",
    "- Key patterns or conventions discovered",
    "- Warnings for future work",
    "Keep CLAUDE.md concise (under 200 lines). Update, don't append blindly.",
  ].join(" ");
  args.push("--append-system-prompt", memoryPrompt);

  const claudeSessionId = getActiveClaudeSessionId(proj.id);
  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }

  const child = spawn("claude", args, {
    cwd: proj.path,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.write(prompt);
  child.stdin.end();

  // Register in global task registry
  const taskEntry = {
    child,
    projectId: proj.id,
    socket, // mutable — updated on reattach
    outputBuffer: [],
    status: "running",
  };
  globalTasks.set(taskId, taskEntry);

  if (!projectRunningTasks.has(proj.id)) {
    projectRunningTasks.set(proj.id, new Map());
  }
  const projMap = projectRunningTasks.get(proj.id);
  if (!projMap.has(sessionId)) {
    projMap.set(sessionId, new Set());
  }
  projMap.get(sessionId).add(taskId);

  let buffer = "";
  let killed = false;

  // #1 — Task timeout with escalation
  const timeoutTimer = setTimeout(() => {
    if (!killed) {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 10_000);
      taskSend(taskId, {
        type: "task_error",
        taskId,
        message: `Task timed out after ${TASK_TIMEOUT_MS / 60000} minutes`,
      });
      taskEntry.status = "error";
    }
  }, TASK_TIMEOUT_MS);

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();

    // #2 — Buffer overflow protection
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer = buffer.slice(buffer.length - MAX_BUFFER_SIZE);
      taskSend(taskId, {
        type: "task_stream",
        taskId,
        text: `[warning] Output buffer exceeded ${MAX_BUFFER_SIZE / 1024 / 1024}MB, truncating`,
      });
    }

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleStreamEvent(event, taskId, proj.id);
      } catch {
        // skip malformed
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      taskSend(taskId, {
        type: "task_stream",
        taskId,
        text: `[stderr] ${text}`,
      });
    }
  });

  function cleanup() {
    clearTimeout(timeoutTimer);
    const projMap = projectRunningTasks.get(proj.id);
    if (projMap) {
      projMap.get(sessionId)?.delete(taskId);
    }
    // Don't delete from globalTasks yet — keep for reattach
    // Clean up after 5 minutes of completion
    setTimeout(() => globalTasks.delete(taskId), 5 * 60 * 1000);
  }

  child.on("close", (code) => {
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        handleStreamEvent(event, taskId, proj.id);
      } catch {
        // skip
      }
      buffer = "";
    }

    cleanup();

    if (killed) return; // timeout error already sent

    if (code === 0) {
      taskEntry.status = "done";
      taskSend(taskId, { type: "task_done", taskId });
    } else if (code === null) {
      taskEntry.status = "cancelled";
      taskSend(taskId, { type: "task_cancelled", taskId });
    } else {
      taskEntry.status = "error";
      taskSend(taskId, {
        type: "task_error",
        taskId,
        message: `Process exited with code ${code}`,
      });
    }
  });

  child.on("error", (err) => {
    cleanup();
    taskEntry.status = "error";
    taskSend(taskId, { type: "task_error", taskId, message: err.message });
  });
}

function handleStreamEvent(event, taskId, projectId) {
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        const text =
          block.text.length > MAX_STREAM_CHUNK
            ? block.text.slice(0, MAX_STREAM_CHUNK) + "\n[truncated]"
            : block.text;
        taskSend(taskId, { type: "task_stream", taskId, text });
      }
      if (block.type === "tool_use") {
        taskSend(taskId, {
          type: "task_tool",
          taskId,
          tools: [{ name: block.name, input: block.input }],
        });
      }
    }
  }

  if (event.type === "result") {
    if (!sessionStore[projectId]) {
      createNewSession(projectId, "Session 1");
    }
    if (event.session_id) {
      setClaudeSessionId(projectId, event.session_id);
    }

    if (lastSaveError) {
      taskSend(taskId, {
        type: "task_stream",
        taskId,
        text: `[warning] Session save failed: ${lastSaveError}`,
      });
    }

    const texts = event.result
      ?.filter((b) => b.type === "text")
      .map((b) => b.text);
    if (texts?.length) {
      const joined = texts.join("\n");
      const text =
        joined.length > MAX_STREAM_CHUNK
          ? joined.slice(0, MAX_STREAM_CHUNK) + "\n[truncated]"
          : joined;
      taskSend(taskId, { type: "task_stream", taskId, text });
    }
  }
}

// ═══════════════════════════════════════════════════════
// #8 — Warn about orphan processes on startup
// ═══════════════════════════════════════════════════════

try {
  const result = execSync(
    "pgrep -f 'claude.*--print.*--dangerously-skip-permissions' || true",
    { encoding: "utf-8" }
  ).trim();
  if (result) {
    const pids = result.split("\n").filter(Boolean);
    log.warn("Found existing claude --print processes", { count: pids.length, pids });
  }
} catch {
  // pgrep not available
}

// ═══════════════════════════════════════════════════════
// Fastify setup
// ═══════════════════════════════════════════════════════

const app = Fastify({ logger: false });

await app.register(fastifyStatic, {
  root: join(__dirname, "frontend", "dist"),
});

await app.register(fastifyWebsocket);

app.get("/health", async () => ({
  status: "ok",
  uptime: process.uptime(),
  projects: config.projects.length,
  sessionSaveError: lastSaveError,
}));

// TOTP setup endpoint — returns QR code for scanning
// TOTP setup — requires valid session token (already logged in)
app.post("/api/totp/setup", async (req, reply) => {
  const { sessionToken: st } = req.body || {};
  if (!st || !validateSessionToken(st)) {
    reply.code(401);
    return { error: "Login first" };
  }
  if (totpEnabled) {
    return { enabled: true, message: "TOTP already configured" };
  }
  const totp = getTOTP();
  const uri = totp.toString();
  const qrDataUrl = await QRCode.toDataURL(uri);
  return { enabled: false, qr: qrDataUrl, uri };
});

// TOTP verify — confirm setup or validate login
app.post("/api/totp/verify", async (req, reply) => {
  const { sessionToken: st, code } = req.body || {};
  if (!st || !validateSessionToken(st)) {
    reply.code(401);
    return { error: "Login first" };
  }
  if (!code || typeof code !== "string") {
    reply.code(400);
    return { error: "Missing code" };
  }
  if (!totpEnabled) {
    if (confirmTOTPSetup(code)) {
      return { ok: true, message: "TOTP enabled successfully" };
    }
    reply.code(400);
    return { error: "Invalid code — scan the QR code first" };
  }
  reply.code(400);
  return { error: "TOTP already configured" };
});

// Auth status — tells frontend if TOTP is required
app.get("/api/auth/status", async () => ({
  accountConfigured: !!authData,
  totpRequired: totpEnabled,
  totpSetupNeeded: !totpEnabled && !!totpSecret,
}));

// Session tokens — issued after TOTP verification, used for WS auth
const sessionTokens = new Map(); // sessionToken -> { createdAt }

function issueSessionToken() {
  const st = randomBytes(32).toString("hex");
  sessionTokens.set(st, { createdAt: Date.now() });
  // Cleanup old tokens
  for (const [k, v] of sessionTokens) {
    if (Date.now() - v.createdAt > SESSION_TOKEN_TTL) sessionTokens.delete(k);
  }
  return st;
}

function validateSessionToken(st) {
  const entry = sessionTokens.get(st);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > SESSION_TOKEN_TTL) {
    sessionTokens.delete(st);
    return false;
  }
  return true;
}

// Create account (first time only)
app.post("/api/auth/setup", async (req, reply) => {
  if (authData) {
    reply.code(400);
    return { error: "Account already configured" };
  }
  const { username, password } = req.body || {};
  if (!username || typeof username !== "string" || username.trim().length < 2) {
    reply.code(400);
    return { error: "Username must be at least 2 characters" };
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    reply.code(400);
    return { error: "Password must be at least 6 characters" };
  }
  const salt = randomBytes(16).toString("hex");
  authData = {
    username: username.trim(),
    passwordHash: hashPwd(password, salt),
    salt,
  };
  saveAuthData(authData);
  // Regenerate TOTP secret with correct username (delete unverified old one)
  if (!totpEnabled && existsSync(TOTP_FILE)) {
    unlinkSync(TOTP_FILE);
  }
  loadTOTP();
  const sessionToken = issueSessionToken();
  return { ok: true, sessionToken };
});

// Login — step 1: verify credentials, step 2: verify TOTP if enabled
app.post("/api/auth/login", async (req, reply) => {
  const { username, password, totpCode } = req.body || {};
  const auth = verifyAuth(username, password, totpCode);
  if (!auth.ok) {
    if (auth.reason === "totp_required") {
      // Credentials correct but need TOTP — tell frontend to show TOTP input
      return { ok: false, totpRequired: true };
    }
    reply.code(401);
    return { error: auth.reason };
  }
  const sessionToken = issueSessionToken();
  return { ok: true, sessionToken };
});

app.get("/ws", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionToken = url.searchParams.get("session");

  if (!sessionToken || !validateSessionToken(sessionToken)) {
    socket.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
    socket.close(4001, "Unauthorized");
    return;
  }

  const taskTimestamps = []; // #6 rate limit

  const pingInterval = setInterval(() => {
    if (socket.readyState === 1) socket.ping();
  }, 30000);

  safeSend(socket, { type: "projects", projects: getProjectsList() });

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (typeof msg.type !== "string") return; // #7

    // ── Task ──
    if (msg.type === "task") {
      const err = validateTaskMsg(msg);
      if (err) {
        safeSend(socket, {
          type: "task_error",
          taskId: msg.taskId || "unknown",
          message: err,
        });
        return;
      }

      const { projectId, prompt, taskId } = msg;
      const project = projectsMap.get(projectId);

      if (!project) {
        safeSend(socket, {
          type: "task_error",
          taskId,
          message: "Unknown project",
        });
        return;
      }

      if (prompt.length > MAX_PROMPT_LENGTH) {
        safeSend(socket, {
          type: "task_error",
          taskId,
          message: `Prompt too long (max ${MAX_PROMPT_LENGTH} chars)`,
        });
        return;
      }

      // #6 — Rate limit
      const now = Date.now();
      while (
        taskTimestamps.length &&
        taskTimestamps[0] < now - RATE_LIMIT_WINDOW_MS
      ) {
        taskTimestamps.shift();
      }
      if (taskTimestamps.length >= RATE_LIMIT_MAX_TASKS) {
        safeSend(socket, {
          type: "task_error",
          taskId,
          message: `Rate limited: max ${RATE_LIMIT_MAX_TASKS} tasks per ${RATE_LIMIT_WINDOW_MS / 1000}s`,
        });
        return;
      }
      taskTimestamps.push(now);

      // Persist user message
      const sessId = getActiveSession(projectId)?.id;

      // Check if this session already has a running task
      const projTasks = projectRunningTasks.get(projectId);
      const sessionTasks = projTasks?.get(sessId);
      if (sessionTasks && sessionTasks.size > 0) {
        safeSend(socket, {
          type: "task_error",
          taskId,
          message: "A task is already running for this session. Wait or cancel it.",
        });
        return;
      }
      if (sessId) {
        appendMessage(projectId, sessId, {
          type: "user",
          text: prompt,
          taskId,
          ts: Date.now(),
        });
        broadcastToSession(projectId, sessId, {
          type: "session_message",
          projectId,
          sessionId: sessId,
          message: { type: "user", text: prompt, taskId, ts: Date.now() },
        }, socket);
      }

      safeSend(socket, { type: "task_start", taskId, projectId });
      runClaude(project, prompt, taskId, socket, sessId);
    }

    // ── Cancel ──
    if (msg.type === "cancel") {
      if (typeof msg.taskId !== "string") return;
      const task = globalTasks.get(msg.taskId);
      if (task?.child) {
        task.child.kill("SIGTERM");
        setTimeout(() => {
          try {
            task.child.kill("SIGKILL");
          } catch {
            // already dead
          }
        }, 10_000);
      }
    }

    // ── Reattach — reconnect to a running/completed task ──
    if (msg.type === "reattach") {
      if (typeof msg.taskId !== "string") return;
      const task = globalTasks.get(msg.taskId);
      if (task) {
        // Update socket reference so future output goes to new connection
        task.socket = socket;
        // Replay buffered output
        for (const buffered of task.outputBuffer) {
          safeSend(socket, buffered);
        }
      }
    }

    // ── Session management ──

    if (msg.type === "list_sessions") {
      if (validateSessionMsg(msg)) return;
      safeSend(socket, {
        type: "sessions_list",
        projectId: msg.projectId,
        ...getSessionList(msg.projectId),
      });
    }

    if (msg.type === "new_session") {
      if (validateSessionMsg(msg)) return;
      createNewSession(
        msg.projectId,
        typeof msg.name === "string" ? msg.name : undefined
      );
      safeSend(socket, {
        type: "sessions_list",
        projectId: msg.projectId,
        ...getSessionList(msg.projectId),
      });
    }

    if (msg.type === "switch_session") {
      if (validateSessionMsg(msg)) return;
      if (typeof msg.sessionId !== "string") return;
      if (switchSession(msg.projectId, msg.sessionId)) {
        safeSend(socket, {
          type: "session_switched",
          projectId: msg.projectId,
          sessionId: msg.sessionId,
        });
        safeSend(socket, {
          type: "sessions_list",
          projectId: msg.projectId,
          ...getSessionList(msg.projectId),
        });
      }
    }

    if (msg.type === "delete_session") {
      if (validateSessionMsg(msg)) return;
      if (typeof msg.sessionId !== "string") return;
      deleteSession(msg.projectId, msg.sessionId);
      safeSend(socket, {
        type: "sessions_list",
        projectId: msg.projectId,
        ...getSessionList(msg.projectId),
      });
    }

    if (msg.type === "rename_session") {
      if (validateSessionMsg(msg)) return;
      if (typeof msg.sessionId !== "string") return;
      if (typeof msg.name !== "string" || !msg.name.trim()) return;
      const entry = sessionStore[msg.projectId];
      if (entry) {
        const s = entry.sessions.find((s) => s.id === msg.sessionId);
        if (s) {
          s.name = msg.name.trim().slice(0, 100);
          saveSessionStore();
          safeSend(socket, {
            type: "sessions_list",
            projectId: msg.projectId,
            ...getSessionList(msg.projectId),
          });
        }
      }
    }

    if (msg.type === "reset_session") {
      if (validateSessionMsg(msg)) return;
      createNewSession(msg.projectId);
      safeSend(socket, { type: "session_reset", projectId: msg.projectId });
      safeSend(socket, {
        type: "sessions_list",
        projectId: msg.projectId,
        ...getSessionList(msg.projectId),
      });
    }

    // ── Retry save ──
    if (msg.type === "retry_save") {
      saveSessionStore();
      saveMessageStore();
      if (!lastSaveError && !lastMessageSaveError) {
        safeSend(socket, { type: "save_ok" });
      }
    }

    // ── Message sync ──

    if (msg.type === "load_messages") {
      if (validateSessionMsg(msg)) return;
      if (typeof msg.sessionId !== "string") return;
      const msgs = getMessages(msg.projectId, msg.sessionId);
      safeSend(socket, {
        type: "messages_loaded",
        projectId: msg.projectId,
        sessionId: msg.sessionId,
        messages: msgs,
      });
      // Track this socket as viewing this session
      socketSessionMap.set(socket, {
        projectId: msg.projectId,
        sessionId: msg.sessionId,
      });
    }

    // ── Project management ──

    if (msg.type === "add_project") {
      try {
        if (typeof msg.name !== "string" || !msg.name.trim()) {
          safeSend(socket, { type: "project_error", message: "Name required" });
          return;
        }
        if (typeof msg.path !== "string" || !msg.path.trim()) {
          safeSend(socket, { type: "project_error", message: "Path required" });
          return;
        }
        addProject({ name: msg.name, path: msg.path, description: msg.description });
        safeSend(socket, { type: "projects", projects: getProjectsList() });
      } catch (err) {
        safeSend(socket, { type: "project_error", message: err.message });
      }
    }

    if (msg.type === "remove_project") {
      try {
        if (typeof msg.projectId !== "string") return;
        removeProject(msg.projectId);
        safeSend(socket, { type: "projects", projects: getProjectsList() });
      } catch (err) {
        safeSend(socket, { type: "project_error", message: err.message });
      }
    }

    if (msg.type === "update_project") {
      try {
        if (typeof msg.projectId !== "string") return;
        updateProject(msg.projectId, {
          name: msg.name,
          path: msg.path,
          description: msg.description,
        });
        safeSend(socket, { type: "projects", projects: getProjectsList() });
      } catch (err) {
        safeSend(socket, { type: "project_error", message: err.message });
      }
    }

    // ── Quick prompt management ──

    if (msg.type === "add_quick_prompt") {
      if (typeof msg.projectId !== "string") return;
      if (typeof msg.label !== "string" || !msg.label.trim()) return;
      const p = config.projects.find((p) => p.id === msg.projectId);
      if (!p) return;
      if (!p.quickPrompts) p.quickPrompts = [];

      const label = msg.label.trim().slice(0, 30);

      // If prompt provided, use it directly
      if (typeof msg.prompt === "string" && msg.prompt.trim()) {
        p.quickPrompts.push({
          id: randomUUID(),
          label,
          prompt: msg.prompt.trim().slice(0, 2000),
        });
        saveConfig();
        safeSend(socket, { type: "projects", projects: getProjectsList() });
        return;
      }

      // Auto-generate prompt via Claude based on project context
      safeSend(socket, {
        type: "quick_prompt_generating",
        projectId: msg.projectId,
        label,
      });

      const genArgs = [
        "--print",
        "--output-format", "json",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
      ];
      const genChild = spawn("claude", genArgs, {
        cwd: p.path,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      genChild.stdin.write(
        `You are configuring a quick-action button for a coding assistant. The project directory is "${p.path}" (${p.name}). ` +
        `The user wants a button labeled "${label}". ` +
        `Generate a concise, actionable prompt (1-3 sentences) that a coding AI should execute when this button is clicked. ` +
        `Only output the prompt text, nothing else. No quotes, no explanation.`
      );
      genChild.stdin.end();

      let genOutput = "";
      genChild.stdout.on("data", (c) => { genOutput += c.toString(); });
      genChild.on("close", (code) => {
        let generatedPrompt = label; // fallback
        if (code === 0 && genOutput.trim()) {
          try {
            const parsed = JSON.parse(genOutput);
            if (parsed.result) generatedPrompt = parsed.result;
            else generatedPrompt = genOutput.trim();
          } catch {
            generatedPrompt = genOutput.trim();
          }
        }
        p.quickPrompts.push({
          id: randomUUID(),
          label,
          prompt: generatedPrompt.slice(0, 2000),
        });
        saveConfig();
        safeSend(socket, { type: "projects", projects: getProjectsList() });
      });
    }

    if (msg.type === "remove_quick_prompt") {
      if (typeof msg.projectId !== "string") return;
      if (typeof msg.promptId !== "string") return;
      const p = config.projects.find((p) => p.id === msg.projectId);
      if (!p || !p.quickPrompts) return;
      p.quickPrompts = p.quickPrompts.filter((qp) => qp.id !== msg.promptId);
      saveConfig();
      safeSend(socket, { type: "projects", projects: getProjectsList() });
    }

    if (msg.type === "update_quick_prompt") {
      if (typeof msg.projectId !== "string") return;
      if (typeof msg.promptId !== "string") return;
      const p = config.projects.find((p) => p.id === msg.projectId);
      if (!p || !p.quickPrompts) return;
      const qp = p.quickPrompts.find((q) => q.id === msg.promptId);
      if (!qp) return;
      if (typeof msg.label === "string" && msg.label.trim())
        qp.label = msg.label.trim().slice(0, 30);
      if (typeof msg.prompt === "string" && msg.prompt.trim())
        qp.prompt = msg.prompt.trim().slice(0, 2000);
      saveConfig();
      safeSend(socket, { type: "projects", projects: getProjectsList() });
    }
  });

  socket.on("close", () => {
    clearInterval(pingInterval);
    socketSessionMap.delete(socket);
    // Detach socket from running tasks — DON'T kill them
    for (const [, task] of globalTasks) {
      if (task.socket === socket) {
        task.socket = null; // output will be buffered
      }
    }
  });
});

// ═══════════════════════════════════════════════════════
// #13 — Graceful shutdown with 5s timeout
// ═══════════════════════════════════════════════════════

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Shutting down...");

  // Kill all running claude tasks
  let tasksKilled = 0;
  for (const [taskId, task] of globalTasks) {
    if (task.child && !task.child.killed) {
      task.child.kill("SIGTERM");
      tasksKilled++;
    }
  }
  if (tasksKilled > 0) {
    log.info("Sent SIGTERM to running tasks", { count: tasksKilled });
  }

  saveSessionStore();
  saveMessageStore();

  const forceTimer = setTimeout(() => {
    // Force kill any remaining tasks
    for (const [, task] of globalTasks) {
      if (task.child && !task.child.killed) {
        task.child.kill("SIGKILL");
      }
    }
    log.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 5000);

  app.close().then(() => {
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ═══════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════

const host = process.env.CAPTASK_HOST || "0.0.0.0";
const port = process.env.PORT || 3456;
await app.listen({ port, host });
log.info(`CapTask server running`, { host, port: Number(port) });
log.info(authData ? `Account: ${authData.username}` : "No account configured — create one via the web UI");
