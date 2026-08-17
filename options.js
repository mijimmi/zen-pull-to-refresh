"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULTS = {
  enabled: true,
  threshold: 150,
  indicator: "spinner",
  blocklist: []
};

const el = {
  enabled: document.getElementById("enabled"),
  threshold: document.getElementById("threshold"),
  thresholdVal: document.getElementById("thresholdVal"),
  indicator: document.getElementById("indicator"),
  blocklist: document.getElementById("blocklist"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  saved: document.getElementById("saved")
};

function store() {
  return api.storage.sync || api.storage.local;
}

function render(s) {
  el.enabled.checked = s.enabled !== false;
  el.threshold.value = s.threshold || DEFAULTS.threshold;
  el.thresholdVal.textContent = el.threshold.value;
  el.indicator.value = s.indicator || DEFAULTS.indicator;
  el.blocklist.value = (Array.isArray(s.blocklist) ? s.blocklist : []).join("\n");
}

function collect() {
  return {
    enabled: el.enabled.checked,
    threshold: Number(el.threshold.value),
    indicator: el.indicator.value,
    blocklist: el.blocklist.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  };
}

function flash() {
  el.saved.classList.add("show");
  setTimeout(() => el.saved.classList.remove("show"), 1400);
}

function save() {
  const result = store().set(collect());
  if (result && typeof result.then === "function") result.then(flash, flash);
  else flash();
}

el.threshold.addEventListener("input", () => {
  el.thresholdVal.textContent = el.threshold.value;
});

el.save.addEventListener("click", save);

el.reset.addEventListener("click", () => {
  render(DEFAULTS);
  save();
});

// Toggle and dropdown feel better applying instantly.
el.enabled.addEventListener("change", save);
el.indicator.addEventListener("change", save);

(function load() {
  const got = store().get(DEFAULTS);
  if (got && typeof got.then === "function") got.then(render, () => render(DEFAULTS));
  else store().get(DEFAULTS, render);
})();
