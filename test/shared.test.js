const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../shared.js"), "utf8");
const sandbox = { console, URL };
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox);
const shared = sandbox.HumbleSteamFilterShared;

test("normalizes punctuation, accents, and trademark markers", () => {
  assert.equal(shared.normalizeTitle("PlateUp!®"), "plateup");
  assert.equal(shared.normalizeTitle("Pokémon™: Let's Go!"), "pokemon let s go");
  assert.equal(shared.normalizeTitle("TMNT: Splintered Fate"), "teenage mutant ninja turtles splintered fate");
});

test("extracts the redesigned catalog across streamed Next.js script chunks", () => {
  const html = fs.readFileSync(require.resolve("./fixtures/humble-next-catalog.html"), "utf8");
  const bundles = shared.extractGameBundles(html);
  assert.equal(bundles.length, 3);
  assert.equal(bundles[0].name, "Humble 15th Anniversary - Survival of the Fittest");
  assert.equal(bundles[0].itemCount, 12);
  assert.equal(bundles[0].endsAt, "2026-12-08T05:00:00.000Z");
  assert.match(bundles[0].image, /^https:\/\/hb-prd\.imgix\.net\//);
});

test("new catalog ignores other products, duplicate entries and unsafe URLs without executing scripts", () => {
  const product = { productType: "humble-bundle", category: "games", productKey: "safe", title: "Safe", url: "/games/safe" };
  const entries = [product, product, { ...product, url: "https://evil.example/games/unsafe" },
    { ...product, category: "books" }, { ...product, productType: "storefront-product" }];
  const stream = "1:" + JSON.stringify(entries) + "\n";
  const html = `<script>self.__next_f.push(${JSON.stringify([1, stream])})</script>`;
  assert.equal(shared.extractGameBundles(html).length, 1);
  assert.throws(() => shared.extractGameBundles('<script>self.__next_f.push([1, alert("unsafe")])</script>'), /not found/);
  assert.throws(() => shared.extractGameBundles('<script>self.__next_f.push([1, "1:{broken}"])</script>'), /not found/);
  assert.equal(shared.safeBundleImageUrl("https://hb-prd.imgix.net.evil.example/tracker.png"), "");
});

test("scores exact Steam search matches above partial matches", () => {
  assert.equal(shared.titleScore("PlateUp!", "PlateUp!"), 1);
  assert.ok(shared.titleScore("PlateUp!", "PlateUp! Demo") < 1);
  assert.ok(shared.titleScore("PlateUp!", "A completely different game") < 0.72);
});

test("coalesces mutations without discarding an in-flight analysis", async () => {
  let finishFirstRun;
  const firstRun = new Promise((resolve) => { finishFirstRun = resolve; });
  const runs = [];
  const reruns = [];
  const requestRun = shared.createAsyncCoalescer(async (force) => {
    runs.push(force);
    await firstRun;
  }, (force) => {
    reruns.push(force);
  });

  const activeRun = requestRun(false);
  await Promise.resolve();
  await requestRun(false);
  await requestRun(true);
  finishFirstRun();
  await activeRun;

  assert.deepEqual(runs, [false]);
  assert.deepEqual(reruns, [true]);
});

test("extracts and categorizes current game bundles from Humble landing data", () => {
  const payload = {
    data: {
      games: {
        mosaic: [{
          products: [{
            machine_name: "squadgoals_gamebundle",
            product_url: "/games/squad-goals",
            tile_short_name: "Squad Goals",
            tile_image: "https://hb.imgix.net/squad.jpg",
            short_marketing_blurb: "Co-op multiplayer party games",
            hover_highlights: ["11 items", "US$200 Value"],
            "start_date|datetime": "2026-07-31T18:00:00",
            "end_date|datetime": "2026-08-21T18:00:00"
          }]
        }]
      }
    }
  };
  const html = `<script type="application/json" id="landingPage-json-data">${JSON.stringify(payload)}</script>`;
  const bundles = shared.extractGameBundles(html);

  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].name, "Squad Goals");
  assert.equal(bundles[0].url, "https://www.humblebundle.com/games/squad-goals");
  assert.equal(bundles[0].itemCount, 11);
  assert.deepEqual(Array.from(bundles[0].tags), ["Co-op"]);
});

