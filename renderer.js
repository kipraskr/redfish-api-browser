const $ = (id) => document.getElementById(id);

const state = {
  origin: "",
  url: "",
  token: "",
  sessionUri: "",
  auth: "basic",
  body: "",
};
const nav = RF.history();

function syncNav() {
  $("back").disabled = !nav.canBack();
  $("fwd").disabled = !nav.canForward();
}

function authHeaders() {
  const h = { Accept: "application/json", "OData-Version": "4.0" };
  if (state.auth === "session" && state.token) h["X-Auth-Token"] = state.token;
  if (state.auth === "basic") {
    const u = $("user").value;
    const p = $("pass").value;
    h.Authorization = "Basic " + btoa(unescape(encodeURIComponent(`${u}:${p}`)));
  }
  return h;
}

async function call(method, url, body) {
  const headers = authHeaders();
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await window.redfish.request({ method, url, headers, body: payload });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* not json */ }
  return { ...res, json };
}

function setStatus(code) {
  $("status").textContent = code == null || code === "" ? "" : String(code);
}

async function login() {
  state.token = "";
  state.sessionUri = "";
  $("logout").hidden = true;
  if (state.auth !== "session") return;
  let sessions = state.origin + "/redfish/v1/SessionService/Sessions";
  try {
    const root = await call("GET", state.origin + "/redfish/v1/");
    const ss = root.json && root.json.SessionService && root.json.SessionService["@odata.id"];
    if (ss) {
      const svc = await call("GET", RF.resolve(state.origin, ss));
      const col = svc.json && svc.json.Sessions && svc.json.Sessions["@odata.id"];
      if (col) sessions = RF.resolve(state.origin, col);
    }
  } catch { /* fall back to the standard sessions URI */ }
  const res = await call("POST", sessions, {
    UserName: $("user").value,
    Password: $("pass").value,
  });
  const token = res.headers["x-auth-token"];
  if (!token) throw new Error(`session login failed (${res.status})`);
  state.token = token;
  const loc = res.headers.location;
  state.sessionUri = loc ? RF.resolve(state.origin, loc) : "";
  $("logout").hidden = false;
}

let loads = 0;
function busy(on) {
  loads += on ? 1 : -1;
  if (loads < 0) loads = 0;
  $("loading").hidden = loads === 0;
}

async function load(url, push) {
  if (push) nav.push(url);
  syncNav();
  state.url = url;
  $("url").value = url;
  scrollUrl();
  $("refresh").disabled = false;
  setStatus("");
  busy(true);
  try {
  let res;
  try {
    res = await call("GET", url);
  } catch (err) {
    $("tree").innerHTML = `<div class="err"></div>`;
    $("tree").firstChild.textContent = String(err.message || err);
    setStatus("");
    return;
  }
  let data = res.json;
  const finalUrl = res.url || url;
  if (finalUrl !== url) {
    state.url = finalUrl;
    state.origin = RF.originOf(finalUrl);
    $("url").value = finalUrl;
    scrollUrl();
    nav.replace(finalUrl);
  }
  if ($("expand").checked && data) {
    data = await RF.expandLinks(
      data,
      async (child) => {
        const r = await call("GET", child);
        if (r.json == null) throw new Error("HTTP " + r.status);
        return r.json;
      },
      finalUrl
    );
  }
  renderTree(data == null ? res.body : data, res.status);
  state.body = res.json == null ? res.body : JSON.stringify(res.json, null, 2) + "\n";
  $("save").disabled = !state.body;
  setStatus(res.status);
  fillSide(res.json, res.status, finalUrl);
  } finally {
    busy(false);
  }
}

let lineNo = 1;

function renderTree(data, status) {
  const root = $("tree");
  root.innerHTML = "";
  const box = document.createElement("div");
  box.className = "code" + (status >= 400 ? " err" : "");
  lineNo = 1;
  if (data && typeof data === "object") data = RF.sortKeys(data);
  const rows = data == null || typeof data !== "object"
    ? String(typeof data === "string" ? data : data).split("\n").map((line) => codeRow(text(line)))
    : renderValue(data, null, false, 0);
  for (const row of rows) box.appendChild(row);
  root.appendChild(box);
}

