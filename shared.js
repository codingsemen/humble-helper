(function attachShared(root) {
  "use strict";

  var HUMBLE_ORIGIN = "https://www.humblebundle.com";
  var BUNDLE_IMAGE_HOSTS = new Set([
    "hb.imgix.net",
    "humblebundle-a.akamaihd.net"
  ]);

  function boundedString(value, maximumLength) {
    if (typeof value !== "string") {
      return "";
    }
    return value.slice(0, maximumLength * 4)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maximumLength);
  }

  function normalizeTitle(value) {
    return String(value || "").slice(0, 1000)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("en-US")
      .replace(/&/g, " and ")
      .replace(/tm(?=[^a-z0-9]|$)/g, " ")
      .replace(/\s+(tm|r|c)\b/g, " ")
      .replace(/\btmnt\b/g, "teenage mutant ninja turtles")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function titleTokens(value) {
    return normalizeTitle(value)
      .split(" ")
      .filter(function filterToken(token) {
        return token.length > 1;
      });
  }

  function titleScore(query, candidate) {
    var left = normalizeTitle(query);
    var right = normalizeTitle(candidate);
    if (!left || !right) {
      return 0;
    }
    if (left === right) {
      return 1;
    }

    var leftTokens = titleTokens(left);
    var rightTokens = titleTokens(right);
    var rightSet = new Set(rightTokens);
    var overlap = leftTokens.filter(function hasToken(token) {
      return rightSet.has(token);
    }).length;
    var tokenScore = overlap / Math.max(leftTokens.length, rightTokens.length, 1);
    var substringScore = right.indexOf(left) === 0 || left.indexOf(right) === 0 ? 0.88 : 0;
    return Math.max(tokenScore, substringScore);
  }

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).map(String).filter(Boolean)));
  }

  function extractLandingPageData(html) {
    var match = String(html || "").match(/<script\b[^>]*\bid=["']landingPage-json-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match || !match[1]) {
      throw new Error("Humble bundle catalog was not found");
    }
    return JSON.parse(match[1].trim());
  }

  function plainText(value, maximumLength) {
    var limit = Number.isInteger(maximumLength) && maximumLength > 0 ? maximumLength : null;
    var input = String(value || "");
    if (limit) {
      input = input.slice(0, limit * 4);
    }
    var result = input
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
    return limit ? result.slice(0, limit) : result;
  }

  function isHumbleBundleHostname(value) {
    if (typeof value !== "string" || !value) {
      return false;
    }
    var hostname = value.toLocaleLowerCase("en-US");
    return hostname === "humblebundle.com" || hostname.endsWith(".humblebundle.com");
  }

  function safeHumbleBundleUrl(value) {
    if (typeof value !== "string" || !value || value.length > 2048) {
      return "";
    }
    try {
      var url = new URL(value, HUMBLE_ORIGIN);
      if (url.protocol !== "https:" || !isHumbleBundleHostname(url.hostname) || url.port ||
        !url.pathname.startsWith("/games/") || url.username || url.password) {
        return "";
      }
      url.hash = "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function safeBundleImageUrl(value) {
    if (typeof value !== "string" || !value || value.length > 2048) {
      return "";
    }
    try {
      var url = new URL(value);
      var hostname = url.hostname.toLocaleLowerCase("en-US");
      if (url.protocol !== "https:" || url.username || url.password || !BUNDLE_IMAGE_HOSTS.has(hostname)) {
        return "";
      }
      url.hash = "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function safeDateString(value) {
    var candidate = boundedString(value, 64);
    if (!candidate) {
      return null;
    }
    var normalized = /(?:Z|[+-]\d\d:?\d\d)$/.test(candidate) ? candidate : candidate + "Z";
    return Number.isNaN(new Date(normalized).getTime()) ? null : candidate;
  }

  function sanitizeGameBundle(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    var url = safeHumbleBundleUrl(value.url || value.product_url);
    var id = boundedString(value.id || value.machine_name || (url && new URL(url).pathname), 200);
    if (!url || !id) {
      return null;
    }
    var allowedTags = new Set([
      "Action", "Adventure", "Casual", "Co-op", "Games", "Horror",
      "Indie", "RPG", "Simulation", "Sports", "Strategy"
    ]);
    var tags = Array.isArray(value.tags)
      ? value.tags.filter(function allowedTag(tag) { return allowedTags.has(tag); }).slice(0, 3)
      : [];
    var itemCount = Number(value.itemCount);
    return {
      id: id,
      name: plainText(value.name || "Humble game bundle", 200) || "Humble game bundle",
      url: url,
      image: safeBundleImageUrl(value.image),
      blurb: plainText(value.blurb, 500),
      category: "Games",
      tags: tags.length ? tags : ["Games"],
      itemCount: Number.isSafeInteger(itemCount) && itemCount > 0 && itemCount <= 10000 ? itemCount : null,
      startsAt: safeDateString(value.startsAt),
      endsAt: safeDateString(value.endsAt)
    };
  }

  function inferBundleTags(product) {
    var text = plainText([
      product && product.tile_name,
      product && product.tile_short_name,
      product && product.short_marketing_blurb,
      product && product.marketing_blurb
    ].filter(Boolean).join(" "), 1000).toLocaleLowerCase("en-US");
    var rules = [
      ["Co-op", /\bco[ -]?op\b|\bmultiplayer\b|\bparty\b|\bsquad\b/],
      ["Strategy", /\bstrategy\b|\btactical\b|\b4x\b/],
      ["RPG", /\brpg\b|role[ -]?playing|dungeons?|fantasy/],
      ["Horror", /\bhorror\b|liminal|survival horror/],
      ["Simulation", /\bsimulation\b|\bsimulator\b|management/],
      ["Adventure", /\badventure\b|point[ -]?(?:and|&)[ -]?click/],
      ["Action", /\baction\b|combat|difficult|rage[ -]?inducing/],
      ["Casual", /\bcasual\b|\bidle(?:rs)?\b|desktop companions?/],
      ["Indie", /\bindie\b/],
      ["Sports", /\bsports?\b|racing/]
    ];
    var tags = rules.filter(function matchesRule(rule) {
      return rule[1].test(text);
    }).map(function labelForRule(rule) {
      return rule[0];
    });
    return tags.length ? tags.slice(0, 3) : ["Games"];
  }

  function parseItemCount(product) {
    var highlights = []
      .concat(product && product.hover_highlights || [])
      .concat(product && product.highlights || []);
    for (var highlight of highlights) {
      var match = plainText(highlight, 100).match(/(\d[\d,]*)\s+(?:items?|games?)/i);
      if (match) {
        var count = Number(match[1].replace(/,/g, ""));
        return Number.isSafeInteger(count) && count > 0 && count <= 10000 ? count : null;
      }
    }
    return null;
  }

  function extractGameBundles(html) {
    var payload = extractLandingPageData(html);
    var sections = payload && payload.data && payload.data.games && payload.data.games.mosaic;
    var products = Array.isArray(sections)
      ? sections.flatMap(function productsForSection(section) {
        return Array.isArray(section && section.products) ? section.products : [];
      })
      : [];
    var seen = new Set();
    return products.slice(0, 500).filter(function isGameBundle(product) {
      return product && Boolean(safeHumbleBundleUrl(product.product_url));
    }).map(function mapBundle(product) {
      var url = safeHumbleBundleUrl(product.product_url);
      var id = boundedString(product.machine_name || new URL(url).pathname, 200);
      if (!id || seen.has(id)) {
        return null;
      }
      seen.add(id);
      return sanitizeGameBundle({
        id: id,
        name: plainText(product.tile_short_name || product.tile_name || "Humble game bundle", 200),
        url: url,
        image: safeBundleImageUrl(product.tile_image) || safeBundleImageUrl(product.high_res_tile_image),
        blurb: plainText(product.short_marketing_blurb || product.marketing_blurb || "", 500),
        category: "Games",
        tags: inferBundleTags(product),
        itemCount: parseItemCount(product),
        startsAt: product["start_date|datetime"] || null,
        endsAt: product["end_date|datetime"] || null
      });
    }).filter(Boolean);
  }

  async function mapWithConcurrency(values, maximumConcurrency, mapper) {
    var items = Array.from(values || []);
    var results = new Array(items.length);
    var nextIndex = 0;
    var workerCount = Math.min(
      items.length,
      Math.max(1, Number.isInteger(maximumConcurrency) ? maximumConcurrency : 1)
    );

    async function mapNext() {
      while (nextIndex < items.length) {
        var index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, mapNext));
    return results;
  }

  function sendRuntimeMessage(browserApi, message) {
    return new Promise(function waitForRuntimeResponse(resolve, reject) {
      var settled = false;

      function settleResolve(response) {
        if (settled) {
          return;
        }
        settled = true;
        if (response && response.__humbleHelperError) {
          reject(new Error(response.__humbleHelperError));
          return;
        }
        resolve(response);
      }

      function settleReject(error) {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      }

      function onResponse(response) {
        var runtimeError = browserApi.runtime && browserApi.runtime.lastError;
        if (runtimeError) {
          settleReject(new Error(runtimeError.message || "Runtime message failed"));
          return;
        }
        settleResolve(response);
      }

      var result;
      try {
        // Passing a callback keeps this compatible with Chrome versions where
        // runtime.sendMessage does not yet return a Promise. Browsers that do
        // return a Promise are handled below; the settled guard prevents a
        // duplicate callback/Promise completion from resolving twice.
        result = browserApi.runtime.sendMessage(message, onResponse);
      } catch (error) {
        settleReject(error);
        return;
      }

      if (result && typeof result.then === "function") {
        result.then(onResponse, settleReject);
      }
    });
  }

  function normalizeDonationSplit(value) {
    var fallback = { developer: 50, charity: 50, humble: 0 };
    var candidate = value || {};
    var developer = Number(candidate.developer);
    var charity = Number(candidate.charity);
    var humble = Number(candidate.humble);
    if (![developer, charity, humble].every(Number.isFinite) ||
        [developer, charity, humble].some(function outsideRange(amount) { return amount < 0 || amount > 100; })) {
      return fallback;
    }
    var total = developer + charity + humble;
    if (total <= 0) {
      return fallback;
    }
    var rawUnits = [developer, charity, humble].map(function proportionalUnits(amount) {
      return amount / total * 1000;
    });
    var units = rawUnits.map(Math.floor);
    var remainingUnits = 1000 - units.reduce(function addUnits(sum, amount) { return sum + amount; }, 0);
    var remainderOrder = [0, 1, 2].sort(function largestRemainder(left, right) {
      return (rawUnits[right] - units[right]) - (rawUnits[left] - units[left]) || left - right;
    });
    for (var index = 0; index < remainingUnits; index += 1) {
      units[remainderOrder[index % remainderOrder.length]] += 1;
    }
    return {
      developer: units[0] / 10,
      charity: units[1] / 10,
      humble: units[2] / 10
    };
  }

  function formatAge(timestamp) {
    if (!timestamp) {
      return "Never";
    }
    var seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) {
      return "Just now";
    }
    if (seconds < 3600) {
      return Math.floor(seconds / 60) + "m ago";
    }
    if (seconds < 86400) {
      return Math.floor(seconds / 3600) + "h ago";
    }
    return Math.floor(seconds / 86400) + "d ago";
  }

  function createAsyncCoalescer(run, scheduleRerun) {
    var inFlight = false;
    var rerunQueued = false;
    var forceRerun = false;

    return async function requestRun(force) {
      if (inFlight) {
        rerunQueued = true;
        forceRerun = forceRerun || Boolean(force);
        return;
      }

      inFlight = true;
      try {
        await run(Boolean(force));
      } finally {
        inFlight = false;
        if (rerunQueued) {
          var nextForce = forceRerun;
          rerunQueued = false;
          forceRerun = false;
          scheduleRerun(nextForce);
        }
      }
    };
  }

  root.HumbleSteamFilterShared = {
    createAsyncCoalescer: createAsyncCoalescer,
    extractGameBundles: extractGameBundles,
    extractLandingPageData: extractLandingPageData,
    formatAge: formatAge,
    inferBundleTags: inferBundleTags,
    isHumbleBundleHostname: isHumbleBundleHostname,
    mapWithConcurrency: mapWithConcurrency,
    normalizeTitle: normalizeTitle,
    normalizeDonationSplit: normalizeDonationSplit,
    plainText: plainText,
    safeBundleImageUrl: safeBundleImageUrl,
    safeHumbleBundleUrl: safeHumbleBundleUrl,
    sanitizeGameBundle: sanitizeGameBundle,
    sendRuntimeMessage: sendRuntimeMessage,
    titleScore: titleScore,
    titleTokens: titleTokens,
    uniqueStrings: uniqueStrings
  };
})(globalThis);
