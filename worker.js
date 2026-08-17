const DEFAULT_CODEBUFF_API = "https://www.codebuff.com";
let configuredCodebuffApi = DEFAULT_CODEBUFF_API;
// Freebuff CLI 0.0.149 wire constants. Keep these values centralized so the
// adapter cannot silently drift between session, prompt, and compatibility
// requests. fingerprintId is deliberately not a chat-wide header.
const FREEBUFF_CLI_USER_AGENT = "ai-sdk/openai-compatible/0.0.149/codebuff";
const FREEBUFF_MODEL_HEADER = "x-freebuff-model";
const FREEBUFF_INSTANCE_HEADER = "x-freebuff-instance-id";
const FREEBUFF_COMPACT_SESSION_HEADER = "x-freebuff-compact-session";
const adSessionIds = new Map();
function adSessionIdFor(token, env) {
  if (env?.FREEBUFF_CHAT_SESSION_ID) return String(env.FREEBUFF_CHAT_SESSION_ID);
  if (!adSessionIds.has(token)) adSessionIds.set(token, crypto.randomUUID());
  return adSessionIds.get(token);
}
const adActivity = new Map();
function adsBehaviorDue(token, context, env) {
  const now = Date.now();
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const latestUser = [...messages].reverse().find((message) => message?.role === "user");
  const activityKey = typeof latestUser?.content === "string" ? latestUser.content : "";
  const state = adActivity.get(token) || { activityKey: "", lastFetch: 0, lastActivity: 0, fetches: 0 };
  if (activityKey && activityKey !== state.activityKey) {
    state.activityKey = activityKey;
    state.lastActivity = now;
    state.fetches = 0;
  }
  const force = String(env?.FREEBUFF_AD_FORCE_START || "false").toLowerCase() === "true";
  if (!state.lastFetch) { if (!(force || activityKey)) { adActivity.set(token, state); return false; } }
  else if (now - state.lastFetch < 60000 || now - state.lastActivity > 30000 || state.fetches >= 3) { adActivity.set(token, state); return false; }
  state.lastFetch = now;
  state.fetches += 1;
  adActivity.set(token, state);
  return true;
}
const FREEBUFF_ACTING_USER_HEADER = "x-freebuff-acting-user-id";

function freebuffAuthHeaders(token, extra = {}) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function freebuffSessionModelHeaders(model) {
  return { [FREEBUFF_MODEL_HEADER]: model };
}

function freebuffSessionInstanceHeaders(instanceId) {
  return { [FREEBUFF_INSTANCE_HEADER]: instanceId };
}
function freebuffSessionGetHeaders(env, instanceId) {
  const headers = instanceId ? freebuffSessionInstanceHeaders(instanceId) : {};
  if (String(env?.FREEBUFF_COMPACT_SESSION || "false").toLowerCase() === "true") {
    headers[FREEBUFF_COMPACT_SESSION_HEADER] = "1";
  }
  return headers;
}

function freebuffChatHeaders(token, instanceId) {
  return freebuffAuthHeaders(token, {
    "Content-Type": "application/json",
    "User-Agent": FREEBUFF_CLI_USER_AGENT,
    [FREEBUFF_INSTANCE_HEADER]: instanceId,
  });
}

function codebuffApi() {
  return configuredCodebuffApi;
}
const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
const VERSION = "1.9.0";

// Freebuff CLI 0.0.149 uses the base3 harness. Keep this catalog limited to the
// ordinary CLI picker; entitlement- or capacity-gated models are not advertised.
const MODELS = [
  { id: "deepseek/deepseek-v4-pro", session: "deepseek/deepseek-v4-pro", agent: "base3-free-deepseek", upstream: "deepseek/deepseek-v4-pro" },
  { id: "deepseek/deepseek-v4-flash", session: "deepseek/deepseek-v4-flash", agent: "base3-free-deepseek-flash", upstream: "deepseek/deepseek-v4-flash" },
  { id: "openai/gpt-5.6-luna", session: "openai/gpt-5.6-luna", agent: "base3-free-luna", upstream: "openai/gpt-5.6-luna" },
  { id: "minimax/minimax-m3", session: "minimax/minimax-m3", agent: "base3-free-minimax-m3", upstream: "minimax/minimax-m3" },
  { id: "mimo/mimo-v2.5", session: "mimo/mimo-v2.5", agent: "base3-free-mimo", upstream: "mimo/mimo-v2.5" },
];

// Quota classification is used only for interpreting an already-observed
// session snapshot. It never adds models to the public catalog.
const PREMIUM_QUOTA_MODELS = new Set([
  "deepseek/deepseek-v4-pro",
  "openai/gpt-5.6-luna",
  "minimax/minimax-m3",
]);
const STANDARD_MODELS = new Set([
  "deepseek/deepseek-v4-flash",
  "mimo/mimo-v2.5",
]);

function modelPoolCategory(modelId) {
  if (PREMIUM_QUOTA_MODELS.has(modelId)) return "premium";
  if (STANDARD_MODELS.has(modelId)) return "standard";
  return null;
}

export default {
  async fetch(request, env) {
    configuredCodebuffApi = String(env.CODEBUFF_API || DEFAULT_CODEBUFF_API).replace(/\/$/, "");
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    // Public liveness endpoint: expose aggregates only, never token/uid prefixes
    // or per-account state labels.
    if (request.method === "GET" && url.pathname === "/healthz") {
      const summary = summarizeAccountHealth(parseAccounts(env), acctHealth);
      return jsonResponse({
        status: summary.status,
        version: VERSION,
        accounts: summary.accounts,
        alive_accounts: summary.alive_accounts,
        unknown_accounts: summary.unknown_accounts,
        unhealthy_accounts: summary.unhealthy_accounts,
        health_source: "worker_cache",
        time: new Date().toISOString(),
      }, 200);
    }

    const key = getApiKey(request, env);
    if (!key) {
      if (url.pathname === "/v1/messages" || url.pathname === "/messages" || url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens") {
        return anthropicError("Invalid API key", "authentication_error", 401);
      }
      return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
    }

    cleanCache();

    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return await handleModels(env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return handleChat(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      return handleResponses(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens")) {
      return handleAnthropicCountTokens(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      return handleAnthropicMessages(request, env);
    }
    return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
  },
};

// ---------------------------------------------------------------------------
// 账号池
// ---------------------------------------------------------------------------

let accountIdx = 0;
const cooldowns = new Map();      // `${token}:${model || "*"}` -> 冷却到期 ms
const sessCache = new Map();      // `${token}:${sessionModel}` -> { instanceId, model, remainingMs, expiresAt }（必须带 token，多账号防串号）
const supersededTokens = new Set(); // 官方语义：本进程一旦被 supersede，不再重新抢占该账号 session
// Responses previous_response_id -> protocol continuation context.  The
// official CLI keeps one agent run open while the model asks the client to
// execute tools; retaining the run id here lets a Responses client continue
// that same run without giving the adapter a local tool runtime.
const responseTraceCache = new Map(); // response id -> { traceSessionId, runId, token, model, instanceId, totalSteps, steps, active, checkedAt }
// Harness drives Chat Completions as a multi-step loop.  Keep the native run
// open between tool-call and tool-result requests when it supplies a stable
// session id; this is intentionally separate from Responses' response-id
// cache and expires with ordinary in-memory cache cleanup.
const harnessRunCache = new Map(); // `${sessionId}:${model}` -> { token, instanceId, run, checkedAt }

// Freebuff's base3 endpoint only advertises the native CLI tool names.  The
// DeepSeek Harness uses a deliberately generic tool catalog (bash/read/write
// ...).  In opt-in harness mode we translate only the names, preserving the
// caller's schemas and arguments; responses are translated back before they
// leave this adapter.  The default path remains byte-for-byte compatible with
// existing OpenAI/Anthropic clients.
const HARNESS_TOOL_ALIASES = {
  bash: "run_terminal_command",
  read: "read_files",
  write: "write_file",
  edit: "str_replace",
  todo_write: "write_todos",
  glob: "list_directory",
  grep: "code_search",
  web_fetch: "read_url",
  ask_user_question: "ask_user",
  subagent: "suggest_followups",
};

function harnessToolMode(env) {
  return String(env?.FREEBUFF_CLIENT_BEHAVIOR || "").toLowerCase() === "harness";
}

function toolAliasFor(name, aliases = HARNESS_TOOL_ALIASES) {
  return aliases[name] || name;
}

function invertToolAliases(aliases = HARNESS_TOOL_ALIASES) {
  const inverse = new Map();
  for (const [clientName, upstreamName] of Object.entries(aliases)) {
    // Do not create an ambiguous reverse mapping.  A duplicate would make it
    // impossible to deterministically restore a streamed tool call.
    if (!inverse.has(upstreamName)) inverse.set(upstreamName, clientName);
  }
  return inverse;
}

function mapToolMessages(messages, aliases = HARNESS_TOOL_ALIASES) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (!Array.isArray(message.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => ({
        ...call,
        function: call.function && typeof call.function === "object"
          ? { ...call.function, name: toolAliasFor(call.function.name, aliases) }
          : call.function,
      })),
    };
  });
}

function mapClientTools(params, enabled) {
  if (!enabled || !Array.isArray(params?.tools)) return params;
  const aliases = HARNESS_TOOL_ALIASES;
  const seen = new Set();
  const tools = [];
  for (const tool of params.tools) {
    if (!tool || typeof tool !== "object") continue;
    // Chat and Harness both use the OpenAI function wrapper here. Responses
    // flattening is completed before executeChat() receives these params.
    const fn = tool.type === "function" && tool.function && typeof tool.function === "object"
      ? tool.function
      : tool;
    const clientName = fn.name || "";
    const upstreamName = toolAliasFor(clientName, aliases);
    if (!clientName || seen.has(upstreamName)) continue;
    seen.add(upstreamName);
    if (tool.type === "function" && tool.function) {
      tools.push({ ...tool, function: { ...tool.function, name: upstreamName } });
    } else {
      tools.push({ ...tool, name: upstreamName });
    }
  }
  let toolChoice = params.tool_choice;
  if (typeof toolChoice === "string") toolChoice = toolAliasFor(toolChoice, aliases);
  else if (toolChoice && typeof toolChoice === "object" && toolChoice.function && typeof toolChoice.function === "object") {
    toolChoice = { ...toolChoice, function: { ...toolChoice.function, name: toolAliasFor(toolChoice.function.name, aliases) } };
  }
  return { ...params, tools, tool_choice: toolChoice, messages: mapToolMessages(params.messages, aliases) };
}

function normalizeCredentialObject(credential) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) return null;
  const token = typeof credential.authToken === "string" ? credential.authToken.trim() : "";
  const fingerprintId = typeof credential.fingerprintId === "string" ? credential.fingerprintId.trim() : "";
  if (token.length <= 8 || !fingerprintId) return null;
  return {
    token,
    // Keep the fingerprint on the same account record as authToken.
    fingerprintId,
  };
}

function parseOfficialCredentials(raw) {
  if (!raw || typeof raw !== "string") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch { return []; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const topLevelKeys = Object.keys(parsed);
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== "accounts") return [];
  if (!parsed.accounts || typeof parsed.accounts !== "object" || Array.isArray(parsed.accounts)) return [];
  const entries = Object.values(parsed.accounts);
  if (entries.length === 0) return [];
  const normalized = entries.map(normalizeCredentialObject);
  if (normalized.some((credential) => !credential)) return [];
  return normalized;
}