function codeRow(src) {
  const row = document.createElement("div");
  row.className = "jrow";
  const ln = document.createElement("span");
  ln.className = "ln";
  ln.textContent = String(lineNo++);
  const gut = document.createElement("span");
  gut.className = "gut";
  row.append(ln, gut, src);
  return row;
}

function text(s) {
  const src = document.createElement("span");
  src.className = "src";
  src.textContent = s;
  return src;
}

function renderValue(value, key, comma, indent) {
  if (!value || typeof value !== "object") return [primitiveRow(value, key, comma, indent)];
  const arr = Array.isArray(value);
  const entries = arr ? value.map((v) => [null, v]) : Object.entries(value);
  const o = arr ? "[" : "{";
  const c = arr ? "]" : "}";
  if (!entries.length) return [primitiveRow(o + c, key, comma, indent, true)];
  const src = srcEl(indent);
  if (key != null) appendKey(src, key);
  const brace = document.createElement("span");
  brace.className = "fold";
  brace.textContent = o;
  src.appendChild(brace);
  const foldComma = document.createElement("span");
  foldComma.textContent = ",";
  foldComma.hidden = true;
  if (comma) src.appendChild(foldComma);
  const open = codeRow(src);
  const gut = open.querySelector(".gut");
  gut.textContent = "▾";
  gut.classList.add("hot");
  const inner = [];
  entries.forEach(([k, v], i) => {
    inner.push(...renderValue(v, k, i < entries.length - 1, indent + 1));
  });
  const close = codeRow(text(c + (comma ? "," : "")));
  close.querySelector(".src").style.paddingLeft = indent * 1.25 + "em";
  const hide = inner.concat(close);
  const toggle = () => {
    const folded = open.classList.toggle("folded");
    gut.textContent = folded ? "▸" : "▾";
    brace.textContent = folded ? o + "…" + c : o;
    foldComma.hidden = !folded;
    for (const row of hide) row.hidden = folded;
  };
  gut.onclick = toggle;
  brace.onclick = toggle;
  return [open].concat(inner, close);
}

function primitiveRow(value, key, comma, indent, literal) {
  const src = srcEl(indent);
  if (key != null) appendKey(src, key);
  src.appendChild(literal ? text(value) : scalar(key, value));
  if (comma) src.appendChild(document.createTextNode(","));
  return codeRow(src);
}

function srcEl(indent) {
  const src = document.createElement("span");
  src.className = "src";
  src.style.paddingLeft = indent * 1.25 + "em";
  return src;
}

function appendKey(src, key) {
  const ks = document.createElement("span");
  ks.className = "k";
  ks.textContent = JSON.stringify(key);
  src.appendChild(ks);
  src.appendChild(document.createTextNode(": "));
}

function scalar(key, value) {
  if (RF.isClickable(key, value)) {
    const a = document.createElement("a");
    a.className = "link s";
    a.textContent = JSON.stringify(value);
    a.onclick = () => load(RF.resolve(state.origin, value), true);
    return a;
  }
  const s = document.createElement("span");
  if (value == null) {
    s.className = "z";
    s.textContent = "null";
  } else if (typeof value === "string") {
    s.className = "s";
    s.textContent = JSON.stringify(value);
  } else if (typeof value === "number") {
    s.className = "n";
    s.textContent = String(value);
  } else {
    s.className = "b";
    s.textContent = String(value);
  }
  return s;
}

async function fillSide(json, status, url) {
  const box = $("meta");
  box.innerHTML = "";
  const lines = [
    ["HTTP", String(status)],
    ["URL", url],
  ];
  if (json && typeof json === "object") {
    for (const k of ["Name", "Id", "@odata.type", "@odata.id", "RedfishVersion", "Description"]) {
      if (json[k] != null) lines.push([k, String(json[k])]);
    }
  }
  for (const [k, v] of lines) {
    const p = document.createElement("div");
    p.className = "prop";
    const b = document.createElement("b");
    b.textContent = k;
    p.appendChild(b);
    p.appendChild(document.createTextNode(" " + v));
    box.appendChild(p);
  }
  const file = json && RF.schemaFile(json["@odata.type"]);
  if (!file) return;
  try {
    const res = await window.redfish.request({
      method: "GET",
      url: "https://redfish.dmtf.org/schemas/v1/" + file + ".json",
      headers: { Accept: "application/json" },
    });
    const schema = JSON.parse(res.body);
    const desc = RF.schemaDescriptions(schema);
    if (desc._type) {
      const d = document.createElement("div");
      d.className = "meta-d";
      d.textContent = desc._type;
      box.appendChild(d);
    }
    const h = document.createElement("h2");
    h.textContent = "Properties";
    box.appendChild(h);
    for (const key of Object.keys(json)) {
      if (!desc[key] || key.startsWith("@")) continue;
      const p = document.createElement("div");
      p.className = "prop";
      const b = document.createElement("b");
      b.textContent = key;
      p.appendChild(b);
      const t = document.createElement("div");
      t.className = "meta-d";
      t.textContent = desc[key];
      p.appendChild(t);
      box.appendChild(p);
    }
  } catch {
    const d = document.createElement("div");
    d.className = "meta-d";
    d.textContent = "Schema " + file + " not loaded.";
    box.appendChild(d);
  }
}

