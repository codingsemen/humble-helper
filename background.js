if (!globalThis.HumbleSteamFilterShared && typeof importScripts === "function") {
  importScripts("shared.js");
}

(function startBackground() {
  "use strict";

  var browserApi = globalThis.browser || globalThis.chrome;
  var shared = globalThis.HumbleSteamFilterShared;
  var SNAPSHOT_MAX_AGE = 6 * 60 * 60 * 1000;
  var TITLE_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  var TITLE_MISS_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
  var TITLE_ERROR_MAX_AGE = 5 * 60 * 1000;
  var TITLE_CACHE_VERSION = 7;
  var TITLE_CACHE_MAX_ENTRIES = 1000;
  var MAX_ANALYSIS_ITEMS = 100;
  var MAX_TITLE_LENGTH = 300;
  var MAX_ACCOUNT_APP_IDS = 100000;
  var REQUEST_TIMEOUT = 20 * 1000;
  var CATALOG_RESPONSE_MAX_LENGTH = 10 * 1024 * 1024;
  var LOGIN_RESPONSE_MAX_LENGTH = 2 * 1024 * 1024;
  var STEAM_JSON_MAX_LENGTH = 10 * 1024 * 1024;
  var DLC_DETAILS_CONCURRENCY = 4;
  var MANUAL_REFRESH_COOLDOWN = 60 * 1000;
  var SYNC_ALARM = "humble-steam-filter-sync";
  var BUNDLE_ALARM = "humble-helper-bundle-sync";
  var BUNDLE_CATALOG_MAX_AGE = 60 * 60 * 1000;
  var defaultSettings = {
    showWishlist: true,
    dimOwned: true,
    applyDonationSplit: true,
    donationSplit: {
      developer: 50,
      charity: 50,
      humble: 0
    }
  };
  var emptySnapshot = {
    ownedAppIds: [],
    wishlistAppIds: [],
    fetchedAt: 0,
    lastAttemptedAt: 0,
    isLoggedIn: false,
    error: null
  };
  var emptyBundleCatalog = {
    items: [],
    knownIds: [],
    newIds: [],
    fetchedAt: 0,
    lastAttemptedAt: 0,
    error: null
  };
  var emptyRefreshControl = {
    steamLastManualAt: 0,
    bundlesLastManualAt: 0
  };
  var syncPromise = null;
  var bundleSyncPromise = null;
  var titleResolutionQueue = Promise.resolve();
  var refreshControlQueue = Promise.resolve();
  var settingsUpdateQueue = Promise.resolve();

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function safeTimestamp(value) {
    var timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 5 * 60 * 1000
      ? timestamp
      : 0;
  }

  function safeError(value) {
    return typeof value === "string" && value ? value.slice(0, 500) : null;
  }

  function safeSnapshotError(value) {
    if (value === "not_logged_in") {
      return value;
    }
    return safeError(value) ? "Steam sync failed" : null;
  }

  function normalizeAppId(value) {
    var candidate = String(value == null ? "" : value).trim();
    return /^[1-9]\d{0,11}$/.test(candidate) ? candidate : "";
  }

  function uniqueAppIds(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    var ids = [];
    var seen = new Set();
    for (var value of values.slice(0, MAX_ACCOUNT_APP_IDS)) {
      var id = normalizeAppId(value);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  function safeBoolean(current, next, key, fallback) {
    if (isRecord(next) && typeof next[key] === "boolean") {
      return next[key];
    }
    if (isRecord(current) && typeof current[key] === "boolean") {
      return current[key];
    }
    return fallback;
  }

  function splitValue(current, next, key) {
    if (isRecord(next) && typeof next[key] === "number" && Number.isFinite(next[key])) {
      return next[key];
    }
    if (isRecord(current) && typeof current[key] === "number" && Number.isFinite(current[key])) {
      return current[key];
    }
    return defaultSettings.donationSplit[key];
  }

  function mergeSettings(current, next) {
    var currentSplit = isRecord(current) && isRecord(current.donationSplit) ? current.donationSplit : {};
    var nextSplit = isRecord(next) && isRecord(next.donationSplit) ? next.donationSplit : {};
    var splitKeys = ["developer", "charity", "humble"];
    if (splitKeys.some(function invalidProvidedSplitValue(key) {
      return Object.prototype.hasOwnProperty.call(nextSplit, key) &&
        (typeof nextSplit[key] !== "number" || !Number.isFinite(nextSplit[key]));
    })) {
      nextSplit = {};
    }
    return {
      showWishlist: safeBoolean(current, next, "showWishlist", defaultSettings.showWishlist),
      dimOwned: safeBoolean(current, next, "dimOwned", defaultSettings.dimOwned),
      applyDonationSplit: safeBoolean(current, next, "applyDonationSplit", defaultSettings.applyDonationSplit),
      donationSplit: shared.normalizeDonationSplit({
        developer: splitValue(currentSplit, nextSplit, "developer"),
        charity: splitValue(currentSplit, nextSplit, "charity"),
        humble: splitValue(currentSplit, nextSplit, "humble")
      })
    };
  }

  function normalizeSnapshot(value) {
    var snapshot = isRecord(value) ? value : {};
    return {
      ownedAppIds: uniqueAppIds(snapshot.ownedAppIds),
      wishlistAppIds: uniqueAppIds(snapshot.wishlistAppIds),
      fetchedAt: safeTimestamp(snapshot.fetchedAt),
      lastAttemptedAt: safeTimestamp(snapshot.lastAttemptedAt),
      isLoggedIn: snapshot.isLoggedIn === true,
      error: safeSnapshotError(snapshot.error)
    };
  }

  function boundedIds(values, maximum) {
    return shared.uniqueStrings((Array.isArray(values) ? values : []).filter(function stringId(id) {
      return typeof id === "string";
    }))
      .filter(function validId(id) { return id.length > 0 && id.length <= 200; })
      .slice(-maximum);
  }

  function normalizeBundleCatalog(value) {
    var catalog = isRecord(value) ? value : {};
    var items = (Array.isArray(catalog.items) ? catalog.items : [])
      .map(shared.sanitizeGameBundle)
      .filter(Boolean)
      .slice(0, 200);
    var currentIds = new Set(items.map(function itemId(item) { return item.id; }));
    return {
      items: items,
      knownIds: boundedIds(catalog.knownIds, 500),
      newIds: boundedIds(catalog.newIds, 200).filter(function currentId(id) { return currentIds.has(id); }),
      fetchedAt: safeTimestamp(catalog.fetchedAt),
      lastAttemptedAt: safeTimestamp(catalog.lastAttemptedAt),
      error: safeError(catalog.error) ? "Bundle refresh failed" : null
    };
  }

  function normalizeRefreshControl(value) {
    var control = isRecord(value) ? value : {};
    return {
      steamLastManualAt: safeTimestamp(control.steamLastManualAt),
      bundlesLastManualAt: safeTimestamp(control.bundlesLastManualAt)
    };
  }

  async function readState() {
    var state = await browserApi.storage.local.get({
      snapshot: emptySnapshot,
      titleCache: {},
      settings: defaultSettings,
      bundleCatalog: emptyBundleCatalog,
      refreshControl: emptyRefreshControl
    });
    return {
      snapshot: normalizeSnapshot(state.snapshot),
      titleCache: isRecord(state.titleCache) ? state.titleCache : {},
      settings: mergeSettings(null, state.settings),
      bundleCatalog: normalizeBundleCatalog(state.bundleCatalog),
      refreshControl: normalizeRefreshControl(state.refreshControl)
    };
  }

  async function saveSnapshot(snapshot) {
    await browserApi.storage.local.set({ snapshot: snapshot });
  }

  async function saveTitleCache(titleCache) {
    await browserApi.storage.local.set({ titleCache: titleCache });
  }

  async function saveSettings(settings) {
    await browserApi.storage.local.set({ settings: settings });
  }

  async function saveBundleCatalog(bundleCatalog) {
    await browserApi.storage.local.set({ bundleCatalog: bundleCatalog });
  }

  async function saveRefreshControl(refreshControl) {
    await browserApi.storage.local.set({ refreshControl: refreshControl });
  }

  async function fetchWithTimeout(url, options, consume) {
    var controller = new AbortController();
    var timeout = setTimeout(function abortSlowRequest() {
      controller.abort();
    }, REQUEST_TIMEOUT);
    try {
      var response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      return consume ? await consume(response) : response;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readBoundedText(response, maximumLength) {
    var declaredLength = response.headers && typeof response.headers.get === "function"
      ? Number(response.headers.get("content-length"))
      : NaN;
    if (Number.isFinite(declaredLength) && declaredLength > maximumLength) {
      throw new Error("Response was too large");
    }
    var text = await response.text();
    if (text.length > maximumLength) {
      throw new Error("Response was too large");
    }
    return text;
  }

  async function getJson(url, includeCredentials) {
    return fetchWithTimeout(url, {
      cache: "no-store",
      credentials: includeCredentials ? "include" : "omit",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      }
    }, async function consumeJson(response) {
      if (!response.ok) {
        throw new Error("Steam returned HTTP " + response.status);
      }
      if (typeof response.text === "function") {
        return JSON.parse(await readBoundedText(response, STEAM_JSON_MAX_LENGTH));
      }
      return response.json();
    });
  }

  function cooldownRemaining(lastManualAt) {
    if (!lastManualAt) {
      return 0;
    }
    return Math.min(MANUAL_REFRESH_COOLDOWN, Math.max(0, MANUAL_REFRESH_COOLDOWN - (Date.now() - lastManualAt)));
  }

  function claimManualRefresh(field) {
    var result = refreshControlQueue.then(async function updateRefreshControl() {
      var state = await readState();
      var remaining = cooldownRemaining(state.refreshControl[field]);
      if (remaining > 0) {
        return false;
      }
      state.refreshControl[field] = Date.now();
      await saveRefreshControl(state.refreshControl);
      return true;
    });
    refreshControlQueue = result.then(function refreshClaimFinished() {}, function refreshClaimFailed() {});
    return result;
  }

  async function detectSteamLogin(cacheBuster) {
    var loginUrl = "https://store.steampowered.com/my/?hsf_refresh=" + encodeURIComponent(cacheBuster || Date.now());
    return fetchWithTimeout(loginUrl, {
      cache: "no-store",
      credentials: "include",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      },
      redirect: "follow"
    }, async function consumeLoginPage(response) {
      if (!response.ok) {
        return false;
      }
      var html = await readBoundedText(response, LOGIN_RESPONSE_MAX_LENGTH);
      var finalPath = "";
      try {
        finalPath = new URL(response.url).pathname;
      } catch (error) {
        finalPath = "";
      }
      return /\/my\/?$/.test(finalPath) ||
        /g_steamID\s*=\s*["']\d+/.test(html) ||
        /data-miniprofile/.test(html);
    });
  }

  async function broadcastUpdate() {
    try {
      var tabs = await browserApi.tabs.query({
        url: [
          "https://*.humblebundle.com/games/*",
          "https://*.humblebundle.com/books/*",
          "https://*.humblebundle.com/software/*"
        ]
      });
      await Promise.all(tabs.map(function notifyTab(tab) {
        return browserApi.tabs.sendMessage(tab.id, { type: "STEAM_DATA_UPDATED" }).catch(function ignore() {});
      }));
    } catch (error) {
      // There may be no open Humble tabs while the background refresh runs.
    }
  }

  async function updateBundleBadge(count) {
    if (!browserApi.action || !browserApi.action.setBadgeText) {
      return;
    }
    try {
      await browserApi.action.setBadgeText({ text: count > 0 ? String(count) : "" });
      if (count > 0 && browserApi.action.setBadgeBackgroundColor) {
        await browserApi.action.setBadgeBackgroundColor({ color: "#d97745" });
      }
    } catch (error) {
      // Badge support is optional in test and older browser environments.
    }
  }

  async function refreshBundleCatalog(force) {
    if (bundleSyncPromise) {
      return bundleSyncPromise;
    }

    var bundleTask = (async function performBundleSync() {
      var state = await readState();
      var catalog = state.bundleCatalog;
      var now = Date.now();
      if (!force && catalog.fetchedAt && now - catalog.fetchedAt < BUNDLE_CATALOG_MAX_AGE) {
        await updateBundleBadge(Array.isArray(catalog.newIds) ? catalog.newIds.length : 0);
        return catalog;
      }

      try {
        var html = await fetchWithTimeout("https://www.humblebundle.com/bundles", {
          cache: "no-store",
          credentials: "omit",
          headers: { Accept: "text/html,application/xhtml+xml" }
        }, async function consumeBundleCatalog(response) {
          if (!response.ok) {
            throw new Error("Humble returned HTTP " + response.status);
          }
          return readBoundedText(response, CATALOG_RESPONSE_MAX_LENGTH);
        });
        var items = shared.extractGameBundles(html).slice(0, 200);
        if (!items.length) {
          throw new Error("Humble returned an empty game bundle catalog");
        }

        var previousKnown = new Set(Array.isArray(catalog.knownIds) ? catalog.knownIds : []);
        var previousNew = new Set(Array.isArray(catalog.newIds) ? catalog.newIds : []);
        var isFirstCatalog = previousKnown.size === 0;
        var currentIds = new Set(items.map(function bundleId(item) { return item.id; }));
        var newIds = new Set(Array.from(previousNew).filter(function remainsCurrent(id) {
          return currentIds.has(id);
        }));
        if (!isFirstCatalog) {
          items.forEach(function detectNewBundle(item) {
            if (!previousKnown.has(item.id)) {
              newIds.add(item.id);
            }
          });
        }
        items.forEach(function rememberBundle(item) {
          previousKnown.add(item.id);
        });

        state.bundleCatalog = {
          items: items,
          knownIds: Array.from(previousKnown).slice(-500),
          newIds: Array.from(newIds),
          fetchedAt: now,
          lastAttemptedAt: now,
          error: null
        };
        await saveBundleCatalog(state.bundleCatalog);
        await updateBundleBadge(newIds.size);
        return state.bundleCatalog;
      } catch (error) {
        state.bundleCatalog = Object.assign({}, catalog, {
          lastAttemptedAt: now,
          error: "Bundle refresh failed"
        });
        await saveBundleCatalog(state.bundleCatalog);
        await updateBundleBadge(Array.isArray(catalog.newIds) ? catalog.newIds.length : 0);
        return state.bundleCatalog;
      }
    })();
    bundleSyncPromise = bundleTask.finally(function clearBundleSync() {
      bundleSyncPromise = null;
    });
    return bundleSyncPromise;
  }

  async function getBundleCatalog() {
    var catalog = await refreshBundleCatalog(false);
    var state = await readState();
    var newIds = new Set(Array.isArray(catalog.newIds) ? catalog.newIds : []);
    return {
      items: (Array.isArray(catalog.items) ? catalog.items : []).map(function markNew(item) {
        return Object.assign({}, item, { isNew: newIds.has(item.id) });
      }),
      fetchedAt: catalog.fetchedAt || 0,
      error: catalog.error || null,
      newCount: newIds.size,
      refreshCooldownMs: cooldownRemaining(state.refreshControl.bundlesLastManualAt)
    };
  }

  async function refreshBundleCatalogManually() {
    if (!await claimManualRefresh("bundlesLastManualAt")) {
      return getBundleCatalog();
    }
    await refreshBundleCatalog(true);
    return getBundleCatalog();
  }

  async function markBundlesSeen() {
    if (bundleSyncPromise) {
      await bundleSyncPromise;
    }
    var state = await readState();
    state.bundleCatalog = Object.assign({}, state.bundleCatalog, { newIds: [] });
    await saveBundleCatalog(state.bundleCatalog);
    await updateBundleBadge(0);
    return getBundleCatalog();
  }

  async function syncSteamData(force) {
    if (syncPromise) {
      var activeSync = syncPromise;
      var activeSnapshot = await activeSync;
      if (!force) {
        return activeSnapshot;
      }
      // A manual refresh must not silently reuse a startup sync that began
      // before the user changed their Steam wishlist.
      return syncSteamData(true);
    }

    var syncTask = (async function performSync() {
      var state = await readState();
      var now = Date.now();
      if (!force && state.snapshot.fetchedAt && now - state.snapshot.fetchedAt < SNAPSHOT_MAX_AGE) {
        return state.snapshot;
      }

      try {
        var isLoggedIn = await detectSteamLogin(now);
        var userData = await getJson(
          "https://store.steampowered.com/dynamicstore/userdata/?hsf_refresh=" + now,
          true
        );
        if (!Array.isArray(userData.rgOwnedApps) || !Array.isArray(userData.rgWishlist)) {
          throw new Error("Steam returned an unexpected account payload");
        }

        // The /my/ page can redirect differently depending on the Steam
        // account state. A populated private account payload is the stronger
        // signal that the request carried the user's Steam session.
        var hasAccountData = userData.rgOwnedApps.length > 0 ||
          userData.rgWishlist.length > 0 ||
          (Array.isArray(userData.rgFollowedApps) && userData.rgFollowedApps.length > 0);
        if (!isLoggedIn && !hasAccountData) {
          state.snapshot = Object.assign({}, emptySnapshot, {
            lastAttemptedAt: now,
            error: "not_logged_in"
          });
          await saveSnapshot(state.snapshot);
          return state.snapshot;
        }

        state.snapshot = {
          ownedAppIds: uniqueAppIds(userData.rgOwnedApps),
          wishlistAppIds: uniqueAppIds(userData.rgWishlist),
          fetchedAt: now,
          lastAttemptedAt: now,
          isLoggedIn: true,
          error: null
        };
        await saveSnapshot(state.snapshot);
        await broadcastUpdate();
        return state.snapshot;
      } catch (error) {
        state.snapshot = Object.assign({}, state.snapshot, {
          lastAttemptedAt: now,
          error: "Steam sync failed"
        });
        await saveSnapshot(state.snapshot);
        return state.snapshot;
      }
    })();
    syncPromise = syncTask.finally(function clearSteamSync() {
      syncPromise = null;
    });
    return syncPromise;
  }

  function isFreshCacheEntry(entry) {
    if (!entry || entry.version !== TITLE_CACHE_VERSION || !entry.fetchedAt) {
      return false;
    }
    var age = Date.now() - entry.fetchedAt;
    if (entry.error) {
      return age < TITLE_ERROR_MAX_AGE;
    }
    return age < (entry.appId ? TITLE_CACHE_MAX_AGE : TITLE_MISS_MAX_AGE);
  }

  async function getSteamAppDetails(appId) {
    appId = normalizeAppId(appId);
    if (!appId) {
      return null;
    }
    var payload = await getJson("https://store.steampowered.com/api/appdetails?appids=" +
      encodeURIComponent(appId) + "&l=english");
    var result = payload && payload[String(appId)];
    return result && result.success ? result.data : null;
  }

  function noTitleMatch(score) {
    score = Number(score);
    return {
      appId: null,
      steamName: null,
      confidence: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
      fetchedAt: Date.now(),
      version: TITLE_CACHE_VERSION
    };
  }

  function titleMatch(appId, steamName, confidence) {
    appId = normalizeAppId(appId);
    if (!appId) {
      return noTitleMatch(confidence);
    }
    return {
      appId: appId,
      steamName: shared.plainText(steamName, MAX_TITLE_LENGTH) || null,
      confidence: Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : 0,
      fetchedAt: Date.now(),
      version: TITLE_CACHE_VERSION
    };
  }

  async function searchDlcFromParent(title) {
    var separator = title.match(/^(.+?)\s+[-–—]\s+.+/);
    if (!separator) {
      return null;
    }

    var parentTerm = separator[1].trim();
    var searchUrl = "https://store.steampowered.com/api/storesearch/?term=" +
      encodeURIComponent(parentTerm) + "&l=english&cc=us";
    var payload = await getJson(searchUrl);
    var parent = (Array.isArray(payload.items) ? payload.items.slice(0, 50) : [])
      .filter(function supportedParent(item) {
        return item && item.id && item.name && item.type === "app";
      })
      .map(function scoreParent(item) {
        return { item: item, score: shared.titleScore(parentTerm, item.name) };
      })
      .sort(function byScore(left, right) {
        return right.score - left.score;
      })[0];

    if (!parent || parent.score < 0.72) {
      return null;
    }

    var parentDetails = await getSteamAppDetails(parent.item.id);
    var dlcIds = parentDetails && Array.isArray(parentDetails.dlc)
      ? uniqueAppIds(parentDetails.dlc).slice(0, 50)
      : [];
    if (!dlcIds.length) {
      return null;
    }

    var dlcDetails = await shared.mapWithConcurrency(dlcIds, DLC_DETAILS_CONCURRENCY, async function readDlcDetails(appId) {
      try {
        var details = await getSteamAppDetails(appId);
        return details && details.type === "dlc" && details.name
          ? { appId: appId, name: details.name }
          : null;
      } catch (error) {
        return null;
      }
    });
    var bestDlc = dlcDetails
      .filter(Boolean)
      .map(function scoreDlc(item) {
        return { item: item, score: shared.titleScore(title, item.name) };
      })
      .sort(function byScore(left, right) {
        return right.score - left.score;
      })[0];

    return bestDlc && bestDlc.score >= 0.6
      ? titleMatch(bestDlc.item.appId, bestDlc.item.name, bestDlc.score)
      : null;
  }

  async function searchSteamTitle(title) {
    var searchTerms = [title];
    var withoutDlcSuffix = title
      .replace(/\s+(?:dlc|add[- ]?on|expansion)$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (withoutDlcSuffix && withoutDlcSuffix !== title) {
      searchTerms.push(withoutDlcSuffix);
    }
    if (/\bdlc\b/i.test(title)) {
      var withoutDlcWord = title.replace(/\bdlc\b/i, "").replace(/\s+/g, " ").trim();
      if (withoutDlcWord && !searchTerms.includes(withoutDlcWord)) {
        searchTerms.push(withoutDlcWord);
      }
      var parentTitle = title.match(/^(.+?)\s+[-–—]\s+.+/);
      if (parentTitle && parentTitle[1] && !searchTerms.includes(parentTitle[1].trim())) {
        searchTerms.push(parentTitle[1].trim());
      }
    }
    var payload = null;
    var items = [];
    for (var term of searchTerms) {
      var url = "https://store.steampowered.com/api/storesearch/?term=" +
        encodeURIComponent(term) + "&l=english&cc=us";
      payload = await getJson(url);
      if (Array.isArray(payload.items)) {
        items = items.concat(payload.items.slice(0, 50)).slice(0, 200);
      }
      if (!/\bdlc\b/i.test(title) && items.length) {
        break;
      }
    }
    var ranked = items
      .filter(function supportedItem(item) {
        return item && item.id && item.name && (item.type === "app" || item.type === "dlc");
      })
      .map(function scoreItem(item) {
        return {
          item: item,
          score: shared.titleScore(title, item.name)
        };
      })
      .sort(function byScore(left, right) {
        return right.score - left.score;
      });

    var best = ranked[0];
    var hasDlcSuffix = /\bdlc\b/i.test(title);
    if ((!best || best.score < 0.72) && hasDlcSuffix) {
      var parentDlcMatch = await searchDlcFromParent(title);
      if (parentDlcMatch) {
        return parentDlcMatch;
      }
    }
    if (!best || best.score < 0.72) {
      return noTitleMatch(best ? best.score : 0);
    }

    // Exact game-name matches do not need a second Steam request. Besides
    // being faster, this avoids rate-limiting a first-time bundle scan.
    if (best.score === 1 && !/\bdlc\b/i.test(title)) {
      return titleMatch(best.item.id, best.item.name, best.score);
    }

    var details = null;
    try {
      details = await getSteamAppDetails(best.item.id);
    } catch (error) {
      details = null;
    }

    if (details && details.type === "dlc" && details.fullgame && details.fullgame.appid) {
      var fullGameName = details.fullgame.name || "";
      if (!hasDlcSuffix && shared.titleScore(title, fullGameName) >= 0.9) {
        return titleMatch(details.fullgame.appid, fullGameName, shared.titleScore(title, fullGameName));
      }
      // Steam currently reports these search results as type "app" even
      // though appdetails correctly identifies them as DLC. Trust appdetails
      // for the type and keep the DLC id for ownership checking.
      if (hasDlcSuffix) {
        return titleMatch(best.item.id, details.name || best.item.name, best.score);
      }
      return noTitleMatch(best.score);
    }
    if (hasDlcSuffix) {
      var fallbackDlcMatch = await searchDlcFromParent(title);
      if (fallbackDlcMatch) {
        return fallbackDlcMatch;
      }
      return best.item.type === "dlc"
        ? titleMatch(best.item.id, details && details.name || best.item.name, best.score)
        : noTitleMatch(best.score);
    }
    return titleMatch(best.item.id, details && details.name || best.item.name, best.score);
  }

  function pruneTitleCache(value) {
    var entries = Object.entries(isRecord(value) ? value : {})
      .filter(function validCacheEntry(pair) {
        var key = pair[0];
        return key.length <= MAX_TITLE_LENGTH && /^[a-z0-9]+(?: [a-z0-9]+)*$/.test(key) && isRecord(pair[1]);
      })
      .sort(function newestFirst(left, right) {
        return safeTimestamp(right[1].fetchedAt) - safeTimestamp(left[1].fetchedAt);
      })
      .slice(0, TITLE_CACHE_MAX_ENTRIES);
    var cache = {};
    entries.forEach(function addCacheEntry(pair) {
      var entry = pair[1];
      cache[pair[0]] = {
        appId: normalizeAppId(entry.appId) || null,
        steamName: shared.plainText(entry.steamName, MAX_TITLE_LENGTH) || null,
        confidence: Number.isFinite(Number(entry.confidence))
          ? Math.max(0, Math.min(1, Number(entry.confidence)))
          : 0,
        fetchedAt: safeTimestamp(entry.fetchedAt),
        version: Number.isInteger(Number(entry.version)) ? Number(entry.version) : 0,
        error: safeError(entry.error)
      };
    });
    return cache;
  }

  async function resolveTitlesNow(items) {
    var state = await readState();
    var cache = pruneTitleCache(state.titleCache);
    var uniqueItems = [];
    var seen = new Set();
    (items || []).slice(0, MAX_ANALYSIS_ITEMS).forEach(function addItem(item) {
      var title = typeof (item && item.title) === "string" ? item.title.trim() : "";
      var key = shared.normalizeTitle(title);
      if (title && title.length <= MAX_TITLE_LENGTH && key && !seen.has(key)) {
        seen.add(key);
        uniqueItems.push({ title: title, key: key });
      }
    });

    var pendingItems = uniqueItems.filter(function needsResolution(item) {
      return !isFreshCacheEntry(cache[item.key]);
    });
    var nextIndex = 0;
    async function resolveNext() {
      while (nextIndex < pendingItems.length) {
        var item = pendingItems[nextIndex];
        nextIndex += 1;
        try {
          cache[item.key] = await searchSteamTitle(item.title);
        } catch (error) {
          cache[item.key] = {
            appId: null,
            steamName: null,
            confidence: 0,
            fetchedAt: Date.now(),
            version: TITLE_CACHE_VERSION,
            error: safeError(error && error.message) || "Search failed"
          };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, pendingItems.length) }, resolveNext));

    var results = uniqueItems.map(function makeResult(item) {
      return {
        title: item.title,
        key: item.key,
        match: cache[item.key]
      };
    });

    cache = pruneTitleCache(cache);
    await saveTitleCache(cache);
    return results;
  }

  function resolveTitles(items) {
    var result = titleResolutionQueue.then(function runTitleResolution() {
      return resolveTitlesNow(items);
    });
    titleResolutionQueue = result.then(function resolutionFinished() {}, function resolutionFailed() {});
    return result;
  }

  function statusForMatch(match, snapshot, ownedAppIds, wishlistAppIds) {
    if (!snapshot.isLoggedIn) {
      return "unknown";
    }
    if (!match || !match.appId) {
      return "unmatched";
    }
    var owned = ownedAppIds.has(String(match.appId));
    var wishlisted = wishlistAppIds.has(String(match.appId));
    if (owned && wishlisted) {
      return "both";
    }
    if (owned) {
      return "owned";
    }
    if (wishlisted) {
      return "wishlist";
    }
    return "available";
  }

  function publicTitleMatch(match) {
    if (!match) {
      return null;
    }
    return {
      appId: normalizeAppId(match.appId) || null,
      steamName: shared.plainText(match.steamName, MAX_TITLE_LENGTH) || null,
      confidence: Number.isFinite(Number(match.confidence))
        ? Math.max(0, Math.min(1, Number(match.confidence)))
        : 0
    };
  }

  function sanitizeAnalysisItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items.slice(0, MAX_ANALYSIS_ITEMS).map(function sanitizeItem(item) {
      if (!isRecord(item) || typeof item.title !== "string") {
        return null;
      }
      var title = item.title.replace(/\s+/g, " ").trim();
      if (!title || title.length > MAX_TITLE_LENGTH || !shared.normalizeTitle(title)) {
        return null;
      }
      return {
        title: title,
        machineName: typeof item.machineName === "string" ? item.machineName.slice(0, 200) : "",
        type: item.type === "dlc" ? "dlc" : "game"
      };
    }).filter(Boolean);
  }

  async function analyzeBundle(items) {
    items = sanitizeAnalysisItems(items);
    var snapshot = await syncSteamData(false);
    var resolved = snapshot.isLoggedIn ? await resolveTitles(items) : [];
    var resolutionsByKey = new Map(resolved.map(function indexResolution(resolution) {
      return [resolution.key, resolution.match];
    }));
    var ownedAppIds = new Set(snapshot.ownedAppIds || []);
    var wishlistAppIds = new Set(snapshot.wishlistAppIds || []);
    return {
      snapshot: {
        fetchedAt: snapshot.fetchedAt,
        isLoggedIn: snapshot.isLoggedIn,
        error: snapshot.error
      },
      items: items.map(function mapItem(item) {
        var title = item.title;
        var key = shared.normalizeTitle(title);
        var match = resolutionsByKey.get(key) || null;
        return {
          title: item.title,
          machineName: item.machineName,
          type: item.type,
          match: publicTitleMatch(match),
          state: statusForMatch(match, snapshot, ownedAppIds, wishlistAppIds)
        };
      })
    };
  }

  async function getStatus() {
    // The install/startup listener begins the initial Steam sync in the
    // background. If the popup opens while that request is still in flight,
    // reading storage immediately would briefly render the empty snapshot.
    // Wait for the active sync so the first status response reflects the
    // account data that is being fetched.
    if (syncPromise) {
      await syncPromise;
    }
    var state = await readState();
    var cacheEntries = Object.values(pruneTitleCache(state.titleCache));
    return {
      snapshot: {
        fetchedAt: state.snapshot.fetchedAt,
        lastAttemptedAt: state.snapshot.lastAttemptedAt,
        isLoggedIn: state.snapshot.isLoggedIn,
        error: state.snapshot.error
      },
      ownedCount: state.snapshot.ownedAppIds.length,
      wishlistCount: state.snapshot.wishlistAppIds.length,
      titleCacheCount: cacheEntries.length,
      matchedTitleCount: cacheEntries.filter(function hasAppId(entry) { return Boolean(entry.appId); }).length,
      refreshCooldownMs: cooldownRemaining(state.refreshControl.steamLastManualAt)
    };
  }

  async function getSettings() {
    return (await readState()).settings;
  }

  async function refreshSteamDataManually() {
    if (!await claimManualRefresh("steamLastManualAt")) {
      return getStatus();
    }
    await syncSteamData(true);
    return getStatus();
  }

  function updateSettings(nextSettings) {
    var result = settingsUpdateQueue.then(async function applySettingsUpdate() {
      var state = await readState();
      state.settings = mergeSettings(state.settings, nextSettings);
      await saveSettings(state.settings);
      await broadcastUpdate();
      return state.settings;
    });
    settingsUpdateQueue = result.then(function settingsUpdateFinished() {}, function settingsUpdateFailed() {});
    return result;
  }

  function configureAlarms() {
    browserApi.alarms.create(SYNC_ALARM, { periodInMinutes: 360 });
    browserApi.alarms.create(BUNDLE_ALARM, { periodInMinutes: 60 });
  }

  function runBackgroundTask(label, task) {
    task.catch(function backgroundTaskFailed(error) {
      console.warn("Humble Helper " + label + " failed", error);
    });
  }

  function isOwnExtensionSender(sender) {
    return Boolean(sender) && sender.id === browserApi.runtime.id;
  }

  function isExtensionPageSender(sender) {
    if (!isOwnExtensionSender(sender) || typeof sender.url !== "string") {
      return false;
    }
    var senderUrl = sender.url.split(/[?#]/, 1)[0];
    return senderUrl === browserApi.runtime.getURL("popup.html") ||
      senderUrl === browserApi.runtime.getURL("options.html");
  }

  function isHumbleBundlePageSender(sender) {
    if (!isOwnExtensionSender(sender) || !sender.tab) {
      return false;
    }
    var value = sender.url || sender.tab.url;
    try {
      var url = new URL(value);
      return url.protocol === "https:" && shared.isHumbleBundleHostname(url.hostname) &&
        /^\/(?:games|books|software)\//.test(url.pathname);
    } catch (error) {
      return false;
    }
  }

  browserApi.runtime.onInstalled.addListener(function onInstalled() {
    configureAlarms();
    runBackgroundTask("Steam sync", syncSteamData(false));
    runBackgroundTask("bundle sync", refreshBundleCatalog(true));
  });

  browserApi.runtime.onStartup.addListener(function onStartup() {
    configureAlarms();
    runBackgroundTask("Steam sync", syncSteamData(false));
    runBackgroundTask("bundle sync", refreshBundleCatalog(true));
  });

  browserApi.alarms.onAlarm.addListener(function onAlarm(alarm) {
    if (alarm.name === SYNC_ALARM) {
      runBackgroundTask("Steam sync", syncSteamData(false));
    }
    if (alarm.name === BUNDLE_ALARM) {
      runBackgroundTask("bundle sync", refreshBundleCatalog(true));
    }
  });

  function handleRuntimeMessage(message, sender) {
    if (!isOwnExtensionSender(sender) || !message || typeof message.type !== "string") {
      return undefined;
    }
    if (message.type === "GET_SETTINGS" && (isExtensionPageSender(sender) || isHumbleBundlePageSender(sender))) {
      return getSettings();
    }
    if (message.type === "ANALYZE_BUNDLE" && isHumbleBundlePageSender(sender)) {
      return analyzeBundle(message.items);
    }
    if (!isExtensionPageSender(sender)) {
      return undefined;
    }
    if (message.type === "GET_STATUS") {
      return getStatus();
    }
    if (message.type === "REFRESH_DATA") {
      return refreshSteamDataManually();
    }
    if (message.type === "SET_SETTINGS") {
      return updateSettings(message.settings);
    }
    if (message.type === "GET_BUNDLES") {
      return getBundleCatalog();
    }
    if (message.type === "REFRESH_BUNDLES") {
      return refreshBundleCatalogManually();
    }
    if (message.type === "MARK_BUNDLES_SEEN") {
      return markBundlesSeen();
    }
    return undefined;
  }

  browserApi.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
    var response = handleRuntimeMessage(message, sender);
    if (!response || typeof response.then !== "function") {
      return undefined;
    }
    response.then(sendResponse, function requestFailed(error) {
      console.warn("Humble Helper message failed", error);
      sendResponse({ __humbleHelperError: "Background request failed" });
    });
    // Promise responses are unavailable before Chrome 148. Keeping the
    // channel open and calling sendResponse works in both Chrome and Firefox.
    return true;
  });

  configureAlarms();
})();