function parseAccounts(env) {
  // The only accepted credential document is:
  // { "accounts": { "account-key": { authToken, fingerprintId } } }.
  // Each normalized record keeps authToken and its matching fingerprintId together.
  const seen = new Set();
  const accounts = [];
  for (const credential of parseOfficialCredentials(env.FREEBUFF_CREDENTIALS_JSON)) {
    const existing = accounts.find((account) => account.token === credential.token);
    if (existing) {
      continue;
    }
    accounts.push(credential);
  }
  return accounts.filter((account) => {
    if (account.token.length <= 8 || seen.has(account.token)) return false;
    seen.add(account.token);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 账号健康探测（v1.6.0）：GET /api/v1/me 不消耗 session/额度，探测 token 有效性并自动发现 uid
// ---------------------------------------------------------------------------

const acctHealth = new Map(); // token -> { alive, state, uid, quota, checkedAt }
const HEALTH_OBSERVATION_TTL_MS = 10 * 60 * 1000;

// 固定公开快照的 cli/src/utils/freebuff-session-api.ts 明确解码的 session
// admission 响应。状态、HTTP code 与方法须同时匹配；这不是对未知状态的推断。
const DOCUMENTED_SESSION_ADMISSION_STATES = {
  banned: { status: 403, methods: new Set(["GET", "POST"]) },
  country_blocked: { status: 403, methods: new Set(["GET", "POST"]) },
  model_locked: { status: 409, methods: new Set(["POST"]) },
  model_unavailable: { status: 409, methods: new Set(["POST"]) },
  rate_limited: { status: 429, methods: new Set(["POST"]) },
  spend_limited: { status: 429, methods: new Set(["POST"]) },
  ip_capped: { status: 429, methods: new Set(["POST"]) },
};

function documentedSessionAdmissionState(method, status, data) {
  const state = data && typeof data === "object" ? data.status : null;
  const rule = typeof state === "string" ? DOCUMENTED_SESSION_ADMISSION_STATES[state] : null;
  return rule && rule.status === status && rule.methods.has(method) ? state : null;
}

function documentedSessionRetryAfterMs(data) {
  const retryAfterMs = data && typeof data === "object" ? Number(data.retryAfterMs) : NaN;
  return Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null;
}

class SessionAdmissionError extends Error {
  constructor(method, status, state, data) {
    const detail = data && typeof data === "object"
      ? String(data.message || data.availableHours || data.requestedModel || "").slice(0, 300)
      : "";
    super("freebuff session " + method + " admission " + state + (detail ? ": " + detail : ""));
    this.name = "SessionAdmissionError";
    this.status = status;
    this.state = state;
    this.retryAfterMs = documentedSessionRetryAfterMs(data);
  }
}

// 只记录真实业务请求已经观察到的上游结果。不要在 healthz 中主动探测，
// 也不要把网络错误/未知响应误记成账号失效。
function recordAccountObservation(token, status, dataOrText, extra = {}) {
  if (!token) return;
  let data = dataOrText;
  if (typeof dataOrText === "string") {
    try { data = JSON.parse(dataOrText); } catch { data = null; }
  }
  const upstreamState = data && typeof data === "object" ? data.status || data.state : null;
  let state = null;
  const documented = documentedSessionAdmissionState("POST", status, data) || documentedSessionAdmissionState("GET", status, data);
  if (status === 404) state = "ok";
  else if (documented) state = documented;
  else if (status >= 200 && status < 300) state = "ok";
  else if (status === 401) state = "token_invalid";
  else if (status === 403) {
    state = upstreamState === "banned"
      ? "banned"
      : upstreamState === "country_blocked" ? "country_blocked" : "blocked";
  } else if (status === 429) state = "rate_limited";
  if (!state) return;

  const previous = acctHealth.get(token) || {};
  const invalidStates = new Set(["token_invalid", "banned", "country_blocked", "blocked"]);
  acctHealth.set(token, {
    ...previous,
    ...extra,
    // 限流、模型锁定和 IP 容量限制都说明 token 仍有效，只是暂时不可用于
    // 当前请求。只有确定的凭证/账号级拒绝才将账号移出轮询池。
    alive: !invalidStates.has(state),
    state,
    uid: extra.uid || previous.uid || null,
    quota: extra.quota || previous.quota || null,
    accessTier: extra.accessTier || data?.accessTier || previous.accessTier || null,
    retryAfterMs: typeof extra.retryAfterMs === "number" ? extra.retryAfterMs : previous.retryAfterMs || null,
    checkedAt: Date.now(),
  });
}

function summarizeAccountHealth(pool, health) {
  const account_details = pool.map((acct) => {
    const info = health.get(acct.token);
    return {
      token: acct.token.slice(0, 8) + "...",
      alive: info ? info.alive : null,
      state: info?.state || "unknown",
      uid: info?.uid ? info.uid.slice(0, 8) + "..." : null,
    };
  });
  const account_states = {};
  for (const detail of account_details) {
    account_states[detail.state] = (account_states[detail.state] || 0) + 1;
  }
  const alive_accounts = account_details.filter((p) => p.alive === true).length;
  const unknown_accounts = account_details.filter((p) => p.alive === null).length;
  const unhealthy_accounts = account_details.filter((p) => p.alive === false).length;
  const hasDegradedState = account_details.some((detail) => detail.state !== "ok");
  const status = pool.length === 0
    ? "critical"
    : alive_accounts === 0 && unhealthy_accounts > 0 && unknown_accounts === 0
      ? "critical"
      : unhealthy_accounts > 0 || unknown_accounts > 0 || hasDegradedState
        ? "degraded"
        : "ok";
  return {
    status,
    accounts: pool.length,
    alive_accounts,
    unknown_accounts,
    unhealthy_accounts,
    account_states,
    account_details,
  };
}

function cooldownKey(token, sessionModel) {
  return `${token}:${sessionModel || "*"}`;
}

function cooldownUntil(token, sessionModel) {
  return Math.max(
    cooldowns.get(cooldownKey(token, "*")) || 0,
    cooldowns.get(cooldownKey(token, sessionModel)) || 0,
  );
}

function pickToken(env, sessionModel, excluded = new Set(), preferredToken = null) {
  const pool = parseAccounts(env);
  if (pool.length === 0) return null;

  // 只跳过有确定证据表明不可用的账号；未知账号仍参与轮询。
  const candidates = pool.filter((acct) => {
    if (excluded.has(acct.token) || supersededTokens.has(acct.token)) return false;
    const h = acctHealth.get(acct.token);
    return !(h && h.alive === false);
  });
  if (candidates.length === 0) return null;

  // A Responses continuation must stay on the account that created the
  // previous response; otherwise its run_id is not valid for the new token.
  if (preferredToken) {
    const preferred = candidates.find((acct) => acct.token === preferredToken);
    if (preferred && cooldownUntil(preferred.token, sessionModel) <= Date.now()) return preferred;
  }

  // 严格按配置顺序轮询。每个账号仍复用自己的 session 缓存，但活跃
  // session 不再抢占轮询顺序；这样 A/B/C 会稳定按请求交替使用。
  for (let k = 0; k < pool.length; k++) {
    const acct = pool[accountIdx % pool.length];
    accountIdx = (accountIdx + 1) % pool.length;
    if (!candidates.some((candidate) => candidate.token === acct.token)) continue;
    if (cooldownUntil(acct.token, sessionModel) > Date.now()) continue;
    return acct;
  }
  return null;
}

function normalizeSession(data, requestedModel, now = Date.now()) {
  const expiryMs = Date.parse(data?.expiresAt || "");
  const remaining = Number(data?.remainingMs);
  const effectiveExpiry = Number.isFinite(expiryMs)
    ? expiryMs
    : (Number.isFinite(remaining) ? now + Math.max(0, remaining) : NaN);
  return {
    model: data?.model || requestedModel,
    instanceId: data?.instanceId || null,
    remainingMs: Number.isFinite(effectiveExpiry) ? Math.max(0, effectiveExpiry - now) : null,
    expiresAt: Number.isFinite(effectiveExpiry) ? new Date(effectiveExpiry).toISOString() : null,
  };
}

function isUsableSession(session, now = Date.now()) {
  const expiryMs = Date.parse(session?.expiresAt || "");
  return Boolean(session?.instanceId) && Number.isFinite(expiryMs) && expiryMs > now + 60000;
}

function accountSlot(pool, token) {
  const index = pool.findIndex((acct) => acct.token === token);
  return index >= 0 ? `${index + 1}/${pool.length}` : `?/${pool.length}`;
}

function logAccountRoute(enabled, pool, token, model, attempt, reason) {
  if (!enabled) return;
  try {
    console.log(JSON.stringify({ event: "account_route", model, account_slot: accountSlot(pool, token), attempt, reason }));
  } catch {}
}

function cooldown(token, sessionModel, ms) {
  if (ms > 0) cooldowns.set(cooldownKey(token, sessionModel), Date.now() + ms);
}

function poolRetryAfterMs(pool, sessionModel) {
  const now = Date.now();
  const waits = pool
    .filter((acct) => !supersededTokens.has(acct.token) && acctHealth.get(acct.token)?.alive !== false)
    .map((acct) => cooldownUntil(acct.token, sessionModel) - now)
    .filter((ms) => ms > 0);
  return waits.length ? Math.min(...waits) : null;
}

// Official Freebuff session-gate recovery requires matching both the HTTP
// status and the relayed error code. Do not treat session_limit_reached or
// waiting_room_queued as stale sessions: those states must not delete a live
// session or burn another session slot.
const SESSION_GATE_CODES = {
  // 428 means admission is required, not that the active session ended.
  // Keep the cached owner evidence so a subsequent request can retry the
  // same session instead of mistaking it for an external process.
  waiting_room_required: { status: 428, endsSession: false },
  session_expired: { status: 410, endsSession: true },
  session_superseded: { status: 409, endsSession: true },
  session_model_mismatch: { status: 409, endsSession: true },
  session_limit_reached: { status: 409, endsSession: false },
  waiting_room_queued: { status: 429, endsSession: false },
};

function getSessionGateCode(status, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  const code = parsed && typeof parsed === "object" ? parsed.error : null;
  if (typeof code !== "string" || !Object.hasOwn(SESSION_GATE_CODES, code)) return null;
  return SESSION_GATE_CODES[code].status === status ? code : null;
}

function shouldRotateAccount(status) {
  // 只在账号/容量/临时上游故障时换号。请求结构错误在所有账号上都会
  // 重现，不应消耗整个账号池。
  return status === 401 || status === 402 || status === 403 || status === 408 || status === 409 ||
    status === 429 || status >= 500;
}

// 仅供流式无首数据时确认 Premium 额度是否耗尽；不参与账号轮询排序。
function isEndpointUnavailableError(status, text) {
  // 仅兼容已观察到的上游瞬时分配失败，普通 404 仍原样返回。
  if (status !== 404) return false;
  const raw = String(text || '');
  try {
    const parsed = JSON.parse(raw);
    const code = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.code;
    const message = parsed?.message || parsed?.error?.message || '';
    return code === 'no_endpoints_found' || /no endpoints found/i.test(String(message));
  } catch {
    return /no endpoints found/i.test(raw);
  }
}
function remainingQuota(token, sessionModel) {
  if (modelPoolCategory(sessionModel) === "standard") return null;
  const h = acctHealth.get(token);
  if (!h || !h.quota) return null;
  let entry = h.quota[sessionModel];
  if (!entry && modelPoolCategory(sessionModel) === "premium") {
    for (const model of PREMIUM_QUOTA_MODELS) {
      if (h.quota[model]) {
        entry = h.quota[model];
        break;
      }
    }
  }
  if (!entry || typeof entry.recentCount !== "number" || typeof entry.limit !== "number") return null;
  return entry.limit - entry.recentCount;
}

// 长流不应因为固定秒数被误杀：只有上游额度探测明确表示不可用时，
// 才允许当前请求中止并切换账号。探测失败/额度未知一律不判定耗尽。
function isQuotaExhausted(info, sessionModel) {
  if (!info) return false;
  if (["rate_limited", "banned", "country_blocked", "token_invalid", "blocked", "model_locked", "ip_capped"].includes(info.state)) return true;
  // STANDARD 没有可靠的剩余次数查询；只处理明确的账号/上游状态，
  // 不根据 rateLimitsByModel 的 STANDARD 数字判断耗尽。
  if (modelPoolCategory(sessionModel) === "standard") return false;
  if (!info.quota) return false;
  let entry = info.quota[sessionModel];
  if (!entry && modelPoolCategory(sessionModel) === "premium") {
    for (const model of PREMIUM_QUOTA_MODELS) {
      if (info.quota[model]) { entry = info.quota[model]; break; }
    }
  }
  if (!entry || typeof entry.recentCount !== "number" || typeof entry.limit !== "number") return false;
  return entry.limit - entry.recentCount <= 0;
}

function parseCooldown(text, status) {
  // 优先解析 JSON 里的 retryAfterMs（luna 等模型 429 返回 {"retryAfterMs": 15506639}）
  const jm = (text || "").match(/"retryAfterMs"\s*:\s*(\d+)/);
  if (jm) {
    const ms = parseInt(jm[1], 10);
    if (ms > 0) return ms;
  }
  const resetMatch = (text || "").match(/"resetAt"\s*:\s*"([^"]+)"/);
  if (resetMatch) {
    const resetAt = Date.parse(resetMatch[1]);
    if (Number.isFinite(resetAt) && resetAt > Date.now()) return resetAt - Date.now();
  }
  const m = (text || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const ms = (parseInt(m[1]||0,10)*3600 + parseInt(m[2]||0,10)*60 + parseInt(m[3]||0,10)) * 1000;
    if (ms > 0) return ms;
  }
  return status === 429 ? 5*60*1000 : 60*1000;
}

class QuotaExhaustedError extends Error {
  constructor(info) {
    super("upstream account quota exhausted");
    this.name = "QuotaExhaustedError";
    this.retryAfterMs = info && typeof info.retryAfterMs === "number" ? info.retryAfterMs : null;
  }
}

class EmptyUpstreamStreamError extends Error {
  constructor() {
    super("upstream returned an empty stream");
    this.name = "EmptyUpstreamStreamError";
  }
}

function invalidateSessionCache(token) {
  const prefix = token + ":";
  for (const key of sessCache.keys()) {
    if (key.startsWith(prefix)) sessCache.delete(key);
  }
}

function isSessionOwnedByToken(token, instanceId) {
  if (!instanceId) return false;
  const prefix = token + ":";
  for (const [key, session] of sessCache) {
    if (key.startsWith(prefix) && session?.instanceId === instanceId) return true;
  }
  return false;
}

async function deleteUpstreamSession(token, instanceId) {
  if (!instanceId) return false;
  try {
    const result = await enqueueUp("DELETE", "/api/v1/freebuff/session", token, undefined,
      undefined, SESSION_TIMEOUT_MS);
    // Keep owner evidence if DELETE failed or the upstream did not confirm
    // cleanup. This prevents the next GET(active) from being misclassified as
    // an external process after a transient control-plane failure.
    if ((result.status >= 200 && result.status < 300) || result.status === 404) {
      invalidateSessionCache(token);
      return true;
    }
  } catch {}
  return false;
}

// VPS 进程退出时只释放本进程缓存中明确持有的 session。不会扫描或删除
// 其他客户端的活跃 session。
export async function closeOwnedSessions() {
  const openHarnessRuns = [...harnessRunCache.values()];
  harnessRunCache.clear();
  for (const context of openHarnessRuns) {
    if (context?.run && context.token) {
      await finishRunChain(context.token, context.run, "cancelled", "process shutdown");
    }
  }
  const owned = [];
  const seen = new Set();
  for (const [key, session] of sessCache) {
    if (!session?.instanceId || seen.has(session.instanceId)) continue;
    const splitAt = key.lastIndexOf(":");
    if (splitAt <= 0) continue;
    owned.push({ token: key.slice(0, splitAt), instanceId: session.instanceId });
    seen.add(session.instanceId);
  }
  for (const session of owned) {
    await deleteUpstreamSession(session.token, session.instanceId);
  }
}

// ---------------------------------------------------------------------------
// 上游请求（串行队列，免费通道并发超过 1 就出问题）
// ---------------------------------------------------------------------------

let chainTail = Promise.resolve();
const CHAIN_GAP_MS = 300; // 上游免费通道并发 >1 会出问题，串行+小间隔；300ms 足够防抖且链路总耗时可控
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function enqueue(fn) {
  const run = chainTail.then(() => sleep(CHAIN_GAP_MS)).then(fn);
  chainTail = run.catch(() => {});
  return run;
}

// Hold one slot for the complete model response, not merely until fetch()
// returns its headers. This prevents two inference streams from overlapping.
let chatTail = Promise.resolve();

async function acquireChatSlot(signal) {
  const previous = chatTail.catch(() => {});
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  chatTail = previous.then(() => gate);

  if (signal?.aborted) {
    releaseGate();
    throw signal.reason || new DOMException("Aborted", "AbortError");
  }

  let abortHandler;
  try {
    await (signal
      ? Promise.race([
          previous,
          new Promise((_, reject) => {
            abortHandler = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
            signal.addEventListener("abort", abortHandler, { once: true });
          }),
        ])
      : previous);
  } catch (error) {
    releaseGate();
    throw error;
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
  };
}

function requestSignal(timeoutMs, parentSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

const UPSTREAM_TIMEOUT_MS = 20000; // 上游单请求超时，避免客户端干等
const NONSTREAM_TIMEOUT_MS = 45000; // 非流式要聚合完整上游流（含推理），给更充裕时间
const SESSION_TIMEOUT_MS = 20000;  // Freebuff CLI 0.0.149 的 session 请求超时为 20 秒
// 这不是流式请求的失败时间，只是首个数据迟迟未到时启动一次额度探测的观察窗口。
// 额度仍在时不 abort、不切号，继续等待上游。
const STREAM_NO_DATA_PROBE_DELAY_MS = 20000;

async function up(method, path, token, body, extraHeaders = {}, timeoutMs = UPSTREAM_TIMEOUT_MS, signal) {
  const headers = {};
  // 桌面版协议：不手动设置 User-Agent（fetch 默认），只带必要的业务头
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, extraHeaders);

  const resp = await fetch(codebuffApi() + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: requestSignal(timeoutMs, signal),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: resp.status, data, text };
}

function enqueueUp(method, path, token, body, extraHeaders, timeoutMs, signal) {
  return enqueue(() => up(method, path, token, body, extraHeaders, timeoutMs, signal));
}

// 流式无首数据时的额度检查：只读本地缓存，绝不打上游。
// ⚠️ 不能在这里 GET /api/v1/freebuff/session 强制刷新：
// 该接口会占用账号 session，而 freebuff 一个号同一时间只能一个客户端在线，
// 探测会顶掉正在推理的会话（428 waiting_room_required）。luna effort=high
// 等长推理模型首 token 可能 >20s，此时探测必然误伤。
// 缓存缺失/过期/额度未知 → 一律不判定耗尽，继续等待上游。
async function freshQuotaProbe(token, sessionModel) {
  const cached = acctHealth.get(token);
  if (!cached) return;
  if (Date.now() - cached.checkedAt > HEALTH_OBSERVATION_TTL_MS) return;
  if (isQuotaExhausted(cached, sessionModel)) throw new QuotaExhaustedError(cached);
}

// 流式 chat 不设置总时长 abort。只有在首个数据迟迟未到时，
// 才强制刷新账号额度；额度未知或仍有额度时，原请求继续等待。
async function fetchStreamWithQuotaGuard(url, init, token, sessionModel, parentSignal) {
  const controller = new AbortController();
  const abortFromParent = () => {
    try { controller.abort(parentSignal.reason); } catch { controller.abort(); }
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const request = fetch(url, { ...init, signal: controller.signal });
  let probeTimer = null;
  const armProbe = () => new Promise((_, reject) => {
    probeTimer = setTimeout(() => {
      freshQuotaProbe(token, sessionModel).catch((error) => {
        if (error instanceof QuotaExhaustedError) {
          try { controller.abort(error); } catch { controller.abort(); }
          reject(error);
        }
      });
    }, STREAM_NO_DATA_PROBE_DELAY_MS);
  });
  const clearProbe = () => {
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = null;
  };
  try {
    // 首个字节前不再使用 AbortSignal.timeout(20s)。
    const response = await Promise.race([request, armProbe()]);
    clearProbe();
    if (!response.body) throw new EmptyUpstreamStreamError();

    const reader = response.body.getReader();
    const first = await Promise.race([reader.read(), armProbe()]);
    clearProbe();
    if (first.done) {
      try { reader.releaseLock(); } catch {}
      throw new EmptyUpstreamStreamError();
    }

    // 首个 chunk 已到达，交还给正常 SSE 转发逻辑；不再设置固定总时长。
    const body = new ReadableStream({
      start(streamController) {
        streamController.enqueue(first.value);
        (async () => {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              streamController.enqueue(next.value);
            }
            streamController.close();
          } catch (error) {
            streamController.error(error);
          } finally {
            parentSignal?.removeEventListener("abort", abortFromParent);
            try { reader.releaseLock(); } catch {}
          }
        })();
      },
      cancel(reason) {
        parentSignal?.removeEventListener("abort", abortFromParent);
        try { controller.abort(reason); } catch { controller.abort(); }
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    clearProbe();
    parentSignal?.removeEventListener("abort", abortFromParent);
    try { controller.abort(error); } catch { controller.abort(); }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// session 生命周期
// ---------------------------------------------------------------------------

class SessionOwnedElsewhereError extends Error {
  constructor(model) {
    super(`account already has an active Freebuff session${model ? ` for ${model}` : ""}`);
    this.name = "SessionOwnedElsewhereError";
  }
}

// The upstream main branch contains an optional normal-client behavior layer
// (fingerprint/ads/usage).  It is deliberately opt-in here: these calls are
// not required by the session/chat wire contract, and enabling them changes
// account-side behavior.  When enabled, the payloads follow the observed
// client order and are throttled per account.
const CLIENT_BEHAVIOR_TTL_MS = 30 * 60 * 1000;
const clientBehaviorCache = new Map();

function behaviorDue(key) {
  const previous = clientBehaviorCache.get(key) || 0;
  if (Date.now() - previous <= CLIENT_BEHAVIOR_TTL_MS) return false;
  clientBehaviorCache.set(key, Date.now());
  return true;
}

async function runNormalClientBehavior(token, env, signal, context = {}, account = null) {
  if (String(env?.FREEBUFF_CLIENT_BEHAVIOR || "cli").toLowerCase() !== "cli") return;
  const fingerprintId = String(account?.fingerprintId || "");
  const localeOptions = Intl.DateTimeFormat().resolvedOptions();
  const device = { os: "linux", timezone: localeOptions.timeZone || "UTC", locale: localeOptions.locale || "en-US" };
  const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const cliUserAgent = "Freebuff-CLI/0.0.149";
  if (adsBehaviorDue(token, context, env)) {
    try {
      const adPayload = {
        provider: String(env.FREEBUFF_AD_PROVIDER || "gravity"),
        messages: Array.isArray(context.messages) ? context.messages.filter((m) => ["user", "assistant"].includes(m?.role) && typeof m?.content === "string" && !m.content.includes("INSTRUCTIONS_PROMPT")).map(({ role, content }) => ({ role, content: content.trim() })).filter((m) => m.content) : [],
        sessionId: adSessionIdFor(token, env),
        device,
        userAgent,
      };
      if (env.FREEBUFF_AD_SURFACE) adPayload.surface = String(env.FREEBUFF_AD_SURFACE);
      if (env.FREEBUFF_AD_PLACEMENT_ID) adPayload.placementId = String(env.FREEBUFF_AD_PLACEMENT_ID);
      const ad = await enqueueUp("POST", "/api/v1/ads", token, adPayload, { "User-Agent": cliUserAgent }, 6000, signal);
      const ads = Array.isArray(ad.data?.ads) ? ad.data.ads : [];
      for (const choice of ads) if (!choice.provider) choice.provider = String(env.FREEBUFF_AD_PROVIDER || "gravity");
      if (ad.status >= 200 && ad.status < 300) {
        for (const choice of ads) {
          if (!choice?.impUrl) continue;
          const impression = await enqueueUp("POST", "/api/v1/ads/impression", token,
            { impUrl: choice.impUrl, mode: String(env.FREEBUFF_AGENT_MODE || "free") },
            { "User-Agent": cliUserAgent }, 6000, signal);
          if (impression.data && Object.hasOwn(impression.data, "creditsGranted")) {
            choice.creditsGranted = impression.data.creditsGranted;
          }
        }
      }
      await reportZeroClickImpressions(ads, signal);
    } catch (error) {
      if (env?.FREEBUFF_DEBUG === "true") console.debug("[ads] failed", String(error?.message || error));
    }
  }
  if (behaviorDue(`usage:${token}`)) {
    try { await enqueueUp("POST", "/api/v1/usage", token, { fingerprintId }, {}, 6000, signal); } catch {}
  }
}
async function reportZeroClickImpressions(ads, signal) {
  const provider = ads.find((choice) => choice?.provider)?.provider;
  const ids = ads.flatMap((choice) => Array.isArray(choice?.impressionIds) ? choice.impressionIds : []);
  if (provider !== "zeroclick" || ids.length === 0) return;
  try {
    await fetch("https://zeroclick.dev/api/v2/impressions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
      signal,
    });
  } catch {}
}
export async function trackAdClick(token, env, impUrl, surface, signal) {
  if (!token || !impUrl) return false;
  try {
    const result = await enqueueUp("POST", "/api/v1/ads/click", token,
      { impUrl, ...(surface ? { surface } : {}) },
      { "User-Agent": "Freebuff-CLI/0.0.149" }, 6000, signal);
    return result.status >= 200 && result.status < 300;
  } catch (error) {
    if (env?.FREEBUFF_DEBUG === "true") console.debug("[ads] click failed", String(error?.message || error));
    return false;
  }
}

async function createSession(token, sessionModel, forceCreate = false, signal, env, context = {}, account = null) {
  // Optional compatibility behavior runs before session reuse, matching the
  // ordering observed in the upstream main branch.
  await runNormalClientBehavior(token, env, signal, context, account);
  // 只复用本进程仍然有效的同一模型 session。
  // 1) 缓存命中且未过期（剩 >60s）直接复用，避免每次请求都打上游 session 接口
  const cacheKey = token + ":" + sessionModel;
  const cached = sessCache.get(cacheKey);
  if (!forceCreate) {
    if (isUsableSession(cached)) {
      return cached;
    }
  }
  // 1) 查上游当前 session，同模型直接复用（forceCreate 时跳过：僵尸 active session 会被 GET 反复复用，
  //    导致 chat 一直 428；强制 POST 拿全新实例）。GET 使用 CLI 的普通请求形态。
  if (!forceCreate) {
    const cur = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined,
      freebuffSessionGetHeaders(env, cached?.instanceId), SESSION_TIMEOUT_MS, signal);
    recordAccountObservation(token, cur.status, cur.data, {
      quota: cur.data?.rateLimitsByModel || null,
      uid: cur.data?.uid || null,
      retryAfterMs: cur.data?.retryAfterMs,
      accessTier: cur.data?.accessTier || null,
    });
    const currentAdmissionState = documentedSessionAdmissionState("GET", cur.status, cur.data);
    if (currentAdmissionState) {
      throw new SessionAdmissionError("GET", cur.status, currentAdmissionState, cur.data);
    }
    if (cur.status === 200 && cur.data?.status === "active" && cur.data?.instanceId) {
      const ownedByThisProcess = isSessionOwnedByToken(token, cur.data.instanceId);
      if (!ownedByThisProcess) {
        // 缓存未命中且 instanceId 不属于本进程，说明 session 由官方 CLI
        // 或另一 VPS 进程持有。不复用、不删除、不 takeover。
        throw new SessionOwnedElsewhereError(cur.data.model || sessionModel);
      }
      if (!cur.data.model || cur.data.model === sessionModel) {
        const s = normalizeSession(cur.data, sessionModel);
        if (isUsableSession(s)) {
          sessCache.set(cacheKey, s);
          return s;
        }
        // 上游仍报告本进程创建的临期 session 为 active。先安全释放，
        // 再创建新 session；不能提前删除缓存，否则会丢失所有权证据。
        await deleteUpstreamSession(token, cur.data.instanceId);
      } else {
        // 同一进程主动切换模型时可以安全释放自己持有的旧 session。
        await deleteUpstreamSession(token, cur.data.instanceId);
      }
    } else {
      // 上游已无 active session，清除本进程针对该账号的陈旧缓存。
      invalidateSessionCache(token);
    }
  }


  // 2) create（可能 queue）。官方 CLI 的 POST 只发送模型头；实例 ID 由服务端生成。
  const r = await enqueueUp("POST", "/api/v1/freebuff/session", token, undefined,
    freebuffSessionModelHeaders(sessionModel), SESSION_TIMEOUT_MS, signal);
  recordAccountObservation(token, r.status, r.data, {
    quota: r.data?.rateLimitsByModel || null,
    uid: r.data?.uid || null,
    retryAfterMs: r.data?.retryAfterMs,
    accessTier: r.data?.accessTier || null,
  });
  const admissionState = documentedSessionAdmissionState("POST", r.status, r.data);
  if (admissionState) {
    throw new SessionAdmissionError("POST", r.status, admissionState, r.data);
  }
  if (r.status === 200 && r.data?.status === "active" && r.data?.instanceId) {
    const s = normalizeSession(r.data, sessionModel);
    sessCache.set(cacheKey, s);
    return s;
  }
  if (r.status === 200 && r.data?.status === "queued" && r.data?.instanceId) {
    const inst = r.data.instanceId;
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      const q = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined, freebuffSessionInstanceHeaders(inst), SESSION_TIMEOUT_MS, signal);
      recordAccountObservation(token, q.status, q.data, {
        quota: q.data?.rateLimitsByModel || null,
        uid: q.data?.uid || null,
        retryAfterMs: q.data?.retryAfterMs,
        accessTier: q.data?.accessTier || null,
      });
      if (q.status === 200 && q.data?.status === "active") {
        const s = normalizeSession({ ...q.data, instanceId: q.data.instanceId || inst }, sessionModel);
        sessCache.set(cacheKey, s);
        return s;
      }
    }
    throw new Error("session stayed queued (retry later)");
  }
  if (r.status === 409) throw new Error("session_model_mismatch: " + String(r.data?.message || r.data?.error || "上游拒绝该模型"));
  throw new Error("create session failed: " + r.status + " " + (r.text || "").slice(0, 300));
}

// ---------------------------------------------------------------------------
// agent-runs 生命周期
// ---------------------------------------------------------------------------

async function startRun(token, agentId, ancestors = [], signal, env) {
  const r = await enqueueUp("POST", "/api/v1/agent-runs", token,
    { action: "START", agentId, ancestorRunIds: ancestors }, env?.FREEBUFF_ACTING_USER_ID ? { [FREEBUFF_ACTING_USER_HEADER]: String(env.FREEBUFF_ACTING_USER_ID) } : undefined, SESSION_TIMEOUT_MS, signal);
  if (r.status !== 200 || !r.data?.runId) throw new Error("start_run failed: " + r.status + " " + (r.text || "").slice(0, 200));
  return r.data.runId;
}

async function finishRun(token, chain, status, errorMessage, signal, env) {
  await enqueueUp("POST", "/api/v1/agent-runs", token,
    {
      action: "FINISH",
      runId: chain.runId,
      status,
      totalSteps: chain.totalSteps,
      directCredits: 0,
      totalCredits: 0,
      ...(errorMessage ? { errorMessage: String(errorMessage).slice(0, 5000) } : {}),
      steps: chain.steps,
    }, env?.FREEBUFF_ACTING_USER_ID ? { [FREEBUFF_ACTING_USER_HEADER]: String(env.FREEBUFF_ACTING_USER_ID) } : undefined, SESSION_TIMEOUT_MS, signal);
}

async function startRunChain(token, agentId, signal, env) {
  const runId = await startRun(token, agentId, [], signal, env);
  return { runId, agentId, totalSteps: 0, steps: [] };
}

function beginRunStep(chain) {
  chain.totalSteps += 1;
  return {
    stepNumber: chain.totalSteps,
    startTime: new Date().toISOString(),
  };
}

function completeRunStep(chain, step, messageId = null) {
  chain.steps.push({
    id: crypto.randomUUID(),
    stepNumber: step.stepNumber,
    credits: 0,
    childRunIds: [],
    messageId,
    status: "completed",
    startTime: step.startTime,
  });
}

async function finishRunChain(token, chain, status, errorMessage, signal, env) {
  if (!chain) return;
  if (chain.runId) await finishRun(token, chain, status, errorMessage, signal, env).catch(() => {});
}

// ---------------------------------------------------------------------------
// 上游 payload 构造（对齐 py 版 build_upstream_payload）
// ---------------------------------------------------------------------------

const UPSTREAM_KEYS = [
  "frequency_penalty", "logit_bias", "logprobs", "max_completion_tokens", "max_tokens",
  "metadata", "modalities", "parallel_tool_calls", "presence_penalty", "reasoning_effort",
  "response_format", "seed", "service_tier", "stop", "store", "stream_options", "thinking",
  "temperature", "tool_choice", "tools", "top_logprobs", "top_p", "top_k", "user",
];

const BASE3_OPENING = "You are Buffy, the coding agent behind Codebuff.";

// 来自 Freebuff CLI 0.0.149 对应 base3 源码的已确认核心提示。CLI 还会在
// 运行时追加 knowledge files、系统信息和初始 git 状态；适配器没有这些真实
// 上下文，因此不伪造，只保留可由公开源码逐字验证的部分。
function base3SystemPrompt() {
  return `${BASE3_OPENING} You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

Current date: ${new Date().toISOString().slice(0, 10)}.

- Match the project's existing conventions. Verify a library is already used in the project before employing it.
- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.
- Verify non-trivial changes by running the project's typecheck and relevant tests.
- Use write_todos to plan and track multi-step tasks.
- Your responses are displayed in a terminal. Keep them short and concise.
- Don't run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.`;
}

function withBase3Prefix(content, prompt) {
  if (typeof content === "string") {
    return content.trimStart().startsWith(BASE3_OPENING) ? content : `${prompt}\n\n${content}`;
  }
  if (Array.isArray(content)) {
    const parts = content.map((part) => part && typeof part === "object" ? { ...part } : part);
    const firstText = parts.find((part) => part && part.type === "text" && typeof part.text === "string");
    if (firstText?.text.trimStart().startsWith(BASE3_OPENING)) return parts;
    parts.unshift({ type: "text", text: prompt });
    return parts;
  }
  return prompt;
}

function normalizeMessages(messages) {
  const prompt = base3SystemPrompt();
  if (!Array.isArray(messages)) return [{ role: "system", content: prompt, cache_control: { type: "ephemeral" } }];
  const out = [];
  let prefixedSystem = false;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const item = { ...m };
    if (item.role === "developer") item.role = "system";
    if (item.role === "system") {
      item.cache_control = { type: "ephemeral" };
      if (!prefixedSystem) {
        item.content = withBase3Prefix(item.content, prompt);
        prefixedSystem = true;
      }
    }
    out.push(item);
  }
  if (!prefixedSystem) out.unshift({ role: "system", content: prompt, cache_control: { type: "ephemeral" } });
  return out;
}

// 官方模型 reasoning effort 上限表（2026-08-12 源码：freebuff-models.ts / reasoning-effort.ts）
// 模型只允许其 efforts 数组中的档位；请求档位超出上限时 clamp-down 到最近可用档，
// 不拒绝请求、不换模型（官方 clampReasoningEffort 语义）。
// 档位升序 ladder：minimal < low < medium < high < xhigh < max < ultra
const REASONING_EFFORT_RANK = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// 官方 per-model efforts：
//   - deepseek-v4-flash: [low, high, max]（无 medium）
//   - deepseek-v4-pro:   [low, high, max]
//   - gpt-5.6-luna:      EFFORTS_THROUGH_MAX（low..max，含 xhigh）
//   - muse-spark:        EFFORTS_THROUGH_XHIGH（minimal..xhigh）
//   - claude-fable-5:    EFFORTS_THROUGH_MAX（仅保留参数校正规则，不在普通目录中）
//   - minimax-m3:        无 effort（官方 adaptive/disabled thinking，不设档位）
//   - 未列出的模型：无限制，原样透传
const MODEL_EFFORTS = {
  "deepseek/deepseek-v4-flash": ["low", "high", "max"],
  "deepseek/deepseek-v4-pro": ["low", "high", "max"],
  "openai/gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.2-contributor": ["minimal", "low", "medium", "high", "xhigh"],
  "anthropic/claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
};

const MODEL_EFFORT_DEFAULTS = {
  "deepseek/deepseek-v4-flash": "high",
  "deepseek/deepseek-v4-pro": "high",
  "openai/gpt-5.6-luna": "high",
  "meta/muse-spark-1.2-contributor": "xhigh",
  "anthropic/claude-fable-5": "high",
};

function clampReasoningEffort(requested, allowed, fallback) {
  if (!Array.isArray(allowed) || allowed.length === 0) return fallback;
  const wanted = REASONING_EFFORT_RANK.indexOf(requested);
  if (wanted < 0) return fallback;
  let best = null;
  let bestRank = -1;
  for (const cand of allowed) {
    const rank = REASONING_EFFORT_RANK.indexOf(cand);
    if (rank < 0 || rank > wanted) continue;
    if (rank > bestRank) { best = cand; bestRank = rank; }
  }
  if (best !== null) return best;
  // 所有可用档都高于请求 → 取最低档（官方语义）
  return allowed.reduce((lo, c) =>
    REASONING_EFFORT_RANK.indexOf(c) < REASONING_EFFORT_RANK.indexOf(lo) ? c : lo);
}

function normalizeReasoningEffort(model, effort) {
  if (effort === undefined || effort === null) return effort;
  const allowed = MODEL_EFFORTS[model];
  if (!allowed) return effort; // 模型未列 → 不干预
  // Official compatibility rule: both DeepSeek V4 models map medium to high;
  // the generic downward clamp would otherwise turn it into low.
  if (effort === "medium" &&
      (model === "deepseek/deepseek-v4-flash" || model === "deepseek/deepseek-v4-pro")) {
    return "high";
  }
  const clamped = clampReasoningEffort(String(effort), allowed, MODEL_EFFORT_DEFAULTS[model]);
  return clamped === String(effort) ? effort : clamped;
}

function newClientSessionId() {
  return Math.random().toString(36).substring(2, 15);
}

function traceContextFor(previousResponseId) {
  if (!previousResponseId) return null;
  const previous = responseTraceCache.get(previousResponseId);
  if (!previous || Date.now() - previous.checkedAt > 2 * 60 * 60 * 1000) return null;
  return previous;
}

function traceSessionFor(previousResponseId) {
  return traceContextFor(previousResponseId)?.traceSessionId || crypto.randomUUID();
}

function rememberResponseTrace(responseId, traceSessionId, continuation = {}) {
  if (!responseId || !traceSessionId) return;
  responseTraceCache.set(responseId, { traceSessionId, ...continuation, checkedAt: Date.now() });
}

function buildUpstreamPayload(params, mc, sess, runId, clientSessionId, traceSessionId, llmStepNumber, harnessMode = false) {
  const sourceParams = mapClientTools(params, harnessMode);
  const payload = {};
  for (const k of UPSTREAM_KEYS) if (sourceParams[k] !== undefined && sourceParams[k] !== null) payload[k] = sourceParams[k];
  // reasoning_effort 按官方模型 efforts 表 clamp-down（不拒绝、不换模型）
  if (payload.reasoning_effort !== undefined) {
    payload.reasoning_effort = normalizeReasoningEffort(mc.id, payload.reasoning_effort);
  }
  payload.model = mc.upstream;
  payload.messages = normalizeMessages(sourceParams.messages);
  payload.stream = true;
  if (!payload.stop) payload.stop = ['"cb_easp"'];
  payload.provider = { data_collection: "deny" };
  payload.codebuff_metadata = {
    freebuff_instance_id: sess.instanceId,
    trace_session_id: traceSessionId,
    run_id: runId,
    // Official SDK semantics: client_id is the per-prompt client session id.
    // Do not substitute a hardware fingerprint or a reused run id here.
    client_id: clientSessionId,
    cost_mode: "free",
    llm_step_number: String(llmStepNumber),
  };
  return payload;
}

// ---------------------------------------------------------------------------
// chat 主流程
// ---------------------------------------------------------------------------

// Only the ordinary CLI picker catalog is advertised and accepted. Account-
// specific limited offers cannot be proven without creating/refreshing a session.
const MODEL_ALIASES = new Map([
  ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
  ["deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
]);

function findModelConfig(modelId) {
  const canonical = MODEL_ALIASES.get(modelId) || modelId;
  return MODELS.find((model) => model.id === canonical) || null;
}

async function resolveModelConfig(modelId) {
  return findModelConfig(modelId);
}

async function handleChat(request, env) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  // Harness emits this stable attribution header on every LLM request.  Use
  // it as an opt-in compatibility signal so deployments do not need a second
  // client-specific URL or environment toggle.  The explicit environment
  // switch remains available for clients that omit the header.
  if (request.headers.has("x-deepseek-harness-user-id") || request.headers.has("x-deepseek-harness-session-id")) {
    params.__harness_mode = true;
  }
  const harnessSessionId = request.headers.get("x-deepseek-harness-session-id");
  if (harnessSessionId) params.__harness_session_id = harnessSessionId;
  const isStream = !!params.stream;
  const requestedModel = params.model || DEFAULT_MODEL;
  const mc = await resolveModelConfig(requestedModel);
  if (!mc) return jsonResponse({ error: { message: "Model not available: " + requestedModel, type: "unsupported_model" } }, 400);
  return executeChat(env, params, mc, isStream, "chat", request.signal);
}

// OpenAI Responses API（/v1/responses）入口：把 Responses 请求翻译成 chat completions 上游调用
async function handleResponses(request, env) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  if (request.headers.has("x-deepseek-harness-user-id") || request.headers.has("x-deepseek-harness-session-id")) {
    params.__harness_mode = true;
  }
  const harnessSessionId = request.headers.get("x-deepseek-harness-session-id");
  if (harnessSessionId) params.__harness_session_id = harnessSessionId;
  const requestedModel = params.model || DEFAULT_MODEL;
  const mc = await resolveModelConfig(requestedModel);
  if (!mc) return jsonResponse({ error: { message: "Model not available: " + requestedModel, type: "unsupported_model" } }, 400);
  return executeChat(env, responsesToChatParams(params, mc), mc, isStream, "responses", request.signal);
}

