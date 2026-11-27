(function startHumbleDonationDefaults() {
  "use strict";

  var SETTINGS_ATTRIBUTE = "data-humble-helper-donation-settings";
  var APPLIED_ATTRIBUTE = "data-humble-helper-applied-split";
  var MAX_RETRIES = 20;
  var timer = null;
  var applying = false;
  var retryCount = 0;
  var modernSignature = "";
  var modernRoot = null;

  function modernControls() {
    var root = document.querySelector('[data-testid="pay-split-custom"]');
    if (!root) {
      return null;
    }
    var radio = root.querySelector('[role="radio"][value="custom"], [role="radio"]#custom');
    var handles = ["publisher", "charity", "humble"].map(function findHandle(name) {
      var input = root.querySelector('input[name="customPaymentSplit.' + name + '"]');
      // Radix places the form input beside its thumb, inside the same span.
      return input && input.parentElement.querySelector('[role="slider"]');
    });
    if (!radio || radio.disabled || radio.getAttribute("aria-disabled") === "true" ||
        root.querySelectorAll('[role="slider"]').length !== 3 || handles.some(function invalidHandle(handle) {
          return !handle || handle.hasAttribute("data-disabled") ||
            handle.getAttribute("aria-valuemin") === null ||
            handle.getAttribute("aria-valuenow") === null ||
            !Number.isFinite(Number(handle.getAttribute("aria-valuenow"))) ||
            Number(handle.getAttribute("aria-valuemax")) !== 100 ||
            !Number.isFinite(Number(handle.getAttribute("aria-valuemin"))) ||
            Number(handle.getAttribute("aria-valuemin")) < 0;
        })) {
      return null;
    }
    return { root: root, radio: radio, handles: handles };
  }

  function nextRender() {
    return new Promise(function waitForReact(resolve) { setTimeout(resolve, 25); });
  }

  function donationToggleLabels() {
    var labels = new Set(["Adjust Donation"]);
    // The server-rendered dictionary gives the label in the active locale.
    Array.from(document.querySelectorAll("script:not([src])")).slice(0, 200).forEach(function readDictionary(script) {
      var text = script.textContent || "";
      if (text.length > 5 * 1024 * 1024) {
        return;
      }
      var match = text.trim().match(/^self\.__next_f\.push\((\[[\s\S]*\])\);?$/);
      if (!match) {
        return;
      }
      try {
        var chunk = JSON.parse(match[1]);
        if (chunk[0] !== 1 || typeof chunk[1] !== "string") {
          return;
        }
        var title = chunk[1].match(/"paymentSplit":\{"title":("(?:[^"\\]|\\.)*")/);
        if (title) {
          labels.add(JSON.parse(title[1]));
        }
      } catch (error) { /* Wait for a complete dictionary or a user-opened panel. */ }
    });
    return labels;
  }

  async function applyModernSplit(settings) {
    var controls = modernControls();
    if (!controls) {
      var custom = document.querySelector('[data-testid="pay-split-custom"] [role="radio"]#custom');
      if (custom && !custom.disabled && custom.getAttribute("aria-disabled") !== "true" &&
          custom.getAttribute("aria-checked") !== "true") {
        // Selecting Custom mounts the sliders; validate them on the next pass.
        custom.click();
        scheduleRetry(false, 100);
        return;
      }
      // The new accordion mounts its controls only after it opens.
      var rail = document.querySelector('[data-testid="bundle-pdp-right-rail"]');
      var labels = donationToggleLabels();
      var toggle = rail && Array.from(rail.querySelectorAll('button[aria-expanded="false"]'))
        .find(function donationToggle(button) { return labels.has(button.textContent.trim()); });
      if (toggle) {
        toggle.click();
      }
      scheduleRetry(false, 350);
      return;
    }
    var minimums = controls.handles.map(function minimum(handle) { return Number(handle.getAttribute("aria-valuemin")); });
    var available = 100 - minimums.reduce(function sum(total, minimum) { return total + minimum; }, 0);
    if (available < 0) {
      return;
    }
    var targets = [settings.developer, settings.charity, settings.humble].map(function target(weight, index) {
      return minimums[index] + available * weight;
    });
    var signature = location.href + "|" + targets.join(":");
    if (modernRoot === controls.root && modernSignature === signature) {
      return;
    }
    applying = true;
    controls.root.removeAttribute(APPLIED_ATTRIBUTE);
    var url = location.href;
    try {
      if (controls.radio.getAttribute("aria-checked") !== "true") {
        controls.radio.click();
        await nextRender();
      }
      // Use the slider's supported keyboard events, allowing React to commit
      // each change and rebalance siblings before sending the next event.
      for (var step = 0; step < 120; step += 1) {
        var currentSettings = readSettings();
        var current = modernControls();
        if (location.href !== url || !currentSettings || JSON.stringify(currentSettings) !== JSON.stringify(settings) ||
            !current || current.root !== controls.root || current.radio.getAttribute("aria-checked") !== "true") {
          return;
        }
        var values = current.handles.map(function value(handle) { return Number(handle.getAttribute("aria-valuenow")); });
        if (values.every(function matched(value, index) { return Math.abs(value - targets[index]) <= 0.51; })) {
          modernRoot = current.root;
          modernSignature = signature;
          current.root.setAttribute(APPLIED_ATTRIBUTE, targets.join(":"));
          retryCount = 0;
          return;
        }
        // Set Humble's floor first, then adjust the largest remaining error.
        var index = values[2] > targets[2] + 0.51 ? 2 :
          (Math.abs(values[0] - targets[0]) >= Math.abs(values[1] - targets[1]) ? 0 : 1);
        var delta = targets[index] - values[index];
        var key = delta > 0 ? "ArrowUp" : "ArrowDown";
        if (Math.abs(delta) >= 10) {
          key = delta > 0 ? "PageUp" : "PageDown";
        }
        current.handles[index].dispatchEvent(new KeyboardEvent("keydown", { key: key, code: key, bubbles: true, cancelable: true }));
        await nextRender();
      }
    } finally {
      applying = false;
      var latestSettings = readSettings();
      if (latestSettings && (location.href !== url || !controls.root.isConnected ||
          JSON.stringify(latestSettings) !== JSON.stringify(settings))) {
        scheduleRetry(true, 80);
      }
    }
  }

  function readSettings() {
    try {
      var source = document.documentElement.getAttribute(SETTINGS_ATTRIBUTE) || "null";
      if (source.length > 2048) {
        return null;
      }
      var value = JSON.parse(source);
      if (!value || value.enabled !== true || !value.split) {
        return null;
      }
      if ([value.split.developer, value.split.charity, value.split.humble]
        .some(function nonNumericShare(share) { return typeof share !== "number"; })) {
        return null;
      }
      var developer = Number(value.split.developer);
      var charity = Number(value.split.charity);
      var humble = Number(value.split.humble);
      if (![developer, charity, humble].every(Number.isFinite) ||
          [developer, charity, humble].some(function invalidShare(share) { return share < 0 || share > 100; })) {
        return null;
      }
      var total = developer + charity + humble;
      if (Math.abs(total - 100) > 0.11) {
        return null;
      }
      return {
        developer: developer / total,
        charity: charity / total,
        humble: humble / total
      };
    } catch (error) {
      return null;
    }
  }

  function topLevelSplitViews(root) {
    var collection = Array.from(root.children).find(function findCollection(element) {
      return element.classList && element.classList.contains("splits-view");
    });
    return collection
      ? Array.from(collection.children).filter(function isSplitView(element) {
        return element.classList && element.classList.contains("split-view");
      })
      : [];
  }

  function commitSlider(view, target) {
    var slider = view.querySelector(".js-slider");
    var handle = view.querySelector("[role='slider']");
    var api = slider && slider.noUiSlider;
    if (!api || typeof api.get !== "function" || typeof api.set !== "function" || !handle) {
      return false;
    }
    var minimum = Number(handle.getAttribute("aria-valuemin"));
    var maximum = Number(handle.getAttribute("aria-valuemax"));
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum || !Number.isFinite(target)) {
      return false;
    }
    var safeTarget = Math.max(minimum, Math.min(maximum, Math.round(target)));
    if (Math.abs(Number(api.get()) - safeTarget) < 0.5) {
      return true;
    }

    // Humble updates its checkout model only for user-style slider events.
    // Position the handle through the public API, then commit one keyboard
    // step so Humble's own change listener performs all sibling balancing.
    var direction = safeTarget >= maximum ? -1 : 1;
    api.set(safeTarget - direction, false);
    handle.dispatchEvent(new KeyboardEvent("keydown", {
      key: direction > 0 ? "ArrowUp" : "ArrowDown",
      code: direction > 0 ? "ArrowUp" : "ArrowDown",
      bubbles: true,
      cancelable: true
    }));
    return true;
  }

  function isUsableSlider(view) {
    var slider = view.querySelector(".js-slider");
    var handle = view.querySelector("[role='slider']");
    var api = slider && slider.noUiSlider;
    if (!api || typeof api.get !== "function" || typeof api.set !== "function" || !handle) {
      return false;
    }
    var minimum = Number(handle.getAttribute("aria-valuemin"));
    var maximum = Number(handle.getAttribute("aria-valuemax"));
    return Number.isFinite(minimum) && Number.isFinite(maximum) && minimum >= 0 && maximum === 1000;
  }

  function amountKey() {
    var selected = document.querySelector('input[name="amount"]:checked');
    var custom = document.querySelector(".js-custom-amount");
    return String(selected ? selected.value : custom && custom.value || "unknown").slice(0, 50);
  }

  function sliderValue(view) {
    var slider = view.querySelector(".js-slider");
    var api = slider && slider.noUiSlider;
    return api && typeof api.get === "function" ? Number(api.get()) : NaN;
  }

  function targetsMatch(views, targets) {
    return views.every(function targetMatches(view, index) {
      var value = sliderValue(view);
      return Number.isFinite(value) && Math.abs(value - targets[index]) <= 1;
    });
  }

  function scheduleRetry(force, delay) {
    if (retryCount >= MAX_RETRIES) {
      return;
    }
    retryCount += 1;
    scheduleApply(force, delay);
  }

  function requestApply(force, delay) {
    retryCount = 0;
    scheduleApply(force, delay);
  }

  function applySplit(force) {
    if (applying) {
      return;
    }
    if (typeof location !== "undefined" && !/^\/(?:games|books|software)\//.test(location.pathname)) {
      return;
    }
    var settings = readSettings();
    if (!settings) {
      return;
    }

    if (document.querySelector('[data-testid="bundle-pdp-right-rail"]')) {
      applyModernSplit(settings).catch(function ignoreChangedCheckout() {});
      return;
    }

    var customOption = document.querySelector('input[name="split-allocation"][value="custom"]');
    if (!customOption) {
      scheduleRetry(force, 500);
      return;
    }
    var sliderRoot = document.querySelector(".js-split-sliders");
    var views = sliderRoot && topLevelSplitViews(sliderRoot);
    // Fail closed if Humble changes the number or order of recipients. The
    // automation is intentionally defined only for developer/charity/Humble.
    if (!sliderRoot || !views || views.length !== 3) {
      scheduleRetry(force, 350);
      return;
    }
    if (!views.every(isUsableSlider)) {
      scheduleRetry(force, 350);
      return;
    }

    var developerView = views[0];
    var charityView = views[1];
    var humbleView = views[views.length - 1];
    var humbleHandle = humbleView.querySelector("[role='slider']");
    var humbleMinimum = humbleHandle ? Number(humbleHandle.getAttribute("aria-valuemin")) : NaN;
    if (!Number.isFinite(humbleMinimum) || humbleMinimum < 0 || humbleMinimum > 1000) {
      scheduleRetry(force, 350);
      return;
    }
    if (!customOption.checked) {
      customOption.click();
    }

    var adjustable = Math.max(0, 1000 - humbleMinimum);
    var developerTarget = Math.round(adjustable * settings.developer);
    var charityTarget = Math.round(adjustable * settings.charity);
    var humbleTarget = 1000 - developerTarget - charityTarget;
    var targets = [developerTarget, charityTarget, humbleTarget];
    var signature = [developerTarget, charityTarget, humbleTarget, amountKey()].join(":");
    if (!force && sliderRoot.getAttribute(APPLIED_ATTRIBUTE) === signature && targetsMatch(views, targets)) {
      return;
    }

    applying = true;
    try {
      // Each Humble change redistributes sibling values. Repeating the three
      // constrained targets converges to the requested split within 0.1%.
      var committed = true;
      for (var pass = 0; pass < 10; pass += 1) {
        committed = commitSlider(humbleView, humbleTarget) && committed;
        committed = commitSlider(developerView, developerTarget) && committed;
        committed = commitSlider(charityView, charityTarget) && committed;
      }
      if (committed && targetsMatch(views, targets)) {
        retryCount = 0;
        sliderRoot.setAttribute(APPLIED_ATTRIBUTE, signature);
      } else {
        sliderRoot.removeAttribute(APPLIED_ATTRIBUTE);
        scheduleRetry(true, 350);
      }
    } finally {
      applying = false;
    }
  }

  function scheduleApply(force, delay) {
    clearTimeout(timer);
    timer = setTimeout(function runApply() {
      try {
        applySplit(Boolean(force));
      } catch (error) {
        scheduleRetry(Boolean(force), 500);
      }
    }, delay == null ? 120 : delay);
  }

  window.addEventListener("humble-helper-donation-settings", function onSettings() {
    requestApply(true, 0);
  });

  document.addEventListener("change", function onCheckoutChange(event) {
    if (event.target && event.target.matches && event.target.matches('input[name="amount"], .js-custom-amount')) {
      requestApply(true, 80);
    }
  }, true);

  var observer = new MutationObserver(function watchCheckout(mutations) {
    var checkoutAdded = mutations.some(function hasCheckoutNode(mutation) {
      return Array.from(mutation.addedNodes || []).some(function matchesCheckout(node) {
        return node.nodeType === Node.ELEMENT_NODE &&
          (node.matches && node.matches('.js-split-sliders, .js-splits-view, [data-testid="pay-split-custom"], [data-testid="bundle-pdp-right-rail"]') ||
            node.querySelector && node.querySelector('.js-split-sliders, .js-splits-view, [data-testid="pay-split-custom"], [data-testid="bundle-pdp-right-rail"]'));
      });
    });
    if (checkoutAdded) {
      requestApply(false, 80);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  requestApply(false, 200);
})();
