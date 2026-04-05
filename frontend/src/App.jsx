import { useState, useRef, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import useWebSocket from "./useWebSocket.js";

const MAX_PROMPT_LENGTH = 100_000; // #12 — match server limit

// --- Quick prompt defaults (used only if project has none) ---
const DEFAULT_QUICK_PROMPTS = [
  { label: "Review", prompt: "Review the recent changes and suggest improvements" },
  { label: "Test", prompt: "Run the tests and fix any failures" },
  { label: "Build", prompt: "Build the project and fix any errors" },
  { label: "Status", prompt: "Give me a brief status of this project" },
];

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function msgKey(projectId, sessionId) {
  return sessionId ? `${projectId}:${sessionId}` : projectId;
}

// --- Syntax-highlighted code blocks ---

const CodeBlock = ({ className, children, ...props }) => {
  const match = /language-(\w+)/.exec(className || "");
  if (match) {
    return (
      <SyntaxHighlighter
        style={oneDark}
        language={match[1]}
        customStyle={{ margin: "8px 0", borderRadius: "8px", fontSize: "12px" }}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
};

// --- Sub-components ---

function ToolChip({ tools }) {
  return (
    <div className="tool-chips fade-in">
      {tools.map((t, i) => (
        <span key={i} className="tool-chip">
          <span className="tool-dot" />
          {t.name}
          {t.input?.file_path && (
            <span className="tool-detail">
              {t.input.file_path.split("/").pop()}
            </span>
          )}
          {!t.input?.file_path && t.input?.command && (
            <span className="tool-detail">
              {t.input.command.slice(0, 60)}
            </span>
          )}
          {!t.input?.file_path && !t.input?.command && t.input?.pattern && (
            <span className="tool-detail">{t.input.pattern}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function MessageBubble({ msg }) {
  if (msg.role === "tools") {
    return <ToolChip tools={msg.tools} />;
  }
  return (
    <div className={`bubble ${msg.role} fade-in`}>
      {msg.role === "user" ? (
        <span className="user-text">{msg.text}</span>
      ) : (
        <div className="markdown">
          <Markdown components={{ code: CodeBlock }}>{msg.text}</Markdown>
        </div>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="bubble assistant typing-indicator fade-in">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [step, setStep] = useState("loading"); // loading | setup | login | totp | totp-setup
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [qrData, setQrData] = useState(null);
  const [tempSession, setTempSession] = useState(null); // for TOTP setup after login

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((s) => setStep(s.accountConfigured ? "login" : "setup"))
      .catch(() => setStep("login"));
  }, []);

  // Step: create account
  const handleSetup = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (data.ok) {
        onLogin(data.sessionToken, true); // new account → prompt TOTP setup
      } else {
        setError(data.error || "Setup failed");
      }
    } catch {
      setError("Connection failed");
    }
    setLoading(false);
  };

  // Step: login with username + password
  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          totpCode: totpCode.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok && data.sessionToken) {
        onLogin(data.sessionToken, true); // no TOTP yet → prompt setup
      } else if (data.totpRequired) {
        setStep("totp");
        setError("");
      } else {
        setError(data.error || "Login failed");
      }
    } catch {
      setError("Connection failed");
    }
    setLoading(false);
  };

  // Step: enter TOTP code (credentials already verified)
  const handleTOTP = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          totpCode: totpCode.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok && data.sessionToken) {
        onLogin(data.sessionToken);
      } else {
        setError(data.error || "Invalid code");
      }
    } catch {
      setError("Connection failed");
    }
    setLoading(false);
  };

  if (step === "loading") {
    return (
      <div className="token-screen">
        <div className="token-logo">C</div>
        <h1>CapTask</h1>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="token-screen">
      <div className="token-logo">C</div>
      <h1>CapTask</h1>

      {step === "setup" && (
        <>
          <p>Create your account</p>
          <form className="login-form" onSubmit={handleSetup}>
            <input
              className="input"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
            <input
              type="password"
              className="input"
              placeholder="Password (min 6 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <button
              className="send-btn"
              type="submit"
              disabled={username.trim().length < 2 || password.length < 6 || loading}
            >
              {loading ? "..." : "Create Account"}
            </button>
          </form>
        </>
      )}

      {step === "login" && (
        <>
          <p>Sign in</p>
          <form className="login-form" onSubmit={handleLogin}>
            <input
              className="input"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
            <input
              type="password"
              className="input"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <button
              className="send-btn"
              type="submit"
              disabled={!username.trim() || !password || loading}
            >
              {loading ? "..." : "Sign In"}
            </button>
          </form>
        </>
      )}

      {step === "totp" && (
        <>
          <p>Enter Authenticator code</p>
          <form className="login-form" onSubmit={handleTOTP}>
            <input
              className="input totp-input"
              placeholder="000000"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
            />
            <button
              className="send-btn"
              type="submit"
              disabled={totpCode.length !== 6 || loading}
            >
              {loading ? "..." : "Verify"}
            </button>
          </form>
          <button className="totp-setup-link" onClick={() => { setStep("login"); setTotpCode(""); }}>
            Back
          </button>
        </>
      )}

      {error && <p className="login-error">{error}</p>}
    </div>
  );
}

function QuickPromptBar({ prompts, onUse, onExecute, onAdd, onRemove, onUpdate, generating }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");

  const resetForm = () => {
    setAdding(false);
    setEditingId(null);
    setLabel("");
    setPrompt("");
  };

  const startEdit = (qp) => {
    setEditingId(qp.id);
    setLabel(qp.label);
    setPrompt(qp.prompt);
    setAdding(true);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    if (editingId) {
      // Edit always requires prompt
      if (!prompt.trim()) return;
      onUpdate(editingId, label.trim(), prompt.trim());
    } else {
      // Add: prompt is optional — server auto-generates if empty
      onAdd(label.trim(), prompt.trim() || undefined);
    }
    resetForm();
  };

  return (
    <div className="quick-prompts-container">
      <div className="quick-prompts">
        {prompts.map((qp) => (
          <button
            key={qp.id || qp.label}
            className="quick-prompt-btn"
            onClick={() => onExecute(qp.prompt)}
            onContextMenu={(e) => {
              e.preventDefault();
              startEdit(qp);
            }}
            title={`Click: execute | Right-click: edit\n${qp.prompt}`}
          >
            {qp.label}
          </button>
        ))}
        {generating && (
          <span className="quick-prompt-btn qp-generating">
            {generating}...
          </span>
        )}
        <button
          className="quick-prompt-btn quick-prompt-add"
          onClick={() => {
            if (adding) resetForm();
            else setAdding(true);
          }}
        >
          {adding ? "\u00d7" : "+"}
        </button>
      </div>

      {adding && (
        <form className="quick-prompt-form" onSubmit={handleSubmit}>
          <input
            className="qp-input"
            placeholder="Label (e.g. Deploy)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
          <input
            className="qp-input qp-input-wide"
            placeholder={editingId ? "Prompt" : "Prompt (leave empty to auto-generate)"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button className="qp-save" type="submit" disabled={!label.trim() || (editingId && !prompt.trim())}>
            {editingId ? "Save" : prompt.trim() ? "Add" : "Auto"}
          </button>
          {editingId && (
            <button
              type="button"
              className="qp-delete"
              onClick={() => {
                onRemove(editingId);
                resetForm();
              }}
            >
              Del
            </button>
          )}
        </form>
      )}
    </div>
  );
}

function NavDrawer({
  open,
  onClose,
  projects,
  activeProject,
  sessions,
  activeSessionId,
  onSelectProject,
  onSwitchSession,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onAddProject,
  onRemoveProject,
  running,
}) {
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [addingProject, setAddingProject] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [newProjPath, setNewProjPath] = useState("");

  const commitRename = () => {
    if (renameValue.trim() && renamingId) {
      onRenameSession(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const submitNewProject = (e) => {
    e.preventDefault();
    if (newProjName.trim() && newProjPath.trim()) {
      onAddProject(newProjName.trim(), newProjPath.trim());
      setNewProjName("");
      setNewProjPath("");
      setAddingProject(false);
    }
  };

  // Sessions for the active project
  const projSessions =
    sessions.projectId === activeProject ? sessions.sessions : [];
  const activeSessId =
    sessions.projectId === activeProject ? sessions.active : null;

  return (
    <>
      <div
        className={`drawer-overlay ${open ? "open" : ""}`}
        onClick={onClose}
      />
      <div className={`drawer ${open ? "open" : ""}`}>
        <div className="drawer-header">
          <h2>Projects</h2>
          <button
            className="drawer-action-btn"
            onClick={() => setAddingProject((v) => !v)}
            title="Add project"
          >
            {addingProject ? "&#10005;" : "+"}
          </button>
        </div>

        {addingProject && (
          <form className="drawer-add-form" onSubmit={submitNewProject}>
            <input
              className="drawer-rename-input"
              placeholder="Project name"
              value={newProjName}
              onChange={(e) => setNewProjName(e.target.value)}
              autoFocus
            />
            <input
              className="drawer-rename-input"
              placeholder="/absolute/path"
              value={newProjPath}
              onChange={(e) => setNewProjPath(e.target.value)}
            />
            <button
              className="new-chat-btn"
              type="submit"
              disabled={!newProjName.trim() || !newProjPath.trim()}
            >
              Add
            </button>
          </form>
        )}

        <div className="drawer-list">
          {projects.map((p) => {
            const isActive = p.id === activeProject;
            return (
              <div key={p.id} className="drawer-project-group">
                {/* Project header */}
                <div
                  className={`drawer-project ${isActive ? "active" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isActive) {
                      onSelectProject(p.id);
                    }
                  }}
                >
                  <div className="drawer-item-info">
                    <span className="drawer-item-name">
                      {p.name}
                      {isActive && projSessions.length > 0 && (
                        <span className="drawer-badge">{projSessions.length}</span>
                      )}
                      {isActive && running && (
                        <span className="drawer-running-dot" />
                      )}
                    </span>
                    <span className="drawer-item-date" title={p.path}>
                      {p.path?.split("/").slice(-2).join("/")}
                    </span>
                  </div>
                  <div className="drawer-item-actions">
                    <button
                      className="drawer-action-btn delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Remove project "${p.name}"?`))
                          onRemoveProject(p.id);
                      }}
                      title="Remove project"
                    >
                      &#10005;
                    </button>
                  </div>
                </div>

                {/* Sessions (only for active project) */}
                {isActive && (
                  <div className="drawer-sessions">
                    {projSessions.map((s) => (
                      <div
                        key={s.id}
                        className={`drawer-item session ${s.id === activeSessId ? "active" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (s.id !== activeSessId && !running) {
                            onSwitchSession(s.id);
                            onClose();
                          }
                        }}
                      >
                        {renamingId === s.id ? (
                          <input
                            className="drawer-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <div className="drawer-item-info">
                              <span className="drawer-item-name">
                                {s.name}
                              </span>
                              <span className="drawer-item-date">
                                {formatTime(s.createdAt)}
                              </span>
                            </div>
                            <div className="drawer-item-actions">
                              <button
                                className="drawer-action-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRenamingId(s.id);
                                  setRenameValue(s.name);
                                }}
                                title="Rename"
                              >
                                &#9998;
                              </button>
                              <button
                                className="drawer-action-btn delete"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm(`Delete "${s.name}"?`))
                                    onDeleteSession(s.id);
                                }}
                                title="Delete"
                              >
                                &#10005;
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                    <button
                      className="drawer-new-session"
                      onClick={onNewSession}
                      disabled={running}
                    >
                      + New Session
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function TotpSetupScreen({ sessionToken, onDone }) {
  const [step, setStep] = useState("loading"); // loading | scan | done
  const [qrData, setQrData] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/totp/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.enabled) {
          onDone(); // already set up
        } else {
          setQrData(data);
          setStep("scan");
        }
      })
      .catch(() => setError("Connection failed"));
  }, [sessionToken, onDone]);

  const handleVerify = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/totp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, code: code.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setStep("done");
        setTimeout(onDone, 1500);
      } else {
        setError(data.error || "Invalid code");
      }
    } catch {
      setError("Connection failed");
    }
    setLoading(false);
  };

  return (
    <div className="token-screen">
      <div className="token-logo">C</div>
      <h1>Set up 2FA</h1>

      {step === "loading" && <p>Loading...</p>}

      {step === "scan" && qrData && (
        <>
          <p>Scan with MS Authenticator</p>
          <img src={qrData.qr} alt="TOTP QR" className="totp-qr" />
          <form className="login-form" onSubmit={handleVerify}>
            <input
              className="input totp-input"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
            />
            <button
              className="send-btn"
              type="submit"
              disabled={code.length !== 6 || loading}
            >
              {loading ? "..." : "Verify & Enable"}
            </button>
          </form>
          <button className="totp-setup-link" onClick={onDone}>
            Skip for now
          </button>
        </>
      )}

      {step === "done" && <p>2FA enabled! Redirecting...</p>}

      {error && <p className="login-error">{error}</p>}
    </div>
  );
}

// --- Main App ---

export default function App() {
  const [sessionToken, setSessionToken] = useState(
    () => localStorage.getItem("captask_session") || ""
  );
  const [showTotpSetup, setShowTotpSetup] = useState(false);

  const {
    connected, authError, projects, sessions, saveError, setSaveError,
    send, subscribe, on, setExpectedProject,
  } = useWebSocket(sessionToken);
  const [activeProject, setActiveProject] = useState(null);
  const [messagesMap, setMessagesMap] = useState({});
  const [input, setInput] = useState(
    () => localStorage.getItem("captask_draft") || ""
  );
  const [running, setRunning] = useState(false);
  const [activeTools, setActiveTools] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [generatingQP, setGeneratingQP] = useState(null);
  const [taskStartedAt, setTaskStartedAt] = useState(null); // Fix #2
  const [elapsed, setElapsed] = useState(0); // Fix #2
  const [lastActivity, setLastActivity] = useState(null); // Fix #2
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const currentTaskRef = useRef(null);

  // Active session ID for current project
  const activeSessionId =
    sessions.projectId === activeProject ? sessions.active : null;

  // Messages keyed by project+session
  const currentKey = msgKey(activeProject, activeSessionId);
  const messages = activeProject ? messagesMap[currentKey] || [] : [];

  // Load messages from server when session changes
  useEffect(() => {
    if (!activeProject || !activeSessionId || !connected) return;
    send({
      type: "load_messages",
      projectId: activeProject,
      sessionId: activeSessionId,
    });
  }, [activeProject, activeSessionId, connected, send]);

  // Handle messages_loaded from server
  useEffect(() => {
    const unsub = on("messages_loaded", (msg) => {
      const key = msgKey(msg.projectId, msg.sessionId);
      // Convert server format to display format
      const displayMsgs = (msg.messages || []).map((m) => {
        if (m.type === "user") return { role: "user", text: m.text, taskId: m.taskId };
        if (m.type === "task_stream") return { role: "assistant", text: m.text, taskId: m.taskId, stream: true };
        if (m.type === "task_error") return { role: "error", text: `Error: ${m.text}`, taskId: m.taskId };
        if (m.type === "task_cancelled") return { role: "error", text: "Task cancelled", taskId: m.taskId };
        return { role: "assistant", text: m.text || "", taskId: m.taskId };
      });
      // Merge consecutive stream messages from same task
      const merged = [];
      for (const m of displayMsgs) {
        const last = merged[merged.length - 1];
        if (m.stream && last?.stream && m.taskId && last.taskId === m.taskId) {
          last.text += m.text;
        } else {
          merged.push(m);
        }
      }
      setMessagesMap((prev) => ({ ...prev, [key]: merged }));
    });
    return unsub;
  }, [on]);

  // Handle live messages from other devices
  useEffect(() => {
    const unsub = on("session_message", (msg) => {
      const key = msgKey(msg.projectId, msg.sessionId);
      const m = msg.message;
      let displayMsg;
      if (m.type === "user") displayMsg = { role: "user", text: m.text, taskId: m.taskId };
      else if (m.type === "task_stream") displayMsg = { role: "assistant", text: m.text, taskId: m.taskId, stream: true };
      else if (m.type === "task_error") displayMsg = { role: "error", text: `Error: ${m.text}`, taskId: m.taskId };
      else return;
      setMessagesMap((prev) => {
        const existing = prev[key] || [];
        const last = existing[existing.length - 1];
        if (displayMsg.stream && last?.stream && last.taskId === displayMsg.taskId) {
          return {
            ...prev,
            [key]: [...existing.slice(0, -1), { ...last, text: last.text + displayMsg.text }],
          };
        }
        return { ...prev, [key]: [...existing, displayMsg] };
      });
    });
    return unsub;
  }, [on]);

  const handleLogin = (st, needsTotpSetup) => {
    localStorage.setItem("captask_session", st);
    setSessionToken(st);
    if (needsTotpSetup) {
      setShowTotpSetup(true);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("captask_session");
    setSessionToken("");
  };

  // Auto-select first project
  useEffect(() => {
    if (projects.length && !activeProject) {
      setActiveProject(projects[0].id);
    }
  }, [projects, activeProject]);

  // Fix #1: Request session list + mark expected project to ignore stale responses
  useEffect(() => {
    if (activeProject && connected) {
      setExpectedProject(activeProject);
      send({ type: "list_sessions", projectId: activeProject });
    }
  }, [activeProject, connected, send, setExpectedProject]);

  // Handle quick prompt generation status
  useEffect(() => {
    const unsub = on("quick_prompt_generating", (msg) => {
      setGeneratingQP(msg.label);
    });
    return unsub;
  }, [on]);

  // Clear generating state when projects list updates (generation done)
  useEffect(() => {
    setGeneratingQP(null);
  }, [projects]);

  // Persist draft input so it survives page refresh / app switch
  useEffect(() => {
    if (input) {
      localStorage.setItem("captask_draft", input);
    } else {
      localStorage.removeItem("captask_draft");
    }
  }, [input]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeTools]);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, [input]);

  // Re-focus textarea when task completes
  useEffect(() => {
    if (!running) inputRef.current?.focus();
  }, [running]);

  // Fix #2: Elapsed timer while task is running
  useEffect(() => {
    if (!running || !taskStartedAt) {
      setElapsed(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - taskStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [running, taskStartedAt]);

  // Offline queue — resend pending prompt on reconnect
  const offlineQueueRef = useRef(null);

  // On reconnect: reattach or replay offline queue
  useEffect(() => {
    if (connected && currentTaskRef.current) {
      send({ type: "reattach", taskId: currentTaskRef.current });
    } else if (connected) {
      setRunning(false);
      setActiveTools([]);
      // Replay offline queue
      if (offlineQueueRef.current) {
        const queued = offlineQueueRef.current;
        offlineQueueRef.current = null;
        setTimeout(() => {
          setInput(queued);
          // Auto-send after brief delay
          // User will see it in input and can edit before Enter
        }, 100);
      }
    }
  }, [connected, send]);

  const updateMessages = useCallback(
    (key, updater) => {
      setMessagesMap((prev) => ({
        ...prev,
        [key]: updater(prev[key] || []),
      }));
    },
    []
  );

  // Queue: if we need to create a session before sending, stash the prompt
  const pendingPromptRef = useRef(null);

  // When sessions update and we have a pending prompt, fire it
  useEffect(() => {
    if (pendingPromptRef.current && activeSessionId) {
      const prompt = pendingPromptRef.current;
      pendingPromptRef.current = null;
      // Defer to next tick so state is settled
      setTimeout(() => doSend(prompt), 0);
    }
  }, [activeSessionId]);

  const doSend = useCallback((prompt) => {
    if (!prompt || !activeProject || running) return;

    const sessionId = activeSessionId || sessions.active;
    if (!sessionId) {
      // Still no session — shouldn't happen, but bail
      pendingPromptRef.current = null;
      return;
    }

    // #5 — Unique ID to avoid collision across restarts
    const taskId = "t-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // #12 — Frontend prompt length check
    if (prompt.length > MAX_PROMPT_LENGTH) {
      updateMessages(msgKey(activeProject, activeSessionId), (prev) => [
        ...prev,
        {
          role: "error",
          text: `Prompt too long (${prompt.length} chars, max ${MAX_PROMPT_LENGTH})`,
        },
      ]);
      return;
    }
    currentTaskRef.current = taskId;
    setRunning(true);
    setActiveTools([]);
    setTaskStartedAt(Date.now());
    setLastActivity("Starting...");

    const key = msgKey(activeProject, activeSessionId);

    updateMessages(key, (prev) => [
      ...prev,
      { role: "user", text: prompt },
    ]);

    send({ type: "task", projectId: activeProject, prompt, taskId });

    const capturedKey = key;
    const unsub = subscribe(taskId, (msg) => {
      switch (msg.type) {
        case "task_stream":
          setActiveTools([]);
          setLastActivity("Responding...");
          updateMessages(capturedKey, (prev) => {
            const last = prev[prev.length - 1];
            if (last?.stream && last.taskId === msg.taskId) {
              return [
                ...prev.slice(0, -1),
                { ...last, text: last.text + msg.text },
              ];
            }
            return [
              ...prev,
              {
                role: "assistant",
                text: msg.text,
                stream: true,
                taskId: msg.taskId,
              },
            ];
          });
          break;
        case "task_tool":
          setActiveTools(msg.tools || []);
          setLastActivity(msg.tools?.[0]?.name || "Working...");
          updateMessages(capturedKey, (prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "tools" && last.taskId === msg.taskId) {
              return [
                ...prev.slice(0, -1),
                { ...last, tools: [...last.tools, ...msg.tools] },
              ];
            }
            return [
              ...prev,
              { role: "tools", tools: msg.tools, taskId: msg.taskId },
            ];
          });
          break;
        case "task_done":
          if (msg.result) {
            updateMessages(capturedKey, (prev) => [
              ...prev,
              { role: "assistant", text: msg.result, taskId },
            ]);
          }
          setActiveTools([]);
          setRunning(false);
          setTaskStartedAt(null);
          setLastActivity(null);
          currentTaskRef.current = null;
          // Refresh session list (server may have auto-created a session)
          send({ type: "list_sessions", projectId: activeProject });
          unsub();
          break;
        case "task_error":
          updateMessages(capturedKey, (prev) => [
            ...prev,
            { role: "error", text: `Error: ${msg.message}`, taskId },
          ]);
          setActiveTools([]);
          setRunning(false);
          setTaskStartedAt(null);
          setLastActivity(null);
          currentTaskRef.current = null;
          unsub();
          break;
        case "task_cancelled":
          updateMessages(capturedKey, (prev) => [
            ...prev,
            { role: "error", text: "Task cancelled", taskId },
          ]);
          setActiveTools([]);
          setRunning(false);
          setTaskStartedAt(null);
          setLastActivity(null);
          currentTaskRef.current = null;
          unsub();
          break;
      }
    });
  }, [activeProject, activeSessionId, running, send, subscribe, updateMessages, sessions]);

  const handleSend = useCallback(() => {
    const prompt = input.trim();
    if (!prompt || !activeProject || running) return;

    if (!activeSessionId) {
      // No session yet — create one first, queue the prompt
      pendingPromptRef.current = prompt;
      setInput("");
      send({ type: "new_session", projectId: activeProject });
      return;
    }

    setInput("");
    doSend(prompt);
  }, [input, activeProject, activeSessionId, running, send, doSend]);

  const handleCancel = useCallback(() => {
    if (currentTaskRef.current) {
      send({ type: "cancel", taskId: currentTaskRef.current });
    }
  }, [send]);

  const handleNewSession = useCallback(() => {
    if (running) return;
    send({ type: "new_session", projectId: activeProject });
  }, [running, activeProject, send]);

  const handleSwitchSession = useCallback(
    (sessionId) => {
      if (running) return;
      send({ type: "switch_session", projectId: activeProject, sessionId });
    },
    [running, activeProject, send]
  );

  const handleDeleteSession = useCallback(
    (sessionId) => {
      send({ type: "delete_session", projectId: activeProject, sessionId });
    },
    [activeProject, send]
  );

  const handleRenameSession = useCallback(
    (sessionId, name) => {
      send({
        type: "rename_session",
        projectId: activeProject,
        sessionId,
        name,
      });
    },
    [activeProject, send]
  );

  const handleProjectChange = useCallback(
    (newProjectId) => {
      if (running) {
        if (!confirm("A task is running. Switch project anyway?")) return;
      }
      setActiveProject(newProjectId);
    },
    [running]
  );

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAddProject = useCallback(
    (name, path) => {
      send({ type: "add_project", name, path });
    },
    [send]
  );

  const handleRemoveProject = useCallback(
    (projectId) => {
      send({ type: "remove_project", projectId });
      if (activeProject === projectId) {
        const remaining = projects.filter((p) => p.id !== projectId);
        setActiveProject(remaining.length ? remaining[0].id : null);
      }
    },
    [send, activeProject, projects]
  );

  // Clear expired session on auth error
  useEffect(() => {
    if (authError && sessionToken) {
      localStorage.removeItem("captask_session");
      setSessionToken("");
    }
  }, [authError, sessionToken]);

  // Conditional return AFTER all hooks
  if (!sessionToken || authError) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  if (showTotpSetup) {
    return (
      <TotpSetupScreen
        sessionToken={sessionToken}
        onDone={() => setShowTotpSetup(false)}
      />
    );
  }

  const activeProjectName =
    projects.find((p) => p.id === activeProject)?.name || "...";

  return (
    <div className="app">
      <NavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        projects={projects}
        activeProject={activeProject}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectProject={handleProjectChange}
        onSwitchSession={handleSwitchSession}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        onAddProject={handleAddProject}
        onRemoveProject={handleRemoveProject}
        running={running}
      />

      <header className="header">
        <div className="header-left">
          <button
            className="icon-btn"
            onClick={() => setDrawerOpen((v) => !v)}
            title="Projects & Sessions"
          >
            &#9776;
          </button>
          <h1>{activeProjectName}</h1>
          <span className={`status ${connected ? "on" : "off"}`}>
            {connected ? "connected" : "disconnected"}
          </span>
        </div>
        <div className="header-right">
          <button
            className="new-chat-btn"
            onClick={handleNewSession}
            disabled={running}
            title="New session"
          >
            New
          </button>
          <button
            className="logout-btn"
            onClick={handleLogout}
            title="Logout"
          >
            &#x23FB;
          </button>
        </div>
      </header>

      {saveError && (
        <div className="save-error-banner">
          <span>Save failed: {saveError}</span>
          <button
            onClick={() => {
              setSaveError(null);
              send({ type: "retry_save" });
            }}
          >
            Retry
          </button>
          <button onClick={() => setSaveError(null)}>Dismiss</button>
        </div>
      )}

      <main className="messages">
        {messages.length === 0 && (
          <div className="empty fade-in">
            <div className="empty-icon">&uarr;</div>
            <p>
              Send a task to <strong>{activeProject || "..."}</strong>
            </p>
            <span className="empty-hint">Shift+Enter for new line</span>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
        {running && activeTools.length > 0 && (
          <ToolChip tools={activeTools} />
        )}
        {running && activeTools.length === 0 && <TypingIndicator />}
        {running && (
          <div className="task-progress fade-in">
            <span className="task-progress-activity">{lastActivity}</span>
            <span className="task-progress-elapsed">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      {/* Quick prompts — dynamic per-project */}
      {!running && connected && activeProject && (
        <QuickPromptBar
          prompts={
            projects.find((p) => p.id === activeProject)?.quickPrompts ||
            DEFAULT_QUICK_PROMPTS
          }
          generating={generatingQP}
          onUse={(prompt) => {
            setInput(prompt);
            // Auto-send immediately
            setTimeout(() => {
              const el = inputRef.current;
              if (el) {
                el.value = prompt;
                el.dispatchEvent(new Event("input", { bubbles: true }));
              }
            }, 0);
          }}
          onExecute={(prompt) => {
            // Direct execute — set input and send
            setInput("");
            if (!activeSessionId) {
              pendingPromptRef.current = prompt;
              send({ type: "new_session", projectId: activeProject });
            } else {
              doSend(prompt);
            }
          }}
          onAdd={(label, prompt) => {
            send({
              type: "add_quick_prompt",
              projectId: activeProject,
              label,
              prompt,
            });
          }}
          onRemove={(promptId) => {
            send({
              type: "remove_quick_prompt",
              projectId: activeProject,
              promptId,
            });
          }}
          onUpdate={(promptId, label, prompt) => {
            send({
              type: "update_quick_prompt",
              projectId: activeProject,
              promptId,
              label,
              prompt,
            });
          }}
        />
      )}

      <footer className="input-bar">
        <textarea
          ref={inputRef}
          className="input"
          rows={1}
          placeholder={running ? "Working..." : "Describe a task..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
          enterKeyHint="send"
        />
        {running ? (
          <button className="cancel-btn" onClick={handleCancel}>
            Stop
          </button>
        ) : (
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!input.trim() || !connected || !activeProject}
          >
            Send
          </button>
        )}
      </footer>
    </div>
  );
}
