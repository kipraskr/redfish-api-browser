const { app, BrowserWindow, dialog, ipcMain, session } = require("electron");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const RF = require("./lib.js");

// BMCs ship self-signed certs. This is a local browser, not a prod client.
app.commandLine.appendSwitch("ignore-certificate-errors");

const agent = new https.Agent({ rejectUnauthorized: false });

function requestRaw(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers,
        agent: u.protocol === "https:" ? agent : undefined,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > 5_000_000) {
            req.destroy();
            reject(new Error("response larger than 5MB"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const hdrs = {};
          for (const [k, v] of Object.entries(res.headers)) {
            hdrs[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
          }
          resolve({
            status: res.statusCode,
            headers: hdrs,
            body: Buffer.concat(chunks).toString("utf8"),
            url: urlStr,
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

// Main-process HTTP: no browser cookie jar, no CORS. Auth is Basic or X-Auth-Token
// on this request only, so a remote page cannot ride a cookie (CSRF).
async function request({ method, url, headers, body }) {
  let current = url;
  let m = method || "GET";
  let b = body;
  let hdrs = Object.assign({}, headers || {});
  let res;
  for (let i = 0; i < 10; i++) {
    res = await requestRaw(m, current, hdrs, b);
    const hop = RF.redirectTarget(m, res.status, res.headers.location, current);
    if (!hop) return res;
    current = hop.url;
    m = hop.method;
    if (hop.dropBody) {
      b = undefined;
      delete hdrs["Content-Type"];
      delete hdrs["content-type"];
    }
  }
  return res;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && (input.meta || input.control) && input.key.toLowerCase() === "f") {
      event.preventDefault();
      win.webContents.send("redfish:find-open");
    }
  });
  win.webContents.on("found-in-page", (_e, result) => {
    if (result.finalUpdate) {
      win.webContents.send("redfish:found", {
        active: result.activeMatchOrdinal,
        matches: result.matches,
      });
    }
  });
  win.loadFile("index.html");
}

app.whenReady().then(() => {
  session.defaultSession.setCertificateVerifyProc((_req, cb) => cb(0));
  ipcMain.handle("redfish:request", (_e, args) => request(args));
  ipcMain.handle("redfish:save", async (e, { text, defaultPath }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      defaultPath: defaultPath || "response.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, text);
    return true;
  });
  ipcMain.handle("redfish:find", (e, { text, forward, findNext }) => {
    if (!text) {
      e.sender.stopFindInPage("clearSelection");
      return;
    }
    e.sender.findInPage(text, { forward: forward !== false, findNext: !!findNext });
  });
  ipcMain.on("redfish:find-stop", (e) => e.sender.stopFindInPage("clearSelection"));
  createWindow();
});

app.on("window-all-closed", () => app.quit());
