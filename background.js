const STORAGE_KEY = "instantBookmark.folderPaths.v1";
const CLOSE_TAB_KEY = "instantBookmark.closeTabAfterSave.v1";
const EXCLUDED_DOMAINS_KEY = "instantBookmark.excludedDomains.v1";

const DEFAULT_EXCLUDED_DOMAINS = "mail.google.com, www.google.com";

const LAST_OUTCOME_KEY = "instantBookmark.lastOutcome.v1";

const SLOT_COUNT = 7;

const BADGE_CLEAR_ALARM_NAME = "instant-bookmark:clearBadge";
const BADGE_CLEAR_DELAY_MS = 1200;

// Tracks the most recently hovered link reported by any frame in a tab.
// Key: tabId, Value: { url, title, ts }
const lastHoveredByTab = new Map();

const HOVER_FRESH_MS = 1200;

// In-memory caches to avoid slow per-command lookups.
let cachedFolderPaths = Array(SLOT_COUNT).fill("");
let cachedCloseTabAfterSave = false;
let cachedExcludedDomainsRaw = "";
let cachedExcludedDomains = [];
let settingsLoaded = false;
let settingsLoadPromise = null;

// Cache resolved folder IDs by canonical path key.
const folderIdCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFolderPaths(raw) {
  if (!Array.isArray(raw)) return Array(SLOT_COUNT).fill("");
  return Array.from({ length: SLOT_COUNT }, (_, i) => {
    const v = raw[i];
    return typeof v === "string" ? v.trim() : "";
  });
}

function normalizeExcludedDomainsRaw(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeDomainToken(token) {
  if (!token || typeof token !== "string") return null;
  let t = token.trim().toLowerCase();
  if (!t) return null;

  // Allow common patterns like "*.example.com" or ".example.com".
  t = t.replace(/^\*\./, "").replace(/^\.+/, "");

  // If user pasted a full URL, extract hostname.
  if (t.includes("://")) {
    try {
      const u = new URL(t);
      t = (u.hostname || "").toLowerCase();
    } catch {
      // fall through
    }
  }

  // Strip path/query/fragment and ports.
  t = t.split(/[/?#]/)[0];
  t = t.split(":")[0];
  t = t.replace(/^\.+/, "").trim();

  if (!t) return null;
  if (!/^[a-z0-9.-]+$/.test(t)) return null;
  if (t === "." || t === "-") return null;

  return t;
}

function parseExcludedDomains(raw) {
  if (!raw || typeof raw !== "string") return [];
  const parts = raw
    .split(",")
    .map((s) => normalizeDomainToken(s))
    .filter(Boolean);

  // De-dupe, keep stable order.
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function urlMatchesExcludedDomains(url, excludedDomains) {
  if (!url || typeof url !== "string") return false;
  if (!Array.isArray(excludedDomains) || excludedDomains.length === 0) return false;
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;

  for (const d of excludedDomains) {
    if (!d) continue;
    if (hostname === d) return true;
    if (hostname.endsWith(`.${d}`)) return true;
  }
  return false;
}

async function recordLastOutcome(outcome) {
  // Best-effort: used by the popup UI for user feedback.
  try {
    await chrome.storage.local.set({
      [LAST_OUTCOME_KEY]: {
        ...outcome,
        ts: typeof outcome?.ts === "number" ? outcome.ts : Date.now(),
      },
    });
  } catch {
    // ignore
  }
}

async function ensureSettingsLoaded() {
  if (settingsLoaded) return;
  if (settingsLoadPromise) {
    await settingsLoadPromise;
    return;
  }

  settingsLoadPromise = (async () => {
    try {
      const out = await chrome.storage.sync.get({
        [STORAGE_KEY]: Array(SLOT_COUNT).fill(""),
        [CLOSE_TAB_KEY]: false,
        [EXCLUDED_DOMAINS_KEY]: DEFAULT_EXCLUDED_DOMAINS,
      });

      cachedFolderPaths = normalizeFolderPaths(out[STORAGE_KEY]);
      cachedCloseTabAfterSave = Boolean(out[CLOSE_TAB_KEY]);
      cachedExcludedDomainsRaw = normalizeExcludedDomainsRaw(out[EXCLUDED_DOMAINS_KEY]);
      cachedExcludedDomains = parseExcludedDomains(cachedExcludedDomainsRaw);
    } finally {
      settingsLoaded = true;
      settingsLoadPromise = null;
    }
  })();

  await settingsLoadPromise;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  if (changes?.[STORAGE_KEY]) {
    cachedFolderPaths = normalizeFolderPaths(changes[STORAGE_KEY].newValue);
    // Folder paths changed; folderId cache might now be stale or unused.
    folderIdCache.clear();
  }

  if (changes?.[CLOSE_TAB_KEY]) {
    cachedCloseTabAfterSave = Boolean(changes[CLOSE_TAB_KEY].newValue);
  }

  if (changes?.[EXCLUDED_DOMAINS_KEY]) {
    cachedExcludedDomainsRaw = normalizeExcludedDomainsRaw(changes[EXCLUDED_DOMAINS_KEY].newValue);
    cachedExcludedDomains = parseExcludedDomains(cachedExcludedDomainsRaw);
  }

  settingsLoaded = true;
});

function scheduleBadgeClear() {
  try {
    // Use an alarm rather than setTimeout because MV3 service workers can suspend.
    chrome.alarms.create(BADGE_CLEAR_ALARM_NAME, { when: Date.now() + BADGE_CLEAR_DELAY_MS });
  } catch {
    // Best-effort only.
  }
}

async function clearBadge() {
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // Best-effort only.
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== BADGE_CLEAR_ALARM_NAME) return;
  void clearBadge();
});

async function showSaveFeedback({ tabId, message }) {
  // Badge feedback: requires no extra permissions.
  // (The message is currently unused for the badge, but kept for future flexibility.)
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    await chrome.action.setBadgeText({ text: "✓" });
    scheduleBadgeClear();
  } catch {
    // Some Chromium variants or policies may restrict action APIs.
  }
}

