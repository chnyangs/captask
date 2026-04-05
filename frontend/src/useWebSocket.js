import { useEffect, useRef, useState, useCallback } from "react";

// #10 — Exponential backoff: 2s → 4s → 8s → 16s → 30s cap
function getBackoff(attempt) {
  return Math.min(2000 * Math.pow(2, attempt), 30000);
}

export default function useWebSocket(token) {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [projects, setProjects] = useState([]);
  const [authError, setAuthError] = useState(false);
  const [sessions, setSessions] = useState({ active: null, sessions: [] });
  const [saveError, setSaveError] = useState(null);
  const listenersRef = useRef(new Map());
  const eventHandlersRef = useRef(new Map());
  // Fix #1: track which project was requested, ignore stale responses
  const expectedProjectRef = useRef(null);

  const subscribe = useCallback((taskId, handler) => {
    listenersRef.current.set(taskId, handler);
    return () => listenersRef.current.delete(taskId);
  }, []);

  const on = useCallback((eventType, handler) => {
    eventHandlersRef.current.set(eventType, handler);
    return () => eventHandlersRef.current.delete(eventType);
  }, []);

  const send = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    if (!token) return;

    // Reset auth error when starting a new connection with a new token
    setAuthError(false);

    let reconnectTimer;
    let attempt = 0;
    let disposed = false; // prevent stale onclose from setting authError

    function connect() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${protocol}//${location.host}/ws?session=${encodeURIComponent(token)}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempt = 0;
        listenersRef.current.clear();
        setConnected(true);
        setAuthError(false);
      };

      ws.onclose = (e) => {
        if (disposed) return;
        setConnected(false);
        if (e.code === 4001) {
          setAuthError(true);
          return;
        }
        const delay = getBackoff(attempt);
        attempt++;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "projects") {
          setProjects(msg.projects);
          return;
        }
        if (msg.type === "sessions_list") {
          // Fix #1: ignore stale responses from a previous project
          if (
            expectedProjectRef.current &&
            msg.projectId !== expectedProjectRef.current
          ) {
            return;
          }
          setSessions({
            projectId: msg.projectId,
            active: msg.active,
            sessions: msg.sessions,
          });
          return;
        }
        if (msg.type === "save_error") {
          setSaveError(msg.message);
          return;
        }
        // Generic event handlers
        const eventHandler = eventHandlersRef.current.get(msg.type);
        if (eventHandler) {
          try {
            eventHandler(msg);
          } catch {
            // ignore
          }
          return;
        }
        // Task-specific handlers
        const handler = listenersRef.current.get(msg.taskId);
        if (handler) {
          try {
            handler(msg);
          } catch {
            // prevent handler error from breaking socket
          }
        }
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [token]);

  const setExpectedProject = useCallback((projectId) => {
    expectedProjectRef.current = projectId;
  }, []);

  return { connected, authError, projects, sessions, saveError, setSaveError, send, subscribe, on, setExpectedProject };
}
