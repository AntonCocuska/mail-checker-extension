console.log("[MAIL] popup.js loaded");
let config = null;
let token = "";
let messages = [];
let bodyCache = {};

const $ = (id) => document.getElementById(id);
const FM_BASE = "https://firstmail.ltd";
const FETCH_TIMEOUT = 30000;

function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ===================== UI =====================

function showSettings(populate = true) {
  $("settingsView").classList.add("active");
  $("listView").style.display = "none";
  $("msgView").classList.remove("active");
  $("cfgStatus").textContent = "";
  if (populate) populateSettings();
}
function showListView() {
  $("settingsView").classList.remove("active");
  $("listView").style.display = "flex";
  $("msgView").classList.remove("active");
}
function showMsgView() {
  $("listView").style.display = "none";
  $("msgView").classList.add("active");
}
function showList() {
  $("listView").style.display = "flex";
  $("msgView").classList.remove("active");
}

function populateSettings() {
  const c = config || {};
  $("cfgProvider").value = c.provider || "roundcube";
  $("cfgRcUrl").value = c.rcUrl || "https://me-n.com/mail/";
  $("cfgEmail").value = c.email || "";
  $("cfgPassword").value = c.password || "";
  toggleProviderFields();
}

function toggleProviderFields() {
  const p = $("cfgProvider").value;
  $("cfgRcBlock").style.display = p === "roundcube" ? "block" : "none";
  $("cfgFmBlock").style.display = p === "firstmail" ? "block" : "none";
}

function autoSplitCredentials() {
  const emailField = $("cfgEmail");
  const val = emailField.value.trim();
  const m = val.match(/^(.+?)\s*[;|,:]\s*(.+)$/);
  if (m) {
    emailField.value = m[1].trim();
    $("cfgPassword").value = m[2].trim();
  }
}

function saveSettings() {
  autoSplitCredentials();
  const newConfig = {
    provider: $("cfgProvider").value,
    rcUrl: $("cfgRcUrl").value.trim().replace(/\/?$/, "/"),
    email: $("cfgEmail").value.trim(),
    password: $("cfgPassword").value,
  };

  if (!newConfig.email || !newConfig.password) {
    $("cfgStatus").textContent = "Fill email and password";
    $("cfgStatus").style.color = "#e94560";
    return;
  }
  if (newConfig.provider === "roundcube" && !newConfig.rcUrl) {
    $("cfgStatus").textContent = "Fill Roundcube URL";
    $("cfgStatus").style.color = "#e94560";
    return;
  }

  chrome.storage.local.set({ mailConfig: newConfig, mailCache: null }, () => {
    config = newConfig;
    bodyCache = {};
    token = "";
    $("cfgStatus").textContent = "Saved!";
    $("cfgStatus").style.color = "#4caf50";
    setTimeout(() => {
      $("emailDisplay").textContent = config.email;
      showListView();
      loadInbox();
    }, 500);
  });
}
function setStatus(t) { $("statusBar").textContent = t; }

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function renderMessages(msgs) {
  const list = $("mailList");
  if (!msgs.length) {
    list.innerHTML = '<div class="loading">No messages</div>';
    return;
  }
  list.innerHTML = msgs.map((m, i) => `
    <div class="mail-item ${m.seen ? "read" : "unread"}" data-idx="${i}">
      <div class="from">${esc(m.name || m.from_name)}</div>
      <div class="subject">${esc(m.subject)}</div>
      <div class="meta">
        <span>${esc(m.email || m.from_email)}</span>
        <span>${esc(m.date)}${m.size ? " · " + esc(m.size) : ""}</span>
      </div>
      <button class="del-btn" data-uid="${m.uid}" title="Delete">&times;</button>
    </div>`).join("");

  list.querySelectorAll(".mail-item").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.classList.contains("del-btn")) return;
      openMessage(parseInt(el.dataset.idx));
    });
  });
  list.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      deleteMessage(btn.dataset.uid);
    });
  });
}

// ===================== Roundcube Provider =====================