/**
 * Load the user-defined folder paths.
 * Returns an array of length SLOT_COUNT with strings (possibly empty).
 */
async function getFolderPaths() {
  await ensureSettingsLoaded();
  return cachedFolderPaths;
}

async function getCloseTabAfterSaveSetting() {
  await ensureSettingsLoaded();
  return cachedCloseTabAfterSave;
}

async function getExcludedDomains() {
  await ensureSettingsLoaded();
  return cachedExcludedDomains;
}

function parseFolderPath(path) {
  if (!path) return [];
  const cleaned = path
    .replace(/^\s*[/\\]+/, "")
    .replace(/\s*$/g, "")
    .replace(/\s*[>\\]+\s*/g, "/");

  return cleaned
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isFolder(node) {
  return !node.url;
}

async function getBookmarkRootNodes() {
  // Prefer fetching only the root's direct children; this avoids pulling the entire tree.
  try {
    const roots = await chrome.bookmarks.getChildren("0");
    return roots ?? [];
  } catch {
    // Fallback: older / restricted environments.
    const trees = await chrome.bookmarks.getTree();
    const root = trees?.[0];
    return root?.children ?? [];
  }
}

function canonicalizePathSegments(pathSegments) {
  // Canonical roots/aliases (case-insensitive). If the root isn't specified, default to Bookmarks Bar.
  const aliases = {
    "bookmarks bar": "bookmarks bar",
    bar: "bookmarks bar",
    "other bookmarks": "other bookmarks",
    other: "other bookmarks",
    "mobile bookmarks": "mobile bookmarks",
    mobile: "mobile bookmarks",
  };

  if (!pathSegments.length) {
    return {
      rootTitleLower: "bookmarks bar",
      remainingSegments: [],
      cacheKey: "bookmarks bar/",
    };
  }

  const firstLower = String(pathSegments[0] || "").toLowerCase();
  const rootTitleLower = aliases[firstLower] || "bookmarks bar";
  const remainingSegments = aliases[firstLower] ? pathSegments.slice(1) : pathSegments;

  const remainingLower = remainingSegments.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
  const cacheKey = `${rootTitleLower}/${remainingLower.join("/")}`;

  return { rootTitleLower, remainingSegments, cacheKey };
}

function pickRootId(roots, rootTitleLower) {
  // In Chrome, these IDs are stable: 1=Bookmarks Bar, 2=Other Bookmarks, 3=Mobile Bookmarks.
  // Use them when present; fall back to title matching; then fall back to the first root.
  const byId = new Map((roots || []).map((n) => [String(n?.id ?? ""), n]));
  if (rootTitleLower === "bookmarks bar" && byId.has("1")) return "1";
  if (rootTitleLower === "other bookmarks" && byId.has("2")) return "2";
  if (rootTitleLower === "mobile bookmarks" && byId.has("3")) return "3";

  const match = (roots || []).find((n) => (n?.title || "").toLowerCase() === rootTitleLower);
  if (match?.id) return match.id;

  return (roots?.[0] || null)?.id ?? null;
}

async function getOrCreateChildFolder(parentId, title) {
  const want = String(title || "").trim().toLowerCase();
  if (!want) return null;

  let children = [];
  try {
    children = await chrome.bookmarks.getChildren(parentId);
  } catch {
    return null;
  }

  const existing = (children || []).find((c) => isFolder(c) && (c.title || "").toLowerCase() === want);
  if (existing?.id) return existing;

  try {
    return await chrome.bookmarks.create({ parentId, title });
  } catch {
    return null;
  }
}

/**
 * Resolve a folder path like:
 *   "Bookmarks Bar/Reading"
 * and returns the folder id (creating folders if needed).
 */
async function resolveFolderIdFromPath(pathSegments) {
  const { rootTitleLower, remainingSegments, cacheKey } = canonicalizePathSegments(pathSegments);

  const cached = folderIdCache.get(cacheKey);
  if (cached && typeof cached === "string") return cached;

  const roots = await getBookmarkRootNodes();
  const rootId = pickRootId(roots, rootTitleLower);
  if (!rootId) return null;

  let parentId = rootId;
  for (const seg of remainingSegments) {
    const folder = await getOrCreateChildFolder(parentId, seg);
    if (!folder?.id) return null;
    parentId = folder.id;
  }

  folderIdCache.set(cacheKey, parentId);
  return parentId;
}

async function getHoveredLinkFromTab(tabId) {
  try {
    // Don't let a slow/noisy frame response block the shortcut.
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "instant-bookmark:getHovered" }),
      sleep(175).then(() => null),
    ]);
    if (!res || typeof res !== "object") return null;
    if (!res.url || typeof res.url !== "string") return null;
    return {
      url: res.url,
      title: typeof res.title === "string" && res.title.trim() ? res.title.trim() : res.url,
    };
  } catch {
    // Most commonly: no content script on chrome:// pages, or tab not reachable.
    return null;
  }
}

