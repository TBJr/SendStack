const state = {
  session: null,
  csrf: "",
  currentView: "dashboard",
  lists: [],
  users: [],
  roles: [],
  permissionDefinitions: [],
  pollTimer: null,
};

const els = {
  loginScreen: document.querySelector("#login-screen"),
  appShell: document.querySelector("#app-shell"),
  loginForm: document.querySelector("#login-form"),
  loginError: document.querySelector("#login-error"),
  content: document.querySelector("#content"),
  pageTitle: document.querySelector("#page-title"),
  pageKicker: document.querySelector("#page-kicker"),
  nav: document.querySelector("#main-nav"),
  modal: document.querySelector("#modal"),
  modalBody: document.querySelector("#modal-body"),
  modalTitle: document.querySelector("#modal-title"),
  modalKicker: document.querySelector("#modal-kicker"),
  toastRegion: document.querySelector("#toast-region"),
  modePill: document.querySelector("#mode-pill"),
  queueStatus: document.querySelector("#queue-status"),
};

const viewMeta = {
  dashboard: ["Overview", "Operations"],
  contacts: ["Contacts", "Audience"],
  campaigns: ["Campaigns", "Delivery"],
  sending: ["Sending setup", "Production readiness"],
  deliveries: ["Deliveries", "Sandbox inbox"],
  suppressions: ["Suppressions", "Safety controls"],
  users: ["Users & roles", "Access control"],
  audit: ["Audit log", "Governance"],
};

const viewPermissions = {
  contacts: "contacts.view",
  campaigns: "campaigns.view",
  sending: "sending.view",
  deliveries: "deliveries.view",
  suppressions: "suppressions.view",
  users: "users.view",
  audit: "audit.view",
};

function can(permission) {
  return Boolean(state.session?.permissions?.includes(permission));
}

const defaultTemplate = `<!doctype html>
<html>
  <body style="margin:0;background:#f1f5fb;font-family:Arial,sans-serif;color:#14213d">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5fb;padding:32px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:white;border-radius:14px;overflow:hidden">
          <tr><td style="padding:26px 30px;background:#172952;color:white;font-size:20px;font-weight:bold">SendStack</td></tr>
          <tr><td style="padding:34px 30px">
            <p style="margin:0 0 14px;font-size:16px">Hello {{first_name}},</p>
            <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">A useful update, sent thoughtfully.</h1>
            <p style="margin:0 0 22px;color:#53627a;line-height:1.65">Replace this text with the message you want your audience to receive. The test inbox will show the fully personalized result before external delivery is enabled.</p>
            <a href="#" style="display:inline-block;background:#5b7cff;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">Primary action</a>
          </td></tr>
          <tr><td style="padding:21px 30px;background:#f7f9fc;color:#718097;font-size:12px;line-height:1.6">You are receiving this because you opted in to updates.<br><a href="{{unsubscribe_url}}" style="color:#536fd9">Unsubscribe</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

const defaultVisualContent = {
  schema_version: 1,
  template: "announcement",
  brand_name: "SendStack",
  preheader: "A useful update for our subscribers",
  headline: "A useful update, sent thoughtfully.",
  body: "Replace this text with the message you want your audience to receive. The test inbox will show the fully personalized result before external delivery is enabled.",
  cta_label: "Primary action",
  cta_url: "https://example.com",
  accent_color: "#5b7cff",
  footer: "You are receiving this because you opted in to updates.",
};

const defaultRichContent = `<h1>A useful update, sent thoughtfully.</h1><p>Hello {{first_name}},</p><p>Write your message here. Use the toolbar for emphasis and lists without touching HTML.</p><p><strong>Thank you for reading.</strong></p>`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeContentObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) { /* legacy campaign metadata falls back safely */ }
  }
  return { schema_version: 1 };
}

function safeComposerUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url === "{{unsubscribe_url}}" || url.startsWith("#")) return url;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : "";
  } catch (_) {
    return "";
  }
}

function sanitizeRichHtml(markup) {
  const template = document.createElement("template");
  template.innerHTML = String(markup || "");
  const allowed = new Set(["P", "DIV", "BR", "H1", "H2", "H3", "STRONG", "B", "EM", "I", "U", "UL", "OL", "LI", "A", "BLOCKQUOTE", "SPAN"]);
  [...template.content.querySelectorAll("*")].forEach((node) => {
    if (!allowed.has(node.tagName)) {
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "SVG"].includes(node.tagName)) node.remove();
      else node.replaceWith(...node.childNodes);
      return;
    }
    const originalHref = node.tagName === "A" ? node.getAttribute("href") : "";
    [...node.attributes].forEach((attribute) => node.removeAttribute(attribute.name));
    if (node.tagName === "A") {
      const href = safeComposerUrl(originalHref || "");
      if (href) {
        node.setAttribute("href", href);
        node.setAttribute("rel", "noopener");
      }
    }
  });
  return template.innerHTML;
}

function richHtmlToText(markup) {
  const container = document.createElement("div");
  container.innerHTML = sanitizeRichHtml(markup)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|li|blockquote)>/gi, "\n");
  return (container.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function visualEmailContent(input) {
  const data = { ...defaultVisualContent, ...(input || {}), schema_version: 1 };
  const accent = /^#[0-9a-f]{6}$/i.test(data.accent_color || "") ? data.accent_color : defaultVisualContent.accent_color;
  const template = ["announcement", "newsletter", "simple"].includes(data.template) ? data.template : "announcement";
  const background = template === "simple" ? "#ffffff" : "#f1f5fb";
  const headerBackground = template === "simple" ? "#ffffff" : template === "newsletter" ? accent : "#172952";
  const headerColor = template === "simple" ? "#14213d" : "#ffffff";
  const cardBorder = template === "simple" ? "1px solid #dfe6f1" : "0";
  const paragraphs = escapeHtml(data.body).split(/\n{2,}/).map((paragraph) => `<p style="margin:0 0 16px;color:#53627a;line-height:1.65">${paragraph.replaceAll("\n", "<br>")}</p>`).join("");
  const ctaUrl = safeComposerUrl(data.cta_url);
  const cta = data.cta_label && ctaUrl ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">${escapeHtml(data.cta_label)}</a>` : "";
  const htmlBody = `<!doctype html><html><body style="margin:0;background:${background};font-family:Arial,sans-serif;color:#14213d"><div style="display:none;max-height:0;overflow:hidden;color:transparent">${escapeHtml(data.preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${background};padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:${cardBorder};border-radius:14px;overflow:hidden"><tr><td style="padding:26px 30px;background:${headerBackground};color:${headerColor};font-size:20px;font-weight:bold">${escapeHtml(data.brand_name)}</td></tr><tr><td style="padding:34px 30px"><p style="margin:0 0 14px;font-size:16px">Hello {{first_name}},</p><h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">${escapeHtml(data.headline)}</h1>${paragraphs}${cta}</td></tr><tr><td style="padding:21px 30px;background:#f7f9fc;color:#718097;font-size:12px;line-height:1.6">${escapeHtml(data.footer)}<br><a href="{{unsubscribe_url}}" style="color:${accent}">Unsubscribe</a></td></tr></table></td></tr></table></body></html>`;
  const textParts = [data.brand_name, `Hello {{first_name}},`, data.headline, data.body];
  if (data.cta_label && ctaUrl) textParts.push(`${data.cta_label}: ${ctaUrl}`);
  textParts.push(data.footer, "Unsubscribe: {{unsubscribe_url}}");
  return { html_body: htmlBody, text_body: textParts.filter(Boolean).join("\n\n"), content_json: data };
}