const RC = {
  async _getCookieHeader() {
    try {
      const url = new URL(config.rcUrl);
      const cookies = await chrome.cookies.getAll({ domain: url.hostname });
      return cookies.map(c => `${c.name}=${c.value}`).join("; ");
    } catch(e) { return ""; }
  },

  async request(path, opts = {}) {
    const cookie = await RC._getCookieHeader();
    const { headers: extraHeaders, ...restOpts } = opts;
    return fetchWithTimeout(config.rcUrl + path, {
      credentials: "include",
      ...restOpts,
      headers: {
        "Cookie": cookie,
        "X-Requested-With": "XMLHttpRequest",
        "X-Roundcube-Request": token,
        ...extraHeaders,
      },
    });
  },

  async login() {
    setStatus("Connecting...");
    const cookie = await RC._getCookieHeader();
    console.log("[RC] login: cookie =", cookie ? cookie.substring(0, 80) + "..." : "(empty)");
    let page;
    try {
      page = await fetchWithTimeout(config.rcUrl, {
        credentials: "include",
        headers: { "Cookie": cookie },
      });
    } catch(e) {
      if (e.name === "AbortError") throw new Error("Roundcube timeout. Server not responding.");
      throw new Error("No connection to Roundcube. Check your internet.");
    }
    console.log("[RC] login: page status =", page.status, page.url);
    if (!page.ok) throw new Error("Roundcube returned error " + page.status);
    const html = await page.text();
    const tm = html.match(/"request_token":"([^"]+)"/);
    if (!tm) {
      console.log("[RC] login: no request_token found. HTML start:", html.substring(0, 500));
      throw new Error("Cannot reach Roundcube server");
    }
    token = tm[1];
    console.log("[RC] login: token =", token, "task-login =", html.indexOf("task-login") !== -1);

    if (html.indexOf("task-login") === -1) {
      setStatus("Connected");
      return;
    }

    setStatus("Logging in...");
    const freshCookie = await RC._getCookieHeader();
    console.log("[RC] login POST: freshCookie =", freshCookie ? freshCookie.substring(0, 80) + "..." : "(empty)");
    const resp = await fetchWithTimeout(config.rcUrl + "?_task=login", {
      method: "POST", credentials: "include",
      headers: {
        "Cookie": freshCookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _token: token, _task: "login", _action: "login",
        _timezone: "Europe/Moscow", _url: "",
        _user: config.email, _pass: config.password,
      }).toString(),
      redirect: "follow",
    });
    const rh = await resp.text();
    console.log("[RC] login POST response: status =", resp.status, "url =", resp.url, "has task-login =", rh.indexOf("task-login") !== -1);
    if (rh.indexOf("task-login") !== -1 && rh.indexOf("rcmloginuser") !== -1)
      throw new Error("Wrong login/password");
    const nt = rh.match(/"request_token":"([^"]+)"/);
    if (nt) token = nt[1];
    console.log("[RC] login: new token =", token);
    setStatus("Connected");
  },

  async fetchInbox() {
    const resp = await RC.request(
      "?_task=mail&_action=list&_mbox=INBOX&_page=1&_layout=list&_remote=1&_unlock=0"
    );
    const text = await resp.text();
    console.log("[RC] fetchInbox: status =", resp.status, "length =", text.length, "start =", text.substring(0, 200));
    let execStr = text;
    try { const j = JSON.parse(text); if (j.exec) execStr = j.exec; console.log("[RC] fetchInbox: parsed JSON, exec length =", execStr.length); } catch(e) { console.log("[RC] fetchInbox: not JSON, raw text"); }

    // Detect login page — session expired
    if (text.indexOf("task-login") !== -1 && text.indexOf("rcmloginuser") !== -1) {
      console.log("[RC] fetchInbox: detected login page — session expired");
      throw new Error("Session expired");
    }

    const msgs = [];
    const re = /add_message_row\((\d+),(\{.*?\}),(\{.*?\})/g;
    let m;
    while ((m = re.exec(execStr))) {
      const [, uid, infoStr, flagsStr] = m;
      let subject="?", em="?", name="?", date="", size="", seen=false;
      try {
        const info = JSON.parse(infoStr);
        subject = info.subject || "?"; date = info.date || ""; size = info.size || "";
        if (info.fromto) {
          const t = info.fromto.match(/title="([^"]*)"/); if (t) em = t[1];
          const n = info.fromto.match(/rcmContactAddress">(.*?)<\/span>/); if (n) name = n[1];
        }
      } catch(e) {}
      try { seen = !!JSON.parse(flagsStr).seen; } catch(e) {}
      msgs.push({ uid, subject, email: em, name, date, size, seen });
    }
    console.log("[RC] fetchInbox: parsed", msgs.length, "messages");
    return msgs;
  },

  async fetchBody(uid) {
    const resp = await RC.request(`?_task=mail&_action=preview&_uid=${uid}&_mbox=INBOX&_framed=1`);
    const html = await resp.text();
    const headers = {};
    const hF = html.match(/id="rcmfromval"[^>]*>([^<]+)</); if (hF) headers.from = hF[1].trim();
    const hD = html.match(/id="rcmdateshow"[^>]*>([^<]+)</); if (hD) headers.date = hD[1].trim();
    const hS = html.match(/id="rcmsubjectshow"[^>]*>([^<]+)</); if (hS) headers.subject = hS[1].trim();
    // Extract message body from the preview frame
    const bodyMatch = html.match(/id="messagebody"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*id="message-footer|<\/td>|$)/i);
    if (bodyMatch) {
      return { headers, body: bodyMatch[1].trim(), isHtml: true };
    }
    // Fallback: try to get the whole body area
    const fallback = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (fallback) {
      return { headers, body: fallback[1].trim(), isHtml: true };
    }
    return { headers, body: html, isHtml: true };
  },

  async deleteMsg(uid) {
    await RC.request(
      `?_task=mail&_action=move&_uid=${uid}&_mbox=INBOX&_target_mbox=Trash&_remote=1&_unlock=0`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _uid: uid, _mbox: "INBOX", _target_mbox: "Trash", _token: token, _action: "move" }).toString() }
    );
  }
};

