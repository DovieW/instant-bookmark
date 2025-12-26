const STORAGE_KEY = "instantBookmark.folderPaths.v1";
const CLOSE_TAB_KEY = "instantBookmark.closeTabAfterSave.v1";

// Tracks the most recently hovered link reported by any frame in a tab.
// Key: tabId, Value: { url, title, ts }
const lastHoveredByTab = new Map();

const HOVER_FRESH_MS = 2500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function showSaveFeedback({ tabId, message }) {
  // Badge feedback: requires no extra permissions.
  // (The message is currently unused for the badge, but kept for future flexibility.)
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    await chrome.action.setBadgeText({ text: "✓" });
    await sleep(1200);
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // Some Chromium variants or policies may restrict action APIs.
  }
}

/**
 * Load the 10 user-defined folder paths.
 * Returns an array of length 10 with strings (possibly empty).
 */
async function getFolderPaths() {
  const out = await chrome.storage.sync.get({ [STORAGE_KEY]: Array(10).fill("") });
  const raw = out[STORAGE_KEY];

  if (!Array.isArray(raw)) return Array(10).fill("");

  // Normalize to exactly 10 strings.
  const normalized = Array(10)
    .fill("")
    .map((_, i) => {
      const v = raw[i];
      return typeof v === "string" ? v.trim() : "";
    });

  return normalized;
}

async function getCloseTabAfterSaveSetting() {
  const out = await chrome.storage.sync.get({ [CLOSE_TAB_KEY]: false });
  return Boolean(out[CLOSE_TAB_KEY]);
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

async function getBookmarksRoots() {
  const trees = await chrome.bookmarks.getTree();
  const root = trees?.[0];
  return root?.children ?? [];
}

function findChildFolderByTitle(parent, title) {
  const want = title.toLowerCase();
  const children = parent?.children ?? [];
  return children.find((c) => isFolder(c) && (c.title || "").toLowerCase() === want) || null;
}

async function ensureFolder(parentId, title) {
  // Create if missing.
  return chrome.bookmarks.create({ parentId, title });
}

/**
 * Resolve a folder path like:
 *   "Bookmarks Bar/Reading"
 * and returns the folder id (creating folders if needed).
 */
async function resolveFolderIdFromPath(pathSegments) {
  const roots = await getBookmarksRoots();

  // If no segments, default to the bookmarks bar root if available.
  if (!pathSegments.length) {
    const bar = roots.find((n) => (n.title || "").toLowerCase() === "bookmarks bar");
    return (bar ?? roots[0])?.id;
  }

  // First segment must match a root node title (Bookmarks Bar / Other Bookmarks / Mobile Bookmarks)
  const first = pathSegments[0].toLowerCase();
  let current =
    roots.find((n) => (n.title || "").toLowerCase() === first) ||
    // convenience aliases
    roots.find((n) => first === "bar" && (n.title || "").toLowerCase() === "bookmarks bar") ||
    roots.find((n) => first === "other" && (n.title || "").toLowerCase() === "other bookmarks") ||
    roots.find((n) => first === "mobile" && (n.title || "").toLowerCase() === "mobile bookmarks") ||
    null;

  // If they didn’t specify an actual root, treat it as a folder under Bookmarks Bar.
  if (!current) {
    current = roots.find((n) => (n.title || "").toLowerCase() === "bookmarks bar") || roots[0] || null;
    if (!current) return null;

    // Now we will create/find the first segment under that root.
    const syntheticSegments = pathSegments;
    return resolveFolderIdUnderRoot(current, syntheticSegments);
  }

  return resolveFolderIdUnderRoot(current, pathSegments.slice(1));
}

async function resolveFolderIdUnderRoot(rootNode, remainingSegments) {
  let parent = rootNode;

  for (const seg of remainingSegments) {
    const existing = findChildFolderByTitle(parent, seg);
    if (existing) {
      parent = existing;
      continue;
    }

    const created = await ensureFolder(parent.id, seg);

    // Keep a minimal synthetic children list so subsequent segments can resolve.
    if (!parent.children) parent.children = [];
    parent.children.push({ ...created, children: [] });

    parent = created;
  }

  return parent.id;
}

async function getHoveredLinkFromTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "instant-bookmark:getHovered" });
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

  // Prefer hover cache first (works across iframes, e.g. Gmail).
  // Fall back to asking the tab directly.
  const hovered = getRecentHoveredLinkFromCache(tab.id) ?? (await getHoveredLinkFromTab(tab.id));

  const usedHoveredLink = Boolean(hovered?.url);
  const url = usedHoveredLink ? hovered.url : tab.url;
  if (!url || typeof url !== "string") return;

  const title = (usedHoveredLink ? hovered.title : tab.title) || url;

  await chrome.bookmarks.create({
    parentId: folderId,
    title,
    url,
  });

  const targetLabel = usedHoveredLink ? "Link" : "Tab";
  const message = `${targetLabel} saved to slot ${slotIndex + 1}`;

  // Provide immediate feedback (best-effort).
  await showSaveFeedback({ tabId: tab.id, message });

  // Optional behavior: close the current tab after saving *the tab*.
  // Never close a tab when we saved a hovered link.
  if (!usedHoveredLink) {
    const closeAfterSave = await getCloseTabAfterSaveSetting();
    if (closeAfterSave) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // Ignore failures (e.g. tab already closed).
      }
    }
  }
}

async function handleCommand(command) {
  const match = /^save_to_folder_(\d+)$/.exec(command);
  if (!match) return;

  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 1 || n > 10) return;

  await saveToSlot(n - 1);
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
});