function richEmailContent(input) {
  const richHtml = sanitizeRichHtml(input?.rich_html || defaultRichContent);
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f1f5fb;font-family:Arial,sans-serif;color:#14213d"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:14px"><tr><td style="padding:34px 30px;line-height:1.65">${richHtml}</td></tr><tr><td style="padding:20px 30px;background:#f7f9fc;color:#718097;font-size:12px">You are receiving this because you opted in.<br><a href="{{unsubscribe_url}}" style="color:#536fd9">Unsubscribe</a></td></tr></table></td></tr></table></body></html>`;
  const text = richHtmlToText(richHtml);
  return { html_body: htmlBody, text_body: `${text}\n\nUnsubscribe: {{unsubscribe_url}}`, content_json: { schema_version: 1, rich_html: richHtml } };
}

function plainEmailContent(input) {
  let text = String(input?.plain_text || "Hello {{first_name}},\n\nWrite your message here.").trim();
  if (!text.includes("{{unsubscribe_url}}")) text += "\n\nUnsubscribe: {{unsubscribe_url}}";
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f1f5fb;font-family:Arial,sans-serif;color:#14213d"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px"><tr><td align="center"><div style="max-width:600px;background:#ffffff;border-radius:12px;padding:30px;white-space:pre-wrap;line-height:1.65">${escapeHtml(text).replaceAll("\n", "<br>")}</div></td></tr></table></body></html>`;
  return { html_body: htmlBody, text_body: text, content_json: { schema_version: 1, plain_text: text } };
}

function buildCampaignContent(mode, draft) {
  if (mode === "visual") return visualEmailContent(draft);
  if (mode === "rich_text") return richEmailContent(draft);
  if (mode === "plain_text") return plainEmailContent(draft);
  return {
    html_body: String(draft?.html_body || defaultTemplate),
    text_body: String(draft?.text_body || "Hello {{first_name}},\n\nWrite your message here.\n\nUnsubscribe: {{unsubscribe_url}}"),
    content_json: { schema_version: 1 },
  };
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function titleCase(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusPill(status) {
  const safe = String(status || "unknown").toLowerCase();
  return `<span class="status ${escapeHtml(safe)}">${escapeHtml(titleCase(safe))}</span>`;
}

function initials(name) {
  return String(name || "User")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  els.toastRegion.append(item);
  setTimeout(() => item.remove(), 4200);
}

async function api(path, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  if (request.body && typeof request.body !== "string") {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(request.body);
  }
  if (request.method && request.method !== "GET" && state.csrf) {
    request.headers["X-CSRF-Token"] = state.csrf;
  }
  const response = await fetch(path, request);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (response.status === 401 && path !== "/api/auth/login") {
    showLogin();
    throw new Error("Your session has ended. Sign in again.");
  }
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return data;
}

function showLogin() {
  state.session = null;
  state.csrf = "";
  clearInterval(state.pollTimer);
  els.appShell.hidden = true;
  els.loginScreen.hidden = false;
  document.querySelector("#login-email")?.focus();
}

function showApp(sessionData) {
  state.session = sessionData;
  state.csrf = sessionData.csrf_token;
  els.loginScreen.hidden = true;
  els.appShell.hidden = false;
  const user = sessionData.user;
  document.querySelector("#user-name").textContent = user.name;
  document.querySelector("#user-role").textContent = user.role_label || titleCase(user.role);
  document.querySelector("#user-initials").textContent = initials(user.name);
  document.querySelectorAll("[data-permission]").forEach((element) => {
    element.hidden = !can(element.dataset.permission);
  });
  const smtp = sessionData.delivery_mode === "smtp";
  const resend = sessionData.delivery_mode === "resend";
  els.modePill.innerHTML = `<span></span> ${resend ? "Resend" : smtp ? "SMTP test" : "Sandbox"}`;
  if (sessionData.must_change_password || user?.must_change_password) {
    openChangePasswordModal(true);
    return;
  }
  startPolling();
  navigate(state.currentView || "dashboard");
}

function openChangePasswordModal(required = false) {
  openModal(
    "Change password",
    required ? "Security" : "Account",
    `<form id="change-password-form" class="stack">
      <p class="subtext">${required ? "You must set a new password before using SendStack." : "Update your account password."}</p>
      <label>Current password<input name="current_password" type="password" autocomplete="current-password" required /></label>
      <label>New password<input name="new_password" type="password" autocomplete="new-password" minlength="12" required /></label>
      <p class="form-error" role="alert"></p>
      <button class="button primary" type="submit">Save password</button>
    </form>`,
  );
  if (required) {
    document.querySelector("#modal-close")?.setAttribute("disabled", "true");
  }
  const form = document.querySelector("#change-password-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await submitForm(form, () =>
      api("/api/auth/change-password", {
        method: "POST",
        body: {
          current_password: form.current_password.value,
          new_password: form.new_password.value,
        },
      }), "Password updated");
    if (result) {
      document.querySelector("#modal-close")?.removeAttribute("disabled");
      closeModal();
      showApp(result);
    }
  });
}

function setLoading() {
  els.content.innerHTML = `<div class="loading-grid" aria-label="Loading"><div></div><div></div><div></div></div>`;
}

function setEmpty(icon, title, copy, actionHtml = "") {
  els.content.innerHTML = `<section class="panel empty-state"><div><div class="empty-mark">${icon}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p>${actionHtml}</div></section>`;
}

async function navigate(view) {
  if (!viewMeta[view]) view = "dashboard";
  if (viewPermissions[view] && !can(viewPermissions[view])) {
    toast("You don’t have permission to open that section.", "error");
    view = "dashboard";
  }
  state.currentView = view;
  document.body.classList.remove("nav-open");
  els.nav.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  els.pageTitle.textContent = viewMeta[view][0];
  els.pageKicker.textContent = viewMeta[view][1];
  setLoading();
  els.content.focus({ preventScroll: true });
  try {
    if (view === "dashboard") await renderDashboard();
    if (view === "contacts") await renderContacts();
    if (view === "campaigns") await renderCampaigns();
    if (view === "sending") await renderSendingSetup();
    if (view === "deliveries") await renderDeliveries();
    if (view === "suppressions") await renderSuppressions();
    if (view === "users") await renderUsers();
    if (view === "audit") await renderAudit();
  } catch (error) {
    renderError(error);
  }
}

function renderError(error) {
  els.content.innerHTML = `<div class="notice warning"><span>!</span><div><strong>Couldn’t load this view.</strong><br>${escapeHtml(error.message)}</div></div>`;
}

async function getLists(force = false) {
  if (!state.lists.length || force) {
    state.lists = (await api("/api/lists")).lists;
  }
  return state.lists;
}

function updateQueueStatus(summary) {
  const queued = summary.counts?.queued || 0;
  els.queueStatus.innerHTML = `<span></span><strong>${queued ? `${queued} queued` : "Queue clear"}</strong>`;
  els.queueStatus.querySelector("span").style.background = queued ? "#f3b65a" : "#50d4c2";
}

function startPolling() {
  clearInterval(state.pollTimer);
  const poll = async () => {
    if (!state.session || document.hidden) return;
    try {
      const summary = await api("/api/summary");
      updateQueueStatus(summary);
    } catch (_) {
      // Authentication handling occurs in api(); transient polling errors stay quiet.
    }
  };
  poll();
  state.pollTimer = setInterval(poll, 3000);
}

