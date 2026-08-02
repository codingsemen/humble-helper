(function startHumbleDonationDefaults() {
  "use strict";

  var SETTINGS_ATTRIBUTE = "data-humble-helper-donation-settings";
  var APPLIED_ATTRIBUTE = "data-humble-helper-applied-split";
  var MAX_RETRIES = 20;
  var timer = null;
  var applying = false;
  var retryCount = 0;

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
    var settings = readSettings();
    if (!settings) {
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
          (node.matches && node.matches(".js-split-sliders, .js-splits-view") ||
            node.querySelector && node.querySelector(".js-split-sliders, .js-splits-view"));
      });
    });
    if (checkoutAdded) {
      requestApply(false, 80);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  requestApply(false, 200);
})();
