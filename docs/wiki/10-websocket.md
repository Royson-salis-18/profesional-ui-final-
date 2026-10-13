# WebSocket — Broadcast Hub & Terminal Multiplexer

**File:** `server/api/websocket.ts`

---

## Design: One Port for Everything

Both the REST API and WebSocket live on the same HTTP server on port **3001**. The `WebSocketServer` is attached with `{ server }` — it intercepts HTTP upgrade requests rather than binding its own port.

**Why not separate ports?** Simpler deployment — one port to open, one NGINX `location` block, one firewall rule. The tradeoff (slightly more complex URL routing) is negligible for this use case.

**Why `ws` and not Socket.io?** Zero overhead. Socket.io adds a custom protocol layer, reconnection logic, namespaces, and rooms on top of raw WebSocket. All of those features are implemented manually here in a much simpler way. The total `ws` package size is ~65KB vs Socket.io's ~300KB.

---

## Message Format

All messages (both directions) use the same envelope:

```typescript
interface WsMessage {
  type: string;
  data: any;
}

// Serialized as:
ws.send(JSON.stringify({ type, data }));
```

---

## Role 1: Graph Broadcast

```typescript
broadcast(type: string, data: any) {
  const payload = JSON.stringify({ type, data });
  for (const client of this.wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
```

### Server → Client Events

| `type` | `data` | When sent |
|---|---|---|
| `graph-update` | `{ nodes, edges, targets }` | Every 5s (polling interval) + immediately after `ingestRemote()` or `handleTopologyDiscovered()` |
| `incident.updated` | `Incident` object | RCA evaluation detects or updates an incident |
| `trace-events` | `{ targetId, events: ConnectionEvent[] }` | Immediately when TCP events arrive in `ingestRemote()` |
| `TERMINAL_LOG` | `string` | Stdout/stderr line from bash/SSH child process |

**No backpressure:** Clients that are too slow to consume messages will fall behind. Acceptable here — the UI is monitoring display, not transactional processing. Stale data is preferable to blocking the server.

---

## Role 2: Terminal Multiplexer

### Architecture

```
Client (TerminalPanel)
  → ws.send({ type: 'TERMINAL_EXEC', data: { cmd, targetId } })

WebSocketManager.handleTerminalExec(ws, { cmd, targetId })
  ├── Check for existing live session (per ws connection)
  │    └── Discard if killed or stdin destroyed
  ├── No session: spawn new
  │    ├── Local:  spawn('bash', ['--login'])
  │    └── Remote: spawn('ssh', ['-tt', '-F', '/dev/null',
  │                              '-i', keyPath,
  │                              '-o', 'StrictHostKeyChecking=no',
  │                              `${user}@${ip}`])
  └── Write to stdin:
       session.stdin.write(`${cmd}\n`)
       session.stdin.write(`echo ___CMD_DONE___$?\n`)   ← sentinel
```

### Session Management

One session (`ChildProcess`) per WebSocket connection:

```typescript
private sessions = new Map<WebSocket, ChildProcess>();
```

**Session reuse:** Subsequent commands from the same browser tab are written to the same bash/SSH process — preserving working directory, environment variables, and shell state between commands.

**Session cleanup:**
- On WS disconnect: `session.kill()` is called
- On next command arrival: if `session.killed || session.exitCode !== null || session.stdin?.destroyed`, the stale session is discarded and a new one is spawned

### Sentinel Pattern

PTY allocation (`-t` flag) and interactive session detection (`stdin.isTTY`) can cause issues. Instead of PTY, the collector uses a sentinel string:

```typescript
const SENTINEL = '___CMD_DONE___';

// After writing the command:
session.stdin.write(`${cmd}\n`);
session.stdin.write(`echo ${SENTINEL}$?\n`);  // $? = exit code of previous command

// In stdout handler:
session.stdout.on('data', (out) => {
  const str = out.toString();
  if (str.includes(SENTINEL)) {
    // Strip the sentinel line from output
    const cleanStr = str.replace(new RegExp(`${SENTINEL}.*?\\n?`, 'g'), '');
    if (cleanStr) ws.send(JSON.stringify({ type: 'TERMINAL_LOG', data: cleanStr }));
    // (Could emit a 'command-done' event here in future)
  } else {
    ws.send(JSON.stringify({ type: 'TERMINAL_LOG', data: str }));
  }
});
```

This gives pseudo-PTY-like behavior (knowing when a command finishes) without requiring `pty.js` or similar native addons.

### SSH Config Lookup

If `targetId` is provided in the `TERMINAL_EXEC` message, the handler reads `data/remote_config.json` to find the EC2 IP and key path:

```typescript
if (data.targetId) {
  const configPath = path.join(process.cwd(), 'data', 'remote_config.json');
  if (fs.existsSync(configPath)) {
    const conf = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const tConf = conf[data.targetId];
    if (tConf) {
      targetIp  = tConf.ec2PublicIp  || targetIp;
      targetKey = tConf.sshKeyPath   || targetKey;
      sshUser   = tConf.sshUsername  || sshUser;
    }
  }
}
```

**No credentials in WebSocket messages:** The client just sends `{ cmd, targetId }`. Credentials are looked up server-side from the config file. This means SSH keys never travel over WebSocket.

### Key Path Resolution

```typescript
function resolveKeyPath(keyPath: string): string {
  return keyPath.startsWith('~/') 
    ? path.join(os.homedir(), keyPath.slice(2)) 
    : keyPath;
}
```

The `~` prefix is expanded using `os.homedir()` — same behavior as a shell would provide but without spawning a shell just for path resolution.

---

## Client-Side WebSocket Handling

**File:** `client/src/hooks/useGraphData.ts`

```typescript
const connectWs = () => {
  const wsUrl = `ws://${window.location.host}/ws`;
  const socket = new WebSocket(wsUrl);
  ws.current = socket;

  socket.onopen  = () => setIsConnected(true);
  socket.onclose = () => { setIsConnected(false); setTimeout(connectWs, 3000); };
  socket.onerror = () => socket.close();

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case 'graph-update':
        // Position-preserving node update (see 09-frontend.md)
        break;
      case 'incident.updated':
        setIncidents(prev => updateOrAppend(prev, message.data));
        break;
      case 'trace-events':
        setTraceEvents(prev => [...prev.slice(-500), ...message.data.events]);
        break;
      case 'TERMINAL_LOG':
        setTerminalLogs(prev => [...prev, message.data]);
        break;
    }
  };
};
```

The connection URL uses `window.location.host` so it works correctly regardless of whether the app is served locally (`localhost:5173`) or behind an NGINX proxy.
