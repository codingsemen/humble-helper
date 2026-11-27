const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const fixture = fs.readFileSync(require.resolve("./fixtures/humble-next-cards.html"), "utf8");
const content = fs.readFileSync(require.resolve("../content/humble.js"), "utf8");
const shared = fs.readFileSync(require.resolve("../shared.js"), "utf8");

function harness(html = fixture, pathname = "/games/survival-fittest") {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const timers = new Map();
  const messages = [];
  let nextTimer = 0;
  let mutation;
  let runtimeListener;
  const location = { pathname, href: `https://www.humblebundle.com${pathname}` };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 200 });
  const sandbox = {
    document, window, location, URL, console, Node: window.Node, HTMLElement: window.HTMLElement,
    Event: window.Event,
    getComputedStyle(element) { return { display: element.hidden ? "none" : "block", visibility: "visible" }; },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    browser: { runtime: {
      onMessage: { addListener(callback) { runtimeListener = callback; } },
      async sendMessage(message) {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (message.type === "GET_SETTINGS") return { showWishlist: true, dimOwned: true };
        return { items: message.items.map((item, index) => ({ ...item, state: index % 2 ? "wishlist" : "owned" })) };
      }
    } }
  };
  vm.createContext(sandbox);
  vm.runInContext(shared, sandbox);
  vm.runInContext(content, sandbox);
  return {
    document, location, messages,
    mutate() { mutation([{ target: document.body, addedNodes: [document.body], removedNodes: [] }]); },
    refresh() { runtimeListener({ type: "STEAM_DATA_UPDATED" }); },
    async flush() {
      for (let i = 0; i < 10 && timers.size; i += 1) {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach(callback => callback());
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(timers.size, 0, "scan should settle");
    }
  };
}

test("detects the current Steam cards and renders stable owned/wishlist marks", async () => {
  const h = harness();
  await h.flush();
  const analysis = h.messages.find(message => message.type === "ANALYZE_BUNDLE");
  assert.equal(analysis.items.length, 12);
  assert.equal(analysis.items[0].title, "Palworld");
  assert.equal(h.document.querySelectorAll("[data-hsf-card]").length, 12);
  assert.equal(h.document.querySelectorAll(".hsf-owned-ribbon").length, 6);
  assert.equal(h.document.querySelectorAll(".hsf-wishlist-ribbon").length, 6);
  assert.match(h.document.querySelector(".hsf-summary").textContent, /6 owned.*6 wishlisted/);
  h.mutate();
  await h.flush();
  assert.equal(h.messages.filter(message => message.type === "ANALYZE_BUNDLE").length, 1);
  assert.equal(h.document.querySelectorAll(".hsf-owned-ribbon").length, 6);
  assert.equal(h.document.querySelectorAll(".hsf-status").length, 6);
});

test("filters non-Steam items and coupons, deduplicates copies, and matches titles exactly", async () => {
  const h = harness();
  const first = h.document.querySelector('[data-testid="bundle-item-card"]');
  first.insertAdjacentHTML("afterend", first.outerHTML);
  const clone = first.cloneNode(true);
  clone.querySelector("img").setAttribute("alt", "Palworld Deluxe Edition");
  clone.insertAdjacentHTML("beforeend", "<div>DLC</div>");
  h.document.body.append(clone);
  const cards = h.document.querySelectorAll('[data-testid="bundle-item-card"]');
  cards[2].querySelector('[aria-label="Steam"]').setAttribute("aria-label", "GOG");
  cards[3].querySelector("img").setAttribute("alt", "20% discount coupon");
  await h.flush();
  const items = h.messages.find(message => message.type === "ANALYZE_BUNDLE").items;
  assert.equal(items.length, 11);
  assert.equal(items.filter(item => item.title === "Palworld").length, 1);
  assert.equal(items.find(item => item.title === "Palworld Deluxe Edition").type, "dlc");
  assert.equal(cards[0].dataset.hsfCard, "owned");
  assert.equal(cards[1].dataset.hsfCard, "owned");
  assert.equal(cards[2].hasAttribute("data-hsf-card"), false);
  assert.equal(cards[3].hasAttribute("data-hsf-card"), false);
  assert.equal(clone.querySelectorAll(".hsf-owned-ribbon").length, 1);
});

test("initializes on a listing and follows client-side navigation and tier replacement", async () => {
  const h = harness("<h1>Bundles</h1>", "/bundles");
  await h.flush();
  assert.equal(h.messages.length, 0);
  h.location.pathname = "/games/first";
  h.location.href = "https://www.humblebundle.com/games/first";
  h.document.body.innerHTML = fixture;
  h.mutate();
  await h.flush();
  assert.equal(h.document.querySelectorAll("[data-hsf-card]").length, 12);
  h.document.body.innerHTML = fixture;
  h.mutate();
  await h.flush();
  assert.equal(h.document.querySelectorAll("[data-hsf-card]").length, 12);
  assert.equal(h.messages.filter(m => m.type === "ANALYZE_BUNDLE").length, 1);
  h.location.pathname = "/bundles";
  h.location.href = "https://www.humblebundle.com/bundles";
  h.mutate();
  await h.flush();
  assert.equal(h.document.querySelectorAll("[data-hsf-card], .hsf-summary").length, 0);
});

test("still reads legacy page data and marks legacy cards", async () => {
  const data = { bundleData: {
    tier_order: ["all"], tier_display_data: { all: { tier_item_machine_names: ["palworld"] } },
    tier_item_data: { palworld: { human_name: "Palworld", availability_icons: { delivery_icons: ["hb-steam"] } } }
  } };
  const h = harness(`<h1>Legacy bundle</h1><script id="webpack-bundle-page-data">${JSON.stringify(data)}</script>
    <div class="tier-item-view"><div><img></div><div class="item-title">Palworld</div></div>`);
  await h.flush();
  assert.equal(h.document.querySelector(".tier-item-view").dataset.hsfCard, "owned");
});
