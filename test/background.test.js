const assert = require("node:assert/strict");
const test = require("node:test");

const { EXTENSION_ID, createBackgroundHarness } = require("./background-harness");

function freshSnapshot(overrides = {}) {
  return {
    ownedAppIds: [],
    wishlistAppIds: [],
    fetchedAt: Date.now(),
    lastAttemptedAt: Date.now(),
    isLoggedIn: true,
    error: null,
    ...overrides
  };
}

test("uses Steam credentials only for account endpoints and preserves the manual cooldown", async () => {
  const credentialModes = {};
  const steamDataUrls = [];
  let wishlist = [];
  const harness = createBackgroundHarness({
    fetch: async (url, options) => {
      if (url.includes("/my/?")) {
        credentialModes.login = options.credentials;
        return { ok: true, url: "https://store.steampowered.com/", text: async () => "<html></html>" };
      }
      if (url.includes("/dynamicstore/userdata/")) {
        credentialModes.account = options.credentials;
        steamDataUrls.push(url);
        return {
          ok: true,
          json: async () => ({
            rgOwnedApps: [1599600],
            rgWishlist: wishlist,
            rgFollowedApps: [],
            rgRecommendedApps: []
          })
        };
      }
      if (url.includes("/api/storesearch/")) {
        credentialModes.search = options.credentials;
        return {
          ok: true,
          json: async () => ({ items: [{ type: "app", id: 1599600, name: "PlateUp!" }] })
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const result = await harness.sendFromContent({
    type: "ANALYZE_BUNDLE",
    items: [{ title: "PlateUp!", machineName: "plateup" }]
  });
  assert.equal(result.snapshot.isLoggedIn, true);
  assert.equal(result.items[0].state, "owned");
  assert.deepEqual(credentialModes, { login: "include", account: "include", search: "omit" });

  wishlist = [2345678];
  const refreshed = await harness.sendFromExtension({ type: "REFRESH_DATA" });
  assert.equal(refreshed.wishlistCount, 1);
  assert.match(steamDataUrls[steamDataUrls.length - 1], /[?&]hsf_refresh=/);
  const requestCountAfterRefresh = steamDataUrls.length;
  const limited = await harness.sendFromExtension({ type: "REFRESH_DATA" });
  assert.equal(steamDataUrls.length, requestCountAfterRefresh);
  assert.ok(limited.refreshCooldownMs > 0);
});

test("resolves a Humble DLC label through Steam's base-title search", async () => {
  const harness = createBackgroundHarness({
    fetch: async (url) => {
      if (url.includes("/my/?")) {
        return { ok: true, url, text: async () => "<html>g_steamID = '123'</html>" };
      }
      if (url.includes("/dynamicstore/userdata/")) {
        return {
          ok: true,
          json: async () => ({ rgOwnedApps: [3784190], rgWishlist: [], rgFollowedApps: [] })
        };
      }
      if (url.includes("/api/storesearch/")) {
        const term = new URL(url).searchParams.get("term");
        return {
          ok: true,
          json: async () => term === "TMNT: Splintered Fate"
            ? { items: [{ type: "app", id: 3784190, name: "TMNT: Splintered Fate - Metalhead" }] }
            : { items: [] }
        };
      }
      if (url.includes("/api/appdetails?")) {
        const appId = new URL(url).searchParams.get("appids");
        if (appId === "2996040") {
          return {
            ok: true,
            json: async () => ({
              "2996040": {
                success: true,
                data: { type: "game", name: "Teenage Mutant Ninja Turtles: Splintered Fate", dlc: [4152390, 3784190] }
              }
            })
          };
        }
        return {
          ok: true,
          json: async () => ({
            [appId]: {
              success: true,
              data: {
                type: "dlc",
                name: appId === "3784190"
                  ? "TMNT: Splintered Fate - Metalhead"
                  : "TMNT: Splintered Fate - Alopex Character DLC",
                fullgame: { appid: 2996040, name: "Teenage Mutant Ninja Turtles: Splintered Fate" }
              }
            }
          })
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const result = await harness.sendFromContent({
    type: "ANALYZE_BUNDLE",
    items: [{ title: "TMNT: Splintered Fate - Metalhead DLC", machineName: "metalhead", type: "dlc" }]
  });

  assert.equal(result.items[0].match.appId, "3784190");
  assert.equal(result.items[0].state, "owned");
});

test("caches the Humble game catalog, marks later arrivals, and rate-limits manual refresh", async () => {
  let catalogVersion = 1;
  let requestCount = 0;
  function catalogHtml() {
    const products = [{
      machine_name: "first_gamebundle",
      product_url: "/games/first",
      tile_short_name: "First Bundle",
      tile_image: "https://hb.imgix.net/first.jpg",
      hover_highlights: ["5 items"]
    }];
    if (catalogVersion > 1) {
      products.push({
        machine_name: "second_gamebundle",
        product_url: "/games/second",
        tile_short_name: "Second Bundle",
        tile_image: "https://hb.imgix.net/second.jpg",
        hover_highlights: ["8 items"]
      });
    }
    return `<script id="landingPage-json-data" type="application/json">${JSON.stringify({
      data: { games: { mosaic: [{ products }] } }
    })}</script>`;
  }
  const harness = createBackgroundHarness({
    fetch: async (url) => {
      if (url === "https://www.humblebundle.com/bundles") {
        requestCount += 1;
        return { ok: true, text: async () => catalogHtml() };
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const first = await harness.sendFromExtension({ type: "GET_BUNDLES" });
  assert.equal(first.items.length, 1);
  assert.equal(first.newCount, 0);

  catalogVersion = 2;
  const second = await harness.sendFromExtension({ type: "REFRESH_BUNDLES" });
  assert.equal(second.items.length, 2);
  assert.equal(second.newCount, 1);
  assert.equal(second.items.find((item) => item.id === "second_gamebundle").isNew, true);

  const requestsAfterRefresh = requestCount;
  const limited = await harness.sendFromExtension({ type: "REFRESH_BUNDLES" });
  assert.equal(requestCount, requestsAfterRefresh);
  assert.ok(limited.refreshCooldownMs > 0);
});

test("keeps privileged messages on extension pages and validates settings types", async () => {
  const harness = createBackgroundHarness({
    fetch: async (url) => { throw new Error(`Unexpected request: ${url}`); }
  });

  assert.equal(await harness.sendFromContent({
    type: "SET_SETTINGS",
    settings: { showWishlist: false }
  }), undefined);
  assert.equal(await harness.send(
    { type: "GET_STATUS" },
    { id: "different-extension", url: "chrome-extension://different-extension/popup.html" }
  ), undefined);

  await harness.sendFromExtension({
    type: "SET_SETTINGS",
    settings: {
      showWishlist: "false",
      donationSplit: { developer: "100", charity: 0, humble: 0 },
      unexpected: "discard me"
    }
  });
  const unchanged = await harness.sendFromExtension({ type: "GET_SETTINGS" });
  assert.equal(unchanged.showWishlist, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(unchanged.donationSplit)),
    { developer: 50, charity: 50, humble: 0 }
  );
  assert.equal("unexpected" in unchanged, false);

  await harness.sendFromExtension({ type: "SET_SETTINGS", settings: { showWishlist: false } });
  assert.equal((await harness.sendFromExtension({ type: "GET_SETTINGS" })).showWishlist, false);

  const optionsUrl = `chrome-extension://${EXTENSION_ID}/options.html`;
  await harness.send(
    { type: "SET_SETTINGS", settings: { dimOwned: false } },
    { id: EXTENSION_ID, url: optionsUrl, tab: { id: 2, url: optionsUrl } }
  );
  assert.equal((await harness.sendFromExtension({ type: "GET_SETTINGS" })).dimOwned, false);
});

test("serializes concurrent partial settings updates", async () => {
  const harness = createBackgroundHarness({
    fetch: async (url) => { throw new Error(`Unexpected request: ${url}`); }
  });

  await Promise.all([
    harness.sendFromExtension({ type: "SET_SETTINGS", settings: { showWishlist: false } }),
    harness.sendFromExtension({ type: "SET_SETTINGS", settings: { dimOwned: false } })
  ]);

  const settings = await harness.sendFromExtension({ type: "GET_SETTINGS" });
  assert.equal(settings.showWishlist, false);
  assert.equal(settings.dimOwned, false);
});

test("returns Steam counts without exposing the library IDs to extension pages", async () => {
  const harness = createBackgroundHarness({
    fetch: async (url) => { throw new Error(`Unexpected request: ${url}`); },
    initialStorage: {
      snapshot: freshSnapshot({ ownedAppIds: [10, 20], wishlistAppIds: [30] }),
      titleCache: {
        example: { appId: "10", steamName: "Example", confidence: 1, fetchedAt: Date.now(), version: 7 }
      }
    }
  });

  const status = await harness.sendFromExtension({ type: "GET_STATUS" });
  assert.equal(status.ownedCount, 2);
  assert.equal(status.wishlistCount, 1);
  assert.equal(status.matchedTitleCount, 1);
  assert.equal("ownedAppIds" in status.snapshot, false);
  assert.equal("wishlistAppIds" in status.snapshot, false);
  assert.equal("settings" in status, false);
});

test("does not overwrite newer settings when title resolution finishes later", async () => {
  let releaseSearch;
  let markSearchStarted;
  const searchStarted = new Promise((resolve) => { markSearchStarted = resolve; });
  const searchGate = new Promise((resolve) => { releaseSearch = resolve; });
  const harness = createBackgroundHarness({
    initialStorage: { snapshot: freshSnapshot({ ownedAppIds: [42] }) },
    fetch: async (url) => {
      if (url.includes("/api/storesearch/")) {
        markSearchStarted();
        await searchGate;
        return { ok: true, json: async () => ({ items: [{ type: "app", id: 42, name: "Slow Game" }] }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const analysis = harness.sendFromContent({
    type: "ANALYZE_BUNDLE",
    items: [{ title: "Slow Game", machineName: "slow-game" }]
  });
  await searchStarted;
  await harness.sendFromExtension({ type: "SET_SETTINGS", settings: { dimOwned: false } });
  releaseSearch();
  await analysis;

  assert.equal(harness.getStored().settings.dimOwned, false);
  assert.equal(harness.getStored().titleCache["slow game"].appId, "42");
});

test("serializes concurrent title-cache updates so both results survive", async () => {
  const harness = createBackgroundHarness({
    initialStorage: { snapshot: freshSnapshot() },
    fetch: async (url) => {
      if (url.includes("/api/storesearch/")) {
        const term = new URL(url).searchParams.get("term");
        const id = term === "First Game" ? 101 : 202;
        return { ok: true, json: async () => ({ items: [{ type: "app", id, name: term }] }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  await Promise.all([
    harness.sendFromContent({ type: "ANALYZE_BUNDLE", items: [{ title: "First Game" }] }),
    harness.sendFromContent({ type: "ANALYZE_BUNDLE", items: [{ title: "Second Game" }] })
  ]);

  assert.deepEqual(Object.keys(harness.getStored().titleCache).sort(), ["first game", "second game"]);
});

test("drops oversized or malformed page items before making Steam requests", async () => {
  let requestCount = 0;
  const harness = createBackgroundHarness({
    initialStorage: { snapshot: freshSnapshot() },
    fetch: async () => {
      requestCount += 1;
      throw new Error("No request expected");
    }
  });

  const result = await harness.sendFromContent({
    type: "ANALYZE_BUNDLE",
    items: [{ title: "x".repeat(301) }, { title: "!!!" }, { title: 123 }, null]
  });

  assert.deepEqual(result.items, []);
  assert.equal(requestCount, 0);
});

test("does not accept content-script messages from non-Humble pages", async () => {
  const harness = createBackgroundHarness({
    fetch: async (url) => { throw new Error(`Unexpected request: ${url}`); }
  });
  const result = await harness.send({ type: "GET_SETTINGS" }, {
    id: EXTENSION_ID,
    url: "https://example.com/games/fake",
    tab: { id: 1, url: "https://example.com/games/fake" }
  });
  assert.equal(result, undefined);
});

test("accepts content-script messages from localized Humble pages only", async () => {
  const harness = createBackgroundHarness({
    fetch: async (url) => { throw new Error(`Unexpected request: ${url}`); }
  });

  for (const path of ["games/test", "books/test", "software/test"]) {
    const settings = await harness.sendFromContent(
      { type: "GET_SETTINGS" },
      `https://de.humblebundle.com/${path}`
    );
    assert.equal(settings.showWishlist, true);
  }

  for (const hostname of ["de.humblebundle.com.evil.example", "evilhumblebundle.com"]) {
    const result = await harness.sendFromContent(
      { type: "GET_SETTINGS" },
      `https://${hostname}/games/fake`
    );
    assert.equal(result, undefined);
  }
});

test("broadcasts updates to every supported localized Humble bundle page", async () => {
  const harness = createBackgroundHarness({
    fetch: async (url) => { throw new Error(`Unexpected request: ${url}`); }
  });

  await harness.sendFromExtension({
    type: "SET_SETTINGS",
    settings: { showWishlist: false }
  });

  assert.deepEqual(harness.getTabQueries(), [{
    url: [
      "https://*.humblebundle.com/games/*",
      "https://*.humblebundle.com/books/*",
      "https://*.humblebundle.com/software/*"
    ]
  }]);
});

test("uses the callback-compatible asynchronous response protocol", async () => {
  const harness = createBackgroundHarness({
    fetch: async (url) => { throw new Error(`Unexpected request: ${url}`); }
  });

  const response = harness.sendFromExtension({ type: "GET_SETTINGS" });
  assert.equal(harness.getLastListenerResult(), true);
  assert.equal((await response).showWishlist, true);
});
