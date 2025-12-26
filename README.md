# instant-bookmark

Manifest V3 Chrome extension to instantly add bookmarks using keyboard shortcuts.

You configure **10 shortcuts → 10 bookmark folder paths**. When you press a shortcut:

- If your mouse is hovering a link, the extension saves **that link**.
- Otherwise, it saves the **current tab**.

## Install (Load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder

## Configure folder paths

Open the extension popup and enter a bookmark folder “path” (a simple slash-separated breadcrumb).

Examples:

- `Bookmarks Bar/Reading`
- `Other Bookmarks/Work/Inbox`
- `Mobile Bookmarks/Articles`

Notes:

- You can start with a root name (`Bookmarks Bar`, `Other Bookmarks`, `Mobile Bookmarks`) or omit it.
	- If you omit it, the path is treated as being under **Bookmarks Bar**.
- Missing folders are **created automatically**.
- If a slot is left empty, it defaults to:
	- `Bookmarks Bar/Instant Bookmark/Slot N`

## Keyboard shortcuts

Default suggested shortcuts are:

- Slot 1 → `Alt+1`
- Slot 2 → `Alt+2`
- Slot 3 → `Alt+3`
- Slot 4 → `Alt+4`

Slots **5–10** intentionally have **no suggested default** (so they don’t steal common key combos). Set them manually.

You can change these in:

- `chrome://extensions/shortcuts`

## How it works

- A content script tracks the currently hovered `<a>`.
- The background service worker listens for commands and saves either the hovered link or the active tab into the configured bookmark folder.

## Feedback when saving

When you save via a keyboard shortcut, the extension provides quick feedback:

- A brief toolbar badge (✓)

## Optional: close tab after saving

In the popup, you can enable **Close tab after saving current tab**.

- This closes the tab only when the shortcut saved the **current tab**.
- It **never** closes the tab when the shortcut saved a **hovered link**.
