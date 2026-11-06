// ollama.js — direct browser -> Ollama HTTP client (streaming NDJSON, cancellation, timeouts, incomplete response handling).

export class OllamaError extends Error {
  constructor(kind, message, { recoverable = false, cause, doneReason = null } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.kind = kind; // unreachable | model_missing | http | timeout | empty | incomplete | protocol | ollama | network
    this.recoverable = recoverable;
    this.cause = cause;
    this.doneReason = doneReason;
  }
}

const abortError = () => new DOMException('Aborted', 'AbortError');
const base = u => String(u || '').trim().replace(/\/+$/, '');

export const modelInstalled = (installed, name) => {
  if (!Array.isArray(installed) || !name) return false;
  const clean = n => String(n).trim().replace(/:latest$/, '');
  const target = clean(name);
  return installed.some(m => clean(m) === target || m === name || m.startsWith(name + ':'));
};

export async function listModels(baseUrl, signal) {
  let res;
  try {
    res = await fetch(base(baseUrl) + '/api/tags', { signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new OllamaError(
      'unreachable',
      `Cannot reach Ollama at ${base(baseUrl)}. Make sure it is running and that OLLAMA_ORIGINS allows this page's origin (see README).`,
      { cause: e }
    );
  }
  if (!res.ok) throw new OllamaError('http', `Ollama /api/tags returned HTTP ${res.status}`);
  const data = await res.json();
  return (data.models || []).map(m => m.name);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Retries ONLY recoverable OllamaErrors (timeouts, incomplete/empty output, 5xx, protocol glitches).
export async function withRetry(fn, { retries = 2, signal, onRetry } = {}) {
  for (let n = 0; ; n++) {
    try {
      return await fn(n);
    } catch (e) {
      if (e.name === 'AbortError' || !(e instanceof OllamaError) || !e.recoverable || n >= retries) {
        throw e;
      }
      onRetry?.(e, n + 1);
      await sleep(800 * (n + 1), signal);
    }
  }
}

/**
 * Streams /api/chat. shouldStop(text, piece, estimatedTokens) may return true to stop
 * consuming the stream early (cancelling the connection to halt generation).
 */
export async function chatStream({
  baseUrl,
  model,
  messages,
  options = {},
  format,
  signal,
  idleTimeoutMs = 180000,
  requestTimeoutMs = 600000,
  onToken,
  shouldStop
}) {
  if (signal?.aborted) throw abortError();
  const ctl = new AbortController();
  let timedOut = false;
  let userAborted = false;
  let idleTimer = null;
  let totalTimer = null;

  const onAbort = () => {
    userAborted = true;
    ctl.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, idleTimeoutMs);
  };

  if (requestTimeoutMs > 0) {
    totalTimer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, requestTimeoutMs);
  }

  let text = '';
  let chunksReceived = 0;
  let evalTokens = 0;
  let finished = false;
  let stoppedEarly = false;
  let doneReason = null;

  const body = { model, messages, stream: true, options };
  if (format) body.format = format;

  const classify = e => {
    if (e instanceof OllamaError) return e;
    if (userAborted) return abortError();
    if (timedOut) {
      return new OllamaError('timeout', `No data from Ollama for ${Math.round(idleTimeoutMs / 1000)} s (model "${model}").`, {
        recoverable: true,
        cause: e
      });
    }
    if (e.name === 'AbortError') return e;
    if (e instanceof TypeError) {
      return new OllamaError('unreachable', `Cannot reach Ollama at ${base(baseUrl)} (server down, or blocked by OLLAMA_ORIGINS/CORS).`, {
        cause: e
      });
    }
    return new OllamaError('network', `Network error: ${e.message}`, { recoverable: true, cause: e });
  };

  const handleLine = line => {
    if (!line.trim()) return false;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      throw new OllamaError('protocol', 'Malformed streaming line received from Ollama.', { recoverable: true });
    }
    if (o.error) {
      throw new OllamaError(/not found/i.test(o.error) ? 'model_missing' : 'ollama', o.error);
    }

    const piece = o.message?.content || '';
    if (piece) {
      text += piece;
      chunksReceived++;
      // Progress estimated tokens: character count / 3.8
      const estimatedTokens = Math.max(chunksReceived, Math.round(text.length / 3.8));
      onToken?.(piece, text, estimatedTokens);
      if (shouldStop?.(text, piece, estimatedTokens)) {
        stoppedEarly = true;
        return true;
      }
    }

    if (o.done) {
      finished = true;
      if (o.eval_count) evalTokens = o.eval_count;
      if (o.done_reason) doneReason = o.done_reason;
    }
    return false;
  };

  try {
    armIdle();
    let res;
    try {
      res = await fetch(base(baseUrl) + '/api/chat', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw classify(e);
    }

    if (!res.ok) {
      let msg = '';
      try {
        const j = await res.json();
        msg = j.error || '';
      } catch {
        /* ignore */
      }
      if (res.status === 404 || /not found/i.test(msg)) {
        throw new OllamaError('model_missing', `Model "${model}" is not installed. Run: ollama pull ${model}`);
      }
      throw new OllamaError('http', `Ollama HTTP ${res.status}${msg ? ': ' + msg : ''}`, { recoverable: res.status >= 500 });
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let stop = false;

    try {
      while (!stop) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle();
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (handleLine(l)) {
            stop = true;
            break;
          }
        }
      }
      if (!stop && buf.trim()) handleLine(buf);
    } catch (e) {
      throw classify(e);
    } finally {
      if (stop) await reader.cancel().catch(() => {});
    }

    if (!text.trim()) {
      throw new OllamaError('empty', `Model "${model}" returned an empty response.`, { recoverable: true });
    }

    // Incomplete stream detection
    if (!finished && !stoppedEarly) {
      throw new OllamaError('incomplete', `Model "${model}" connection closed before response finished.`, {
        recoverable: true,
        doneReason
      });
    }

    const totalTokens = evalTokens || Math.max(chunksReceived, Math.round(text.length / 3.8));
    return {
      text,
      tokens: totalTokens,
      evalCount: evalTokens,
      stoppedEarly,
      finished,
      doneReason
    };
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onAbort);
    if (!ctl.signal.aborted) ctl.abort();
  }
}
