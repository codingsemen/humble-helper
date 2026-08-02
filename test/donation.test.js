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

  assert.equal(result.queryCount, 2);
  assert.equal(result.clickCount, 0);
  assert.equal(result.scheduled.length, 1);
});

test("donation automation does not select custom allocation before validating every slider", () => {
  const result = runDonationScript({
    enabled: true,
    split: { developer: 50, charity: 50, humble: 0 }
  }, 3);

  assert.equal(result.queryCount, 2);
  assert.equal(result.clickCount, 0);
  assert.equal(result.scheduled.length, 1);
});