async function getHoveredLinkViaScripting(tabId) {
  // Fallback for pages/frames where our content script can't run or can't reliably respond
  // (e.g. Gmail message body iframes). Requires the "scripting" permission.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        function isProbablyUsefulUrl(url, rawHref) {
          if (!url || typeof url !== "string") return false;
          const raw = (rawHref || "").trim().toLowerCase();
          if (!raw) return false;
          if (raw === "#" || raw.startsWith("javascript:") || raw.startsWith("void(") || raw.startsWith("about:")) {
            return false;
          }
          if (raw.startsWith("#")) return false;
          try {
            const u = new URL(url);
            return u.protocol === "http:" || u.protocol === "https:";
          } catch {
            return false;
          }
        }

        function findHovered() {
          try {
            const hovered = document.querySelectorAll(":hover");
            const el = hovered?.[hovered.length - 1];
            if (!el) return null;
            const a = el.closest?.("a[href]");
            if (!a) return null;
            const url = a.href;
            const rawHref = a.getAttribute("href");
            if (!isProbablyUsefulUrl(url, rawHref)) return null;
            const title = (a.getAttribute("title") || a.textContent || "").trim();
            return { url, title: title || url };
          } catch {
            return null;
          }
        }

        return findHovered();
      },
    });

    for (const r of results || []) {
      const v = r?.result;
      if (v && typeof v === "object" && typeof v.url === "string" && v.url) {
        return {
          url: v.url,
          title: typeof v.title === "string" && v.title.trim() ? v.title.trim() : v.url,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function getRecentHoveredLinkFromCache(tabId) {
  const v = lastHoveredByTab.get(tabId);
  if (!v || typeof v !== "object") return null;
  if (!v.url || typeof v.url !== "string") return null;
  const ts = Number(v.ts);
  if (!Number.isFinite(ts)) return null;
  if (Date.now() - ts > HOVER_FRESH_MS) return null;

  return {
    url: v.url,
    title: typeof v.title === "string" && v.title.trim() ? v.title.trim() : v.url,
  };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] ?? null;
}

function isNewTabUrl(url) {
  if (!url || typeof url !== "string") return false;
  const u = url.toLowerCase();

  // Chrome / Chromium
  if (u === "chrome://newtab/" || u === "chrome://newtab") return true;
  if (u === "chrome://new-tab-page/" || u === "chrome://new-tab-page") return true;

  // Edge (Chromium)
  if (u === "edge://newtab/" || u === "edge://newtab") return true;

  // Firefox
  if (u === "about:newtab" || u === "about:home") return true;

  // A freshly created tab can sometimes be about:blank.
  if (u === "about:blank") return true;

  return false;
}

async function showErrorFeedback() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
    await chrome.action.setBadgeText({ text: "!" });
    scheduleBadgeClear();
  } catch {
    // Best-effort only.
  }
}