// Responses API 请求 → chat completions 参数（字段名/结构翻译）
function responsesToChatParams(params, mc) {
  const chat = {};
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "stop", "seed", "store", "metadata", "user", "stream", "thinking", "stream_options"]) {
    if (params[k] !== undefined && params[k] !== null) chat[k] = params[k];
  }
  if (params.max_output_tokens !== undefined && params.max_output_tokens !== null) chat.max_completion_tokens = params.max_output_tokens;
  if (params.reasoning && typeof params.reasoning === "object" && params.reasoning.effort) chat.reasoning_effort = params.reasoning.effort;
  if (params.text && typeof params.text === "object" && params.text.format && params.text.format.type && params.text.format.type !== "text") {
    chat.response_format = { type: params.text.format.type };
    if (params.text.format.json_schema) chat.response_format.json_schema = params.text.format.json_schema;
  }
  // Responses 工具格式（扁平 function）→ chat completions 格式（function 包装）。
  // 上游只接受 type:"function"，namespace/web_search 等非 function 工具一律过滤，避免反序列化报错。
  if (Array.isArray(params.tools)) {
    chat.tools = params.tools
      .filter((t) => t && typeof t === "object" && t.type === "function")
      .map((t) => ({
        type: "function",
        function: {
          name: t.name || "",
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
    if (chat.tools.length === 0) delete chat.tools;
  }
  // Responses tool_choice → chat 格式；仅支持 function 类型，其它对象形式退回 auto
  if (params.tool_choice && typeof params.tool_choice === "object") {
    if (params.tool_choice.type === "function" && params.tool_choice.name) {
      chat.tool_choice = { type: "function", function: { name: params.tool_choice.name } };
    } else {
      chat.tool_choice = "auto";
    }
  }
  chat.model = mc.id;
  chat.messages = responsesInputToMessages(params.input, params.instructions);
  if (params.__harness_mode) chat.__harness_mode = true;
  if (params.__harness_session_id) chat.__harness_session_id = params.__harness_session_id;
  if (params.previous_response_id) chat.__previous_response_id = params.previous_response_id;
  return chat;
}

// Responses API input → chat messages（input 可为字符串或消息条目数组）
function responsesInputToMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") { messages.push({ role: "user", content: input }); return messages; }
  if (!Array.isArray(input)) { messages.push({ role: "user", content: input == null ? "" : String(input) }); return messages; }
  for (const item of input) {
    if (typeof item === "string") { messages.push({ role: "user", content: item }); continue; }
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id || "", content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
      continue;
    }
    if (item.type === "function_call") {
      const toolCall = {
        id: item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function",
        function: {
          name: item.name || "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      };
      // Responses 可连续返回多个 function_call；合并成一条 assistant
      // message，确保后续 function_call_output 都有合法的调用上下文。
      const previous = messages.at(-1);
      if (previous?.role === "assistant" && previous.content === null && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }
    // reasoning / item_reference 没有可安全翻译成 Chat Completions 的内容。
    if (item.type === "reasoning" || item.type === "item_reference") continue;
    const role = item.role || "user";
    const content = item.content;
    if (typeof content === "string") { messages.push({ role, content }); continue; }
    if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "input_text" || c.type === "output_text") { parts.push({ type: "text", text: c.text ?? "" }); continue; }
        if (c.type === "text" && typeof c.text === "string") { parts.push(c); continue; }
      }
      messages.push({ role, content: parts.length ? parts : "" });
      continue;
    }
    messages.push({ role, content: "" });
  }
  return messages;
}

// chat completions 与 responses 共用的上游执行。完整请求生命周期全局串行；
// session gate 按官方 error+status wire contract 原样终止，不自动抢 session 或换号。
async function executeChat(env, chatParams, mc, isStream, mode, requestAbortSignal) {
  const debug = env.FREEBUFF_DEBUG === "true";
  const harnessMode = harnessToolMode(env) || chatParams?.__harness_mode === true;
  const reverseToolAliases = harnessMode ? invertToolAliases() : null;
  const harnessSessionId = harnessMode && typeof chatParams?.__harness_session_id === "string"
    ? chatParams.__harness_session_id.trim() : "";
  const harnessRunKey = harnessSessionId ? `${harnessSessionId}:${mc.session}` : null;
  const pool = parseAccounts(env);
  if (pool.length === 0) return jsonResponse({ error: { message: "缺少 FREEBUFF_CREDENTIALS_JSON（官方 credentials JSON）", type: "config_error" } }, 503);

  let releaseChatSlot;
  try {
    releaseChatSlot = await acquireChatSlot(requestAbortSignal);
  } catch (error) {
    return jsonResponse({ error: { message: String(error?.message || "Request aborted"), type: "cancelled" } }, 499);
  }

  let slotTransferredToStream = false;
  let lastErrMsg = "";
  let lastStatus = 502;
  const clientSessionId = newClientSessionId();
  const previousResponseId = mode === "responses" ? chatParams.__previous_response_id || null : null;
  const previousTrace = mode === "responses" ? traceContextFor(previousResponseId) : null;
  const traceSessionId = traceSessionFor(previousResponseId);
  const attemptedTokens = new Set();
  const endpointRecoveryTokens = new Set();
  const recreateSessionTokens = new Set();
  try {
    // no_endpoints_found 只允许每个账号触发一次同账号重建。
    for (let acctTry = 0; acctTry < pool.length * 2; acctTry++) {
      const cachedHarnessRun = harnessRunKey ? harnessRunCache.get(harnessRunKey) : null;
      const recoveryToken = recreateSessionTokens.values().next().value || null;
      if (recoveryToken) attemptedTokens.delete(recoveryToken);
      const acct = pickToken(
        env,
        mc.session,
        attemptedTokens,
        recoveryToken || (previousTrace?.active ? previousTrace.token : cachedHarnessRun?.token || null),
      );
      const token = acct ? acct.token : null;
      if (!token) break;
      const forceSessionRecreate = token === recoveryToken;
      if (forceSessionRecreate) recreateSessionTokens.delete(token);
      attemptedTokens.add(token);
      logAccountRoute(debug, pool, token, mc.session, acctTry + 1,
        forceSessionRecreate ? 'endpoint_recovery' :
          (isUsableSession(sessCache.get(token + ':' + mc.session)) ? 'active_session' : 'quota_or_round_robin'));

      let run = null;
      let step = null;
      let stepCompleted = false;
      let runFinalized = false;
      const completeCurrentStep = (messageId = null) => {
        if (stepCompleted || !run || !step) return;
        stepCompleted = true;
        completeRunStep(run, step, messageId);
      };
      const finishCurrentRun = async (status, errorMessage) => {
        if (runFinalized || !run) return;
        runFinalized = true;
        if (harnessRunKey) {
          const cached = harnessRunCache.get(harnessRunKey);
          if (cached?.run === run) harnessRunCache.delete(harnessRunKey);
        }
        // FINISH must survive an ordinary downstream disconnect so the run
        // ledger records cancellation. The VPS runtime supplies a separate
        // process-level signal that only aborts FINISH during shutdown,
        // unblocking the shared queue before closeOwnedSessions sends DELETE.
        await finishRunChain(token, run, status, errorMessage, env.SHUTDOWN_SIGNAL, env);
      };

      try {
        const sess = await createSession(token, mc.session, forceSessionRecreate, requestAbortSignal, env, chatParams, acct);
        if (debug) console.log(`[acct ${acctTry + 1}] session=${sess.instanceId}`);

        // A Responses tool continuation reuses the same agent run and ledger
        // on the account that produced previous_response_id.  New requests
        // still start one base3 root run, preserving the adapter's no-runtime
        // boundary while matching the CLI's multi-step FINISH contract.
        if (previousTrace?.active && previousTrace.token === token && previousTrace.model === mc.session &&
            previousTrace.instanceId === sess.instanceId && previousTrace.runId) {
          run = {
            runId: previousTrace.runId,
            agentId: mc.agent,
            totalSteps: Number.isInteger(previousTrace.totalSteps) ? previousTrace.totalSteps : 0,
            steps: Array.isArray(previousTrace.steps) ? previousTrace.steps.map((item) => ({ ...item })) : [],
          };
        } else if (harnessRunKey && cachedHarnessRun?.token === token && cachedHarnessRun.instanceId === sess.instanceId && cachedHarnessRun.run?.runId) {
          run = cachedHarnessRun.run;
          cachedHarnessRun.checkedAt = Date.now();
        } else {
          run = await startRunChain(token, mc.agent, requestAbortSignal, env);
        }
        if (debug) console.log(`[acct ${acctTry + 1}] run=${run.runId} agent=${mc.agent}`);
        step = beginRunStep(run);

        const payload = buildUpstreamPayload(
          chatParams,
          mc,
          sess,
          run.runId,
          clientSessionId,
          traceSessionId,
          step.stepNumber,
          harnessMode,
        );
        const headers = freebuffChatHeaders(token, sess.instanceId);
        const chatInit = { method: "POST", headers, body: JSON.stringify(payload) };
        const resp = isStream
          ? await fetchStreamWithQuotaGuard(
              codebuffApi() + "/api/v1/chat/completions",
              chatInit,
              token,
              mc.session,
              requestAbortSignal,
            )
          : await fetch(codebuffApi() + "/api/v1/chat/completions", {
              ...chatInit,
              signal: requestSignal(NONSTREAM_TIMEOUT_MS, requestAbortSignal),
            });

        if (!resp.ok) {
          const errText = await resp.text();
          lastStatus = resp.status;
          const gateCode = getSessionGateCode(resp.status, errText);
          // Gate 429 is a transient admission race, not an account rate limit.
          // Keep gate responses out of the generic account-health classifier.
          if (!gateCode) recordAccountObservation(token, resp.status, errText);
          await finishCurrentRun("failed", gateCode || errText);

          if (gateCode) {
            if (gateCode === "session_model_mismatch" && sess?.instanceId) {
              // The instance was proven to be ours before the chat call. A
              // model mismatch is not proof that it ended, so release that
              // known owner explicitly; failed DELETE keeps the evidence.
              await deleteUpstreamSession(token, sess.instanceId);
            } else if (SESSION_GATE_CODES[gateCode].endsSession) {
              sessCache.delete(token + ":" + mc.session);
            }
            if (gateCode === "session_superseded") supersededTokens.add(token);
            let parsed = null;
            try { parsed = JSON.parse(errText); } catch {}
            const message = parsed?.message || gateCode;
            if (debug) console.log(`[acct ${acctTry + 1}] terminal session gate=${gateCode}`);
            return jsonResponse({ error: { message, type: "api_error", code: gateCode } }, resp.status);
          }

          lastErrMsg = "upstream error: " + errText.slice(0, 300);
          if (isEndpointUnavailableError(resp.status, errText)) {
            // 适配器可用性扩展：不把普通 404 当作可重试错误。
            if (!endpointRecoveryTokens.has(token) && await deleteUpstreamSession(token, sess.instanceId)) {
              endpointRecoveryTokens.add(token);
              recreateSessionTokens.add(token);
              attemptedTokens.delete(token);
              if (debug) console.log(`[acct ${acctTry + 1}] no endpoints found, rebuild session once`);
              continue;
            }
            cooldown(token, mc.session, 2_000);
            lastStatus = 503;
            if (debug) console.log(`[acct ${acctTry + 1}] no endpoints found, switch account`);
            continue;
          }
          if (!shouldRotateAccount(resp.status)) {
            return jsonResponse({ error: { message: lastErrMsg, type: "api_error" } }, resp.status);
          }
          cooldown(token, mc.session, parseCooldown(errText, resp.status));
          if (debug) console.log(`[acct ${acctTry + 1}] failed ${resp.status}, switch account`);
          continue;
        }

        recordAccountObservation(token, resp.status, null);
        const finalizeStream = async (streamError, streamInfo = {}) => {
          const aborted = requestAbortSignal?.aborted;
          const status = aborted ? "cancelled" : streamError ? "failed" : "completed";
          if (status === "completed") completeCurrentStep();
          const hasContinuation = status === "completed" && streamInfo.hasToolCalls && (mode === "responses" || Boolean(harnessRunKey));
          if (hasContinuation && harnessRunKey) {
            harnessRunCache.set(harnessRunKey, { token, instanceId: sess.instanceId, run, checkedAt: Date.now() });
          }
          if (mode === "responses" && streamInfo.responseId) {
            rememberResponseTrace(streamInfo.responseId, traceSessionId, {
              token,
              model: mc.session,
              instanceId: sess.instanceId,
              runId: run.runId,
              totalSteps: run.totalSteps,
              steps: run.steps,
              active: hasContinuation,
            });
          }
          if (!hasContinuation) {
            await finishCurrentRun(status, streamError ? String(streamError?.message || streamError) : undefined);
          }
          releaseChatSlot();
        };

        if (isStream) {
          const { readable, writable } = new TransformStream();
          slotTransferredToStream = true;
          if (mode === "responses") pipeUpstreamToResponsesStream(
            resp.body,
            writable,
            mc,
            finalizeStream,
            previousResponseId,
            traceSessionId,
            { token, model: mc.session, instanceId: sess.instanceId, runId: run.runId, totalSteps: run.totalSteps, steps: run.steps },
            reverseToolAliases,
          );
          else pipeUpstreamToClient(resp.body, writable, finalizeStream, reverseToolAliases);
          return new Response(readable, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() },
          });
        }

        const result = mode === "responses"
          ? await responsesToNonStream(resp.body, mc, previousResponseId, reverseToolAliases)
          : await streamToNonStream(resp.body, mc.upstream, reverseToolAliases);
        completeCurrentStep();
        const hasContinuation = mode === "responses"
          ? Array.isArray(result.output) && result.output.some((item) => item && item.type === "function_call")
          : Boolean(harnessRunKey) && Array.isArray(result.choices?.[0]?.message?.tool_calls)
            && result.choices[0].message.tool_calls.length > 0;
        if (hasContinuation && harnessRunKey) {
          harnessRunCache.set(harnessRunKey, { token, instanceId: sess.instanceId, run, checkedAt: Date.now() });
        }
        if (mode === "responses") {
          rememberResponseTrace(result.id, traceSessionId, {
            token,
            model: mc.session,
            instanceId: sess.instanceId,
            runId: run.runId,
            totalSteps: run.totalSteps,
            steps: run.steps,
            active: hasContinuation,
          });
        }
        if (!hasContinuation) await finishCurrentRun("completed");
        return jsonResponse(result, 200);
      } catch (error) {
        const aborted = requestAbortSignal?.aborted;
        await finishCurrentRun(aborted ? "cancelled" : "failed", String(error?.message || error));
        if (aborted) {
          return jsonResponse({ error: { message: "Request aborted", type: "cancelled" } }, 499);
        }

        console.error("[" + mode + "]", error);
        const msg = String(error?.message || error);
        if (error instanceof UpstreamProtocolError) {
          lastErrMsg = msg;
          lastStatus = 502;
          return jsonResponse({ error: { message: msg, type: "upstream_protocol_error" } }, 502);
        }
        const statusMatch = msg.match(/\b(?:failed|error|upstream error:)\s*:?\s*(4\d{2}|5\d{2})\b/i);
        if (statusMatch) lastStatus = Number(statusMatch[1]);
        if (error instanceof SessionAdmissionError) {
          lastStatus = error.status;
          // 仅对公开快照明示的 429 retryAfterMs 应用模型级冷却；不删除 session，
          // 也不回退模型或猜测未知等待时间。
          if (error.status === 429 && error.retryAfterMs) cooldown(token, mc.session, error.retryAfterMs);
        } else if (error instanceof QuotaExhaustedError) {
          // Quota exhaustion is not proof that the upstream session ended;
          // retain owner evidence so a later GET(active) cannot look foreign.
          cooldown(token, mc.session, error.retryAfterMs || 5 * 60 * 1000);
        } else if (error instanceof EmptyUpstreamStreamError) {
          // No evidence that an empty response makes the session stale: keep it
          // intact and let a later client request retry normally.
          cooldown(token, mc.session, 60 * 1000);
        } else if (error instanceof SessionOwnedElsewhereError) {
          cooldown(token, mc.session, 5 * 60 * 1000);
        } else if (/create session failed|stayed queued|start_run failed|abort|timeout|timed out|terminated/i.test(msg)) {
          cooldown(token, mc.session, /429/.test(msg) ? parseCooldown(msg, 429) : 60 * 1000);
        }
        lastErrMsg = msg;
        if (debug) console.log(`[acct ${acctTry + 1}] exception: ${msg.slice(0, 120)}, switch account`);
      }
    }

    const retryAfterMs = poolRetryAfterMs(pool, mc.session);
    if (!lastErrMsg && retryAfterMs !== null) {
      lastErrMsg = "all configured accounts are cooling down";
      lastStatus = 429;
    } else if (!lastErrMsg && attemptedTokens.size === 0) {
      lastErrMsg = "no eligible Freebuff account is available";
      lastStatus = 503;
    }
    const headers = retryAfterMs === null ? {} : { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
    return jsonResponse({ error: { message: lastErrMsg || "upstream request failed", type: "api_error" } }, lastStatus, headers);
  } finally {
    if (!slotTransferredToStream) releaseChatSlot();
  }
}


