import {spawn} from 'node:child_process';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export async function runOwnedChild({argv, cwd, env, maxMs, maxLogBytes, graceMs = 5000, reapMs = 2000,
  signal, spawnChild = (args, options) => spawn(process.execPath, args, options),
  killGroup = (pid, action) => process.kill(-pid, action), groupAlive = alive,
  onChunk = () => {}, onStarted = () => {}, thermalCheck = () => false}) {
  const startedAt = new Date().toISOString();
  let child;
  try { child = spawnChild(argv, {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']}); }
  catch (error) { return {pid: null, pgid: null, startedAt, terminalAt: new Date().toISOString(), code: 127, signal: null, reason: 'spawn-failed', spawnError: {name: error.name, code: error.code}, reaped: true, groupGone: true, keptLogBytes: 0, observedLogBytes: 0}; }
  const pid = child.pid ?? null;
  let reason = null; let bytes = 0; let keptBytes = 0; let killTimer; let closeTimer; let fallbackTimer; let finishWait;
  let cleanupError = null;
  const observedAlive = () => { try { return pid ? groupAlive(pid) : false; } catch (error) { cleanupError = {name: error.name, code: error.code}; return true; } };
  let reaped = false; let code = null; let exitSignal = null; let spawnError = null;
  const safelyKill = (action) => {
    if (!pid) return;
    try { killGroup(pid, action); } catch (error) { if (error.code !== 'ESRCH') cleanupError = {name: error.name, code: error.code}; }
  };
  const stop = (why) => {
    if (reason) return;
    reason = why; safelyKill('SIGTERM');
    killTimer = setTimeout(() => safelyKill('SIGKILL'), graceMs);
    fallbackTimer = setTimeout(() => finishWait(), graceMs + reapMs);
  };
  const onAbort = () => stop('cancelled');
  const close = new Promise((resolve) => {
    finishWait = resolve;
    child.once('error', (error) => { spawnError = {name: error.name, code: error.code}; });
    child.once('close', (value, action) => { code = value; exitSignal = action; reaped = true; resolve(); });
    closeTimer = setTimeout(() => stop('wall-limit'), maxMs);
  });
  const consume = (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    const part = data.subarray(0, Math.max(0, maxLogBytes - keptBytes));
    if (part.length) { try { onChunk(part); keptBytes += part.length; } catch { stop('log-write-failed'); } }
    if (bytes >= maxLogBytes) stop('log-limit');
  };
  child.stdout?.on('data', consume); child.stderr?.on('data', consume);
  signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) onAbort();
  const thermalTimer = setInterval(() => {
    try { if (thermalCheck()) stop('thermal-hold'); } catch { stop('thermal-observation-failed'); }
  }, 1000);
  try {
    if (pid) { try { onStarted({pid, pgid: pid, startedAt}); } catch { stop('start-ledger-failed'); } }
    await close;
    if (pid && observedAlive()) {
      stop(reason || 'descendants-remained');
      const until = Date.now() + graceMs;
      while (observedAlive() && Date.now() < until) await delay(25);
      if (observedAlive()) safelyKill('SIGKILL');
      const reapUntil = Date.now() + reapMs;
      while (observedAlive() && Date.now() < reapUntil) await delay(25);
    }
  } finally {
    clearTimeout(closeTimer); clearTimeout(killTimer); clearTimeout(fallbackTimer); clearInterval(thermalTimer);
    signal?.removeEventListener('abort', onAbort);
    if (!reaped || (pid && observedAlive())) safelyKill('SIGKILL');
    if (!reaped) { child.stdout?.destroy?.(); child.stderr?.destroy?.(); child.unref?.(); }
  }
  return {pid, pgid: pid, startedAt, terminalAt: new Date().toISOString(), code,
    signal: exitSignal, reason, observedLogBytes: bytes, keptLogBytes: keptBytes,
    truncated: bytes > keptBytes, spawnError, cleanupError, reaped, groupGone: !pid || !observedAlive()};
}
