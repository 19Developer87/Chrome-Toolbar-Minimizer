const TOP_EDGE_PX = 8;
const HIDE_DELAY_MS = 2500;
let mode;
let screenTop;
let hideTimer;
let modeRequest = 0;
let revealing = false;
let pointerOnPage = false;

function cancelHide() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
}

function scheduleHide() {
  if (mode !== "revealed" || !pointerOnPage || hideTimer !== undefined || !document.hasFocus()) return;
  hideTimer = setTimeout(() => {
    hideTimer = undefined;
    if (document.hasFocus()) void requestMode("hide-toolbar");
  }, HIDE_DELAY_MS);
}

function leavePage() {
  pointerOnPage = false;
  cancelHide();
}

async function requestMode(message) {
  const request = ++modeRequest;
  try {
    const status = await chrome.runtime.sendMessage(message);
    const nextMode = status?.mode ?? null;
    if (request === modeRequest && nextMode !== mode) {
      cancelHide();
      mode = nextMode;
      screenTop = status?.screenTop;
      scheduleHide();
    }
  } catch {
    // The extension may have been reloaded or disabled while this page was open.
    if (request === modeRequest) mode = null;
  }
}

function onPointerMove(event) {
  if (!event.isTrusted || event.pointerType !== "mouse" || event.buttons) return;
  pointerOnPage = true;

  if (mode === "hidden" && !revealing && Math.abs(event.screenY - screenTop) <= TOP_EDGE_PX) {
    revealing = true;
    void requestMode("reveal-toolbar").finally(() => { revealing = false; });
  } else {
    scheduleHide();
  }
}

window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
window.addEventListener("pointerout", event => {
  if (event.isTrusted && event.pointerType === "mouse" && event.relatedTarget === null) leavePage();
}, { capture: true, passive: true });
window.addEventListener("blur", event => {
  if (event.target === window) leavePage();
}, true);
document.addEventListener("visibilitychange", () => {
  leavePage();
  if (!document.hidden) void requestMode("get-toolbar-mode");
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message === "refresh-toolbar-mode") void requestMode("get-toolbar-mode");
  if (message === "measure-toolbar") {
    respond({ outerHeight, innerHeight, outerWidth, innerWidth, focused: document.hasFocus(),
      fullscreen: Boolean(document.fullscreenElement) });
  }
});
document.addEventListener("fullscreenchange", event => {
  if (!event.isTrusted) return;
  leavePage();
  const message = document.fullscreenElement ? "fullscreen-entered" : "fullscreen-exited";
  void chrome.runtime.sendMessage(message).catch(() => {});
});
void chrome.runtime.sendMessage("toolbar-page-ready").catch(() => {});
void requestMode("get-toolbar-mode");