// ---------------------------------------------------------------------------
// Anthropic Messages API（本地适配，复用稳定的 executeChat 主链路）
// ---------------------------------------------------------------------------
function anthropicModelToOpenAI(model) {
  const raw = String(model || DEFAULT_MODEL).trim();
  if (findModelConfig(raw)) return raw;
  const short = raw.replace(/^anthropic\//, "");
  const hit = MODELS.find((m) => m.id.toLowerCase().endsWith("/" + short.toLowerCase()));
  return hit ? hit.id : DEFAULT_MODEL;
}

function anthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

function anthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") out.push({ type: "text", text: p.text });
    if (p.type === "image" && p.source && typeof p.source === "object") {
      const s = p.source;
      if (s.type === "base64" && s.media_type && s.data) out.push({ type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } });
      else if (s.type === "url" && s.url) out.push({ type: "image_url", image_url: { url: s.url } });
    }
  }
  return out;
}

function anthropicToChat(body, mc) {
  const chat = { model: mc.id, stream: !!body.stream, messages: [] };
  if (body.stream) chat.stream_options = { include_usage: true };
  const system = anthropicText(body.system);
  if (system) chat.messages.push({ role: "system", content: system });
  if (body.max_tokens != null) chat.max_completion_tokens = body.max_tokens;
  for (const k of ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty"]) if (body[k] != null) chat[k] = body[k];
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chat.stop = body.stop_sequences;
  if (body.thinking?.type === "enabled" && Number.isFinite(body.thinking.budget_tokens)) {
    // Anthropic thinking budget → reasoning effort 分档；经 clamp 归一化后即使产生
    // medium（如 deepseek-v4-flash 不支持）也会被钳到最近可用档
    chat.reasoning_effort = body.thinking.budget_tokens >= 16000 ? "high" : body.thinking.budget_tokens >= 8000 ? "medium" : "low";
  }
  if (body.metadata && typeof body.metadata === "object") chat.metadata = body.metadata;

  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.filter((t) => t && t.name).map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
    const tc = body.tool_choice;
    if (tc?.type === "auto") chat.tool_choice = "auto";
    else if (tc?.type === "any") chat.tool_choice = "required";
    else if (tc?.type === "none") chat.tool_choice = "none";
    else if (tc?.type === "tool" && tc.name) chat.tool_choice = { type: "function", function: { name: tc.name } };
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      const parts = Array.isArray(m.content) ? m.content : [];
      const results = parts.filter((p) => p && p.type === "tool_result");
      if (results.length) {
        for (const p of results) chat.messages.push({ role: "tool", tool_call_id: p.tool_use_id || "", content: anthropicContent(p.content) });
        const text = parts.filter((p) => p && p.type === "text" && p.text).map((p) => p.text).join("\n");
        if (text) chat.messages.push({ role: "user", content: text });
      } else chat.messages.push({ role: "user", content: anthropicContent(m.content) });
    } else if (m.role === "assistant") {
      const uses = Array.isArray(m.content) ? m.content.filter((p) => p && p.type === "tool_use") : [];
      if (uses.length) chat.messages.push({ role: "assistant", content: anthropicText(m.content), tool_calls: uses.map((p) => ({ id: p.id || ("call_" + Math.random().toString(36).slice(2, 10)), type: "function", function: { name: p.name || "", arguments: JSON.stringify(p.input ?? {}) } })) });
      else chat.messages.push({ role: "assistant", content: anthropicText(m.content) });
    }
  }
  return chat;
}

function anthropicStopReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function anthropicFromChat(oai, mc) {
  const choice = oai?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: tc.id || ("toolu_" + Math.random().toString(36).slice(2, 10)), name: tc.function?.name || "", input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const u = oai?.usage || {};
  return { id: oai?.id || ("msg_" + Math.random().toString(36).slice(2, 10)), type: "message", role: "assistant", model: mc.id, content, stop_reason: anthropicStopReason(choice.finish_reason), stop_sequence: null, usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 } };
}

function anthropicError(message, type, status, retryAfter) {
  const headers = { ...corsHeaders() };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return jsonResponse({ type: "error", error: { type: type || "api_error", message: String(message || "Upstream error") } }, status || 500, headers);
}

function estimateAnthropicTokens(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n, x) => n + estimateAnthropicTokens(x), 0);
  if (value && typeof value === "object") return Object.entries(value).reduce((n, [k, v]) => n + k.length + estimateAnthropicTokens(v), 0);
  return 0;
}

async function handleAnthropicCountTokens(request, env) {
  let body;
  try { body = await request.json(); } catch { return anthropicError("Invalid JSON", "invalid_request_error", 400); }
  const openaiModel = anthropicModelToOpenAI(body.model);
  const mc = findModelConfig(openaiModel);
  if (!mc) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  const chat = anthropicToChat(body, mc);
  return jsonResponse({ input_tokens: Math.max(1, Math.ceil(estimateAnthropicTokens(chat.messages) / 4)) }, 200);
}

