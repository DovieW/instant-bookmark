const STORAGE_KEY = "instantBookmark.folderPaths.v1";
const CLOSE_TAB_KEY = "instantBookmark.closeTabAfterSave.v1";

const SLOT_COUNT = 7;

const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const openShortcutsBtn = document.getElementById("openShortcuts");
const closeTabAfterSaveEl = document.getElementById("closeTabAfterSave");

const inputs = Array.from({ length: SLOT_COUNT }, (_, i) => document.getElementById(`slot${i + 1}`));

let statusTimer = null;
function setStatus(text) {
  if (statusTimer) window.clearTimeout(statusTimer);
  statusEl.textContent = text;
  if (text) statusTimer = window.setTimeout(() => (statusEl.textContent = ""), 1400);
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
  });
  const values = out[STORAGE_KEY];
  writeUI(normalizeFolderPaths(values));

  closeTabAfterSaveEl.checked = Boolean(out[CLOSE_TAB_KEY]);
}

async function save() {
  const values = readUI();
  await chrome.storage.sync.set({
    [STORAGE_KEY]: normalizeFolderPaths(values),
    [CLOSE_TAB_KEY]: Boolean(closeTabAfterSaveEl.checked),
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

void load();