$("go").onclick = async () => {
  const raw = $("url").value.trim();
  if (!raw) return;
  busy(true);
  try {
    state.auth = $("auth").value;
    state.origin = RF.originOf(raw);
    state.url = raw;
    setStatus("");
    await login();
    await load(raw, true);
  } catch (err) {
    $("tree").innerHTML = `<div class="err"></div>`;
    $("tree").firstChild.textContent = String(err.message || err);
    setStatus("");
  } finally {
    busy(false);
  }
};

function goHist(dir) {
  const url = dir < 0 ? (nav.canBack() && nav.back()) : (nav.canForward() && nav.forward());
  if (url) load(url);
}

$("back").onclick = () => goHist(-1);
$("fwd").onclick = () => goHist(1);

$("refresh").onclick = () => state.url && load(state.url);
$("save").onclick = () => {
  if (!state.body) return;
  const name = (state.url.split("/").filter(Boolean).pop() || "response") + ".json";
  window.redfish.save({ text: state.body, defaultPath: name });
};
$("expand").onchange = () => state.url && load(state.url);

$("logout").onclick = async () => {
  if (state.sessionUri && state.token) {
    try { await call("DELETE", state.sessionUri); } catch { /* session may already be gone */ }
  }
  state.token = "";
  state.sessionUri = "";
  $("logout").hidden = true;
  setStatus("");
};

function applyTheme(light) {
  document.body.classList.toggle("light", light);
  $("theme").title = light ? "Dark theme" : "Light theme";
  localStorage.setItem("theme", light ? "light" : "dark");
}
$("theme").onclick = () => applyTheme(!document.body.classList.contains("light"));
applyTheme(localStorage.getItem("theme") === "light");

function scrollUrl() {
  const el = $("url");
  requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
}
$("url").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  $("go").click();
});
$("url").addEventListener("blur", scrollUrl);
window.addEventListener("resize", scrollUrl);
scrollUrl();

function openFind() {
  document.querySelectorAll(".jrow.folded .gut.hot").forEach((g) => g.click());
  $("find").hidden = false;
  $("findq").focus();
  $("findq").select();
  if ($("findq").value) runFind(false, true);
}
function closeFind() {
  $("find").hidden = true;
  $("findn").textContent = "";
  window.redfish.findStop();
}
let findWanted = false;
function keepFindFocus() {
  const q = $("findq");
  if (!findWanted || $("find").hidden || document.activeElement === q) return;
  const a = q.selectionStart;
  const b = q.selectionEnd;
  q.focus();
  q.setSelectionRange(a, b);
}
function runFind(findNext, forward) {
  const q = $("findq");
  findWanted = document.activeElement === q;
  window.redfish.find({ text: q.value, forward, findNext });
}
document.addEventListener("mousedown", (e) => {
  if (!$("find").contains(e.target)) findWanted = false;
}, true);
$("findq").addEventListener("focusout", () => requestAnimationFrame(keepFindFocus));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("find").hidden) closeFind();
});
window.redfish.onFindOpen(openFind);
$("findq").addEventListener("input", () => runFind(false, true));
$("findq").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  runFind(true, !e.shiftKey);
});
$("findnext").onclick = () => runFind(true, true);
$("findprev").onclick = () => runFind(true, false);
$("findx").onclick = closeFind;
window.redfish.onFound((r) => {
  $("findn").textContent = r.matches ? r.active + "/" + r.matches : "0/0";
  keepFindFocus();
});