async function renderDashboard() {
  const data = await api("/api/summary");
  updateQueueStatus(data);
  const remaining = Math.max(0, data.daily_limit - data.counts.sent_today);
  els.content.innerHTML = `
    <section class="stat-grid" aria-label="Delivery overview">
      <article class="stat-card"><span class="stat-label">Active contacts</span><strong class="stat-value">${data.counts.contacts.toLocaleString()}</strong><span class="stat-detail">Ready for eligible campaigns</span></article>
      <article class="stat-card" style="--stat-glow:rgba(80,212,194,.15)"><span class="stat-label">Captured today</span><strong class="stat-value">${data.counts.sent_today.toLocaleString()}</strong><span class="stat-detail"><strong>${remaining.toLocaleString()}</strong> left under the test cap</span></article>
      <article class="stat-card" style="--stat-glow:rgba(243,182,90,.14)"><span class="stat-label">Queue</span><strong class="stat-value">${data.counts.queued.toLocaleString()}</strong><span class="stat-detail">Messages waiting or processing</span></article>
      <article class="stat-card" style="--stat-glow:rgba(255,111,125,.12)"><span class="stat-label">Suppressed</span><strong class="stat-value">${data.counts.suppressed.toLocaleString()}</strong><span class="stat-detail">Globally excluded before delivery</span></article>
    </section>
    <div class="two-column">
      <section class="panel">
        <div class="panel-head"><div><h2>Recent campaigns</h2><p>Latest audience runs and current states</p></div><button class="button small ghost" data-go="campaigns">View all</button></div>
        ${renderRecentCampaignTable(data.recent_campaigns)}
      </section>
      ${can("deliveries.view") ? `<section class="panel">
        <div class="panel-head"><div><h2>Latest captures</h2><p>${escapeHtml(titleCase(data.delivery_mode))} delivery activity</p></div><button class="button small ghost" data-go="deliveries">Open inbox</button></div>
        <div class="panel-body">${renderRecentMessages(data.recent_messages)}</div>
      </section>` : `<section class="panel access-summary"><div class="panel-body"><div class="access-lock">◌</div><h2>Recipient data is protected</h2><p>Your Analyst role includes aggregate campaign reporting without contact addresses or message contents.</p></div></section>`}
    </div>
    <section class="production-target-strip">
      <div class="target-strip-copy"><span class="readiness-status pending">Migration required</span><div><strong>Production target: Vercel + PostgreSQL + Resend</strong><p>The architecture is selected, but live delivery is not connected to this local build yet.</p></div></div>
      <button class="button" data-go="sending">View readiness</button>
    </section>
    <div class="notice" style="margin-top:16px"><span>i</span><div><strong>${data.delivery_mode === "sandbox" ? "Sandbox delivery is active." : "SMTP test delivery is active."}</strong> ${data.delivery_mode === "sandbox" ? "No message leaves this application; every send is captured in Deliveries." : "Only explicitly allowlisted recipients can receive messages."}</div></div>`;
}

function readinessStatusLabel(status) {
  const labels = {
    ready: "Ready",
    migration_required: "Migration required",
    not_connected: "Not connected",
    not_verified: "Not verified",
    configured_locked: "Configured (locked)",
    configured: "Configured",
  };
  return labels[status] || titleCase(status);
}

function checkById(checks, id) {
  return checks.find((check) => check.id === id) || { status: "pending", detail: "" };
}

async function renderSendingSetup() {
  const data = await api("/api/production-readiness");
  const target = data.target;
  const readyCount = data.checks.filter((check) => check.status === "ready").length;
  const vercel = checkById(data.checks, "vercel_runtime");
  const postgres = checkById(data.checks, "postgres_database");
  const resend = checkById(data.checks, "resend_broadcasts");
  const liveReady = Boolean(data.ready_for_live_sending);
  els.content.innerHTML = `
    <section class="production-hero">
      <div>
        <span class="readiness-status ${liveReady ? "ready" : "pending"}">${liveReady ? "Live sending unlocked" : "Live sending locked"}</span>
        <p class="eyebrow">SELECTED PRODUCTION ARCHITECTURE</p>
        <h2>${escapeHtml(target.platform)} + ${escapeHtml(target.database)} + ${escapeHtml(target.provider)}</h2>
        <p>Current runtime: ${escapeHtml(data.current.runtime)}. Database: ${escapeHtml(data.current.database)}. Transport: ${escapeHtml(data.current.transport)}.</p>
      </div>
      <div class="readiness-score"><strong>${readyCount}/${data.checks.length}</strong><span>readiness gates complete</span></div>
    </section>

    <section class="target-grid" aria-label="Production architecture">
      <article class="target-card"><span class="target-card-index">01</span><h3>Vercel</h3><p>${escapeHtml(vercel.detail)}</p><span class="readiness-status ${vercel.status === "ready" ? "ready" : "pending"}">${escapeHtml(readinessStatusLabel(vercel.status))}</span></article>
      <article class="target-card"><span class="target-card-index">02</span><h3>PostgreSQL</h3><p>${escapeHtml(postgres.detail)}</p><span class="readiness-status ${postgres.status === "ready" ? "ready" : "pending"}">${escapeHtml(readinessStatusLabel(postgres.status))}</span></article>
      <article class="target-card"><span class="target-card-index">03</span><h3>Resend Broadcasts</h3><p>${escapeHtml(resend.detail)}</p><span class="readiness-status ${resend.status === "ready" ? "ready" : "pending"}">${escapeHtml(readinessStatusLabel(resend.status))}</span></article>
    </section>

    <div class="readiness-layout">
      <section class="panel">
        <div class="panel-head"><div><h2>Launch gates</h2><p>Every item must be verified before live sending is unlocked</p></div><span class="readiness-status ${liveReady ? "ready" : "locked"}">${liveReady ? "Live ready" : "Sandbox only"}</span></div>
        <div class="readiness-list">${data.checks.map((check) => `
          <div class="readiness-item">
            <span class="readiness-marker ${escapeHtml(check.status)}">${check.status === "ready" ? "✓" : ""}</span>
            <div><strong>${escapeHtml(check.label)}</strong><p>${escapeHtml(check.detail)}</p></div>
            <span class="readiness-status ${check.status === "ready" ? "ready" : "pending"}">${escapeHtml(readinessStatusLabel(check.status))}</span>
          </div>`).join("")}</div>
      </section>

      <div class="readiness-side">
        <section class="panel">
          <div class="panel-head"><div><h2>Production delivery path</h2><p>Resend owns the live queue after handoff</p></div></div>
          <ol class="delivery-path">${data.delivery_path.map((step, index) => `<li><span>${index + 1}</span><p>${escapeHtml(step)}</p></li>`).join("")}</ol>
        </section>
        <section class="panel volume-plan">
          <div class="panel-head"><div><h2>Volume goal</h2><p>Target, not an automatic day-one guarantee</p></div></div>
          <div class="panel-body"><strong class="volume-goal">${escapeHtml(data.volume_plan.goal)}</strong><p>${escapeHtml(data.volume_plan.launch_policy)}</p><div class="notice warning"><span>!</span><div>Bounce, complaint, and unsubscribe signals must remain healthy before volume increases.</div></div></div>
        </section>
      </div>
    </div>

    <div class="notice setup-note"><span>i</span><div><strong>Cloudflare can stay in the stack for DNS and domain records.</strong> Vercel supplies the application runtime; Resend supplies email delivery. Cloudflare is not replacing either of those services.</div></div>`;
}

