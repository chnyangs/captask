#!/usr/bin/env node
/**
 * CapTask Admin CLI — one-off management tasks (12-Factor #12)
 *
 * Usage:
 *   node admin.mjs <command> [options]
 *
 * Commands:
 *   status          Show system status (accounts, sessions, messages)
 *   reset-password  Reset account password
 *   reset-totp      Remove 2FA (TOTP) so it can be re-setup
 *   purge-sessions  Delete sessions older than N days (default: 30)
 *   purge-messages  Delete messages for non-existent sessions
 *   backup          Create a backup of all data files
 *   restore         Restore from a backup directory
 *   list-projects   List configured projects
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHmac, randomBytes } from "crypto";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CAPTASK_DATA_DIR || __dirname;

const AUTH_FILE = join(DATA_DIR, ".auth.json");
const TOTP_FILE = join(DATA_DIR, ".totp-secret.json");
const SESSION_FILE = join(DATA_DIR, ".sessions.json");
const MESSAGES_FILE = join(DATA_DIR, ".messages.json");
const PROJECTS_FILE = join(DATA_DIR, "projects.json");

const DATA_FILES = [AUTH_FILE, TOTP_FILE, SESSION_FILE, MESSAGES_FILE, PROJECTS_FILE];

function loadJSON(path) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8"));
  } catch { /* ignore */ }
  return null;
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function hashPwd(password, salt) {
  return createHmac("sha256", salt).update(password).digest("hex");
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Commands ──

function cmdStatus() {
  const auth = loadJSON(AUTH_FILE);
  const totp = loadJSON(TOTP_FILE);
  const sessions = loadJSON(SESSION_FILE) || {};
  const messages = loadJSON(MESSAGES_FILE) || {};
  const projects = loadJSON(PROJECTS_FILE);

  console.log("\n=== CapTask Status ===\n");
  console.log(`Data directory: ${DATA_DIR}`);

  // Account
  if (auth) {
    console.log(`Account: ${auth.username}`);
    console.log(`2FA: ${totp?.verified ? "enabled" : "not enabled"}`);
  } else {
    console.log("Account: not configured");
  }

  // Projects
  const projectList = projects?.projects || [];
  console.log(`Projects: ${projectList.length}`);
  for (const p of projectList) {
    console.log(`  - ${p.name} (${p.path})`);
  }

  // Sessions
  let totalSessions = 0;
  let totalMessages = 0;
  for (const [projectId, entry] of Object.entries(sessions)) {
    const sessCount = entry.sessions?.length || 0;
    totalSessions += sessCount;
  }
  for (const [key, msgs] of Object.entries(messages)) {
    totalMessages += Array.isArray(msgs) ? msgs.length : 0;
  }
  console.log(`Sessions: ${totalSessions}`);
  console.log(`Messages: ${totalMessages}`);
  console.log();
}

async function cmdResetPassword() {
  const auth = loadJSON(AUTH_FILE);
  if (!auth) {
    console.error("No account configured.");
    process.exit(1);
  }

  const password = await ask(`New password for "${auth.username}": `);
  if (password.length < 6) {
    console.error("Password must be at least 6 characters.");
    process.exit(1);
  }

  const salt = randomBytes(16).toString("hex");
  auth.passwordHash = hashPwd(password, salt);
  auth.salt = salt;
  saveJSON(AUTH_FILE, auth);
  console.log(`Password reset for "${auth.username}".`);
}

function cmdResetTOTP() {
  if (!existsSync(TOTP_FILE)) {
    console.log("2FA is not configured.");
    return;
  }
  const totp = loadJSON(TOTP_FILE);
  if (totp) {
    // Keep secret but mark as unverified — user must re-scan QR
    saveJSON(TOTP_FILE, { secret: totp.secret, verified: false });
    console.log("2FA reset. User will be prompted to re-setup on next login.");
  }
}

function cmdPurgeSessions() {
  const days = parseInt(process.argv[3] || "30", 10);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const sessions = loadJSON(SESSION_FILE);
  if (!sessions) {
    console.log("No sessions file found.");
    return;
  }

  let purged = 0;
  for (const [projectId, entry] of Object.entries(sessions)) {
    if (!entry.sessions) continue;
    const before = entry.sessions.length;
    entry.sessions = entry.sessions.filter((s) => (s.createdAt || 0) > cutoff);
    purged += before - entry.sessions.length;
    if (entry.active >= entry.sessions.length) {
      entry.active = Math.max(0, entry.sessions.length - 1);
    }
  }
  saveJSON(SESSION_FILE, sessions);
  console.log(`Purged ${purged} sessions older than ${days} days.`);
}

function cmdPurgeMessages() {
  const sessions = loadJSON(SESSION_FILE) || {};
  const messages = loadJSON(MESSAGES_FILE);
  if (!messages) {
    console.log("No messages file found.");
    return;
  }

  // Build set of valid session keys
  const validKeys = new Set();
  for (const [projectId, entry] of Object.entries(sessions)) {
    for (const s of entry.sessions || []) {
      validKeys.add(`${projectId}:${s.id}`);
    }
  }

  let purged = 0;
  for (const key of Object.keys(messages)) {
    if (!validKeys.has(key)) {
      delete messages[key];
      purged++;
    }
  }
  saveJSON(MESSAGES_FILE, messages);
  console.log(`Purged messages for ${purged} orphaned sessions.`);
}

function cmdBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = join(DATA_DIR, `backup-${ts}`);
  mkdirSync(backupDir, { recursive: true });

  let count = 0;
  for (const f of DATA_FILES) {
    if (existsSync(f)) {
      const name = f.split("/").pop();
      copyFileSync(f, join(backupDir, name));
      count++;
    }
  }
  console.log(`Backed up ${count} files to ${backupDir}`);
}

