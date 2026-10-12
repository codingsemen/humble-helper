const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const popupSource = fs.readFileSync(require.resolve("../popup.js"), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeElement(initialText = "") {
  const classes = new Set();
  const listeners = new Map();
  return {
    children: [],
    className: "",
    dataset: {},
    disabled: false,
    hidden: false,
    textContent: initialText,
    classList: {
      contains(name) {
        return classes.has(name);
      },
      remove(name) {
        classes.delete(name);
      },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return enabled;
      }
    },
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    async dispatch(type) {
      const event = { preventDefault() {} };
      await Promise.all((listeners.get(type) || []).map((listener) => listener(event)));
    },
    replaceChildren(...children) {
      this.children = children;
    }
  };
}

function createPopupHarness(sendRuntimeMessage) {
  const elements = {
    "#all-bundles-button": fakeElement(),
    "#bundle-list": fakeElement(),
    "#bundle-refresh": fakeElement("Refresh"),
    "#bundle-status": fakeElement("Checking Humble…"),
    "#cache-count": fakeElement("—"),
    "#footer-settings": fakeElement(),
    "#owned-count": fakeElement("—"),
    "#settings-button": fakeElement(),
    "#steam-card": fakeElement(),
    "#steam-detail": fakeElement("Checking your cached account…"),
    "#steam-refresh": fakeElement("Refresh"),
    "#wishlist-count": fakeElement("—")
  };
  const document = {
    createElement() {
      return fakeElement();
    },
    querySelector(selector) {
      return elements[selector] || null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const browser = {
    runtime: {
      getURL(path) {
        return "moz-extension://humble-helper/" + path;
      },
      async openOptionsPage() {}
    },
    tabs: {
      async create() {}
    }
  };
  const shared = {
    formatAge() {
      return "1h ago";
    },
    safeBundleImageUrl(value) {
      return value || "";
    },
    safeHumbleBundleUrl(value) {
      return value || "";
    },
    sanitizeGameBundle(bundle) {
      return bundle;
    },
    sendRuntimeMessage(browserApi, message) {
      assert.equal(browserApi, browser);
      return sendRuntimeMessage(message);
    }
  };
  const sandbox = {
    browser,
    clearTimeout,
    console,
    document,
    HumbleSteamFilterShared: shared,
    setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(popupSource, sandbox);
  return { elements };
}

function bundleCatalog() {
  return {
    error: null,
    fetchedAt: Date.now(),
    items: [],
    newCount: 0,
    refreshCooldownMs: 0
  };
}

function steamStatus({ error = null, fetchedAt = Date.now(), isLoggedIn = true, owned = 3001, wishlist = 121 } = {}) {
  return {
    matchedTitleCount: 258,
    ownedCount: owned,
    refreshCooldownMs: 0,
    snapshot: {
      error,
      fetchedAt,
      isLoggedIn,
      lastAttemptedAt: Date.now()
    },
    wishlistCount: wishlist
  };
}

test("Steam status renders without waiting for a slow bundle request", async () => {
  const bundles = deferred();
  const harness = createPopupHarness((message) => {
    if (message.type === "GET_BUNDLES") {
      return bundles.promise;
    }
    assert.equal(message.type, "GET_STATUS");
    return Promise.resolve(steamStatus());
  });

  await flushPromises();

  assert.equal(harness.elements["#owned-count"].textContent, (3001).toLocaleString());
  assert.equal(harness.elements["#wishlist-count"].textContent, (121).toLocaleString());
  assert.match(harness.elements["#steam-detail"].textContent, /^Connected/);
  assert.equal(harness.elements["#bundle-status"].textContent, "Checking Humble…");

  bundles.resolve(bundleCatalog());
  await flushPromises();
  assert.match(harness.elements["#bundle-status"].textContent, /0 active/);
});

test("a late startup status cannot overwrite a newer manual refresh", async () => {
  const startupStatus = deferred();
  const harness = createPopupHarness((message) => {
    if (message.type === "GET_BUNDLES") {
      return Promise.resolve(bundleCatalog());
    }
    if (message.type === "GET_STATUS") {
      return startupStatus.promise;
    }
    assert.equal(message.type, "REFRESH_DATA");
    return Promise.resolve(steamStatus());
  });

  await harness.elements["#steam-refresh"].dispatch("click");
  assert.equal(harness.elements["#owned-count"].textContent, (3001).toLocaleString());
  assert.match(harness.elements["#steam-detail"].textContent, /^Connected/);

  startupStatus.resolve(steamStatus({
    error: "not_logged_in",
    fetchedAt: 0,
    isLoggedIn: false,
    owned: 0,
    wishlist: 0
  }));
  await flushPromises();

  assert.equal(harness.elements["#owned-count"].textContent, (3001).toLocaleString());
  assert.equal(harness.elements["#wishlist-count"].textContent, (121).toLocaleString());
  assert.match(harness.elements["#steam-detail"].textContent, /^Connected/);
});

test("unavailable account data is not presented as a real zero", async () => {
  const harness = createPopupHarness((message) => {
    if (message.type === "GET_BUNDLES") {
      return Promise.resolve(bundleCatalog());
    }
    return Promise.resolve(steamStatus({
      error: "not_logged_in",
      fetchedAt: 0,
      isLoggedIn: false,
      owned: 0,
      wishlist: 0
    }));
  });

  await flushPromises();

  assert.equal(harness.elements["#owned-count"].textContent, "—");
  assert.equal(harness.elements["#wishlist-count"].textContent, "—");
  assert.equal(harness.elements["#cache-count"].textContent, (258).toLocaleString());
  assert.match(harness.elements["#steam-detail"].textContent, /Sign in to Steam/);
});

test("a validated empty Steam account is presented as a real zero", async () => {
  const harness = createPopupHarness((message) => {
    if (message.type === "GET_BUNDLES") {
      return Promise.resolve(bundleCatalog());
    }
    return Promise.resolve(steamStatus({ owned: 0, wishlist: 0 }));
  });

  await flushPromises();

  assert.equal(harness.elements["#owned-count"].textContent, "0");
  assert.equal(harness.elements["#wishlist-count"].textContent, "0");
  assert.match(harness.elements["#steam-detail"].textContent, /^Connected/);
});

test("an in-progress refresh keeps the last rendered account counts", async () => {
  const refreshedStatus = deferred();
  const harness = createPopupHarness((message) => {
    if (message.type === "GET_BUNDLES") {
      return Promise.resolve(bundleCatalog());
    }
    if (message.type === "REFRESH_DATA") {
      return refreshedStatus.promise;
    }
    return Promise.resolve(steamStatus());
  });
  await flushPromises();

  const refresh = harness.elements["#steam-refresh"].dispatch("click");

  assert.equal(harness.elements["#owned-count"].textContent, (3001).toLocaleString());
  assert.equal(harness.elements["#wishlist-count"].textContent, (121).toLocaleString());
  assert.equal(harness.elements["#steam-detail"].textContent, "Refreshing your Steam snapshot…");

  refreshedStatus.resolve(steamStatus({ owned: 3002, wishlist: 122 }));
  await refresh;
  assert.equal(harness.elements["#owned-count"].textContent, (3002).toLocaleString());
  assert.equal(harness.elements["#wishlist-count"].textContent, (122).toLocaleString());
});

test("a preserved snapshot remains visible when the latest Steam check fails", async () => {
  const harness = createPopupHarness((message) => {
    if (message.type === "GET_BUNDLES") {
      return Promise.resolve(bundleCatalog());
    }
    return Promise.resolve(steamStatus({
      error: "empty_snapshot_unconfirmed",
      fetchedAt: Date.now() - 3600000,
      isLoggedIn: true
    }));
  });

  await flushPromises();

  assert.equal(harness.elements["#owned-count"].textContent, (3001).toLocaleString());
  assert.equal(harness.elements["#wishlist-count"].textContent, (121).toLocaleString());
  assert.match(harness.elements["#steam-detail"].textContent, /^Using saved snapshot/);
  assert.match(harness.elements["#steam-detail"].textContent, /empty library/);
  assert.match(harness.elements["#steam-detail"].textContent, /refresh again after the cooldown/);
});

test("an unconfirmed empty first snapshot remains unavailable", async () => {
  const harness = createPopupHarness((message) => {
    if (message.type === "GET_BUNDLES") {
      return Promise.resolve(bundleCatalog());
    }
    return Promise.resolve(steamStatus({
      error: "empty_snapshot_unconfirmed",
      fetchedAt: 0,
      isLoggedIn: true,
      owned: 0,
      wishlist: 0
    }));
  });

  await flushPromises();

  assert.equal(harness.elements["#owned-count"].textContent, "—");
  assert.equal(harness.elements["#wishlist-count"].textContent, "—");
  assert.match(harness.elements["#steam-detail"].textContent, /could not be confirmed/);
  assert.match(harness.elements["#steam-detail"].textContent, /Refresh again after the cooldown/);
});
