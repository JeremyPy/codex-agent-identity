/**
 * Codex Agent Identity — pure frontend generator
 *
 * Flow (same as codex_agent.py by 久雾):
 * 1. Parse ChatGPT session JWT
 * 2. Generate Ed25519 keypair (Web Crypto)
 * 3. POST auth.openai.com agent/register
 * 4. Optional task register
 * 5. Download auth.json
 *
 * Nothing is stored on any third-party server. Only OpenAI receives the
 * registration request with the user-provided access token.
 */

const AUTHAPI_BASE = "https://auth.openai.com/api/accounts";
const AGENT_VERSION = "0.138.0-alpha.6";
const AGENT_HARNESS_ID = "codex-cli";
const RUNNING_LOCATION = "local";

const $ = (id) => document.getElementById(id);

const els = {
  input: $("input"),
  verifyTask: $("verifyTask"),
  filename: $("filename"),
  btnGenerate: $("btnGenerate"),
  btnClear: $("btnClear"),
  btnCopy: $("btnCopy"),
  btnDownload: $("btnDownload"),
  btnCopySessionUrl: $("btnCopySessionUrl"),
  status: $("status"),
  result: $("result"),
  meta: $("meta"),
  output: $("output"),
};

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const JWT_ONE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

let lastAuthJson = null;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(type, message) {
  els.status.hidden = false;
  els.status.className = `status ${type}`;
  els.status.textContent = message;
}

function clearStatus() {
  els.status.hidden = true;
  els.status.textContent = "";
}

function setBusy(busy) {
  els.btnGenerate.disabled = busy;
  els.btnGenerate.textContent = busy ? "生成中…" : "生成 auth.json";
}

// ---------------------------------------------------------------------------
// Input parsing / cleanup
// ---------------------------------------------------------------------------

/**
 * Try to locate a balanced JSON object that starts at `start` inside `text`.
 * Handles messy paste where UI chrome sits before/after the real session JSON.
 */
function extractBalancedJsonObject(text, start = 0) {
  const i = text.indexOf("{", start);
  if (i < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let p = i; p < text.length; p++) {
    const ch = text[p];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(i, p + 1);
        try {
          return { raw: slice, value: JSON.parse(slice), start: i, end: p + 1 };
        } catch {
          // keep scanning for a later valid object
          return extractBalancedJsonObject(text, p + 1);
        }
      }
    }
  }
  return null;
}

/**
 * Prefer the JSON object that looks like chatgpt /api/auth/session.
 */
function findSessionLikeJson(text) {
  let searchFrom = 0;
  let fallback = null;

  while (searchFrom < text.length) {
    const found = extractBalancedJsonObject(text, searchFrom);
    if (!found) break;

    const v = found.value;
    const hasAccess =
      typeof v?.accessToken === "string" ||
      typeof v?.access_token === "string" ||
      typeof v?.sessionToken === "string" ||
      typeof v?.session_token === "string";
    const looksLikeSession =
      hasAccess ||
      (v?.user && (v?.account || v?.authProvider || v?.expires));

    if (looksLikeSession && hasAccess) return found;
    if (looksLikeSession && !fallback) fallback = found;

    searchFrom = found.end;
  }
  return fallback;
}

function pickTokenFromObject(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.accessToken,
    data.access_token,
    data?.user?.accessToken,
    data?.session?.accessToken,
    data?.data?.accessToken,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && JWT_ONE.test(c.trim())) return c.trim();
  }
  return null;
}

/**
 * From a pile of JWTs in mixed paste, prefer the ChatGPT API access token
 * (aud includes api.openai.com/v1) over sessionToken JWE-looking blobs we
 * already only match as 3-part JWTs anyway.
 */
