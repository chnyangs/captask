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
} from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { randomBytes, randomUUID } from "crypto";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════
// #14 — Preflight: check claude binary is available
// ═══════════════════════════════════════════════════════

try {
  execSync("which claude", { stdio: "ignore" });
} catch {
  console.error(
    "FATAL: 'claude' binary not found in PATH. Install Claude Code first."
  );
  process.exit(1);
}

// ═══════════════════════════════════════════════════════
// Project config (hot-reloadable) — #9 validate on load
// ═══════════════════════════════════════════════════════

const PROJECTS_FILE = join(__dirname, "projects.json");

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
  console.log("Created empty projects.json — add projects via the web UI");
}
let config = loadConfig();
let projectsMap = new Map(config.projects.map((p) => [p.id, p]));

watchFile(PROJECTS_FILE, { interval: 2000 }, () => {
  try {
    config = loadConfig();
    projectsMap = new Map(config.projects.map((p) => [p.id, p]));
    console.log("Reloaded projects.json");
  } catch (err) {
    console.error("Failed to reload projects.json:", err.message);
  }
});

function saveConfig() {
  const tmpFile = PROJECTS_FILE + ".tmp";
  try {
    writeFileSync(tmpFile, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpFile, PROJECTS_FILE);
  } catch (err) {
    console.error("Failed to save projects.json:", err.message);
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
// Auth
// ═══════════════════════════════════════════════════════

const AUTH_TOKEN =
  process.env.CAPTASK_TOKEN || randomBytes(32).toString("hex");

// ═══════════════════════════════════════════════════════
// Session persistence — #3 atomic writes, #4 error notify
// ═══════════════════════════════════════════════════════

const SESSION_FILE = join(__dirname, ".sessions.json");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // #11 — 30 day TTL

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
    console.error("Failed to load .sessions.json:", err.message);
    try {
      if (existsSync(SESSION_FILE)) {
        renameSync(SESSION_FILE, SESSION_FILE + ".bak");
        console.log(
          "Backed up corrupt .sessions.json to .sessions.json.bak"
        );
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
    console.error("Failed to save sessions:", err.message);
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
    console.log(`Purged ${purged} expired sessions (>30 days)`);
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

const MESSAGES_FILE = join(__dirname, ".messages.json");
const MAX_MESSAGES_PER_SESSION = 200;

function loadMessageStore() {
  try {
    if (existsSync(MESSAGES_FILE)) {
      return JSON.parse(readFileSync(MESSAGES_FILE, "utf-8"));
    }
  } catch (err) {
    console.error("Failed to load .messages.json:", err.message);
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
    console.error("Failed to save messages:", err.message);
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

const projectRunningTasks = new Map();
const MAX_PROMPT_LENGTH = 100_000;
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // #2 — 10MB buffer cap
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // #1 — 30 min timeout
const MAX_STREAM_CHUNK = 1024 * 1024; // #15 — 1MB per stream msg
const RATE_LIMIT_WINDOW_MS = 10_000; // #6
const RATE_LIMIT_MAX_TASKS = 5; // #6
const MAX_OUTPUT_BUFFER = 200; // max buffered messages for reattach

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

function runClaude(project, prompt, taskId, socket) {
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
    projectRunningTasks.set(proj.id, new Set());
  }
  projectRunningTasks.get(proj.id).add(taskId);

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
    projectRunningTasks.get(proj.id)?.delete(taskId);
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
    console.warn(
      `WARNING: Found ${pids.length} existing claude --print process(es): PIDs ${pids.join(", ")}`
    );
  }
} catch {
  // pgrep not available
}

// ═══════════════════════════════════════════════════════
// Fastify setup
// ═══════════════════════════════════════════════════════

const app = Fastify({ logger: { level: "warn" } });

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

app.get("/ws", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (token !== AUTH_TOKEN) {
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

      const running = projectRunningTasks.get(projectId);
      if (running && running.size > 0) {
        safeSend(socket, {
          type: "task_error",
          taskId,
          message:
            "A task is already running for this project. Wait or cancel it.",
        });
        return;
      }

      // Persist user message
      const sessId = getActiveSession(projectId)?.id;
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
      runClaude(project, prompt, taskId, socket);
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
  console.log("Shutting down...");
  saveSessionStore();
  saveMessageStore();

  const forceTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit");
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
console.log(`CapTask server running on http://${host}:${port}`);
console.log(`Auth token: ${AUTH_TOKEN}`);
