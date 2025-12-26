const STORAGE_KEY = "instantBookmark.folderPaths.v1";
const CLOSE_TAB_KEY = "instantBookmark.closeTabAfterSave.v1";
const EXCLUDED_DOMAINS_KEY = "instantBookmark.excludedDomains.v1";

const DEFAULT_EXCLUDED_DOMAINS = "mail.google.com, www.google.com";

const LAST_OUTCOME_KEY = "instantBookmark.lastOutcome.v1";

const SLOT_COUNT = 7;

const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const openShortcutsBtn = document.getElementById("openShortcuts");
const closeTabAfterSaveEl = document.getElementById("closeTabAfterSave");
const excludedDomainsEl = document.getElementById("excludedDomains");

const inputs = Array.from({ length: SLOT_COUNT }, (_, i) => document.getElementById(`slot${i + 1}`));

let statusTimer = null;
function setStatus(text, { clearAfterMs = 1400 } = {}) {
  if (statusTimer) window.clearTimeout(statusTimer);
  statusEl.textContent = text;
  if (text && Number.isFinite(clearAfterMs) && clearAfterMs > 0) {
    statusTimer = window.setTimeout(() => (statusEl.textContent = ""), clearAfterMs);
  }
}

function readUI() {
  return inputs.map((i) => (i.value || "").trim());
}

function writeUI(values) {
  for (let i = 0; i < inputs.length; i++) {
    inputs[i].value = typeof values?.[i] === "string" ? values[i] : "";
  }
}

function normalizeFolderPaths(raw) {
  if (!Array.isArray(raw)) return Array(SLOT_COUNT).fill("");
  return Array.from({ length: SLOT_COUNT }, (_, i) => {
    const v = raw[i];
    return typeof v === "string" ? v.trim() : "";
  });
}

async function load() {
  const out = await chrome.storage.sync.get({
    [STORAGE_KEY]: Array(SLOT_COUNT).fill(""),
    [CLOSE_TAB_KEY]: false,
    [EXCLUDED_DOMAINS_KEY]: DEFAULT_EXCLUDED_DOMAINS,
  });
  const values = out[STORAGE_KEY];
  writeUI(normalizeFolderPaths(values));

  closeTabAfterSaveEl.checked = Boolean(out[CLOSE_TAB_KEY]);
  excludedDomainsEl.value = typeof out[EXCLUDED_DOMAINS_KEY] === "string" ? out[EXCLUDED_DOMAINS_KEY] : "";

  // If the user recently tried saving an excluded tab, show a clear symbol in the popup.
  try {
    const local = await chrome.storage.local.get({ [LAST_OUTCOME_KEY]: null });
    const last = local[LAST_OUTCOME_KEY];
    if (last && typeof last === "object" && last.type === "excluded-tab") {
      // Keep this visible a bit longer than the usual "Saved" toast.
      setStatus("⛔ Blocked by exclusions", { clearAfterMs: 4000 });
      // Clear so it doesn't keep showing every time the popup opens.
      await chrome.storage.local.remove(LAST_OUTCOME_KEY);
    }
  } catch {
    // ignore
  }
}

async function save() {
  const values = readUI();
  await chrome.storage.sync.set({
    [STORAGE_KEY]: normalizeFolderPaths(values),
    [CLOSE_TAB_KEY]: Boolean(closeTabAfterSaveEl.checked),
    [EXCLUDED_DOMAINS_KEY]: (excludedDomainsEl.value || "").trim(),
  });
  setStatus("Saved");
}

let debounceId = null;
function queueAutosave() {
  if (debounceId) window.clearTimeout(debounceId);
  debounceId = window.setTimeout(() => {
    void save();
  }, 450);
}

saveBtn.addEventListener("click", () => void save());

openShortcutsBtn.addEventListener("click", async () => {
  // chrome:// pages can't be opened from all contexts in all Chromium variants,
  // but in Chrome this works fine.
  try {
    await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  } catch {
    setStatus("Open chrome://extensions/shortcuts manually");
  }
});

for (const input of inputs) {
  input.addEventListener("input", queueAutosave);
}

closeTabAfterSaveEl.addEventListener("change", queueAutosave);
excludedDomainsEl.addEventListener("input", queueAutosave);

void load();
