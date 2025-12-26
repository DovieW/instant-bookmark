let lastGoodHover = null;

let lastSentUrl = null;
let lastSentAt = 0;
const HOVER_SEND_MIN_INTERVAL_MS = 200;

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
  if (live) {
    lastGoodHover = live;

    // Push updates to the service worker so it can use hovered links even when
    // on-demand frame messaging is unreliable (e.g. Gmail iframes).
    const now = Date.now();
    const shouldSend =
      live.url &&
      (live.url !== lastSentUrl || now - lastSentAt >= HOVER_SEND_MIN_INTERVAL_MS);

    if (shouldSend) {
      lastSentUrl = live.url;
      lastSentAt = now;
      try {
        chrome.runtime.sendMessage({
          type: "instant-bookmark:hoverUpdate",
          url: live.url,
          title: live.title,
          ts: live.ts,
        });
      } catch {
        // ignore
      }
    }
  }
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

    // Important: do NOT respond with `null`.
    // In iframe-heavy apps (like Gmail), *multiple* content scripts receive this message.
    // If the top frame responds quickly with null, it prevents the iframe (where the actual
    // hovered link lives) from responding with the real URL.
    //
    // So we only respond when we have a usable URL (live or a very recent last-good hover).
    if (lastGoodHover && Date.now() - lastGoodHover.ts < 2500) {
      sendResponse({ url: lastGoodHover.url, title: lastGoodHover.title });
      return;
    }

    // No response => background will treat this as "no hovered link" and fall back to tab URL.
    return;
  }
});