async function saveToSlot(slotIndex) {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const folderPaths = await getFolderPaths();
  const rawPath = folderPaths[slotIndex] || "";

  // If empty, fall back to a predictable default so the command always does something useful.
  // (Creates folders if missing.)
  const pathToUse = rawPath || `Bookmarks Bar/Instant Bookmark/Slot ${slotIndex + 1}`;

  const folderId = await resolveFolderIdFromPath(parseFolderPath(pathToUse));
  if (!folderId) return;

  const excludedDomains = await getExcludedDomains();

  // Prefer hover cache first (works across iframes, e.g. Gmail).
  // Fall back to asking the tab directly.
  let hovered = getRecentHoveredLinkFromCache(tab.id) ?? (await getHoveredLinkFromTab(tab.id));
  let usedHoveredLink = Boolean(hovered?.url);

  // Important: exclusions are TAB-only.
  // If the tab is excluded but we failed to detect a hovered link, try a stronger fallback
  // so users can still save hovered links on excluded sites (like Gmail).
  const tabIsExcluded = urlMatchesExcludedDomains(tab.url, excludedDomains);
  if (!usedHoveredLink && tabIsExcluded) {
    hovered = await getHoveredLinkViaScripting(tab.id);
    usedHoveredLink = Boolean(hovered?.url);
  }

  const url = usedHoveredLink ? hovered.url : tab.url;
  if (!url || typeof url !== "string") return;

  const isTabExcluded = !usedHoveredLink && tabIsExcluded;
  if (isTabExcluded) {
    await recordLastOutcome({
      type: "excluded-tab",
      url: tab.url || "",
      slotIndex,
    });
    await showErrorFeedback();
    return;
  }

  const title = (usedHoveredLink ? hovered.title : tab.title) || url;

  try {
    await chrome.bookmarks.create({
      parentId: folderId,
      title,
      url,
    });
  } catch {
    await showErrorFeedback();
    return;
  }

  const targetLabel = usedHoveredLink ? "Link" : "Tab";
  const message = `${targetLabel} saved to slot ${slotIndex + 1}`;

  // Provide immediate feedback (best-effort).
  await showSaveFeedback({ tabId: tab.id, message });

  // Optional behavior: close the current tab after saving *the tab*.
  // Never close a tab when we saved a hovered link.
  if (!usedHoveredLink) {
    const closeAfterSave = await getCloseTabAfterSaveSetting();
    if (closeAfterSave) {
      // Never close tabs on excluded domains.
      if (isTabExcluded) return;
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // Ignore failures (e.g. tab already closed).
      }
    }
  }
}

