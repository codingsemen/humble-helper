(function startOptions() {
  "use strict";

  var browserApi = globalThis.browser || globalThis.chrome;
  var shared = globalThis.HumbleSteamFilterShared;
  var elements = {
    applySplit: document.querySelector("#apply-split"),
    developer: document.querySelector("#developer-share"),
    charity: document.querySelector("#charity-share"),
    humble: document.querySelector("#humble-share"),
    developerBar: document.querySelector("#developer-bar"),
    charityBar: document.querySelector("#charity-bar"),
    humbleBar: document.querySelector("#humble-bar"),
    total: document.querySelector("#allocation-total"),
    totalRow: document.querySelector(".total-row"),
    wishlist: document.querySelector("#wishlist-toggle"),
    dim: document.querySelector("#dim-toggle"),
    reset: document.querySelector("#reset-button"),
    save: document.querySelector("#save-button"),
    status: document.querySelector("#save-status")
  };

  function numericValue(input) {
    var value = Number(input.value);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  }

  function currentSplit() {
    return {
      developer: numericValue(elements.developer),
      charity: numericValue(elements.charity),
      humble: numericValue(elements.humble)
    };
  }

  function renderAllocation() {
    var split = currentSplit();
    var total = split.developer + split.charity + split.humble;
    elements.developerBar.style.width = split.developer + "%";
    elements.charityBar.style.width = split.charity + "%";
    elements.humbleBar.style.width = split.humble + "%";
    elements.total.textContent = total.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%";
    elements.totalRow.classList.toggle("is-invalid", Math.abs(total - 100) > 0.001);
    elements.save.disabled = Math.abs(total - 100) > 0.001;
    elements.status.textContent = Math.abs(total - 100) > 0.001 ? "The three values must total 100%." : "";
  }

  function setSplit(split) {
    var normalized = shared.normalizeDonationSplit(split);
    elements.developer.value = normalized.developer;
    elements.charity.value = normalized.charity;
    elements.humble.value = normalized.humble;
    renderAllocation();
  }

  async function load() {
    var settings = await shared.sendRuntimeMessage(browserApi, { type: "GET_SETTINGS" }) || {};
    elements.applySplit.checked = settings.applyDonationSplit !== false;
    elements.wishlist.checked = settings.showWishlist !== false;
    elements.dim.checked = settings.dimOwned !== false;
    setSplit(settings.donationSplit || { developer: 50, charity: 50, humble: 0 });
  }

  async function save() {
    elements.save.disabled = true;
    elements.status.textContent = "Saving…";
    try {
      await shared.sendRuntimeMessage(browserApi, {
        type: "SET_SETTINGS",
        settings: {
          applyDonationSplit: elements.applySplit.checked,
          donationSplit: currentSplit(),
          showWishlist: elements.wishlist.checked,
          dimOwned: elements.dim.checked
        }
      });
      elements.status.textContent = "Settings saved.";
    } catch (error) {
      elements.status.textContent = "Could not save settings.";
    } finally {
      renderAllocation();
    }
  }

  [elements.developer, elements.charity, elements.humble].forEach(function listenToShare(input) {
    input.addEventListener("input", renderAllocation);
  });
  elements.reset.addEventListener("click", function resetSplit() {
    setSplit({ developer: 50, charity: 50, humble: 0 });
  });
  elements.save.addEventListener("click", save);

  load().catch(function loadFailed() {
    elements.status.textContent = "Could not load settings. Reopen this page to try again.";
  });
})();
