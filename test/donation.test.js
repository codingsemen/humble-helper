const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../content/page-donation.js"), "utf8");

function runDonationScript(settings, splitViewCount = null) {
  const scheduled = [];
  let queryCount = 0;
  let clickCount = 0;
  const classList = (className) => ({ contains(value) { return value === className; } });
  const views = Array.from({ length: splitViewCount || 0 }, () => ({
    classList: classList("split-view"),
    querySelector() { return null; }
  }));
  const sliderRoot = splitViewCount == null ? null : {
    children: [{ classList: classList("splits-view"), children: views }]
  };
  const documentElement = {
    getAttribute() { return JSON.stringify(settings); }
  };
  const document = {
    documentElement,
    addEventListener() {},
    querySelector(selector) {
      queryCount += 1;
      if (selector.includes("split-allocation")) {
        return splitViewCount == null ? null : {
          checked: false,
          click() { clickCount += 1; }
        };
      }
      if (selector === ".js-split-sliders") {
        return sliderRoot;
      }
      return null;
    }
  };
  const sandbox = {
    KeyboardEvent: class KeyboardEvent {},
    MutationObserver: class MutationObserver {
      observe() {}
    },
    Node: { ELEMENT_NODE: 1 },
    clearTimeout() {},
    document,
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    window: { addEventListener() {} }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  scheduled.shift()();
  return { clickCount, queryCount, scheduled };
}

test("donation automation rejects disabled or non-numeric settings before touching checkout", () => {
  const disabled = runDonationScript({
    enabled: false,
    split: { developer: 50, charity: 50, humble: 0 }
  });
  const wrongTypes = runDonationScript({
    enabled: true,
    split: { developer: "50", charity: 50, humble: 0 }
  });

  assert.equal(disabled.queryCount, 0);
  assert.equal(wrongTypes.queryCount, 0);
  assert.equal(disabled.scheduled.length, 0);
  assert.equal(wrongTypes.scheduled.length, 0);
});

test("donation automation fails closed when Humble exposes an unexpected recipient count", () => {
  const result = runDonationScript({
    enabled: true,
    split: { developer: 50, charity: 50, humble: 0 }
  }, 4);

  assert.equal(result.queryCount, 3);
  assert.equal(result.clickCount, 0);
  assert.equal(result.scheduled.length, 1);
});

test("donation automation does not select custom allocation before validating every slider", () => {
  const result = runDonationScript({
    enabled: true,
    split: { developer: 50, charity: 50, humble: 0 }
  }, 3);

  assert.equal(result.queryCount, 3);
  assert.equal(result.clickCount, 0);
  assert.equal(result.scheduled.length, 1);
});

function modernHarness({ split = { developer: 50, charity: 50, humble: 0 }, minimums = [0, 0, 20], extraSlider = false } = {}) {
  const { parseHTML } = require("linkedom");
  const { document, window } = parseHTML('<html><body><aside data-testid="bundle-pdp-right-rail"><div data-testid="pay-split-custom"><button role="radio" id="custom" value="custom" aria-checked="false"></button></div></aside></body></html>');
  document.documentElement.setAttribute("data-humble-helper-donation-settings", JSON.stringify({ enabled: true, split }));
  const root = document.querySelector('[data-testid="pay-split-custom"]');
  const radio = root.querySelector("button");
  const timers = new Map();
  let nextTimer = 0;
  let values = [65, 5, 30];
  let keyEvents = 0;
  let observer;
  let handles = [];
  radio.addEventListener("click", () => {
    radio.setAttribute("aria-checked", "true");
    ["publisher", "charity", "humble"].forEach((name, index) => {
      const wrapper = document.createElement("span");
      wrapper.innerHTML = `<span role="slider" aria-valuemin="${minimums[index]}" aria-valuemax="100" aria-valuenow="${values[index]}"></span><input name="customPaymentSplit.${name}">`;
      root.append(wrapper);
      const handle = wrapper.querySelector('[role="slider"]');
      handles.push(handle);
      // Model Humble's published proportional sibling balancing and Radix's
      // integer keyboard steps. The addon only sees DOM and keyboard events.
      handle.addEventListener("keydown", event => {
        keyEvents += 1;
        const step = ({ ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 })[event.key];
        assert.ok(step, "uses supported slider keys");
        const next = Math.max(minimums[index], Math.min(100, minimums[index] + Math.round(values[index] + step - minimums[index])));
        const target = Math.min(next, 100 - minimums.reduce((sum, min, i) => sum + (i === index ? 0 : min), 0));
        const changed = values.slice();
        changed[index] = target;
        const difference = 100 - changed.reduce((a, b) => a + b, 0);
        const siblings = values.reduce((sum, value, i) => sum + (i === index ? 0 : value), 0);
        changed.forEach((value, i) => {
          if (i !== index) changed[i] = Math.max(minimums[i], value + (siblings ? value / siblings : 0.5) * difference);
        });
        const remainder = 100 - changed.reduce((a, b) => a + b, 0);
        changed.forEach((value, i) => { if (i !== index && value > minimums[i]) changed[i] += remainder; });
        timers.set(++nextTimer, () => {
          values = changed;
          handles.forEach((node, i) => node.setAttribute("aria-valuenow", values[i]));
        });
      });
    });
    if (extraSlider) root.insertAdjacentHTML("beforeend", '<span role="slider"></span>');
  });
  vm.runInNewContext(source, {
    document, window, Node: window.Node,
    location: { href: "https://www.humblebundle.com/games/example", pathname: "/games/example" },
    KeyboardEvent: class extends window.Event { constructor(type, options) { super(type, options); this.key = options.key; } },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  });
  return {
    root, document,
    get values() { return values; },
    get keyEvents() { return keyEvents; },
    mutate() { observer([{ addedNodes: [root] }]); },
    async flush() {
      for (let i = 0; i < 300 && timers.size; i += 1) {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach(callback => callback());
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(timers.size, 0, "donation automation must settle");
    }
  };
}

test("new donation controls mount on Custom and preserve Humble's mandatory minimum", async () => {
  const h = modernHarness();
  await h.flush();
  assert.ok(h.keyEvents > 0);
  h.values.forEach((value, index) => assert.ok(Math.abs(value - [40, 40, 20][index]) <= 0.51));
  assert.ok(h.root.hasAttribute("data-humble-helper-applied-split"));
  const count = h.keyEvents;
  h.mutate();
  await h.flush();
  assert.equal(h.keyEvents, count);
});

test("new donation controls support custom weights and all recipient floors", async () => {
  const h = modernHarness({ split: { developer: 25, charity: 50, humble: 25 }, minimums: [10, 5, 20] });
  await h.flush();
  h.values.forEach((value, index) => assert.ok(Math.abs(value - [26.25, 37.5, 36.25][index]) <= 0.51, `${h.values}`));
  assert.ok(h.root.hasAttribute("data-humble-helper-applied-split"));
});

for (const split of [
  { developer: 100, charity: 0, humble: 0 },
  { developer: 0, charity: 100, humble: 0 },
  { developer: 0, charity: 0, humble: 100 }
]) {
  test(`new donation controls converge for ${JSON.stringify(split)}`, async () => {
    const h = modernHarness({ split });
    await h.flush();
    const expected = [0.8 * split.developer, 0.8 * split.charity, 20 + 0.8 * split.humble];
    h.values.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= 0.51, `${h.values}`));
    assert.ok(h.root.hasAttribute("data-humble-helper-applied-split"));
  });
}

test("new donation controls fail closed for an unexpected recipient count", async () => {
  const h = modernHarness({ extraSlider: true });
  await h.flush();
  assert.equal(h.keyEvents, 0);
  assert.equal(h.root.hasAttribute("data-humble-helper-applied-split"), false);
});