async function openFirstThenRemoveFromSlot(slotIndex) {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const folderPaths = await getFolderPaths();
  const rawPath = folderPaths[slotIndex] || "";
  const pathToUse = rawPath || `Bookmarks Bar/Instant Bookmark/Slot ${slotIndex + 1}`;

  const folderId = await resolveFolderIdFromPath(parseFolderPath(pathToUse));
  if (!folderId) {
    await showErrorFeedback();
    return;
  }

  let children = [];
  try {
    children = await chrome.bookmarks.getChildren(folderId);
  } catch {
    await showErrorFeedback();
    return;
  }

  const firstBookmark = (children || []).find((c) => typeof c?.url === "string" && c.url);
  if (!firstBookmark?.id || !firstBookmark.url) {
    await showErrorFeedback();
    return;
  }

  // Open immediately after the current tab.
  // If the current tab is already a new-tab page, reuse it.
  try {
    if (isNewTabUrl(tab.url)) {
      await chrome.tabs.update(tab.id, { url: firstBookmark.url, active: true });
    } else {
      await chrome.tabs.create({
        url: firstBookmark.url,
        active: true,
        index: typeof tab.index === "number" ? tab.index + 1 : undefined,
        openerTabId: tab.id,
      });
    }
  } catch {
    // If we couldn't open it, do not remove it.
    await showErrorFeedback();
    return;
  }

  try {
    await chrome.bookmarks.remove(firstBookmark.id);
  } catch {
    // Open succeeded but removal failed; still provide best-effort feedback.
  }

  await showSaveFeedback({ tabId: tab.id, message: `Opened+removed slot ${slotIndex + 1}` });
}

async function handleCommand(command) {
  const saveMatch = /^save_to_folder_(\d+)$/.exec(command);
  if (saveMatch) {
    const n = Number(saveMatch[1]);
    if (!Number.isFinite(n) || n < 1 || n > SLOT_COUNT) return;
    await saveToSlot(n - 1);
    return;
  }

  const openMatch = /^open_first_then_remove_(\d+)$/.exec(command);
  if (openMatch) {
    const n = Number(openMatch[1]);
    if (!Number.isFinite(n) || n < 1 || n > SLOT_COUNT) return;
    await openFirstThenRemoveFromSlot(n - 1);
    return;
  }
}

chrome.commands.onCommand.addListener((command) => {
  // Keep the service worker alive by awaiting within this async chain.
  void handleCommand(command);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "instant-bookmark:hoverUpdate") {
    const tabId = sender?.tab?.id;
    if (!Number.isFinite(tabId)) return;

    const url = typeof msg.url === "string" ? msg.url : "";
    if (!url) return;

    lastHoveredByTab.set(tabId, {
      url,
      title: typeof msg.title === "string" ? msg.title : "",
      ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
    });
  }

  if (msg.type === "instant-bookmark:hoverClear") {
    const tabId = sender?.tab?.id;
    if (!Number.isFinite(tabId)) return;

    const ts = typeof msg.ts === "number" ? msg.ts : Date.now();
    const cur = lastHoveredByTab.get(tabId);

    // Only clear if this clear event is newer than (or equal to) the last hover update.
    if (!cur || typeof cur !== "object") {
      lastHoveredByTab.delete(tabId);
      return;
    }

    const curTs = Number(cur.ts);
    if (!Number.isFinite(curTs) || ts >= curTs) {
      lastHoveredByTab.delete(tabId);
    }
  }
});

// Keep caches fresh.
chrome.bookmarks.onCreated.addListener(() => folderIdCache.clear());
chrome.bookmarks.onRemoved.addListener(() => folderIdCache.clear());
chrome.bookmarks.onChanged.addListener(() => folderIdCache.clear());
chrome.bookmarks.onMoved.addListener(() => folderIdCache.clear());

// Prime settings cache early so the first shortcut is snappier.
void ensureSettingsLoaded();
