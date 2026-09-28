// Pure helpers shared by the renderer (script tag) and `node lib.js`.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RF = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function originOf(url) {
    const u = new URL(url);
    return u.origin;
  }

  function resolve(origin, ref) {
    if (/^https?:\/\//i.test(ref)) return ref;
    if (ref.startsWith("/")) return origin + ref;
    return origin + "/" + ref;
  }

  function isLinkObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (typeof value["@odata.id"] !== "string") return false;
    return Object.keys(value).every((k) => k === "@odata.id" || k.startsWith("@"));
  }

  function isClickable(key, value) {
    if (typeof value !== "string" || !value) return false;
    if (key === "@odata.id" || key === "@odata.nextLink" || key === "target") return true;
    return /^https?:\/\//i.test(value) || value.startsWith("/redfish/");
  }

  // One level. Link objects become { "@odata.id", "@expanded": body }.
  // ponytail: sequential, cap 40; parallel + deeper levels if a BMC is slow or huge.
  async function expandLinks(node, fetchJson, currentUrl, left = { n: 40 }) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      const out = [];
      for (const item of node) out.push(await expandLinks(item, fetchJson, currentUrl, left));
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (isLinkObject(v) && left.n > 0 && resolveUrl(currentUrl, v["@odata.id"]) !== currentUrl) {
        left.n -= 1;
        const url = resolveUrl(currentUrl, v["@odata.id"]);
        try {
          out[k] = { "@odata.id": v["@odata.id"], "@expanded": await fetchJson(url) };
        } catch (err) {
          out[k] = { ...v, "@expandError": String(err.message || err) };
        }
      } else if (v && typeof v === "object") {
        out[k] = await expandLinks(v, fetchJson, currentUrl, left);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function resolveUrl(currentUrl, ref) {
    return resolve(originOf(currentUrl), ref);
  }

  function schemaFile(odataType) {
    // #ComputerSystem.v1_22_0.ComputerSystem -> ComputerSystem.v1_22_0
    const m = /^#?([A-Za-z0-9]+)\.(v\d+_\d+_\d+)\./.exec(odataType || "");
    return m ? `${m[1]}.${m[2]}` : null;
  }

  function schemaDescriptions(schema) {
    const desc = {};
    const defs = schema && schema.definitions;
    if (!defs) return desc;
    for (const def of Object.values(defs)) {
      if (def && def.description && !desc._type) desc._type = def.description;
      const props = def && def.properties;
      if (!props) continue;
      for (const [name, prop] of Object.entries(props)) {
        if (prop && prop.description && !desc[name]) desc[name] = prop.description;
      }
    }
    return desc;
  }

  function redirectTarget(method, status, location, currentUrl) {
    if (!(status >= 300 && status < 400) || !location) return null;
    let next;
    try { next = new URL(location, currentUrl); } catch { return null; }
    if (next.hostname !== new URL(currentUrl).hostname) return null;
    const toGet = status === 300 || status === 301 || status === 302 || status === 303;
    return { url: next.href, method: toGet ? "GET" : method, dropBody: toGet };
  }

  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }

  function history() {
    const h = [];
    let i = -1;
    return {
      push(url) {
        if (h[i] === url) return;
        h.splice(i + 1);
        h.push(url);
        i = h.length - 1;
      },
      back() {
        if (i > 0) i -= 1;
        return h[i];
      },
      forward() {
        if (i < h.length - 1) i += 1;
        return h[i];
      },
      canBack() {
        return i > 0;
      },
      canForward() {
        return i < h.length - 1;
      },
      replace(url) {
        if (i >= 0) h[i] = url;
      },
    };
  }

  return {
    originOf,
    resolve,
    isLinkObject,
    isClickable,
    expandLinks,
    schemaFile,
    schemaDescriptions,
    history,
    redirectTarget,
    sortKeys,
  };
});

if (typeof require !== "undefined" && require.main === module) {
  const assert = require("assert");
  const rf = require("./lib.js");
  assert.strictEqual(rf.originOf("https://bmc:443/redfish/v1/"), "https://bmc");
  assert.strictEqual(rf.resolve("https://bmc", "/redfish/v1/Systems"), "https://bmc/redfish/v1/Systems");
  assert.strictEqual(rf.isLinkObject({ "@odata.id": "/redfish/v1/Systems" }), true);
  assert.strictEqual(rf.isLinkObject({ "@odata.id": "/x", Name: "n" }), false);
  assert.strictEqual(rf.isClickable("@odata.id", "/redfish/v1/"), true);
  assert.strictEqual(rf.isClickable("Name", "System"), false);
  assert.strictEqual(rf.schemaFile("#ComputerSystem.v1_22_0.ComputerSystem"), "ComputerSystem.v1_22_0");
  const h = rf.history();
  h.push("/a");
  h.push("/b");
  h.push("/b");
  assert.strictEqual(h.back(), "/a");
  h.push("/c");
  assert.strictEqual(h.canForward(), false);
  assert.strictEqual(h.back(), "/a");
  assert.strictEqual(h.forward(), "/c");
  const hop = rf.redirectTarget("GET", 300, "/redfish/v1/", "http://127.0.0.1:8080/redfish/v1");
  assert.strictEqual(hop.url, "http://127.0.0.1:8080/redfish/v1/");
  assert.strictEqual(hop.method, "GET");
  const up = rf.redirectTarget("GET", 301, "https://127.0.0.1/redfish/v1/", "http://127.0.0.1:8080/redfish/v1");
  assert.strictEqual(up.url, "https://127.0.0.1/redfish/v1/");
  assert.strictEqual(rf.redirectTarget("GET", 302, "https://other/x", "http://127.0.0.1/x"), null);
  assert.strictEqual(rf.redirectTarget("POST", 307, "/ok", "http://127.0.0.1/x").method, "POST");
  assert.strictEqual(rf.redirectTarget("POST", 303, "/ok", "http://127.0.0.1/x").dropBody, true);
  assert.deepStrictEqual(
    rf.sortKeys({ b: 1, a: { d: 1, c: [2, 1] } }),
    { a: { c: [2, 1], d: 1 }, b: 1 }
  );
  const got = [];
  rf.expandLinks(
    { Systems: { "@odata.id": "/redfish/v1/Systems" }, Name: "Root" },
    async (url) => {
      got.push(url);
      return { Name: "Systems" };
    },
    "https://bmc/redfish/v1/"
  ).then((out) => {
    assert.deepStrictEqual(got, ["https://bmc/redfish/v1/Systems"]);
    assert.strictEqual(out.Systems["@expanded"].Name, "Systems");
    assert.strictEqual(out.Name, "Root");
    console.log("lib.js ok");
  });
}