function pickBestJwt(tokens) {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (!unique.length) return null;
  if (unique.length === 1) return unique[0];

  let best = unique[0];
  let bestScore = -1;
  for (const t of unique) {
    let score = 0;
    try {
      const claims = decodeJwtClaims(t);
      const aud = claims.aud;
      const audStr = Array.isArray(aud) ? aud.join(" ") : String(aud || "");
      if (/api\.openai\.com/.test(audStr)) score += 5;
      if (claims["https://api.openai.com/auth"]) score += 5;
      if (claims["https://api.openai.com/profile"]) score += 2;
      if (claims.chatgpt_account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id)
        score += 3;
      // longer RS256 access tokens typically outrank short junk
      score += Math.min(2, Math.floor(t.length / 800));
    } catch {
      score = 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Extract accessToken from:
 * - raw JWT string
 * - full /api/auth/session JSON (pretty or minified)
 * - messy paste with UI chrome (Checkout / 支付链接生成 / …)
 * - key=value paste
 */
function extractAccessToken(raw) {
  const text = (raw || "").trim();
  if (!text) throw new Error("请粘贴 accessToken 或完整 session JSON");

  // Pure JWT
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) {
    return text;
  }

  // JSON object (whole textarea, or embedded in junk)
  const embedded = findSessionLikeJson(text);
  if (embedded) {
    const token = pickTokenFromObject(embedded.value);
    if (token) return token;
  }

  // Whole-text JSON parse (after stripping common noise prefixes)
  if (text.includes("{")) {
    const cleaned = text.replace(/^[\s\S]*?(?=\{)/, "");
    try {
      const data = JSON.parse(cleaned);
      const token = pickTokenFromObject(data);
      if (token) return token;
    } catch {
      /* fall through */
    }
  }

  // key: value / key=value lines
  const m =
    text.match(/accessToken["'\s:=]+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i) ||
    text.match(/access_token["'\s:=]+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i);
  if (m) return m[1];

  // Fallback: best JWT substring (handles "粘贴时带上了支付页 UI 文案")
  const all = text.match(JWT_RE) || [];
  const best = pickBestJwt(all);
  if (best) return best;

  throw new Error(
    "无法识别 accessToken。\n请从 chatgpt.com/api/auth/session 复制 JSON，或只复制 accessToken 字段（eyJ…）。"
  );
}

/**
 * Clean input box: strip UI chrome, pretty-print session JSON if found,
 * otherwise keep the best JWT only.
 */
function cleanAndFormatInput({ silent = false } = {}) {
  const text = els.input.value || "";
  if (!text.trim()) {
    if (!silent) setStatus("warn", "输入框为空");
    return false;
  }

  const session = findSessionLikeJson(text);
  if (session) {
    els.input.value = JSON.stringify(session.value, null, 2);
    if (!silent) {
      const token = pickTokenFromObject(session.value);
      setStatus(
        "ok",
        token
          ? "已从粘贴内容中提取 session JSON 并格式化（已识别 accessToken）"
          : "已提取并格式化 JSON（未找到 accessToken 字段，请检查）"
      );
    }
    return true;
  }

  // Try parse entire text as JSON
  try {
    const obj = JSON.parse(text.trim());
    els.input.value = JSON.stringify(obj, null, 2);
    if (!silent) setStatus("ok", "JSON 已格式化");
    return true;
  } catch {
    /* continue */
  }

  const all = text.match(JWT_RE) || [];
  const best = pickBestJwt(all);
  if (best) {
    els.input.value = best;
    if (!silent) {
      setStatus(
        "ok",
        all.length > 1
          ? `已从杂乱文本中提取 accessToken（共发现 ${all.length} 个 JWT，已自动选择最像 ChatGPT accessToken 的一个）`
          : "已提取 accessToken（纯 JWT）"
      );
    }
    return true;
  }

  if (!silent) {
    setStatus("error", "未能从内容中识别 JSON 或 accessToken，请重新复制 session");
  }
  return false;
}

function b64urlToBytes(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJwtClaims(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const json = new TextDecoder().decode(b64urlToBytes(parts[1]));
  return JSON.parse(json);
}

function sessionFromAccessToken(accessToken) {
  const claims = decodeJwtClaims(accessToken);
  const auth = claims["https://api.openai.com/auth"] || {};
  const profile = claims["https://api.openai.com/profile"] || {};

  const accountId = auth.chatgpt_account_id || "";
  const userId = auth.chatgpt_user_id || auth.user_id || "";
  const email = profile.email || "";
  const planType = auth.chatgpt_plan_type || "free";

  if (!accountId || !userId) {
    throw new Error(`JWT 缺少必要字段: account_id=${accountId}, user_id=${userId}`);
  }

  // exp is unix seconds
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
    throw new Error("accessToken 已过期，请重新从 /api/auth/session 获取");
  }

  return {
    accessToken,
    accountId,
    userId,
    email,
    planType,
    exp: claims.exp || null,
  };
}

// ---------------------------------------------------------------------------
// Ed25519 keypair (Web Crypto) → PKCS8 base64 + SSH public key
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function sshEncodeString(strBytes) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, strBytes.length);
  const out = new Uint8Array(4 + strBytes.length);
  out.set(len, 0);
  out.set(strBytes, 4);
  return out;
}

function toSshEd25519PublicKey(rawPublicKey) {
  // ssh-ed25519 blob: string("ssh-ed25519") || string(32-byte key)
  const header = new TextEncoder().encode("ssh-ed25519");
  const part1 = sshEncodeString(header);
  const part2 = sshEncodeString(rawPublicKey);
  const blob = new Uint8Array(part1.length + part2.length);
  blob.set(part1, 0);
  blob.set(part2, part1.length);
  return `ssh-ed25519 ${bytesToBase64(blob)}`;
}

async function generateEd25519Keypair() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前浏览器不支持 Web Crypto（需要 HTTPS 或 localhost）");
  }

  let keyPair;
  try {
    keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  } catch (err) {
    throw new Error(
      `无法生成 Ed25519 密钥：${err.message || err}。请使用较新的 Chrome / Firefox / Safari。`
    );
  }

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));

  return {
    privateKeyPkcs8B64: bytesToBase64(pkcs8),
    publicKeySsh: toSshEd25519PublicKey(rawPub),
    privateKey: keyPair.privateKey,
  };
}

// ---------------------------------------------------------------------------
// OpenAI agent APIs
// ---------------------------------------------------------------------------

async function registerAgent(accessToken, publicKeySsh) {
  const res = await fetch(`${AUTHAPI_BASE}/v1/agent/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      abom: {
        agent_version: AGENT_VERSION,
        agent_harness_id: AGENT_HARNESS_ID,
        running_location: RUNNING_LOCATION,
      },
      agent_public_key: publicKeySsh,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      data?.detail ||
      text.slice(0, 300) ||
      res.statusText;
    throw new Error(`Agent 注册失败 (${res.status}): ${msg}`);
  }

  const agentRuntimeId = data.agent_runtime_id;
  if (!agentRuntimeId) {
    throw new Error(`响应中无 agent_runtime_id: ${text.slice(0, 300)}`);
  }
  return agentRuntimeId;
}

async function registerTask(accessToken, agentRuntimeId, privateKey) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const payload = `${agentRuntimeId}:${timestamp}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(payload))
  );
  const signatureB64 = bytesToBase64(sig);

  const res = await fetch(`${AUTHAPI_BASE}/v1/agent/${agentRuntimeId}/task/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      timestamp,
      signature: signatureB64,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Task 注册失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    const data = JSON.parse(text);
    return data.encrypted_task_id || "";
  } catch {
    return "";
  }
}

function buildAuthJson({ agentRuntimeId, privateKeyPkcs8B64, accountId, userId, email, planType }) {
  return {
    auth_mode: "agent_identity",
    agent_identity: {
      agent_runtime_id: agentRuntimeId,
      agent_private_key: privateKeyPkcs8B64,
      account_id: accountId,
      chatgpt_user_id: userId,
      email: email,
      plan_type: planType,
      chatgpt_account_is_fedramp: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function generate() {
  clearStatus();
  els.result.hidden = true;
  lastAuthJson = null;
  setBusy(true);

  try {
    // Auto-clean messy paste (Checkout UI chrome, unformatted JSON, etc.)
    const before = els.input.value;
    cleanAndFormatInput({ silent: true });
    if (els.input.value !== before && els.input.value.includes("{")) {
      // pretty session left in box for user visibility
    }

    setStatus("info", "① 解析 accessToken…");
    const accessToken = extractAccessToken(els.input.value);
    const session = sessionFromAccessToken(accessToken);

    setStatus(
      "info",
      `① 账号 ${session.email || "(no email)"} · ${session.planType}\n② 生成 Ed25519 密钥对…`
    );
    const keys = await generateEd25519Keypair();

    setStatus("info", `② 密钥已生成\n③ 向 auth.openai.com 注册 agent…`);
    const agentRuntimeId = await registerAgent(accessToken, keys.publicKeySsh);

    let taskNote = "已跳过";
    if (els.verifyTask.checked) {
      setStatus("info", `③ agent_runtime_id=${agentRuntimeId}\n④ 验证 task 注册…`);
      try {
        const taskId = await registerTask(accessToken, agentRuntimeId, keys.privateKey);
        taskNote = taskId ? `OK (${taskId.slice(0, 24)}…)` : "OK";
      } catch (err) {
        taskNote = `失败（不影响 auth.json）: ${err.message}`;
      }
    }

    const authJson = buildAuthJson({
      agentRuntimeId,
      privateKeyPkcs8B64: keys.privateKeyPkcs8B64,
      accountId: session.accountId,
      userId: session.userId,
      email: session.email,
      planType: session.planType,
    });

    lastAuthJson = authJson;
    const pretty = JSON.stringify(authJson, null, 2);
    els.output.textContent = pretty;
    els.meta.innerHTML = `
      <dt>email</dt><dd>${escapeHtml(session.email || "—")}</dd>
      <dt>plan</dt><dd>${escapeHtml(session.planType)}</dd>
      <dt>account_id</dt><dd>${escapeHtml(session.accountId)}</dd>
      <dt>user_id</dt><dd>${escapeHtml(session.userId)}</dd>
      <dt>agent_runtime_id</dt><dd>${escapeHtml(agentRuntimeId)}</dd>
      <dt>task</dt><dd>${escapeHtml(taskNote)}</dd>
    `;
    els.result.hidden = false;
    markStepProgress({ pasted: true, generated: true });

    const warn =
      taskNote.startsWith("失败") || taskNote === "已跳过"
        ? `\ntask: ${taskNote}`
        : `\ntask: ${taskNote}`;
    setStatus(
      "ok",
      `完成。请先点击「下载 auth.json」保存文件，再进入第 4 步用 Cockpit 导入。${warn}`
    );
    // Stay on step 3 so the user can download first; jump to step 4 only after download.
    focusStep(3);
  } catch (err) {
    console.error(err);
    let msg = err?.message || String(err);
    if (err instanceof TypeError && /fetch|network|Failed/i.test(msg)) {
      msg +=
        "\n\n可能原因：网络无法访问 auth.openai.com，或浏览器扩展拦截了请求。请检查代理/VPN 后重试。";
    }
    setStatus("error", msg);
    markStepProgress({ pasted: !!(els.input.value || "").trim(), generated: false });
  } finally {
    setBusy(false);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadAuth() {
  if (!lastAuthJson) return;
  const name = (els.filename.value || "auth.json").trim() || "auth.json";
  const blob = new Blob([JSON.stringify(lastAuthJson, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.endsWith(".json") ? name : `${name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("ok", "已开始下载。请继续第 4 步：在 Cockpit 中从本地文件导入 auth.json");
  focusStep(4);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

async function copyAuth() {
  if (!lastAuthJson) return;
  const text = JSON.stringify(lastAuthJson, null, 2);
  const ok = await copyText(text);
  setStatus(ok ? "ok" : "error", ok ? "已复制 auth.json 到剪贴板" : "复制失败，请手动选择复制");
}

function clearAll() {
  els.input.value = "";
  lastAuthJson = null;
  els.result.hidden = true;
  clearStatus();
  markStepProgress({ pasted: false, generated: false });
  els.input.focus();
}

// ---------------------------------------------------------------------------
// Step navigation / progress
// ---------------------------------------------------------------------------

function focusStep(n) {
  const el = document.getElementById(`step${n}`);
  if (!el) return;
  document.querySelectorAll(".step-card").forEach((c) => c.classList.remove("highlight"));
  el.classList.add("highlight");
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelectorAll("[data-step-nav]").forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-step-nav") === String(n));
  });
}

function markStepProgress({ pasted = false, generated = false } = {}) {
  const hasInput = pasted || !!(els.input.value || "").trim();
  const hasResult = generated || !!lastAuthJson;
  document.querySelectorAll("[data-step-nav]").forEach((item) => {
    const n = item.getAttribute("data-step-nav");
    // 1/2 are instructional — shown as done so users see the path
    // 3 done after successful generate; 4 left for user after install
    const done = n === "1" || n === "2" || (n === "3" && hasResult) || (n === "3" && hasInput && hasResult);
    item.classList.toggle("done", done && n !== "4");
    if (n === "3") item.classList.toggle("done", hasResult);
    if (n === "4") item.classList.remove("done");
  });
}

// Wire up
els.btnGenerate.addEventListener("click", generate);
els.btnClear.addEventListener("click", clearAll);
els.btnDownload.addEventListener("click", downloadAuth);
els.btnCopy.addEventListener("click", copyAuth);

els.btnCopySessionUrl?.addEventListener("click", async () => {
  const url = $("sessionUrl")?.textContent?.trim() || "https://chatgpt.com/api/auth/session";
  const ok = await copyText(url);
  setStatus(ok ? "ok" : "error", ok ? "已复制 Session 链接，请在已登录的浏览器中打开" : "复制失败");
});

document.querySelectorAll("[data-step-nav]").forEach((item) => {
  item.addEventListener("click", () => focusStep(item.getAttribute("data-step-nav")));
});

// Paste: always auto-format / extract (no extra click)
els.input.addEventListener("paste", () => {
  setTimeout(() => {
    cleanAndFormatInput({ silent: false });
    markStepProgress({ pasted: true, generated: !!lastAuthJson });
    focusStep(3);
  }, 0);
});

els.input.addEventListener("input", () => {
  if ((els.input.value || "").trim()) {
    markStepProgress({ pasted: true, generated: !!lastAuthJson });
  }
});

// Soft warning when not secure context (Web Crypto needs it except localhost)
if (!globalThis.isSecureContext) {
  setStatus(
    "warn",
    "当前不是安全上下文（HTTPS/localhost）。Web Crypto 可能不可用。请用本地服务器或 GitHub Pages 打开。"
  );
}

// Initial: highlight step 1
markStepProgress();
focusStep(1);
// don't force scroll on first load harshly — only highlight
document.getElementById("step1")?.classList.add("highlight");
window.scrollTo(0, 0);
