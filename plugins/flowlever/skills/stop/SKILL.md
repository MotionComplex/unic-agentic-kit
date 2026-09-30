---
name: stop
description: >
  Stop the FlowLever cockpit — kill the local dashboard server and cleanly end the /flowlever:watch
  loop. Use when the user says "/flowlever:stop", "stop flowlever", "stop the cockpit", "kill the
  server", "shut down flowlever", or "stop the watch loop".
---

# /flowlever:stop — stop the cockpit

Cleanly shuts FlowLever down: the dashboard server (a background process) and the watch loop (running
in this session).

## Procedure
1. **Stop the server** (it listens on a port; default 4173, or `$PORT`).
   **CRITICAL: filter to the LISTENING socket with `-sTCP:LISTEN`.** Without it, `lsof -ti tcp:<port>`
   also returns *client* PIDs connected to that port — including the user's **browser** — and `xargs kill`
   would kill the browser too.
   ```
   lsof -ti tcp:${PORT:-4173} -sTCP:LISTEN | xargs kill 2>/dev/null && echo "stopped server on :${PORT:-4173}" || echo "no server on :${PORT:-4173}"
   ```
   This stops only the FlowLever server process — no state is lost (all data is on disk), and your browser
   tab stays open (it just can't reach the server until you `/flowlever:start` again).
2. **End the watch loop** by dropping a stop sentinel the loop checks on its next wake:
   ```
   mkdir -p "${FLOWLEVER_DATA:-$HOME/.flowlever}" && : > "${FLOWLEVER_DATA:-$HOME/.flowlever}/.watch-stop"
   ```
   The next `/flowlever:watch` pass sees this file, deletes it, and exits the loop instead of
   rescheduling. If a `/loop` is driving `/flowlever:watch`, also stop that loop directly so it doesn't
   immediately respawn.
3. Confirm to the user: server stopped, watch loop will end on its next tick. Data is safe on disk
   (`${FLOWLEVER_DATA:-$HOME/.flowlever}`); `/flowlever:start` brings everything back exactly as it was.
