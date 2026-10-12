(function startPopup() {
  "use strict";

  var browserApi = globalThis.browser || globalThis.chrome;
  var shared = globalThis.HumbleSteamFilterShared;
  var bundleRequestGeneration = 0;
  var steamRequestGeneration = 0;
  var elements = {
    bundleList: document.querySelector("#bundle-list"),
    bundleStatus: document.querySelector("#bundle-status"),
    bundleRefresh: document.querySelector("#bundle-refresh"),
    steamCard: document.querySelector("#steam-card"),
    steamDetail: document.querySelector("#steam-detail"),
    steamRefresh: document.querySelector("#steam-refresh"),
    ownedCount: document.querySelector("#owned-count"),
    wishlistCount: document.querySelector("#wishlist-count"),
    cacheCount: document.querySelector("#cache-count")
  };

  function openUrl(url) {
    return browserApi.tabs.create({ url: url });
  }

  function applyRefreshCooldown(button, cooldownMs) {
    if (button.hsfCooldownTimer) {
      clearTimeout(button.hsfCooldownTimer);
      button.hsfCooldownTimer = null;
    }
    var remaining = Math.max(0, Number(cooldownMs) || 0);
    if (!remaining) {
      button.disabled = false;
      button.textContent = "Refresh";
      return;
    }
    var unlockAt = Date.now() + remaining;
    function updateCooldown() {
      var seconds = Math.ceil(Math.max(0, unlockAt - Date.now()) / 1000);
      if (!seconds) {
        button.disabled = false;
        button.textContent = "Refresh";
        button.hsfCooldownTimer = null;
        return;
      }
      button.disabled = true;
      button.textContent = "Wait " + seconds + "s";
      button.hsfCooldownTimer = setTimeout(updateCooldown, 1000);
    }
    updateCooldown();
  }

  function formatEnding(value) {
    if (!value) {
      return "Limited time";
    }
    var normalized = /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : value + "Z";
    var date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      return "Limited time";
    }
    var days = Math.ceil((date.getTime() - Date.now()) / 86400000);
    if (days <= 0) {
      return "Ending soon";
    }
    if (days === 1) {
      return "Ends tomorrow";
    }
    if (days <= 7) {
      return "Ends in " + days + " days";
    }
    return "Ends " + date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function tag(text, className) {
    var element = document.createElement("span");
    element.className = "tag" + (className ? " " + className : "");
    element.textContent = text;
    return element;
  }

  function detail(text) {
    var element = document.createElement("span");
    element.className = "bundle-detail";
    element.textContent = text;
    return element;
  }

  function createBundleCard(bundle) {
    var card = document.createElement("a");
    var imageFrame = document.createElement("span");
    var image = document.createElement("img");
    var body = document.createElement("span");
    var title = document.createElement("span");
    var meta = document.createElement("span");

    var bundleUrl = shared.safeHumbleBundleUrl(bundle.url);
    var imageUrl = shared.safeBundleImageUrl(bundle.image);
    card.className = "bundle-card";
    card.href = bundleUrl;
    card.addEventListener("click", function openBundle(event) {
      event.preventDefault();
      openUrl(bundleUrl);
    });
    imageFrame.className = "bundle-card__image";
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    if (imageUrl) {
      image.src = imageUrl;
    } else {
      image.hidden = true;
    }
    image.addEventListener("error", function hideBrokenImage() { image.hidden = true; });
    imageFrame.appendChild(image);
    body.className = "bundle-card__body";
    title.className = "bundle-card__title";
    title.textContent = bundle.name;
    meta.className = "bundle-card__meta";
    if (bundle.isNew) {
      meta.appendChild(tag("New", "new-tag"));
    }
    (bundle.tags || [bundle.category || "Games"]).slice(0, 2).forEach(function addTag(value) {
      meta.appendChild(tag(value));
    });
    if (bundle.itemCount) {
      meta.appendChild(detail(bundle.itemCount + " items"));
    }
    meta.appendChild(detail(formatEnding(bundle.endsAt)));
    body.append(title, meta);
    card.append(imageFrame, body);
    return card;
  }

  function renderBundles(catalog) {
    var items = (Array.isArray(catalog.items) ? catalog.items : []).map(function sanitizeBundle(bundle) {
      var safeBundle = shared.sanitizeGameBundle(bundle);
      return safeBundle ? Object.assign(safeBundle, { isNew: bundle.isNew === true }) : null;
    }).filter(Boolean).slice(0, 200);
    items.sort(function newThenEnding(left, right) {
      if (Boolean(left.isNew) !== Boolean(right.isNew)) {
        return left.isNew ? -1 : 1;
      }
      return String(left.endsAt || "").localeCompare(String(right.endsAt || ""));
    });
    elements.bundleList.replaceChildren();
    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = catalog.error
        ? "The bundle list could not be refreshed. Your previous list will remain available after the next successful check."
        : "No active game bundles were found.";
      elements.bundleList.appendChild(empty);
    } else {
      items.forEach(function addBundle(bundle) {
        elements.bundleList.appendChild(createBundleCard(bundle));
      });
    }
    var prefix = catalog.newCount ? catalog.newCount + " new · " : "";
    elements.bundleStatus.textContent = prefix + items.length + " active · updated " + shared.formatAge(catalog.fetchedAt).toLocaleLowerCase();
    if (catalog.error) {
      elements.bundleStatus.textContent += " · refresh issue";
    }
    if (catalog.newCount) {
      shared.sendRuntimeMessage(browserApi, { type: "MARK_BUNDLES_SEEN" }).catch(function ignore() {});
    }
    applyRefreshCooldown(elements.bundleRefresh, catalog.refreshCooldownMs);
  }

  function renderSteam(status) {
    status = status || {};
    var snapshot = status.snapshot || {};
    var hasSavedSnapshot = Number.isFinite(snapshot.fetchedAt) && snapshot.fetchedAt > 0;
    var owned = Number.isSafeInteger(status.ownedCount) ? status.ownedCount : null;
    var wishlist = Number.isSafeInteger(status.wishlistCount) ? status.wishlistCount : null;
    var matched = Number.isSafeInteger(status.matchedTitleCount) ? status.matchedTitleCount : null;
    elements.ownedCount.textContent = hasSavedSnapshot && owned !== null ? owned.toLocaleString() : "—";
    elements.wishlistCount.textContent = hasSavedSnapshot && wishlist !== null ? wishlist.toLocaleString() : "—";
    elements.cacheCount.textContent = matched !== null ? matched.toLocaleString() : "—";
    elements.steamCard.classList.toggle("is-ready", Boolean(snapshot.isLoggedIn && !snapshot.error));
    if (snapshot.isLoggedIn && !snapshot.error) {
      elements.steamDetail.textContent = "Connected · updated " + shared.formatAge(snapshot.fetchedAt).toLocaleLowerCase() + ".";
    } else if (hasSavedSnapshot && snapshot.error === "empty_snapshot_unconfirmed") {
      elements.steamDetail.textContent = "Using saved snapshot from " + shared.formatAge(snapshot.fetchedAt).toLocaleLowerCase() +
        ". Steam returned an empty library; refresh again after the cooldown to confirm.";
    } else if (hasSavedSnapshot && snapshot.error === "not_logged_in") {
      elements.steamDetail.textContent = "Using saved snapshot from " + shared.formatAge(snapshot.fetchedAt).toLocaleLowerCase() +
        ". Sign in to Steam in this browser, then refresh.";
    } else if (hasSavedSnapshot && snapshot.error) {
      elements.steamDetail.textContent = "Using saved snapshot from " + shared.formatAge(snapshot.fetchedAt).toLocaleLowerCase() +
        ". The latest Steam refresh failed.";
    } else if (snapshot.error === "empty_snapshot_unconfirmed") {
      elements.steamDetail.textContent = "Steam returned an empty library, but it could not be confirmed. Refresh again after the cooldown.";
    } else if (snapshot.error === "not_logged_in") {
      elements.steamDetail.textContent = "Sign in to Steam in this browser, then refresh the snapshot.";
    } else if (snapshot.error) {
      var checkedAt = snapshot.lastAttemptedAt ? " Checked " + shared.formatAge(snapshot.lastAttemptedAt).toLocaleLowerCase() + "." : "";
      elements.steamDetail.textContent = "Steam refresh failed: " + snapshot.error + "." + checkedAt;
    } else {
      elements.steamDetail.textContent = snapshot.error || "Steam data is not available yet.";
    }
    applyRefreshCooldown(elements.steamRefresh, status.refreshCooldownMs);
  }

  async function requestBundles(messageType, showLoading) {
    var requestGeneration = ++bundleRequestGeneration;
    if (showLoading) {
      elements.bundleRefresh.disabled = true;
      elements.bundleStatus.textContent = "Refreshing Humble…";
    }
    try {
      var catalog = await shared.sendRuntimeMessage(browserApi, { type: messageType });
      if (requestGeneration === bundleRequestGeneration) {
        renderBundles(catalog);
      }
    } catch (error) {
      if (requestGeneration === bundleRequestGeneration) {
        elements.bundleStatus.textContent = messageType === "GET_BUNDLES"
          ? "The extension is still starting. Reopen this panel to try again."
          : "Humble refresh failed: " + (error && error.message || "message unavailable") + ".";
        applyRefreshCooldown(elements.bundleRefresh, 0);
      }
    }
  }

  async function requestSteam(messageType, showLoading) {
    var requestGeneration = ++steamRequestGeneration;
    if (showLoading) {
      elements.steamRefresh.disabled = true;
      elements.steamDetail.textContent = "Refreshing your Steam snapshot…";
    }
    try {
      var status = await shared.sendRuntimeMessage(browserApi, { type: messageType });
      if (requestGeneration === steamRequestGeneration) {
        renderSteam(status);
      }
    } catch (error) {
      if (requestGeneration === steamRequestGeneration) {
        elements.steamCard.classList.remove("is-ready");
        elements.steamDetail.textContent = messageType === "GET_STATUS"
          ? "Steam snapshot unavailable."
          : "Steam refresh failed: " + (error && error.message || "message unavailable") + ".";
        applyRefreshCooldown(elements.steamRefresh, 0);
      }
    }
  }

  elements.bundleRefresh.addEventListener("click", function refreshBundles() {
    return requestBundles("REFRESH_BUNDLES", true);
  });

  elements.steamRefresh.addEventListener("click", function refreshSteam() {
    return requestSteam("REFRESH_DATA", true);
  });

  function openSettings() {
    if (browserApi.runtime.openOptionsPage) {
      browserApi.runtime.openOptionsPage();
    } else {
      openUrl(browserApi.runtime.getURL("options.html"));
    }
  }
  document.querySelector("#settings-button").addEventListener("click", openSettings);
  document.querySelector("#footer-settings").addEventListener("click", openSettings);
  document.querySelector("#all-bundles-button").addEventListener("click", function openAllBundles() {
    openUrl("https://www.humblebundle.com/bundles");
  });
  document.querySelectorAll("[data-open]").forEach(function addSteamLink(button) {
    button.addEventListener("click", function openSteamPage() {
      openUrl(button.dataset.open === "wishlist"
        ? "https://store.steampowered.com/wishlist/"
        : "https://store.steampowered.com/my/games/");
    });
  });

  requestBundles("GET_BUNDLES", false);
  requestSteam("GET_STATUS", false);
})();