function renderRecentCampaignTable(campaigns) {
  if (!campaigns.length) return `<div class="empty-state"><div><p>No campaigns yet.</p>${can("campaigns.manage") ? `<button class="button primary" data-new-campaign>Create campaign</button>` : ""}</div></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th>Issues</th></tr></thead><tbody>${campaigns.map((campaign) => {
    const recipients = Number(campaign.recipients || 0);
    const sent = Number(campaign.sent || 0);
    const progress = recipients ? Math.round((sent / recipients) * 100) : 0;
    return `<tr><td><strong>${escapeHtml(campaign.name)}</strong><span class="subtext">${escapeHtml(campaign.subject)}</span></td><td>${statusPill(campaign.status)}</td><td><span class="subtext">${sent}/${recipients}</span><div class="progress"><span style="width:${progress}%"></span></div></td><td>${Number(campaign.issues || 0)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderRecentMessages(messages) {
  if (!messages.length) return `<div class="empty-state" style="min-height:180px;padding:20px"><div><p>Messages will appear here after a test send or campaign launch.</p></div></div>`;
  return `<div class="activity-list">${messages.map((message) => `<div class="activity-item"><div class="activity-icon">↗</div><div><strong>${escapeHtml(message.to_email)}</strong><p>${escapeHtml(message.subject)} · ${formatDate(message.created_at)}</p></div></div>`).join("")}</div>`;
}

async function renderContacts(query = "") {
  const [data, lists] = await Promise.all([
    api(`/api/contacts${query ? `?q=${encodeURIComponent(query)}` : ""}`),
    getLists(),
  ]);
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${data.contacts.length.toLocaleString()} contacts</h2><p>Consent-aware audience records across ${lists.length} list${lists.length === 1 ? "" : "s"}.</p></div>${can("contacts.manage") ? `<div class="section-actions"><button class="button" id="import-contacts">Import CSV</button><button class="button primary" id="add-contact">Add contact</button></div>` : ""}</div>
    <div class="toolbar"><div class="search"><input id="contact-search" type="search" placeholder="Search email or name" value="${escapeHtml(query)}" /></div>${can("lists.manage") ? `<div class="toolbar-group"><button class="button small ghost" id="create-list">+ New list</button></div>` : ""}</div>
    <section class="panel">
      ${data.contacts.length ? `<div class="table-wrap"><table><thead><tr><th>Contact</th><th>Lists</th><th>Consent</th><th>Status</th><th>Added</th></tr></thead><tbody>${data.contacts.map((contact) => `<tr><td><strong>${escapeHtml([contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Unnamed contact")}</strong><span class="subtext email">${escapeHtml(contact.email)}</span></td><td>${escapeHtml(contact.lists || "—")}</td><td>${escapeHtml(titleCase(contact.consent_source))}</td><td>${statusPill(contact.status)}</td><td>${formatDate(contact.created_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><div><div class="empty-mark">◎</div><h2>No contacts found</h2><p>Import a consented audience or add a test contact.</p>${can("contacts.manage") ? `<button class="button primary" id="empty-add-contact">Add contact</button>` : ""}</div></div>`}
    </section>`;
  const search = document.querySelector("#contact-search");
  let searchTimer;
  search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderContacts(search.value.trim()), 280);
  });
  document.querySelector("#add-contact")?.addEventListener("click", openContactModal);
  document.querySelector("#empty-add-contact")?.addEventListener("click", openContactModal);
  document.querySelector("#import-contacts")?.addEventListener("click", openImportModal);
  document.querySelector("#create-list")?.addEventListener("click", openListModal);
}

function listOptions(lists, selected = "") {
  return lists.map((list) => `<option value="${escapeHtml(list.id)}" ${list.id === selected ? "selected" : ""}>${escapeHtml(list.name)} (${Number(list.contact_count || 0)})</option>`).join("");
}

async function openContactModal() {
  const lists = await getLists();
  openModal("Add contact", "Audience", `
    <form id="contact-form" class="stack">
      <div class="form-grid"><label>First name<input name="first_name" maxlength="120" /></label><label>Last name<input name="last_name" maxlength="120" /></label></div>
      <label>Email address<input name="email" type="email" required /></label>
      <label>List<select name="list_id" required>${listOptions(lists)}</select></label>
      <label>Consent source<input name="consent_source" value="manual_test_entry" maxlength="120" required /><span class="help">Use only consented or synthetic addresses.</span></label>
      <p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Add contact</button></div>
    </form>`, true);
  document.querySelector("#contact-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    await submitForm(form, () => api("/api/contacts", { method: "POST", body: data }), "Contact added");
    if (!form.querySelector(".form-error").textContent) {
      closeModal();
      await renderContacts();
    }
  });
}

async function openListModal() {
  openModal("Create list", "Audience", `
    <form id="list-form" class="stack"><label>List name<input name="name" required maxlength="120" /></label><label>Description<textarea name="description" maxlength="500" placeholder="What this audience opted in to receive"></textarea></label><p class="form-error" role="alert"></p><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create list</button></div></form>`, true);
  document.querySelector("#list-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await submitForm(form, () => api("/api/lists", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "List created");
    if (!form.querySelector(".form-error").textContent) {
      state.lists = [];
      closeModal();
      await renderContacts();
    }
  });
}

async function openImportModal() {
  const lists = await getLists();
  openModal("Import contacts", "CSV audience", `
    <form id="import-form" class="stack">
      <div class="notice"><span>i</span><div>The CSV must include an <strong>email</strong> column. Optional fields: <strong>first_name</strong> and <strong>last_name</strong>. Use only permission-based or synthetic data.</div></div>
      <label>Destination list<select name="list_id" required>${listOptions(lists)}</select></label>
      <label>CSV file<input name="file" type="file" accept=".csv,text/csv" required /></label>
      <p class="form-error" role="alert"></p>
      <div id="import-result"></div>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Close</button><button class="button primary" type="submit">Import CSV</button></div>
    </form>`, true);
  document.querySelector("#import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.file.files[0];
    const error = form.querySelector(".form-error");
    error.textContent = "";
    if (!file) return;
    try {
      const csvText = await file.text();
      const result = await api("/api/contacts/import", { method: "POST", body: { csv_text: csvText, list_id: form.elements.list_id.value } });
      document.querySelector("#import-result").innerHTML = `<div class="notice"><span>✓</span><div><strong>${result.imported} imported, ${result.updated} updated.</strong><br>${result.duplicates} duplicates and ${result.invalid} invalid rows skipped.</div></div>`;
      state.lists = [];
      toast("CSV import complete");
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  });
}

async function renderCampaigns() {
  const data = await api("/api/campaigns");
  await getLists();
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${data.campaigns.length} campaign${data.campaigns.length === 1 ? "" : "s"}</h2><p>${can("campaigns.send") ? "Draft, preview, and run each audience in the sandbox. Live Resend delivery remains locked." : "Read-only campaign reporting without recipient-level personal data."}</p></div>${can("campaigns.manage") ? `<button class="button primary" data-new-campaign>New campaign</button>` : ""}</div>
    ${data.campaigns.length ? `<section class="campaign-grid">${data.campaigns.map(renderCampaignCard).join("")}</section>` : `<section class="panel empty-state"><div><div class="empty-mark">✦</div><h2>No campaigns yet</h2><p>${can("campaigns.manage") ? "Build a message, preview personalization, and capture a sandbox delivery." : "Campaign reports will appear here after a marketer creates a campaign."}</p>${can("campaigns.manage") ? `<button class="button primary" data-new-campaign>New campaign</button>` : ""}</div></section>`}`;
}

function renderCampaignCard(campaign) {
  const recipients = Number(campaign.recipients || 0);
  const sent = Number(campaign.sent || 0);
  const queued = Number(campaign.queued || 0);
  const issues = Number(campaign.failed || 0) + Number(campaign.bounced || 0) + Number(campaign.complained || 0);
  const editable = can("campaigns.manage") && ["draft", "paused"].includes(campaign.status);
  const launchable = can("campaigns.send") && ["draft", "paused"].includes(campaign.status);
  return `<article class="campaign-card" data-campaign-id="${escapeHtml(campaign.id)}">
    <div class="campaign-card-top"><span class="subtext">${escapeHtml(campaign.list_name)} · ${escapeHtml(titleCase(campaign.content_mode || "custom_html"))}</span>${statusPill(campaign.status)}</div>
    <h3>${escapeHtml(campaign.name)}</h3><p>${escapeHtml(campaign.subject)}</p>
    <div class="campaign-stats"><div><span>Recipients</span><strong>${recipients}</strong></div><div><span>Captured</span><strong>${sent}</strong></div><div><span>Issues</span><strong>${issues}</strong></div></div>
    ${queued ? `<div class="progress" style="margin-bottom:14px"><span style="width:${recipients ? Math.round((sent / recipients) * 100) : 0}%"></span></div>` : ""}
    <div class="campaign-card-actions">
      <button class="button small" data-action="view" data-id="${escapeHtml(campaign.id)}">Details</button>
      ${editable ? `<button class="button small ghost" data-action="edit" data-id="${escapeHtml(campaign.id)}">Edit</button>` : ""}
      ${can("campaigns.send") ? `<button class="button small ghost" data-action="test" data-id="${escapeHtml(campaign.id)}">Test</button>` : ""}
      ${can("campaigns.send") && campaign.status === "sending" ? `<button class="button small" data-action="pause" data-id="${escapeHtml(campaign.id)}">Pause</button>` : ""}
      ${launchable ? `<button class="button small primary" data-action="${campaign.status === "paused" ? "resume" : "launch"}" data-id="${escapeHtml(campaign.id)}">${campaign.status === "paused" ? "Resume test" : (state.session?.delivery_mode === "sandbox" ? "Run in sandbox" : "Run controlled test")}</button>` : ""}
    </div>
  </article>`;
}

const contentModes = [
  { id: "visual", icon: "▦", title: "Visual builder", copy: "Compose a branded layout from simple fields." },
  { id: "rich_text", icon: "Aa", title: "Rich text", copy: "Write and format without working in code." },
  { id: "custom_html", icon: "</>", title: "Custom HTML", copy: "Paste or edit complete email markup." },
  { id: "plain_text", icon: "¶", title: "Plain text", copy: "Send a simple, text-first message." },
];

function contentModePicker(selectedMode) {
  return `<div class="content-mode-section"><span class="field-label">Message format</span><div class="content-mode-grid" role="radiogroup" aria-label="Message format">${contentModes.map((mode) => `<button class="content-mode-card ${mode.id === selectedMode ? "selected" : ""}" type="button" data-content-mode="${mode.id}" role="radio" aria-checked="${mode.id === selectedMode}"><span class="content-mode-icon">${escapeHtml(mode.icon)}</span><span><strong>${escapeHtml(mode.title)}</strong><small>${escapeHtml(mode.copy)}</small></span></button>`).join("")}</div></div>`;
}

function modeEditorMarkup(mode, draft) {
  if (mode === "visual") {
    const data = { ...defaultVisualContent, ...(draft || {}) };
    return `<div class="mode-editor visual-editor" data-mode-editor="visual">
      <div class="form-grid"><label>Layout<select data-visual-field="template"><option value="announcement" ${data.template === "announcement" ? "selected" : ""}>Announcement</option><option value="newsletter" ${data.template === "newsletter" ? "selected" : ""}>Newsletter</option><option value="simple" ${data.template === "simple" ? "selected" : ""}>Simple</option></select></label><label>Accent colour<input data-visual-field="accent_color" type="color" value="${escapeHtml(data.accent_color)}" /></label></div>
      <label>Brand name<input data-visual-field="brand_name" maxlength="80" value="${escapeHtml(data.brand_name)}" /></label>
      <label>Inbox preview text<input data-visual-field="preheader" maxlength="160" value="${escapeHtml(data.preheader)}" /></label>
      <label>Headline<input data-visual-field="headline" maxlength="180" value="${escapeHtml(data.headline)}" /></label>
      <label>Message<textarea data-visual-field="body" rows="7">${escapeHtml(data.body)}</textarea></label>
      <div class="form-grid"><label>Button label<input data-visual-field="cta_label" maxlength="80" value="${escapeHtml(data.cta_label)}" /></label><label>Button link<input data-visual-field="cta_url" type="url" value="${escapeHtml(data.cta_url)}" placeholder="https://" /></label></div>
      <label>Footer note<input data-visual-field="footer" maxlength="240" value="${escapeHtml(data.footer)}" /></label>
      <p class="help">Personalized greeting and unsubscribe link are added automatically.</p>
    </div>`;
  }
  if (mode === "rich_text") {
    const richHtml = sanitizeRichHtml(draft?.rich_html || defaultRichContent);
    return `<div class="mode-editor" data-mode-editor="rich_text"><span class="field-label">Message</span><div class="rich-toolbar" role="toolbar" aria-label="Text formatting"><button type="button" data-rich-command="bold" aria-label="Bold"><strong>B</strong></button><button type="button" data-rich-command="italic" aria-label="Italic"><em>I</em></button><button type="button" data-rich-command="underline" aria-label="Underline"><u>U</u></button><button type="button" data-rich-command="insertUnorderedList" aria-label="Bulleted list">• List</button></div><div id="rich-editor" class="rich-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Rich text message">${richHtml}</div><p class="help">Formatting is limited to email-safe text, headings, links, and lists. Unsubscribe is added automatically.</p></div>`;
  }
  if (mode === "plain_text") {
    return `<div class="mode-editor" data-mode-editor="plain_text"><label>Plain-text message<textarea id="plain-editor" class="plain-editor" rows="15">${escapeHtml(draft?.plain_text || "Hello {{first_name}},\n\nWrite your message here.\n\nUnsubscribe: {{unsubscribe_url}}")}</textarea><span class="help">Line breaks are preserved. A safe HTML wrapper is generated for clients that require it.</span></label></div>`;
  }
  return `<div class="mode-editor" data-mode-editor="custom_html"><label>HTML message<textarea id="html-editor" class="code-area" rows="16" required>${escapeHtml(draft?.html_body || defaultTemplate)}</textarea><span class="help">Scripts, forms, embedded objects, unsafe URLs, and event handlers are blocked.</span></label><label>Plain-text alternative<textarea id="html-text-fallback" rows="8">${escapeHtml(draft?.text_body || "Hello {{first_name}},\n\nWrite your message here.\n\nUnsubscribe: {{unsubscribe_url}}")}</textarea></label></div>`;
}

async function openCampaignComposer(campaignId = null) {
  const [lists, campaignData] = await Promise.all([
    getLists(),
    campaignId ? api(`/api/campaigns/${campaignId}`) : Promise.resolve(null),
  ]);
  const campaign = campaignData?.campaign || {};
  const storedContent = safeContentObject(campaign.content_json);
  let selectedMode = contentModes.some((mode) => mode.id === campaign.content_mode) ? campaign.content_mode : (campaignId ? "custom_html" : "visual");
  const modeDrafts = {
    visual: selectedMode === "visual" ? { ...defaultVisualContent, ...storedContent } : { ...defaultVisualContent },
    rich_text: selectedMode === "rich_text" ? { schema_version: 1, rich_html: storedContent.rich_html || defaultRichContent } : { schema_version: 1, rich_html: defaultRichContent },
    custom_html: { schema_version: 1, html_body: campaign.html_body || defaultTemplate, text_body: campaign.text_body || "Hello {{first_name}},\n\nWrite your message here.\n\nUnsubscribe: {{unsubscribe_url}}" },
    plain_text: selectedMode === "plain_text" ? { schema_version: 1, plain_text: storedContent.plain_text || campaign.text_body || "" } : { schema_version: 1, plain_text: "Hello {{first_name}},\n\nWrite your message here.\n\nUnsubscribe: {{unsubscribe_url}}" },
  };
  openModal(campaignId ? "Edit campaign" : "New campaign", "Composer", `
    <form id="campaign-form" class="composer">
      <div class="composer-fields">
        <label>Internal campaign name<input name="name" maxlength="160" value="${escapeHtml(campaign.name || "Product update")}" required /></label>
        <label>Audience<select name="list_id" required>${listOptions(lists, campaign.list_id || lists[0]?.id)}</select><span class="help">Suppression is checked again immediately before delivery.</span></label>
        <div class="form-grid"><label>From name<input name="from_name" value="${escapeHtml(campaign.from_name || "SendStack Team")}" required /></label><label>From email<input name="from_email" type="email" value="${escapeHtml(campaign.from_email || "updates@example.test")}" required /></label></div>
        <label>Subject<input name="subject" maxlength="250" value="${escapeHtml(campaign.subject || "A quick update for {{first_name}}")}" required /></label>
        ${contentModePicker(selectedMode)}
        <div id="mode-editor-host">${modeEditorMarkup(selectedMode, modeDrafts[selectedMode])}</div>
        <p class="help variable-help">Personalization: {{first_name}}, {{last_name}}, {{email}}, {{unsubscribe_url}}</p>
        <p class="form-error" role="alert"></p>
        <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">${campaignId ? "Save changes" : "Save draft"}</button></div>
      </div>
      <div class="preview-shell"><div class="preview-bar"><span>PERSONALIZED PREVIEW</span><div class="preview-dots"><span></span><span></span><span></span></div></div><iframe class="email-preview" title="Email preview" sandbox=""></iframe></div>
    </form>`, false);
  const form = document.querySelector("#campaign-form");
  const editorHost = form.querySelector("#mode-editor-host");
  const captureModeDraft = () => {
    if (selectedMode === "visual") {
      const visual = { schema_version: 1 };
      form.querySelectorAll("[data-visual-field]").forEach((field) => { visual[field.dataset.visualField] = field.value; });
      modeDrafts.visual = visual;
    } else if (selectedMode === "rich_text") {
      modeDrafts.rich_text = { schema_version: 1, rich_html: sanitizeRichHtml(form.querySelector("#rich-editor")?.innerHTML || "") };
    } else if (selectedMode === "plain_text") {
      modeDrafts.plain_text = { schema_version: 1, plain_text: form.querySelector("#plain-editor")?.value || "" };
    } else {
      modeDrafts.custom_html = { schema_version: 1, html_body: form.querySelector("#html-editor")?.value || "", text_body: form.querySelector("#html-text-fallback")?.value || "" };
    }
  };
  const updatePreview = () => {
    captureModeDraft();
    const substitutions = {
      "{{first_name}}": "Alex",
      "{{last_name}}": "Morgan",
      "{{email}}": "alex@example.test",
      "{{unsubscribe_url}}": "#unsubscribe",
    };
    let markup = buildCampaignContent(selectedMode, modeDrafts[selectedMode]).html_body;
    Object.entries(substitutions).forEach(([key, value]) => { markup = markup.split(key).join(value); });
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
    form.querySelector("iframe").srcdoc = policy + markup;
  };
  const attachEditorEvents = () => {
    editorHost.querySelectorAll("input, select, textarea, [contenteditable]").forEach((field) => field.addEventListener("input", updatePreview));
    const richEditor = editorHost.querySelector("#rich-editor");
    richEditor?.addEventListener("paste", (event) => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    });
    editorHost.querySelectorAll("[data-rich-command]").forEach((button) => button.addEventListener("click", () => {
      richEditor?.focus();
      document.execCommand(button.dataset.richCommand, false);
      updatePreview();
    }));
  };
  form.querySelectorAll("[data-content-mode]").forEach((button) => button.addEventListener("click", () => {
    captureModeDraft();
    selectedMode = button.dataset.contentMode;
    form.querySelectorAll("[data-content-mode]").forEach((item) => {
      const active = item.dataset.contentMode === selectedMode;
      item.classList.toggle("selected", active);
      item.setAttribute("aria-checked", String(active));
    });
    editorHost.innerHTML = modeEditorMarkup(selectedMode, modeDrafts[selectedMode]);
    attachEditorEvents();
    updatePreview();
  }));
  attachEditorEvents();
  updatePreview();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    captureModeDraft();
    const content = buildCampaignContent(selectedMode, modeDrafts[selectedMode]);
    const payload = Object.fromEntries(new FormData(form));
    payload.content_mode = selectedMode;
    payload.content_json = content.content_json;
    payload.html_body = content.html_body;
    payload.text_body = content.text_body;
    const path = campaignId ? `/api/campaigns/${campaignId}` : "/api/campaigns";
    const method = campaignId ? "PATCH" : "POST";
    await submitForm(form, () => api(path, { method, body: payload }), campaignId ? "Campaign updated" : "Draft saved");
    if (!form.querySelector(".form-error").textContent) {
      closeModal();
      if (state.currentView === "campaigns") await renderCampaigns();
      else await navigate("campaigns");
    }
  });
}

async function openCampaignDetails(campaignId) {
  const { campaign } = await api(`/api/campaigns/${campaignId}`);
  const stats = campaign.stats || {};
  const total = Object.values(stats).reduce((sum, value) => sum + Number(value || 0), 0);
  openModal(campaign.name, "Campaign detail", `
    <div class="stack">
      <div class="notice"><span>i</span><div><strong>${escapeHtml(campaign.subject)}</strong><br>${escapeHtml(campaign.list_name)} · ${escapeHtml(campaign.from_name)} &lt;${escapeHtml(campaign.from_email)}&gt;</div></div>
      <div class="form-grid">
        <section class="panel"><div class="panel-head"><h3>Delivery totals</h3>${statusPill(campaign.status)}</div><div class="panel-body">
          <div class="metric-line"><span>Audience snapshot</span><strong>${total}</strong></div>
          <div class="metric-line"><span>Captured / submitted</span><strong>${Number(stats.sent || 0)}</strong></div>
          <div class="metric-line"><span>Queued</span><strong>${Number(stats.queued || 0) + Number(stats.processing || 0)}</strong></div>
          <div class="metric-line"><span>Suppressed</span><strong>${Number(stats.suppressed || 0)}</strong></div>
          <div class="metric-line"><span>Failed / bounced / complained</span><strong>${Number(stats.failed || 0) + Number(stats.bounced || 0) + Number(stats.complained || 0)}</strong></div>
        </div></section>
        <section class="panel"><div class="panel-head"><h3>Timing</h3></div><div class="panel-body"><div class="metric-line"><span>Created</span><strong>${formatDate(campaign.created_at)}</strong></div><div class="metric-line"><span>Launched</span><strong>${formatDate(campaign.launched_at)}</strong></div><div class="metric-line"><span>Completed</span><strong>${formatDate(campaign.completed_at)}</strong></div></div></section>
      </div>
      <div class="form-actions"><button class="button" data-close-modal>Close</button>${can("deliveries.view") ? `<button class="button primary" id="view-campaign-deliveries">View deliveries</button>` : ""}</div>
    </div>`, false);
  document.querySelector("#view-campaign-deliveries")?.addEventListener("click", () => {
    closeModal();
    state.deliveryCampaign = campaignId;
    navigate("deliveries");
  });
}

async function openTestSend(campaignId) {
  openModal("Send a test", "Preflight", `
    <form id="test-send-form" class="stack"><div class="notice"><span>i</span><div>${state.session.delivery_mode === "sandbox" ? "This will be captured inside the sandbox inbox. No external email is sent." : "SMTP mode is enabled. The address must be in the server-side recipient allowlist."}</div></div><label>Test recipient<input name="email" type="email" value="owner@example.test" required /></label><p class="form-error" role="alert"></p><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Send test</button></div></form>`, true);
  const form = document.querySelector("#test-send-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitForm(form, () => api(`/api/campaigns/${campaignId}/test-send`, { method: "POST", body: { email: form.elements.email.value } }), "Test message captured");
    if (!form.querySelector(".form-error").textContent) {
      closeModal();
      navigate("deliveries");
    }
  });
}

async function campaignAction(action, id) {
  if (action === "view") return openCampaignDetails(id);
  if (action === "edit") return openCampaignComposer(id);
  if (action === "test") return openTestSend(id);
  if (action === "launch") {
    openModal(state.session.delivery_mode === "sandbox" ? "Run campaign in sandbox?" : "Launch controlled test?", "Delivery preflight", `
      <div class="stack">
        <div class="notice ${state.session.delivery_mode === "smtp" ? "warning" : ""}"><span>!</span><div><strong>${state.session.delivery_mode === "sandbox" ? "Messages will stay inside the sandbox." : "Messages will be submitted to the configured SMTP test relay."}</strong><br>Eligibility and global suppression are checked again before every recipient is processed.</div></div>
        <div class="metric-line"><span>Transport</span><strong>${escapeHtml(titleCase(state.session.delivery_mode))}</strong></div>
        <div class="metric-line"><span>Daily safety cap</span><strong>${Number(state.session.daily_limit).toLocaleString()}</strong></div>
        <div class="metric-line"><span>Production provider</span><strong>Resend — not connected</strong></div>
        <p class="help">Production campaigns will use Resend Broadcasts after Vercel, PostgreSQL, the sending domain, and signed webhooks are verified.</p>
        <div class="form-actions"><button class="button" data-close-modal>Cancel</button><button class="button primary" id="confirm-launch">${state.session.delivery_mode === "sandbox" ? "Queue sandbox run" : "Queue controlled test"}</button></div>
      </div>`, true);
    document.querySelector("#confirm-launch").addEventListener("click", async () => {
      closeModal();
      await executeCampaignAction(action, id);
    });
    return;
  }
  return executeCampaignAction(action, id);
}

async function executeCampaignAction(action, id) {
  try {
    const result = await api(`/api/campaigns/${id}/${action}`, { method: "POST", body: {} });
    toast(action === "launch" ? `${result.queued} recipients queued` : `Campaign ${action}d`);
    await renderCampaigns();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renderDeliveries() {
  const suffix = state.deliveryCampaign ? `?campaign_id=${encodeURIComponent(state.deliveryCampaign)}` : "";
  const data = await api(`/api/messages${suffix}`);
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${data.messages.length} captured message${data.messages.length === 1 ? "" : "s"}</h2><p>Inspect rendered content and simulate recipient feedback.</p></div><div class="section-actions">${state.deliveryCampaign ? `<button class="button" id="clear-delivery-filter">Clear campaign filter</button>` : ""}</div></div>
    <div class="notice" style="margin-bottom:15px"><span>i</span><div><strong>Delivery status is intentionally precise.</strong> “Sandboxed” means captured locally; “submitted” means accepted by the configured relay, not necessarily delivered to an inbox.</div></div>
    <section class="panel">${data.messages.length ? `<div class="table-wrap"><table><thead><tr><th>Recipient</th><th>Message</th><th>Campaign</th><th>Status</th><th>Time</th><th></th></tr></thead><tbody>${data.messages.map((message) => `<tr><td class="email">${escapeHtml(message.to_email)}</td><td><strong>${escapeHtml(message.subject)}</strong><span class="subtext">From ${escapeHtml(message.from_email)}</span></td><td>${escapeHtml(message.campaign_name || "Test send")}</td><td>${statusPill(message.status)}</td><td>${formatDate(message.created_at)}</td><td><button class="button small ghost" data-message-id="${escapeHtml(message.id)}">View</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><div><div class="empty-mark">↗</div><h2>The inbox is empty</h2><p>Create a campaign and send a test to inspect the rendered result.</p><button class="button primary" data-new-campaign>Create campaign</button></div></div>`}</section>`;
  document.querySelector("#clear-delivery-filter")?.addEventListener("click", () => { state.deliveryCampaign = null; renderDeliveries(); });
}

async function openMessage(messageId) {
  const { message } = await api(`/api/messages/${messageId}`);
  openModal(message.subject, "Captured message", `
    <dl class="message-meta"><dt>To</dt><dd>${escapeHtml(message.to_email)}</dd><dt>From</dt><dd>${escapeHtml(message.from_email)}</dd><dt>Status</dt><dd>${statusPill(message.status)}</dd><dt>Captured</dt><dd>${formatDate(message.created_at)}</dd></dl>
    <div class="message-preview"><iframe title="Captured email" sandbox=""></iframe></div>
    <div class="form-actions" style="margin-top:16px"><button class="button" data-close-modal>Close</button>${can("deliveries.feedback") ? `<a class="button" href="/u/${encodeURIComponent(message.unsubscribe_token)}" target="_blank" rel="noopener">Test unsubscribe</a><button class="button danger" data-feedback="hard_bounce">Simulate hard bounce</button><button class="button danger" data-feedback="complaint">Simulate complaint</button>` : ""}</div>`, false);
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
  document.querySelector(".message-preview iframe").srcdoc = policy + message.html_body;
  document.querySelectorAll("[data-feedback]").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm(`Mark this recipient as a ${titleCase(button.dataset.feedback)} and suppress it globally?`)) return;
    try {
      await api(`/api/messages/${messageId}/event`, { method: "POST", body: { event: button.dataset.feedback } });
      toast("Feedback recorded and recipient suppressed");
      closeModal();
      renderDeliveries();
    } catch (error) { toast(error.message, "error"); }
  }));
}

async function renderSuppressions() {
  const data = await api("/api/suppressions");
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${data.suppressions.length} globally suppressed</h2><p>These addresses are excluded from every campaign at execution time.</p></div>${can("suppressions.manage") ? `<button class="button primary" id="add-suppression">Add suppression</button>` : ""}</div>
    <section class="panel">${data.suppressions.length ? `<div class="table-wrap"><table><thead><tr><th>Email</th><th>Reason</th><th>Source</th><th>Created</th></tr></thead><tbody>${data.suppressions.map((entry) => `<tr><td><strong class="email">${escapeHtml(entry.email)}</strong></td><td>${statusPill(entry.reason)}</td><td>${escapeHtml(titleCase(entry.source))}</td><td>${formatDate(entry.created_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><div><div class="empty-mark">⊘</div><h2>No suppressions yet</h2><p>Unsubscribes, hard bounces, complaints, and manual exclusions appear here.</p></div></div>`}</section>`;
  document.querySelector("#add-suppression")?.addEventListener("click", openSuppressionModal);
}

function openSuppressionModal() {
  openModal("Suppress an address", "Safety control", `<form id="suppression-form" class="stack"><div class="notice warning"><span>!</span><div>This creates a manual exclusion. Unsubscribes, bounces, and complaints must come from recipient or verified delivery events.</div></div><label>Email address<input name="email" type="email" required /></label><input name="reason" type="hidden" value="manual" /><p class="form-error" role="alert"></p><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button danger" type="submit">Suppress globally</button></div></form>`, true);
  const form = document.querySelector("#suppression-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitForm(form, () => api("/api/suppressions", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "Address suppressed");
    if (!form.querySelector(".form-error").textContent) { closeModal(); renderSuppressions(); }
  });
}

function roleOptions(roles, selected = "marketer") {
  return roles.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === selected ? "selected" : ""}>${escapeHtml(role.label)}</option>`).join("");
}

function rolePill(role) {
  const safeRole = String(role.role || role.id || "unknown").toLowerCase();
  const label = role.role_label || role.label || titleCase(safeRole);
  return `<span class="role-pill ${escapeHtml(safeRole)}">${escapeHtml(label)}</span>`;
}

async function renderUsers() {
  const data = await api("/api/users");
  state.users = data.users;
  state.roles = data.roles;
  state.permissionDefinitions = data.permissions;
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${data.users.length} user${data.users.length === 1 ? "" : "s"}</h2><p>Create accounts, assign least-privilege access, and disable access without deleting audit history.</p></div><button class="button primary" id="create-user">Create user</button></div>
    <section class="panel user-directory">
      <div class="panel-head"><div><h2>User directory</h2><p>Role and status changes take effect immediately</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Created</th><th></th></tr></thead><tbody>${data.users.map((user) => `<tr>
        <td><div class="table-user"><span class="avatar">${escapeHtml(initials(user.name))}</span><div><strong>${escapeHtml(user.name)}${user.is_current_user ? `<span class="you-badge">You</span>` : ""}</strong><span class="subtext email">${escapeHtml(user.email)}</span></div></div></td>
        <td>${rolePill(user)}</td><td>${statusPill(user.active ? "active" : "disabled")}</td><td>${user.last_login_at ? formatDate(user.last_login_at) : "Never"}</td><td>${formatDate(user.created_at)}</td><td><button class="button small ghost" data-user-id="${escapeHtml(user.id)}">Manage</button></td>
      </tr>`).join("")}</tbody></table></div>
    </section>

    <section class="role-grid" aria-label="Built-in roles">${data.roles.map((role) => `<article class="role-card ${escapeHtml(role.id)}"><div class="role-card-head"><span class="role-symbol">${role.id === "admin" ? "A" : role.id === "marketer" ? "M" : "R"}</span>${rolePill(role)}</div><h3>${escapeHtml(role.label)}</h3><p>${escapeHtml(role.description)}</p><span class="role-count">${role.permissions.length} permissions</span></article>`).join("")}</section>

    <section class="panel permission-panel">
      <div class="panel-head"><div><h2>Built-in permissions</h2><p>Roles are fixed for this release; every permission is enforced by the server</p></div></div>
      <div class="table-wrap"><table class="permission-table"><thead><tr><th>Capability</th>${data.roles.map((role) => `<th>${escapeHtml(role.label)}</th>`).join("")}</tr></thead><tbody>${data.permissions.map((permission) => `<tr><td><strong>${escapeHtml(permission.label)}</strong><span class="subtext">${escapeHtml(permission.description)}</span></td>${data.roles.map((role) => `<td><span class="permission-check ${role.permissions.includes(permission.id) ? "granted" : "denied"}" aria-label="${role.permissions.includes(permission.id) ? "Granted" : "Not granted"}">${role.permissions.includes(permission.id) ? "✓" : "—"}</span></td>`).join("")}</tr>`).join("")}</tbody></table></div>
    </section>`;
  document.querySelector("#create-user")?.addEventListener("click", openCreateUserModal);
}

function openCreateUserModal() {
  openModal("Create user", "Access control", `
    <form id="create-user-form" class="stack" autocomplete="off">
      <div class="notice"><span>i</span><div>Create the account directly and share the temporary password through a secure channel.</div></div>
      <label>Full name<input name="name" maxlength="120" autocomplete="off" required /></label>
      <label>Email address<input name="email" type="email" autocomplete="off" required /></label>
      <label>Role<select name="role">${roleOptions(state.roles)}</select><span class="help">Choose the least access needed. Roles can be changed later by an administrator.</span></label>
      <label>Temporary password<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required /><span class="help">Use at least 12 characters.</span></label>
      <p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create user</button></div>
    </form>`, true);
  const form = document.querySelector("#create-user-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await submitForm(form, () => api("/api/users", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "User created");
    if (result) {
      closeModal();
      await renderUsers();
    }
  });
}

function openManageUserModal(userId) {
  const user = state.users.find((entry) => entry.id === userId);
  if (!user) return;
  const selfLocked = user.is_current_user;
  openModal(`Manage ${user.name}`, "Access control", `
    <div class="stack">
      ${selfLocked ? `<div class="notice"><span>i</span><div><strong>This is your account.</strong> Another administrator must change your role or disable your access.</div></div>` : `<div class="notice warning"><span>!</span><div>Role or status changes revoke this user’s active sessions. Disabled users keep their audit history.</div></div>`}
      <form id="user-access-form" class="stack">
        <label>Full name<input name="name" maxlength="120" value="${escapeHtml(user.name)}" required /></label>
        <label>Email address<input name="email" type="email" value="${escapeHtml(user.email)}" required /></label>
        <div class="form-grid"><label>Role<select name="role" ${selfLocked ? "disabled" : ""}>${roleOptions(state.roles, user.role)}</select></label><label>Account status<select name="active" ${selfLocked ? "disabled" : ""}><option value="true" ${user.active ? "selected" : ""}>Active</option><option value="false" ${!user.active ? "selected" : ""}>Disabled</option></select></label></div>
        <p class="form-error" role="alert"></p>
        <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Save access</button></div>
      </form>
      <section class="reset-password-section">
        <div><strong>Reset password</strong><p>All active sessions for this user will be revoked.</p></div>
        <form id="reset-password-form" class="stack"><label>New temporary password<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required /></label><p class="form-error" role="alert"></p><div class="form-actions"><button class="button" type="submit">Reset password</button></div></form>
      </section>
    </div>`, false);
  const accessForm = document.querySelector("#user-access-form");
  accessForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: accessForm.elements.name.value,
      email: accessForm.elements.email.value,
      role: selfLocked ? user.role : accessForm.elements.role.value,
      active: selfLocked ? user.active : accessForm.elements.active.value === "true",
    };
    const result = await submitForm(accessForm, () => api(`/api/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: payload }), "User access updated");
    if (result) {
      closeModal();
      await renderUsers();
    }
  });
  const passwordForm = document.querySelector("#reset-password-form");
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await submitForm(passwordForm, () => api(`/api/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST", body: { password: passwordForm.elements.password.value } }), "Password reset; active sessions revoked");
    if (!result) return;
    closeModal();
    if (user.is_current_user) showLogin();
    else await renderUsers();
  });
}