function anthropicStream(mc) {
  const decoder = new TextDecoder();
  let buffer = "", started = false, ended = false, block = null, blockIndex = -1, reason = "end_turn", input = 0, output = 0;
  const encoder = new TextEncoder();
  const events = (ctl, name, data) => { if (!data.type) data.type = name; ctl.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)); };
  const close = (ctl) => { if (block) { events(ctl, "content_block_stop", { index: block.index }); block = null; } };
  const end = (ctl) => {
    if (ended) return; ended = true;
    if (!started) events(ctl, "message_start", { message: { id: "msg_" + Math.random().toString(36).slice(2, 10), type: "message", role: "assistant", model: mc.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } });
    close(ctl);
    events(ctl, "message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } });
    events(ctl, "message_stop", {});
  };
  return new TransformStream({
    transform(chunk, ctl) {
      if (ended) return;
      buffer += decoder.decode(chunk, { stream: true });
      let pos;
      while ((pos = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, pos).trim(); buffer = buffer.slice(pos + 1);
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") { end(ctl); continue; }
        let obj; try { obj = JSON.parse(raw); } catch { continue; }
        if (obj?.error) {
          ended = true;
          events(ctl, "error", {
            type: "error",
            error: {
              type: obj.error.type || "api_error",
              message: obj.error.message || String(obj.error),
            },
          });
          continue;
        }
        if (obj.usage) { input = obj.usage.prompt_tokens ?? input; output = obj.usage.completion_tokens ?? output; }
        const choice = obj.choices?.[0]; if (!choice) continue;
        const delta = choice.delta || {};
        if (!started) { started = true; events(ctl, "message_start", { message: { id: "msg_" + Math.random().toString(36).slice(2, 10), type: "message", role: "assistant", model: mc.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } }); }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const fn = tc.function || {}; const idx = tc.index ?? 0;
            if (!block || block.kind !== "tool" || block.sourceIndex !== idx) { close(ctl); block = { index: ++blockIndex, kind: "tool", sourceIndex: idx }; events(ctl, "content_block_start", { index: block.index, content_block: { type: "tool_use", id: tc.id || ("toolu_" + Math.random().toString(36).slice(2, 10)), name: fn.name || "", input: {} } }); }
            if (fn.arguments) events(ctl, "content_block_delta", { index: block.index, delta: { type: "input_json_delta", partial_json: fn.arguments } });
          }
        } else if (delta.content) {
          if (!block || block.kind !== "text") { close(ctl); block = { index: ++blockIndex, kind: "text" }; events(ctl, "content_block_start", { index: block.index, content_block: { type: "text", text: "" } }); }
          events(ctl, "content_block_delta", { index: block.index, delta: { type: "text_delta", text: delta.content } });
        }
        if (choice.finish_reason) reason = anthropicStopReason(choice.finish_reason);
      }
    },
    flush(ctl) { end(ctl); },
  });
}