test("normalizes donation weights while preserving a 50/50/0 default", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(shared.normalizeDonationSplit({ developer: 50, charity: 50, humble: 0 }))),
    { developer: 50, charity: 50, humble: 0 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(shared.normalizeDonationSplit({ developer: 2, charity: 1, humble: 1 }))),
    { developer: 50, charity: 25, humble: 25 }
  );
  const edgeCase = shared.normalizeDonationSplit({ developer: 0.05, charity: 99.95, humble: 0 });
  assert.equal(edgeCase.developer + edgeCase.charity + edgeCase.humble, 100);
  assert.ok(Object.values(edgeCase).every((value) => value >= 0 && value <= 100));
});

test("keeps bundle links on Humble and accepts images only from approved HTTPS hosts", () => {
  assert.equal(
    shared.safeHumbleBundleUrl("/games/safe-bundle#checkout"),
    "https://www.humblebundle.com/games/safe-bundle"
  );
  assert.equal(
    shared.safeHumbleBundleUrl("https://de.humblebundle.com/games/safe-bundle#checkout"),
    "https://de.humblebundle.com/games/safe-bundle"
  );
  assert.equal(shared.safeHumbleBundleUrl("https://example.com/games/phishing"), "");
  assert.equal(shared.safeHumbleBundleUrl("https://de.humblebundle.com.evil.example/games/phishing"), "");
  assert.equal(shared.safeHumbleBundleUrl("https://evilhumblebundle.com/games/phishing"), "");
  assert.equal(shared.safeHumbleBundleUrl("javascript:alert(1)"), "");
  assert.equal(
    shared.safeBundleImageUrl("https://hb.imgix.net/safe.jpg"),
    "https://hb.imgix.net/safe.jpg"
  );
  assert.equal(shared.safeBundleImageUrl("http://hb.imgix.net/insecure.jpg"), "");
  assert.equal(shared.safeBundleImageUrl("https://www.humblebundle.com/account"), "");
  assert.equal(shared.safeBundleImageUrl("https://example.com/tracker.gif"), "");
});

test("sanitizes catalog fields before they reach extension storage or the popup", () => {
  const bundle = shared.sanitizeGameBundle({
    id: "safe-id",
    name: "<b>Safe name</b>",
    url: "/games/safe",
    image: "data:image/svg+xml,<svg></svg>",
    tags: ["Action", "invented", "Horror"],
    itemCount: 999999,
    startsAt: "not-a-date"
  });

  assert.equal(bundle.name, "Safe name");
  assert.equal(bundle.image, "");
  assert.deepEqual(Array.from(bundle.tags), ["Action", "Horror"]);
  assert.equal(bundle.itemCount, null);
  assert.equal(bundle.startsAt, null);
});

test("maps async work with a fixed concurrency limit while preserving order", async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await shared.mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(Array.from(results), [2, 4, 6, 8]);
  assert.equal(maximumActive, 2);
});

test("turns callback-compatible background error envelopes into rejected requests", async () => {
  const browserApi = {
    runtime: {
      async sendMessage() {
        return { __humbleHelperError: "Background request failed" };
      }
    }
  };

  await assert.rejects(
    shared.sendRuntimeMessage(browserApi, { type: "GET_STATUS" }),
    /Background request failed/
  );
});

test("supports callback-only runtime message APIs used by older Chrome", async () => {
  const browserApi = {
    runtime: {
      sendMessage(message, callback) {
        assert.deepEqual(message, { type: "GET_STATUS" });
        setTimeout(() => callback({ ok: true }), 0);
        return undefined;
      }
    }
  };

  assert.deepEqual(
    await shared.sendRuntimeMessage(browserApi, { type: "GET_STATUS" }),
    { ok: true }
  );
});

test("handles runtimes that complete through both callback and Promise APIs once", async () => {
  let resolvePromise;
  const browserApi = {
    runtime: {
      sendMessage(message, callback) {
        callback({ source: "callback" });
        return new Promise((resolve) => {
          resolvePromise = resolve;
        });
      }
    }
  };

  const response = await shared.sendRuntimeMessage(browserApi, { type: "GET_STATUS" });
  assert.deepEqual(response, { source: "callback" });
  resolvePromise({ source: "promise" });
});
