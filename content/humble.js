(function startHumbleContentScript() {
  "use strict";

  var browserApi = globalThis.browser || globalThis.chrome;
  var shared = globalThis.HumbleSteamFilterShared;
  var pageDataCache = null;
  var lastSignature = "";
  var lastAnalysis = null;
  var scanTimer = null;

  // Clean up UI created by a pre-0.1.6 content script when the add-on is
  // reloaded without a full page reload.
  var oldPanel = document.querySelector("#hsf-panel");
  if (oldPanel) {
    oldPanel.remove();
  }
  if (document.documentElement) {
    document.documentElement.classList.remove("hsf-overlays-hidden");
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function parsePageDataScript(script) {
    if (!script) {
      return null;
    }
    try {
      var source = script.textContent || "{}";
      return source.length <= 5 * 1024 * 1024 ? JSON.parse(source) : null;
    } catch (error) {
      return null;
    }
  }

  function capturePageDataFromNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    var script = node.id === "webpack-bundle-page-data"
      ? node
      : node.querySelector && node.querySelector("#webpack-bundle-page-data");
    var parsed = parsePageDataScript(script);
    if (parsed && parsed.bundleData) {
      pageDataCache = parsed;
    }
  }

  function getPageData() {
    if (pageDataCache) {
      return pageDataCache;
    }
    var script = document.querySelector("#webpack-bundle-page-data");
    pageDataCache = parsePageDataScript(script);
    return pageDataCache;
  }

  function orderedMachineNames(bundleData) {
    var tiers = bundleData.tier_display_data || {};
    var order = Array.isArray(bundleData.tier_order) ? bundleData.tier_order : Object.keys(tiers);
    var names = [];
    var seen = new Set();
    for (var tierName of order) {
      var tier = tiers[tierName] || {};
      var tierNames = Array.isArray(tier.tier_item_machine_names) ? tier.tier_item_machine_names : [];
      for (var name of tierNames) {
        if (typeof name === "string" && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
        if (names.length >= 100) {
          return names;
        }
      }
    }
    return names;
  }

  function isSteamItem(item) {
    var deliveryIcons = item && item.availability_icons && item.availability_icons.delivery_icons;
    var steamPlatforms = item && item.platforms_and_oses && item.platforms_and_oses.game && item.platforms_and_oses.game.steam;
    return (Array.isArray(deliveryIcons) && deliveryIcons.includes("hb-steam")) ||
      (Array.isArray(steamPlatforms) && steamPlatforms.length > 0);
  }

  function parseBundle() {
    var pageData = getPageData();
    var bundleData = pageData && pageData.bundleData;
    if (!bundleData || !bundleData.tier_item_data) {
      return null;
    }

    var items = orderedMachineNames(bundleData).slice(0, 100)
      .map(function mapMachineName(machineName) {
        if (typeof machineName !== "string" || machineName.length > 200) {
          return null;
        }
        var item = bundleData.tier_item_data[machineName];
        if (!item || !item.human_name || !isSteamItem(item)) {
          return null;
        }
        var type = item.item_content_type || "game";
        if (type !== "game" && type !== "dlc") {
          return null;
        }
        if (/\b(coupon|discount)\b/i.test(item.human_name)) {
          return null;
        }
        var title = normalizeText(item.human_name);
        if (!shared.normalizeTitle(title)) {
          return null;
        }
        return {
          machineName: machineName,
          title: title,
          type: type
        };
      })
      .filter(Boolean);

    if (!items.length) {
      return null;
    }
    return {
      title: normalizeText(bundleData.basic_data && bundleData.basic_data.title) || document.title,
      items: items
    };
  }

  function isVisible(element) {
    if (!element || !(element instanceof HTMLElement)) {
      return false;
    }
    var style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().width > 0;
  }

  function candidateCardForTitle(title) {
    var normalizedTitle = shared.normalizeTitle(title);
    if (!normalizedTitle) {
      return null;
    }
    var bundleCards = Array.from(document.querySelectorAll(".tier-item-view")).slice(0, 500)
      .filter(isVisible)
      .filter(function cardContainsTitle(card) {
        return Array.from(card.querySelectorAll(".item-title, .js-item-details")).slice(0, 20)
          .some(function titleNodeContainsTitle(titleNode) {
            return shared.normalizeTitle(titleNode.textContent).includes(normalizedTitle);
          });
      });
    if (bundleCards.length) {
      return bundleCards[0];
    }

    var headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading'], a")).slice(0, 2000)
      .filter(isVisible)
      .filter(function containsTitle(element) {
        var text = shared.normalizeTitle(element.textContent);
        return text === normalizedTitle || text.includes(normalizedTitle);
      });

    if (!headings.length) {
      return null;
    }

    var best = null;
    headings.forEach(function inspectHeading(heading) {
      var current = heading;
      for (var depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        var text = shared.normalizeTitle(current.textContent);
        var className = typeof current.className === "string" ? current.className.toLowerCase() : "";
        var looksLikeCard = current.matches("article, li, [data-testid], [data-entity-kind]") ||
          /(entity|product|tile|card|item|offer|content)/.test(className);
        if (looksLikeCard && text.includes(normalizedTitle) && text.length < 1200) {
          var score = text.length + depth * 80;
          if (!best || score < best.score) {
            best = { element: current, score: score };
          }
        }
      }
    });
    return best ? best.element : headings[0].parentElement;
  }

  function clearCardMark(card) {
    card.removeAttribute("data-hsf-card");
    card.classList.remove("hsf-card--owned", "hsf-card--wishlist", "hsf-card--both", "hsf-card--unmatched", "hsf-card--dim");
    card.querySelectorAll(".hsf-badge, .hsf-status, .hsf-owned-ribbon, .hsf-wishlist-ribbon").forEach(function removeStatus(status) {
      status.remove();
    });
    card.querySelectorAll(".hsf-ribbon-host").forEach(function removeRibbonHostClass(host) {
      host.classList.remove("hsf-ribbon-host");
    });
  }

  function statusLabel(state) {
    return {
      owned: "Owned",
      wishlist: "Wishlist",
      both: "Wishlist",
      unknown: "Steam unavailable",
      unmatched: "Not matched"
    }[state] || "";
  }

  function statusIcon(state) {
    return {
      owned: "✓",
      wishlist: "♡",
      both: "♡",
      unknown: "?",
      unmatched: "~"
    }[state] || "";
  }

  function createStatus(item) {
    var status = document.createElement("div");
    status.className = "hsf-status hsf-status--" + item.state;
    status.dataset.hsfMachine = item.machineName || "";
    var icon = document.createElement("span");
    var label = document.createElement("span");
    icon.className = "hsf-status__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = statusIcon(item.state);
    label.className = "hsf-status__label";
    label.textContent = statusLabel(item.state);
    status.append(icon, label);
    return status;
  }

  function createOwnedRibbon() {
    var ribbon = document.createElement("div");
    ribbon.className = "hsf-owned-ribbon";
    ribbon.setAttribute("aria-label", "Owned on Steam");
    ribbon.textContent = "Owned";
    return ribbon;
  }

  function createWishlistRibbon() {
    var ribbon = document.createElement("div");
    ribbon.className = "hsf-wishlist-ribbon";
    ribbon.setAttribute("aria-label", "Wishlisted on Steam");
    ribbon.textContent = "Wishlist";
    return ribbon;
  }

  function ribbonHostForCard(card) {
    var image = card.querySelector("img");
    if (!image || !image.parentElement) {
      return card;
    }
    var host = image.closest("picture, figure") || image.parentElement;
    if (!card.contains(host)) {
      return card;
    }
    if (host !== card) {
      host.classList.add("hsf-ribbon-host");
    }
    return host;
  }

  function findSummaryAnchor() {
    var headings = Array.from(document.querySelectorAll("h1, h2, h3, [role='heading']"))
      .filter(isVisible);
    if (headings.length) {
      return headings[0];
    }
    var firstCard = document.querySelector(".tier-item-view");
    return firstCard && firstCard.parentElement;
  }

  function renderSummary(analysis) {
    var items = analysis.items || [];
    var owned = items.filter(function countOwned(item) { return item.state === "owned" || item.state === "both"; }).length;
    var wishlisted = items.filter(function countWishlist(item) { return item.state === "wishlist" || item.state === "both"; }).length;
    var unmatched = items.filter(function countUnmatched(item) { return item.state === "unmatched"; }).length;
    var parts = ["Steam: " + owned + " owned"];
    if (wishlisted) {
      parts.push(wishlisted + " wishlisted");
    }
    if (unmatched) {
      parts.push(unmatched + " not matched");
    }
    var summaryText = parts.join("  ·  ");
    var summary = document.querySelector(".hsf-summary");
    if (!summary) {
      summary = document.createElement("div");
      summary.className = "hsf-summary";
    }
    if (summary.dataset.text !== summaryText) {
      summary.dataset.text = summaryText;
      summary.textContent = summaryText;
    }
    if (!summary.parentElement) {
      var anchor = findSummaryAnchor();
      if (anchor && anchor.parentElement) {
        if (anchor.matches("h1, h2, h3, [role='heading']")) {
          anchor.insertAdjacentElement("afterend", summary);
        } else {
          anchor.insertBefore(summary, anchor.firstChild);
        }
      }
    }
  }

  function renderMarks(bundle, analysis) {
    var settings = analysis.settings || { showWishlist: true, dimOwned: true };
    var desiredCards = new Map();
    (analysis.items || []).forEach(function renderItem(item) {
      if (item.state === "wishlist" && !settings.showWishlist) {
        return;
      }
      if (!["owned", "wishlist", "both", "unmatched"].includes(item.state)) {
        return;
      }
      var card = candidateCardForTitle(item.title);
      if (!card) {
        return;
      }
      desiredCards.set(card, item);
    });

    document.querySelectorAll("[data-hsf-card]").forEach(function removeStaleMark(card) {
      if (!desiredCards.has(card)) {
        clearCardMark(card);
      }
    });

    desiredCards.forEach(function applyMark(item, card) {
      var shouldDim = settings.dimOwned && (item.state === "owned" || item.state === "both");
      var status = card.querySelector(".hsf-status");
      var ribbon = card.querySelector(".hsf-owned-ribbon");
      var wishlistRibbon = card.querySelector(".hsf-wishlist-ribbon");
      var shouldRibbon = item.state === "owned" || item.state === "both";
      var shouldWishlistRibbon = item.state === "wishlist" || item.state === "both";
      var shouldShowStatus = item.state !== "owned";
      var ribbonHost = ribbon && ribbon.parentElement;
      var ribbonPlaced = Boolean(ribbon) && (ribbonHost === card || ribbonHost.classList.contains("hsf-ribbon-host"));
      var wishlistRibbonHost = wishlistRibbon && wishlistRibbon.parentElement;
      var wishlistRibbonPlaced = Boolean(wishlistRibbon) && (wishlistRibbonHost === card || wishlistRibbonHost.classList.contains("hsf-ribbon-host"));
      var isCurrent = card.dataset.hsfCard === item.state &&
        Boolean(status) === shouldShowStatus &&
        (!shouldShowStatus || status.dataset.hsfMachine === (item.machineName || "")) &&
        card.classList.contains("hsf-card--dim") === shouldDim &&
        ribbonPlaced === shouldRibbon &&
        wishlistRibbonPlaced === shouldWishlistRibbon;
      if (isCurrent) {
        return;
      }

      clearCardMark(card);
      card.dataset.hsfCard = item.state;
      card.classList.add("hsf-card--" + item.state);
      if (shouldDim) {
        card.classList.add("hsf-card--dim");
      }
      if (shouldRibbon) {
        ribbonHostForCard(card).appendChild(createOwnedRibbon());
      }
      if (shouldWishlistRibbon) {
        ribbonHostForCard(card).appendChild(createWishlistRibbon());
      }
      if (shouldShowStatus) {
        status = createStatus(item);
        var titleNode = card.querySelector(".item-title");
        if (titleNode && titleNode.parentElement) {
          titleNode.insertAdjacentElement("afterend", status);
        } else {
          card.appendChild(status);
        }
      }
    });
  }

  function render(bundle, analysis) {
    lastAnalysis = analysis;
    renderSummary(analysis);
    renderMarks(bundle, analysis);
  }

  function bundleSignature(bundle) {
    return location.href.slice(0, 2048) + "|" + bundle.items.map(function itemKey(item) {
      return item.machineName + ":" + item.title;
    }).join("|");
  }

  function publishDonationSettings(settings) {
    var payload = {
      enabled: Boolean(settings && settings.applyDonationSplit === true),
      split: shared.normalizeDonationSplit(settings && settings.donationSplit)
    };
    document.documentElement.setAttribute("data-humble-helper-donation-settings", JSON.stringify(payload));
    window.dispatchEvent(new Event("humble-helper-donation-settings"));
  }

  async function performScan(force) {
    var bundle = parseBundle();
    if (!bundle) {
      return;
    }
    var signature = bundleSignature(bundle);
    if (!force && signature === lastSignature && lastAnalysis) {
      render(bundle, lastAnalysis);
      return;
    }
    var analysis = await shared.sendRuntimeMessage(browserApi, {
      type: "ANALYZE_BUNDLE",
      items: bundle.items
    });
    var settings = await shared.sendRuntimeMessage(browserApi, { type: "GET_SETTINGS" });
    analysis.settings = settings;
    publishDonationSettings(settings);

    var currentPageBundle = parseBundle();
    if (!currentPageBundle || bundleSignature(currentPageBundle) !== signature) {
      scheduleScan(true);
      return;
    }

    lastSignature = signature;
    render(bundle, analysis);
  }

  var scan = shared.createAsyncCoalescer(performScan, function queueRerun(force) {
    scheduleScan(force);
  });

  function scheduleScan(force) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function runScheduledScan() {
      scan(force).catch(function scanFailed(error) {
        console.warn("Humble Helper scan failed", error);
      });
    }, 250);
  }

  function belongsToExtension(mutation) {
    if (mutation.target && mutation.target.closest && mutation.target.closest(".hsf-status, .hsf-summary, .hsf-owned-ribbon, .hsf-wishlist-ribbon")) {
      return true;
    }
    var changedNodes = Array.from(mutation.addedNodes || []).concat(Array.from(mutation.removedNodes || []));
    return changedNodes.length > 0 && changedNodes.every(function isExtensionNode(node) {
      return node.nodeType === Node.ELEMENT_NODE &&
        (node.classList.contains("hsf-status") || node.classList.contains("hsf-summary") || node.classList.contains("hsf-owned-ribbon") ||
          node.classList.contains("hsf-wishlist-ribbon") || node.classList.contains("hsf-badge") ||
          (node.closest && node.closest(".hsf-status, .hsf-summary, .hsf-owned-ribbon, .hsf-wishlist-ribbon")));
    });
  }

  var observer = new MutationObserver(function onMutation(mutations) {
    mutations.forEach(function captureMutationData(mutation) {
      capturePageDataFromNode(mutation.target);
      Array.from(mutation.addedNodes || []).forEach(capturePageDataFromNode);
    });
    if (mutations.some(function isPageMutation(mutation) { return !belongsToExtension(mutation); })) {
      scheduleScan(false);
    }
  });

  browserApi.runtime.onMessage.addListener(function onRuntimeMessage(message) {
    if (message && message.type === "STEAM_DATA_UPDATED") {
      scheduleScan(true);
    }
  });

  observer.observe(document, { childList: true, subtree: true });
  shared.sendRuntimeMessage(browserApi, { type: "GET_SETTINGS" }).then(function publishInitialSettings(settings) {
    publishDonationSettings(settings);
  }).catch(function ignoreSettingsBridgeError() {});
  scheduleScan(false);
})();