async function handleAnthropicMessages(request, env) {
  let body;
  try { body = await request.json(); } catch { return anthropicError("Invalid JSON", "invalid_request_error", 400); }
  const openaiModel = anthropicModelToOpenAI(body.model);
  const mc = findModelConfig(openaiModel);
  if (!mc) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  const chat = anthropicToChat(body, mc);
  const response = await executeChat(env, chat, mc, !!chat.stream, "chat", request.signal);
  if (response.status >= 400) {
    let msg = "Upstream error"; try { const data = await response.json(); msg = data?.error?.message || msg; } catch {}
    const types = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 429: "rate_limit_error", 503: "overloaded_error" };
    return anthropicError(msg, types[response.status] || "api_error", response.status, response.headers.get("Retry-After"));
  }
  if (!chat.stream) return jsonResponse(anthropicFromChat(await response.json(), mc), response.status);
  return new Response(response.body.pipeThrough(anthropicStream(mc)), { status: response.status, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() } });
}



function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object" && (obj.data.choices || obj.data.id || obj.data.usage)) return obj.data;
  return obj;
}

class UpstreamProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamProtocolError";
  }
}

function throwForUpstreamSseError(obj) {
  if (!obj || typeof obj !== "object") return;
  const error = obj.error ?? obj.data?.error;
  if (error === undefined || error === null) return;
  const code = typeof error === "object" && error.code ? String(error.code) : "";
  const message = typeof error === "string"
    ? error
    : (error.message || (() => {
        try { return JSON.stringify(error); } catch { return String(error); }
      })());
  throw new UpstreamProtocolError(
    `upstream SSE error${code ? ` (${code})` : ""}: ${String(message).slice(0, 5000)}`,
  );
}

function parseSseBlock(block) {
  const dataLines = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue;
    if (rawLine === "data") dataLines.push("");
    else if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n").trim();
}

// 严格而增量地读取 SSE：支持 CRLF、跨 chunk 事件以及末尾没有换行的
// 最后一个事件。无效 JSON 不再被静默吞掉并伪装成 completed。
async function* readUpstreamSse(body) {
  if (!body) throw new EmptyUpstreamStreamError();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawData = false;

  const decodeBlock = (block) => {
    const payload = parseSseBlock(block);
    if (payload === null || payload === "") return null;
    sawData = true;
    if (payload === "[DONE]") return { done: true, obj: null };
    try {
      const obj = unwrapData(JSON.parse(payload));
      throwForUpstreamSseError(obj);
      return { done: false, obj };
    } catch (error) {
      if (error instanceof UpstreamProtocolError) throw error;
      throw new UpstreamProtocolError(`invalid upstream SSE JSON: ${String(error?.message || error)}`);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const event = decodeBlock(block);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      const event = decodeBlock(buffer);
      if (event) yield event;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (!sawData) throw new EmptyUpstreamStreamError();
}

function mergeToolCall(toolCalls, tc) {
  if (!tc || typeof tc !== "object") return;
  const index = Number.isInteger(tc.index) ? tc.index : 0;
  let item = toolCalls.get(index);
  if (!item) {
    item = { index, id: "", type: "function", name: "", arguments: "" };
    toolCalls.set(index, item);
  }
  const fn = tc.function || {};
  if (tc.id) item.id = tc.id;
  if (tc.type) item.type = tc.type;
  if (fn.name) item.name += fn.name;
  if (fn.arguments) item.arguments += fn.arguments;
}

function openAiToolCalls(toolCalls, reverseToolAliases = null) {
  return [...toolCalls.values()].map((item) => ({
    id: item.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    type: item.type || "function",
    function: {
      name: reverseToolAliases?.get(item.name) || item.name,
      arguments: item.arguments,
    },
  }));
}

// 流式：把上游 SSE 剥 {data:...} 包装后透传
function pipeUpstreamToClient(upstreamBody, writable, onComplete, reverseToolAliases = null) {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  (async () => {
    let streamError = null;
    let sawDone = false;
    let sawFinish = false;
    let hasToolCalls = false;
    try {
      for await (const event of readUpstreamSse(upstreamBody)) {
        if (event.done) {
          sawDone = true;
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          continue;
        }
        const choice = event.obj?.choices?.[0];
        if (choice?.finish_reason) sawFinish = true;
        if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length) hasToolCalls = true;
        const output = event.obj;
        if (reverseToolAliases && Array.isArray(output?.choices?.[0]?.delta?.tool_calls)) {
          output.choices[0].delta.tool_calls = output.choices[0].delta.tool_calls.map((call) => ({
            ...call,
            function: call.function && typeof call.function === "object"
              ? { ...call.function, name: reverseToolAliases.get(call.function.name) || call.function.name }
              : call.function,
          }));
        }
        await writer.write(encoder.encode("data: " + JSON.stringify(output) + "\n\n"));
      }
      if (!sawDone && !sawFinish) throw new UpstreamProtocolError("upstream SSE ended before finish_reason or [DONE]");
      if (!sawDone) await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (error) {
      streamError = error;
      try {
        await writer.write(encoder.encode("data: " + JSON.stringify({ error: { message: String(error?.message || error), type: "upstream_protocol_error" } }) + "\n\n"));
        if (!sawDone) await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch {}
    }
    finally {
      try { if (onComplete) await onComplete(streamError, { hasToolCalls }); } catch {}
      try { await writer.close(); } catch {}
    }
  })();
}

// 非流式：聚合上游流成 OpenAI 非流式对象
async function streamToNonStream(upstreamBody, upstreamModel, reverseToolAliases = null) {
  let content = "", reasoning = "", finishReason = null, model = "", id = "", usage = null;
  let sawDone = false;
  const toolCalls = new Map();
  for await (const event of readUpstreamSse(upstreamBody)) {
    if (event.done) { sawDone = true; continue; }
    const obj = event.obj;
    if (obj?.id) id = obj.id;
    if (obj?.model) model = obj.model;
    if (obj?.usage) usage = obj.usage;
    const choice = obj?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) content += delta.content;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) mergeToolCall(toolCalls, tc);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (!sawDone && !finishReason) throw new UpstreamProtocolError("upstream SSE ended before finish_reason or [DONE]");
  const mergedToolCalls = openAiToolCalls(toolCalls, reverseToolAliases);
  const msg = { role: "assistant", content: mergedToolCalls.length && !content ? null : content };
  if (mergedToolCalls.length) msg.tool_calls = mergedToolCalls;
  if (reasoning && !content) { msg.content = reasoning; msg.reasoning_used_as_content = true; }
  else if (reasoning) msg.reasoning_content = reasoning;
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || upstreamModel,
    choices: [{ index: 0, message: msg, finish_reason: finishReason || (mergedToolCalls.length ? "tool_calls" : "stop"), logprobs: null }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Responses API（/v1/responses）输出
// ---------------------------------------------------------------------------

function responsesBase(mc, respId, createdAt, previousResponseId = null) {
  return {
    id: respId || "resp_" + Math.random().toString(36).slice(2, 10),
    object: "response",
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: mc.id,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: previousResponseId,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1.0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1.0,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  };
}

function responsesUsage() {
  return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
}

// 上游是 Chat Completions 格式，Responses API 要求 input/output_tokens。
// 统一归一化，避免把不完整或错误格式的 usage 直接透传给严格客户端。
function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return responsesUsage();
  const inputTokens = Number.isFinite(usage.input_tokens)
    ? usage.input_tokens
    : Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage.output_tokens)
    ? usage.output_tokens
    : Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  const totalTokens = Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : inputTokens + outputTokens;
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details : {};
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: Number.isFinite(inputDetails.cached_tokens) ? inputDetails.cached_tokens : 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number.isFinite(outputDetails.reasoning_tokens) ? outputDetails.reasoning_tokens : 0 },
    total_tokens: totalTokens,
  };
}