function cmdRestore() {
  const backupDir = process.argv[3];
  if (!backupDir || !existsSync(backupDir)) {
    console.error("Usage: node admin.mjs restore <backup-directory>");
    process.exit(1);
  }

  let count = 0;
  for (const f of DATA_FILES) {
    const name = f.split("/").pop();
    const src = join(backupDir, name);
    if (existsSync(src)) {
      copyFileSync(src, f);
      count++;
    }
  }
  console.log(`Restored ${count} files from ${backupDir}`);
}

function cmdListProjects() {
  const projects = loadJSON(PROJECTS_FILE);
  if (!projects?.projects?.length) {
    console.log("No projects configured.");
    return;
  }
  console.log("\nProjects:\n");
  for (const p of projects.projects) {
    const exists = existsSync(p.path) ? "OK" : "MISSING";
    console.log(`  ${p.name} [${p.id}]`);
    console.log(`    Path: ${p.path} (${exists})`);
    if (p.description) console.log(`    Desc: ${p.description}`);
    console.log();
  }
}

// ── Main ──

const cmd = process.argv[2];
const commands = {
  status: cmdStatus,
  "reset-password": cmdResetPassword,
  "reset-totp": cmdResetTOTP,
  "purge-sessions": cmdPurgeSessions,
  "purge-messages": cmdPurgeMessages,
  backup: cmdBackup,
  restore: cmdRestore,
  "list-projects": cmdListProjects,
};

if (!cmd || !commands[cmd]) {
  console.log(`
CapTask Admin CLI

Usage: node admin.mjs <command> [options]

Commands:
  status            Show system status
  reset-password    Reset account password
  reset-totp        Remove 2FA for re-setup
  purge-sessions    Delete old sessions (default: 30 days)
                    Usage: node admin.mjs purge-sessions [days]
  purge-messages    Delete orphaned messages
  backup            Create backup of all data files
  restore           Restore from backup directory
                    Usage: node admin.mjs restore <backup-dir>
  list-projects     List configured projects

Environment:
  CAPTASK_DATA_DIR  Data directory (default: current directory)
`);
  process.exit(cmd ? 1 : 0);
}

await commands[cmd]();
