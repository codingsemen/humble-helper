const fs = require("node:fs");
const vm = require("node:vm");

const sharedSource = fs.readFileSync(require.resolve("../shared.js"), "utf8");
const backgroundSource = fs.readFileSync(require.resolve("../background.js"), "utf8");
const EXTENSION_ID = "humble-helper-test";

function createBackgroundHarness({ fetch, initialStorage = {}, initialAlarms = {}, now = () => Date.now() }) {
  let stored = { ...initialStorage };
  let alarms = Object.fromEntries(Object.entries(initialAlarms).map(([name, alarm]) => [
    name,
    { name, ...alarm }
  ]));
  const alarmCreates = [];
  const tabQueries = [];
  let messageHandler;
  let lastListenerResult;
  const browser = {
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...stored };
        },
        async set(values) {
          stored = { ...stored, ...values };
        }
      }
    },
    runtime: {
      id: EXTENSION_ID,
      getURL(path = "") {
        return `chrome-extension://${EXTENSION_ID}/${path}`;
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { messageHandler = listener; } }
    },
    alarms: {
      async get(name) {
        return alarms[name] ? { ...alarms[name] } : undefined;
      },
      create(name, details) {
        alarmCreates.push({ name, ...details });
        alarms[name] = { name, ...details };
      },
      onAlarm: { addListener() {} }
    },
    tabs: {
      async query(query) {
        tabQueries.push(query);
        return [];
      },
      async sendMessage() {},
      async create() {}
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    }
  };
  class HarnessDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now()]));
    }

    static now() {
      return now();
    }
  }
  const sandbox = {
    AbortController,
    Date: HarnessDate,
    URL,
    browser,
    clearTimeout,
    console,
    fetch,
    setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(sharedSource, sandbox);
  vm.runInNewContext(backgroundSource, sandbox);

  function invokeMessage(message, sender) {
    return new Promise((resolve) => {
      let responded = false;
      const result = messageHandler(message, sender, (response) => {
        responded = true;
        resolve(response);
      });
      lastListenerResult = result;
      if (result !== true && !responded) {
        resolve(result);
      }
    });
  }

  return {
    getStored() {
      return stored;
    },
    getLastListenerResult() {
      return lastListenerResult;
    },
    getTabQueries() {
      return JSON.parse(JSON.stringify(tabQueries));
    },
    getAlarms() {
      return JSON.parse(JSON.stringify(alarms));
    },
    getAlarmCreates() {
      return JSON.parse(JSON.stringify(alarmCreates));
    },
    async settleBackgroundTasks() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    send(message, sender) {
      return invokeMessage(message, sender);
    },
    sendFromContent(message, url = "https://www.humblebundle.com/games/test-bundle") {
      return invokeMessage(message, {
        id: EXTENSION_ID,
        url,
        tab: { id: 1, url }
      });
    },
    sendFromExtension(message, url = `chrome-extension://${EXTENSION_ID}/popup.html`) {
      return invokeMessage(message, { id: EXTENSION_ID, url });
    }
  };
}

module.exports = {
  EXTENSION_ID,
  createBackgroundHarness
};