// ===================== FirstMail (REST API) =====================

const FM = {
  async _getCookieHeader() {
    const cookies = await chrome.cookies.getAll({ domain: "firstmail.ltd" });
    console.log("[FM] Cookies found:", cookies.length, cookies.map(c => `${c.name}=${c.value.substring(0,8)}... (domain=${c.domain}, expires=${c.expirationDate ? new Date(c.expirationDate*1000).toISOString() : "session"}, httpOnly=${c.httpOnly})`));
    if (!cookies.length) console.log("[FM] NO COOKIES — user needs to login on firstmail.ltd");
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  },

  async _api(path, opts = {}) {
    const cookie = await FM._getCookieHeader();
    // Also grab challenge cookies from subdomains
    const subCookies = await chrome.cookies.getAll({ domain: ".firstmail.ltd" });
    const allCookies = [...new Map([...subCookies, ...await chrome.cookies.getAll({ domain: "firstmail.ltd" })].map(c => [c.name, c])).values()];
    const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join("; ");
    console.log("[FM] _api cookies:", allCookies.length, "for", path);
    const { headers: extraHeaders, ...restOpts } = opts;
    const r = await fetchWithTimeout(`${FM_BASE}${path}`, {
      credentials: "include",
      ...restOpts,
      headers: {
        "Cookie": cookieStr,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://firstmail.ltd/webmail/",
        "X-Requested-With": "XMLHttpRequest",
        ...extraHeaders,
      },
    });
    return r;
  },

  async _json(path, opts = {}) {
    const r = await FM._api(path, opts);
    const text = await r.text();
    if (text.startsWith("<")) {
      console.log("FM HTML response for " + path + ":", text.substring(0, 300));
      throw new Error("Not logged in to FirstMail. Open firstmail.ltd and login first.");
    }
    return JSON.parse(text);
  },

  async login() {
    setStatus("Connecting to FirstMail...");
    try {
      const data = await FM._json("/webmail/api/session/accounts/");
      console.log("[FM] login response:", JSON.stringify(data).substring(0, 500));
      if (data.success && data.accounts && data.accounts.length > 0) {
        setStatus("Connected");
        return;
      }
      throw new Error("No session");
    } catch(e) {
      console.log("[FM] login error:", e.message);
      if (e.name === "AbortError") throw new Error("FirstMail timeout. Server not responding.");
      if (e.message === "Failed to fetch") throw new Error("No connection to FirstMail. Check your internet.");
      throw new Error("Not logged in. Open firstmail.ltd, login with «Memorize session» ✓");
    }
  },

  async fetchInbox() {
    const data = await FM._json(`/webmail/api/emails/?folder=inbox&t=${Date.now()}`);
    if (!data.success) throw new Error("Failed to fetch inbox");
    return (data.emails || []).map(m => {
      let name = m.from || "";
      let em = m.from || "";
      const emMatch = (m.from || "").match(/<([^>]+)>/);
      if (emMatch) {
        em = emMatch[1];
        name = m.from.substring(0, m.from.indexOf("<")).trim().replace(/^"|"$/g, "");
      }
      return {
        uid: m.id, subject: m.subject,
        email: em, name: name,
        date: m.date, size: "", seen: m.is_read,
      };
    });
  },

  async fetchBody(uid) {
    const data = await FM._json(`/webmail/api/emails/${uid}/`);
    const em = data.email || {};
    const body = em.body || "";
    const isHtml = body.trimStart().startsWith("<");
    return {
      headers: {
        from: em.from || "",
        to: em.to || "",
        subject: em.subject || "",
        date: em.date || "",
      },
      body,
      isHtml,
    };
  },

  async deleteMsg(uid) {
    // Try DELETE first
    let r = await FM._api(`/webmail/api/emails/${uid}/`, { method: "DELETE" });
    if (r.ok) return;
    // Try move to trash
    r = await FM._api(`/webmail/api/emails/${uid}/move/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: "trash" }),
    });
    if (r.ok) return;
    // Try trash endpoint
    r = await FM._api(`/webmail/api/emails/${uid}/trash/`, { method: "POST" });
    if (!r.ok) throw new Error("Delete failed");
  }
};

// ===================== Render body =====================

function renderBody(body, isHtml) {
  const c = $("msgBody");
  if (isHtml) {
    let clean = body
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<img[^>]*(width\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?|display\s*:\s*none)[^>]*>/gi, "")
      .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "")
      .replace(/\s+on\w+\s*=\s*[^\s>]+/gi, "")
      .replace(/<a\s/gi, '<a target="_blank" rel="noopener" ')
      .replace(/\s*bgcolor\s*=\s*["'][^"']*["']/gi, "")
      .replace(/\s*bgcolor\s*=\s*\S+/gi, "")
      .replace(/background\s*:\s*#[0-9a-fA-F]{3,8}/gi, "background:transparent")
      .replace(/background-color\s*:\s*#[0-9a-fA-F]{3,8}/gi, "background-color:transparent")
      .replace(/background-color\s*:\s*(?:white|rgb\([^)]+\))/gi, "background-color:transparent");
    c.innerHTML = `
      <style>
        .mr{font-family:-apple-system,sans-serif;font-size:13px;line-height:1.6;color:#ddd;word-wrap:break-word;background:#1a1a2e!important}
        .mr *{max-width:100%!important;box-sizing:border-box!important;background-color:transparent!important;color:#ddd!important}
        .mr img{max-width:100%!important;height:auto!important;border-radius:4px}
        .mr a{color:#e94560!important;text-decoration:none!important;word-break:break-all}
        .mr a:hover{text-decoration:underline!important}
        .mr table{border-collapse:collapse;max-width:100%!important;width:auto!important}
        .mr td,.mr th{max-width:390px!important;background-color:transparent!important}
        .mr hr{border:none;border-top:1px solid #333;margin:10px 0}
        .mr h1,.mr h2,.mr h3{color:#fff!important;font-size:14px;margin:8px 0 4px}
        .mr p{margin:4px 0}
        .mr blockquote{border-left:3px solid #333;padding-left:10px;margin:6px 0;color:#999!important}
        .mr span,.mr div,.mr td,.mr th,.mr p,.mr li,.mr b,.mr strong,.mr em,.mr i{color:#ddd!important}
        .mr strong,.mr b{color:#fff!important}
      </style>
      <div class="mr">${clean}</div>`;
  } else {
    let t = esc(body);
    t = t.replace(/(https?:\/\/[^\s<]{10,})/g, url => {
      let label;
      try { const u = new URL(url.replace(/&amp;/g, "&")); label = u.hostname + (u.pathname.length > 20 ? u.pathname.substring(0, 20) + "..." : u.pathname); }
      catch(e) { label = url.substring(0, 40) + "..."; }
      return `<a href="${url.replace(/&amp;/g, "&")}" target="_blank" class="text-link">${label}</a>`;
    });
    t = t.replace(/^[=\-]{5,}$/gm, "<hr>");
    c.innerHTML = `<div class="text-render">${t}</div>`;
  }
}

// ===================== Actions =====================

function getProvider() {
  return config.provider === "firstmail" ? FM : RC;
}

async function loadInbox() {
  setStatus("Loading...");
  if (!messages.length) {
    $("mailList").innerHTML = '<div class="loading">Loading...</div>';
  }
  const P = getProvider();

  try {
    // Login only if no token cached (first load or after error)
    if (!token) await P.login();
    try {
      messages = await P.fetchInbox();
    } catch (e2) {
      // Token might be stale — re-login once and retry
      console.log("[MAIL] fetchInbox failed, re-login:", e2.message);
      token = "";
      await P.login();
      messages = await P.fetchInbox();
    }
    renderMessages(messages);
    chrome.storage.local.set({ mailCache: { messages, time: Date.now() } });
    setStatus(`${messages.length} messages · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    console.log("[MAIL] loadInbox error:", e.message);
    token = "";
    $("mailList").innerHTML = `<div class="error-msg">${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">Retry</button></div>`;
    setStatus("Error");
  }
}

async function openMessage(idx) {
  const msg = messages[idx];
  $("msgSubj").textContent = msg.subject;
  $("msgFrom").textContent = `${msg.name || msg.from_name || ""} <${msg.email || msg.from_email || ""}>`;
  $("msgDate").textContent = msg.date;
  $("msgBody").innerHTML = '<div style="text-align:center;color:#555;padding:30px">Loading...</div>';
  showMsgView();

  // Mark as read
  if (!msg.seen) {
    msg.seen = true;
    const row = $("mailList").querySelector(`.mail-item[data-idx="${idx}"]`);
    if (row) { row.classList.remove("unread"); row.classList.add("read"); }
    chrome.storage.local.set({ mailCache: { messages, time: Date.now() } });
  }

  try {
    if (bodyCache[String(msg.uid)]) {
      const c = bodyCache[String(msg.uid)];
      if (c.headers) {
        if (c.headers.from) $("msgFrom").textContent = c.headers.from;
        if (c.headers.date) $("msgDate").textContent = c.headers.date;
        if (c.headers.subject) $("msgSubj").textContent = c.headers.subject;
      }
      renderBody(c.body, c.isHtml);
      return;
    }

    const P = getProvider();
    const data = await P.fetchBody(msg.uid);
    bodyCache[String(msg.uid)] = data;
    if (data.headers) {
      if (data.headers.from) $("msgFrom").textContent = data.headers.from;
      if (data.headers.date) $("msgDate").textContent = data.headers.date;
      if (data.headers.subject) $("msgSubj").textContent = data.headers.subject;
    }
    renderBody(data.body, data.isHtml);
  } catch (e) {
    $("msgBody").textContent = "Error: " + e.message;
  }
}

async function deleteMessage(uid) {
  const item = document.querySelector(`.del-btn[data-uid="${uid}"]`);
  const row = item ? item.closest(".mail-item") : null;
  // Double-click protection: require confirmation via second click within 3s
  if (row && !row.dataset.confirmDelete) {
    row.dataset.confirmDelete = "1";
    row.style.background = "rgba(233,69,96,0.15)";
    const delBtn = row.querySelector(".del-btn");
    if (delBtn) { delBtn.style.opacity = "1"; delBtn.style.color = "#e94560"; }
    setTimeout(() => {
      delete row.dataset.confirmDelete;
      row.style.background = "";
      if (delBtn) { delBtn.style.opacity = ""; delBtn.style.color = ""; }
    }, 3000);
    return;
  }
  if (row) { row.style.opacity = "0.3"; row.style.pointerEvents = "none"; }

  try {
    await getProvider().deleteMsg(uid);
    messages = messages.filter(m => String(m.uid) !== String(uid));
    delete bodyCache[String(uid)];
    renderMessages(messages);
    chrome.storage.local.set({ mailCache: { messages, time: Date.now() } });
    setStatus("Deleted · " + new Date().toLocaleTimeString());
  } catch (e) {
    if (row) { row.style.opacity = "1"; row.style.pointerEvents = "auto"; }
    setStatus("Delete failed: " + e.message);
  }
}

// ===================== Init =====================

async function init() {
  $("cfgProvider").addEventListener("change", toggleProviderFields);
  $("cfgEmail").addEventListener("paste", () => setTimeout(autoSplitCredentials, 0));
  $("cfgSave").addEventListener("click", saveSettings);
  $("cfgCancel").addEventListener("click", () => {
    if (config && config.email) showListView();
  });
  $("settingsBtn").addEventListener("click", () => showSettings());
  $("refreshBtn").addEventListener("click", () => { bodyCache = {}; loadInbox(); });
  $("backBtn").addEventListener("click", showList);
  $("emailDisplay").addEventListener("click", () => {
    const email = $("emailDisplay").textContent;
    if (email) {
      navigator.clipboard.writeText(email);
      const orig = $("emailDisplay").textContent;
      $("emailDisplay").textContent = "Copied!";
      setTimeout(() => { $("emailDisplay").textContent = orig; }, 1000);
    }
  });

  const data = await chrome.storage.local.get(["mailConfig", "mailCache"]);
  config = data.mailConfig;

  if (!config || !config.email || !config.password) {
    showSettings();
    return;
  }

  $("emailDisplay").textContent = config.email;
  showListView();

  // Show cache instantly
  if (data.mailCache && data.mailCache.messages && data.mailCache.messages.length) {
    messages = data.mailCache.messages;
    renderMessages(messages);
    const mins = Math.round((Date.now() - (data.mailCache.time || 0)) / 60000);
    setStatus(`Cached (${mins}m ago) · refreshing...`);
  }

  // Fresh load (loadInbox will login if needed)
  await loadInbox();
}

init();