// 流式：上游 chat SSE → Responses API 事件序列（response.created … response.completed）
async function pipeUpstreamToResponsesStream(
  upstreamBody,
  writable,
  mc,
  onComplete,
  previousResponseId = null,
  traceSessionId = null,
  continuation = {},
  reverseToolAliases = null,
) {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const respId = "resp_" + Math.random().toString(36).slice(2, 10);
  const createdAt = Math.floor(Date.now() / 1000);
  rememberResponseTrace(respId, traceSessionId, { ...continuation, active: false });
  let model = "", usage = null, sawDone = false, finishReason = null;
  const send = (obj) => writer.write(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));

  // 按上游出现顺序记录输出项：message（文本）或 function_call（工具调用）
  const items = [];
  let nextOutputIndex = 0;
  let contentItem = null;
  const toolItems = new Map(); // 上游 tool_calls index → 输出项

  const startContent = () => {
    const item = {
      kind: "message",
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      outputIndex: nextOutputIndex++,
      text: "",
      contentIndex: 0,
      started: false,
    };
    items.push(item);
    return item;
  };
  const startTool = (tc) => {
    const fn = tc.function || {};
    const item = {
      kind: "function_call",
      id: "fc_" + Math.random().toString(36).slice(2, 10),
      outputIndex: nextOutputIndex++,
      callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
      name: reverseToolAliases?.get(fn.name) || fn.name || "",
      args: "",
    };
    items.push(item);
    return item;
  };

  (async () => {
    let streamError = null;
    try {
      await send({ type: "response.created", response: responsesBase(mc, respId, createdAt, previousResponseId) });
      await send({ type: "response.in_progress", response: responsesBase(mc, respId, createdAt, previousResponseId) });

      for await (const event of readUpstreamSse(upstreamBody)) {
        if (event.done) { sawDone = true; continue; }
        const obj = event.obj;
        if (obj?.model) model = obj.model;
        if (obj?.usage) usage = obj.usage;
        const choice = obj?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (choice.finish_reason) finishReason = choice.finish_reason;

        // 工具调用增量（chat 格式 delta.tool_calls[]）
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== "object") continue;
            const ti = tc.index ?? 0;
            let item = toolItems.get(ti);
            if (!item) {
              item = startTool(tc);
              toolItems.set(ti, item);
              await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "in_progress", call_id: item.callId, name: item.name, arguments: "" } });
            }
            const fn = tc.function || {};
            if (tc.id) item.callId = tc.id;
            if (fn.name) {
              const clientName = reverseToolAliases?.get(fn.name) || fn.name;
              if (item.name !== clientName) item.name += clientName;
            }
            if (fn.arguments) {
              item.args += fn.arguments;
              await send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: item.outputIndex, delta: fn.arguments });
            }
          }
        }

        // 文本增量
        if (delta.content) {
          if (!contentItem) contentItem = startContent();
          if (!contentItem.started) {
            contentItem.started = true;
            await send({ type: "response.output_item.added", output_index: contentItem.outputIndex, item: { id: contentItem.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
            await send({ type: "response.content_part.added", item_id: contentItem.id, output_index: contentItem.outputIndex, content_index: contentItem.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
          }
          contentItem.text += delta.content;
          await send({ type: "response.output_text.delta", item_id: contentItem.id, output_index: contentItem.outputIndex, content_index: contentItem.contentIndex, delta: delta.content });
        }
      }
      if (!sawDone && !finishReason) throw new UpstreamProtocolError("upstream SSE ended before finish_reason or [DONE]");

      // 既无文本也无工具调用时补一个空 message，避免 output 为空数组
      if (items.length === 0) {
        const item = startContent();
        item.started = true;
        await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
        await send({ type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
      }

      // 收尾：按出现顺序输出每个输出项的 done 事件
      for (const item of items) {
        if (item.kind === "message") {
          if (!item.started) {
            await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
            await send({ type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
          }
          const part = { type: "output_text", text: item.text, annotations: [] };
          await send({ type: "response.output_text.done", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, text: item.text });
          await send({ type: "response.content_part.done", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part });
          await send({ type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "completed", role: "assistant", content: [part] } });
        } else {
          await send({ type: "response.function_call_arguments.done", item_id: item.id, output_index: item.outputIndex, arguments: item.args });
          await send({ type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args } });
        }
      }

      const resp = responsesBase(mc, respId, createdAt, previousResponseId);
      resp.status = "completed";
      resp.model = model || mc.id;
      resp.output = items.map((item) =>
        item.kind === "message"
          ? { id: item.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }] }
          : { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args }
      );
      resp.usage = chatUsageToResponsesUsage(usage);
      await send({ type: "response.completed", response: resp });
    } catch (error) {
      streamError = error;
      try {
        const failed = responsesBase(mc, respId, createdAt, previousResponseId);
        failed.status = "failed";
        failed.error = { code: "upstream_protocol_error", message: String(error?.message || error) };
        failed.model = model || mc.id;
        failed.usage = chatUsageToResponsesUsage(usage);
        await send({ type: "response.failed", response: failed });
      } catch {}
    }
    finally {
      try {
        if (onComplete) await onComplete(streamError, { responseId: respId, hasToolCalls: toolItems.size > 0 });
      } catch {}
      try { await writer.close(); } catch {}
    }
  })();
}

// 非流式：聚合上游流成 Responses API 非流式对象
async function responsesToNonStream(upstreamBody, mc, previousResponseId = null, reverseToolAliases = null) {
  let model = "", outputText = "", reasoning = "", usage = null, finishReason = null, sawDone = false;
  const toolCalls = new Map();
  for await (const event of readUpstreamSse(upstreamBody)) {
    if (event.done) { sawDone = true; continue; }
    const obj = event.obj;
    if (obj?.model) model = obj.model;
    if (obj?.usage) usage = obj.usage;
    const choice = obj?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) outputText += delta.content;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) mergeToolCall(toolCalls, tc);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (!sawDone && !finishReason) throw new UpstreamProtocolError("upstream SSE ended before finish_reason or [DONE]");
  const resp = responsesBase(mc, undefined, Math.floor(Date.now() / 1000), previousResponseId);
  resp.status = "completed";
  resp.model = model || mc.id;
  resp.output = [];
  if (outputText || reasoning) {
    const text = outputText || reasoning;
    resp.output.push({
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const item of openAiToolCalls(toolCalls, reverseToolAliases)) {
    resp.output.push({
      id: "fc_" + Math.random().toString(36).slice(2, 10),
      type: "function_call",
      status: "completed",
      call_id: item.id,
      name: item.function.name,
      arguments: item.function.arguments,
    });
  }
  resp.usage = chatUsageToResponsesUsage(usage);
  return resp;
}


// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

// 轻量缓存清理：避免 VPS 进程长时间运行后 Map 无限增长
function cleanCache() {
  const now = Date.now();
  try {
    if (sessCache.size > 50) {
      for (const [k, v] of sessCache) {
        const exp = v.expiresAt ? new Date(v.expiresAt).getTime() : 0;
        if (exp > 0 && exp < now) sessCache.delete(k);
      }
    }
    if (cooldowns.size > 200) {
      for (const [key, until] of cooldowns) {
        if (until <= now) cooldowns.delete(key);
      }
    }
    if (responseTraceCache.size > 1000) {
      for (const [responseId, context] of responseTraceCache) {
        if (now - context.checkedAt > 2 * 60 * 60 * 1000) responseTraceCache.delete(responseId);
      }
      while (responseTraceCache.size > 1000) {
        const oldest = responseTraceCache.keys().next().value;
        if (oldest === undefined) break;
        responseTraceCache.delete(oldest);
      }
    }
    for (const [key, context] of harnessRunCache) {
      if (now - (context.checkedAt || 0) > 2 * 60 * 60 * 1000) harnessRunCache.delete(key);
    }
    if (harnessRunCache.size > 1000) {
      while (harnessRunCache.size > 1000) {
        const oldest = harnessRunCache.keys().next().value;
        if (oldest === undefined) break;
        harnessRunCache.delete(oldest);
      }
    }
  } catch {}
}

// Return the ordinary CLI picker catalog only. Entitlement- and capacity-gated
// offers are account/session state, not static model metadata.
function visibleModelsForAccounts(env) {
  const pool = parseAccounts(env);
  const observed = pool.map((acct) => acctHealth.get(acct.token)).filter(Boolean);
  // 只有所有账号都已被上游明确识别为 limited 时才收窄目录。任一账号
  // 未知或具有更高 tier 时保留完整 picker，避免在首次启动时误隐藏模型。
  if (observed.length === pool.length && observed.length > 0 && observed.every((info) => info.accessTier === "limited")) {
    return MODELS.filter((model) => STANDARD_MODELS.has(model.id));
  }
  return MODELS;
}

async function handleModels(env) {
  const visibleModels = visibleModelsForAccounts(env);
  return jsonResponse({
    object: "list",
    data: visibleModels.map((m) => ({ id: m.id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "freebuff" })),
  }, 200, { "X-Freebuff2api-Version": VERSION });
}

function getApiKey(request, env) {
  const expected = String(env.API_KEY || env.FREEBUFF_API_KEY || "").trim();
  if (!expected) return null;
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === expected ? expected : null;
  return request.headers.get("x-api-key") === expected ? expected : null;
}

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders } });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-freebuff-instance-id, anthropic-version, anthropic-beta",
  };
}