async function renderAudit() {
  const data = await api("/api/audit");
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>Recent administrative activity</h2><p>Authentication, imports, campaigns, delivery feedback, and suppressions.</p></div></div>
    <section class="panel">${data.events.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead><tbody>${data.events.map((event) => `<tr><td>${formatDate(event.created_at)}</td><td>${escapeHtml(event.actor_name || "System / recipient")}</td><td><strong>${escapeHtml(titleCase(event.action))}</strong></td><td>${escapeHtml(titleCase(event.entity_type))}${event.entity_id ? `<span class="subtext">${escapeHtml(event.entity_id)}</span>` : ""}</td><td><span class="subtext">${escapeHtml(Object.entries(event.detail || {}).map(([key, value]) => `${titleCase(key)}: ${value}`).join(" · ") || "—")}</span></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><div><p>No audit events yet.</p></div></div>`}</section>`;
}

function openModal(title, kicker, content, compact = false) {
  els.modalTitle.textContent = title;
  els.modalKicker.textContent = kicker;
  els.modalBody.innerHTML = content;
  els.modalBody.classList.toggle("compact", compact);
  els.modal.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  if (!els.modal.open) els.modal.showModal();
  requestAnimationFrame(() => els.modalBody.querySelector("input, select, textarea, button")?.focus());
}

function closeModal() {
  if (els.modal.open) els.modal.close();
  els.modalBody.innerHTML = "";
}

async function submitForm(form, request, successMessage) {
  const error = form.querySelector(".form-error");
  const submit = form.querySelector('[type="submit"]');
  error.textContent = "";
  submit.disabled = true;
  try {
    const result = await request();
    toast(successMessage);
    return result;
  } catch (requestError) {
    error.textContent = requestError.message;
    return null;
  } finally {
    submit.disabled = false;
  }
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.textContent = "";
  const submit = els.loginForm.querySelector("button");
  submit.disabled = true;
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: document.querySelector("#login-email").value,
        password: document.querySelector("#login-password").value,
      },
    });
    showApp(session);
  } catch (error) {
    els.loginError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

els.nav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) navigate(button.dataset.view);
});

document.querySelector("#global-new-campaign").addEventListener("click", () => {
  if (can("campaigns.manage")) openCampaignComposer();
});
document.querySelector("#modal-close").addEventListener("click", closeModal);
document.querySelector("#mobile-nav-button").addEventListener("click", () => document.body.classList.toggle("nav-open"));
document.querySelector("#logout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch (_) { /* local logout still proceeds */ }
  showLogin();
});

els.modal.addEventListener("click", (event) => {
  if (event.target === els.modal) closeModal();
});

els.modal.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeModal();
});

els.content.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]");
  if (go) return navigate(go.dataset.go);
  if (event.target.closest("[data-new-campaign]") && can("campaigns.manage")) return openCampaignComposer();
  const campaignButton = event.target.closest("[data-action][data-id]");
  if (campaignButton) return campaignAction(campaignButton.dataset.action, campaignButton.dataset.id);
  const messageButton = event.target.closest("[data-message-id]");
  if (messageButton) return openMessage(messageButton.dataset.messageId);
  const userButton = event.target.closest("[data-user-id]");
  if (userButton) return openManageUserModal(userButton.dataset.userId);
});

async function initialize() {
  try {
    const session = await api("/api/session");
    showApp(session);
  } catch (_) {
    showLogin();
  }
}

initialize();
