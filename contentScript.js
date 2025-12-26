let lastGoodHover = null;

function isProbablyUsefulUrl(url, rawHref) {
  if (!url || typeof url !== "string") return false;

  const raw = (rawHref || "").trim().toLowerCase();
  if (!raw) return false;

  // Ignore JS pseudo-links and empty anchors.
  if (raw === "#" || raw.startsWith("javascript:") || raw.startsWith("void(") || raw.startsWith("about:")) {
    return false;
  }

  // Ignore same-page fragments where the raw href is only a fragment.
  if (raw.startsWith("#")) return false;

  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeAnchorFromElement(el) {
  if (!el) return null;

  const a = el.closest?.("a[href]");
  if (!a) return null;

  const url = a.href;
  const rawHref = a.getAttribute("href");
  if (!isProbablyUsefulUrl(url, rawHref)) return null;

  const text = (a.getAttribute("title") || a.textContent || "").trim();

  return {
    url,
    title: text,
    ts: Date.now(),
  };
}

function getLiveHoveredAnchor() {
  // This is surprisingly effective: the last element in :hover is the deepest hovered node.
  // It does not cross into cross-origin iframes, but combined with all_frames injection it helps.
  try {
    const hovered = document.querySelectorAll(":hover");
    const el = hovered?.[hovered.length - 1];
    return normalizeAnchorFromElement(el);
  } catch {
    return null;
  }
}

function onPointerMove() {
  const live = getLiveHoveredAnchor();
  if (live) lastGoodHover = live;
}

window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
window.addEventListener("mousemove", onPointerMove, { capture: true, passive: true });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "instant-bookmark:getHovered") {
    // Prefer live lookup first, then fall back to last known good hover.
    const live = getLiveHoveredAnchor();
    if (live) {
      lastGoodHover = live;
      sendResponse({ url: live.url, title: live.title });
      return;
    }

    // If nothing is currently hovered, treat as a tab-save.
    sendResponse(null);
  }
});
