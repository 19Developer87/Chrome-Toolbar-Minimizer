const windowTasks = new Map();
const positionHosts = new Map();
const reconcileTimers = new Map();
const actionIcons = new Map();
const POSITION_HOST = "com.toolbar_minimiser.position";
const RECONCILE_DELAY_MS = 220;

function inWindow(windowId, task) {
  const previous = windowTasks.get(windowId) ?? Promise.resolve();
  const next = previous.then(task);
  const settled = next.catch(error => console.warn("Toolbar Minimiser:", error));
  windowTasks.set(windowId, settled);
  void settled.then(() => {
    if (windowTasks.get(windowId) === settled) windowTasks.delete(windowId);
  });
  return next;
}

function sessionKey(windowId) {
  return `window-${windowId}`;
}

async function getSession(windowId) {
  const key = sessionKey(windowId);
  return (await chrome.storage.session.get(key))[key];
}

async function activeTab(windowId) {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  return tab;
}

function setActionIcon(tabId, enabled) {
  if (!actionIcons.has(enabled)) {
    const imageData = {};
    for (const size of [16, 32]) {
      const context = new OffscreenCanvas(size, size).getContext("2d");
      context.fillStyle = enabled ? "#16834c" : "#6b6b6b";
      context.roundRect(0, 0, size, size, size / 9);
      context.fill();
      context.fillStyle = "#ffffff";
      context.font = `${size * 0.6875}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("C", size / 2, size / 2);
      imageData[size] = context.getImageData(0, 0, size, size);
    }
    actionIcons.set(enabled, imageData);
  }
  // The tab may have closed since we selected it.
  return chrome.action.setIcon({ tabId, imageData: actionIcons.get(enabled) }).catch(() => {});
}

function syncTabIcon(tabId, windowId) {
  void inWindow(windowId, async () => setActionIcon(tabId, Boolean(await getSession(windowId))));
}

function sendToPage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null);
}

async function notifyActiveTab(windowId) {
  const tab = await activeTab(windowId);
  if (tab) await sendToPage(tab.id, "refresh-toolbar-mode");
}

async function saveSession(windowId, session) {
  if (session) {
    await chrome.storage.session.set({ [sessionKey(windowId)]: session });
  } else {
    await chrome.storage.session.remove(sessionKey(windowId));
  }
  const tab = await activeTab(windowId);
  if (tab) {
    await setActionIcon(tab.id, Boolean(session));
    await sendToPage(tab.id, "refresh-toolbar-mode");
  }
}

function connectPositionHost(windowId) {
  const port = chrome.runtime.connectNative(POSITION_HOST);
  let pending;
  const host = {
    watching: false,
    send(request) {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        try {
          port.postMessage(request);
        } catch (error) {
          pending = undefined;
          reject(error);
        }
      });
    },
    close() {
      if (positionHosts.get(windowId) === host) positionHosts.delete(windowId);
      port.disconnect();
    }
  };
  port.onMessage.addListener(message => {
    if (message.hoverMode === "hidden" || message.hoverMode === "revealed") {
      void inWindow(windowId, () => {
        if (positionHosts.get(windowId) === host && host.watching) {
          return changeMode(windowId, message.hoverMode);
        }
      });
    } else if (pending) {
      host.watching = Boolean(message.watching);
      pending.resolve(message);
      pending = undefined;
    }
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? "Windows helper disconnected.";
    pending?.reject(new Error(error));
    pending = undefined;
    if (positionHosts.get(windowId) === host) {
      positionHosts.delete(windowId);
      if (host.watching) void notifyActiveTab(windowId).catch(() => {});
    }
  });
  positionHosts.set(windowId, host);
  return host;
}

function bounds({ left, top, width, height }) {
  return { left, top, width, height };
}

function overlap(a, b) {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return Math.max(0, width) * Math.max(0, height);
}

function sameBounds(actual, expected) {
  return Object.keys(expected).every(key => Math.abs(actual[key] - expected[key]) <= 2);
}

async function getPlacement(window) {
  const displays = await chrome.system.display.getInfo();
  const display = displays.reduce((best, candidate) => {
    return overlap(window, candidate.bounds) > overlap(window, best.bounds) ? candidate : best;
  });
  const { workArea } = display;
  if (workArea.top !== display.bounds.top) {
    throw new Error("This display has a Windows taskbar at the top.");
  }
  // Preserve Windows' invisible resize borders, especially on snapped windows.
  const revealed = bounds(window);
  if (revealed.top < workArea.top - 12) {
    // Chrome may reopen a saved window that was closed with its toolbar off-screen.
    revealed.height -= workArea.top - revealed.top;
    revealed.top = workArea.top;
  }
  if (revealed.top > workArea.top + 8) revealed.top = workArea.top;
  return {
    revealed,
    workArea,
    otherDisplays: displays.filter(other => other.id !== display.id).map(other => other.bounds)
  };
}

async function hiddenBounds(tabId, placement, fallback, waitForPageFocus = false) {
  const zoom = await chrome.tabs.getZoom(tabId);
  const viewport = await sendToPage(tabId, "measure-toolbar");
  if (viewport?.fullscreen) return null;
  if (waitForPageFocus && viewport?.focused === false) return null;

  // Chrome also exposes the viewport in desktop units on its built-in pages.
  const tab = viewport ? null : await chrome.tabs.get(tabId);
  const window = tab ? await chrome.windows.get(tab.windowId) : null;
  const frameWidth = viewport ? viewport.outerWidth - viewport.innerWidth * zoom
    : window.width - tab.width;
  // The bottom resize border contributes to the height difference too.
  const bottomBorder = Math.min(6, Math.max(0, Math.floor(frameWidth / 2) - 1));
  const frameHeight = viewport ? viewport.outerHeight - viewport.innerHeight * zoom
    : window.height - tab.height;
  const overhead = Math.ceil(frameHeight - bottomBorder);
  if (!Number.isFinite(overhead) || overhead < 25 || overhead > 200) {
    if (!viewport && fallback) return fallback;
    throw new Error("Close docked DevTools or other panels and try again.");
  }
  const { revealed, workArea, otherDisplays } = placement;
  const strip = { ...revealed, top: workArea.top - overhead, height: overhead };
  if (otherDisplays.some(display => overlap(display, strip))) {
    throw new Error("There is another monitor directly above this Chrome window.");
  }
  return { ...strip, height: revealed.top + revealed.height - strip.top };
}

async function restore(windowId, session) {
  const window = await chrome.windows.get(windowId);
  if (!sameBounds(window, session.original) || window.state !== "normal") {
    await chrome.windows.update(windowId, { ...session.original, state: "normal" });
  }
  if (session.wasMaximized) await chrome.windows.update(windowId, { state: "maximized" });
}

async function move(windowId, target) {
  const updated = await chrome.windows.update(windowId, target);
  if (!sameBounds(updated, target)) {
    throw new Error("Windows changed the requested window bounds.");
  }
  return bounds(updated);
}

async function slide(window, target, workArea, mode, toolbarHeight, place = false) {
  const host = positionHosts.get(window.id);
  const request = {
    left: window.left - workArea.left,
    top: window.top - workArea.top,
    width: window.width,
    height: window.height,
    offset: target.top - window.top,
    ...(place ? {
      place: true,
      leftOffset: target.left - window.left,
      widthOffset: target.width - window.width,
      bottomOffset: target.top + target.height - window.top - window.height
    } : {})
  };
  let result;
  try {
    result = host
      ? await host.send({ ...request, mode, toolbarHeight })
      : await chrome.runtime.sendNativeMessage(POSITION_HOST, request);
  } catch (error) {
    host?.close();
    if (!error.message.includes("native messaging host not found")) throw error;
    try {
      return await move(window.id, target);
    } catch {
      throw new Error("Install the Windows helper to hide the toolbar at this window size.");
    }
  }
  if (host && !host.watching) host.close();
  if (!result?.ok) throw new Error(result?.error ?? "The Windows helper did not respond.");
  const updated = await chrome.windows.get(window.id);
  if (!sameBounds(updated, target)) throw new Error("The toolbar could not move to the requested position.");
  return bounds(updated);
}

async function enableWindow(window, tab, previous) {
  const windowId = window.id;
  const placement = await getPlacement(window);
  // Check the page and monitor before changing any window state.
  if (!await hiddenBounds(tab.id, placement)) return false;
  const wasMaximized = window.state === "maximized";
  let original = bounds(wasMaximized
    ? await chrome.windows.update(windowId, { state: "normal" })
    : window);
  if (original.top < placement.workArea.top - 12) {
    original = wasMaximized && previous ? previous.original : {
      ...original,
      height: original.top + original.height - placement.workArea.top,
      top: placement.workArea.top
    };
  }
  const next = { original, wasMaximized, placement, mode: "hidden" };
  try {
    // Measure in restored mode, where Chrome's frame has a different height.
    let current = await chrome.windows.get(windowId);
    if (!positionHosts.has(windowId)) connectPositionHost(windowId);
    if (!sameBounds(current, placement.revealed)) {
      current = await chrome.windows.update(windowId, placement.revealed);
      if (!sameBounds(current, placement.revealed)) {
        await slide(current, placement.revealed, placement.workArea, "off", 0, true);
      }
    }
    const hidden = await hiddenBounds(tab.id, placement);
    if (!hidden) throw new Error("Chrome entered fullscreen before the toolbar moved.");
    next.hidden = await slide(await chrome.windows.get(windowId), hidden, placement.workArea,
      "hidden", placement.workArea.top - hidden.top);
    await saveSession(windowId, next);
    return true;
  } catch (error) {
    positionHosts.get(windowId)?.close();
    if ((await chrome.windows.get(windowId)).state !== "fullscreen") await restore(windowId, next);
    throw error;
  }
}

async function toggle(tab) {
  const windowId = tab.windowId;
  const window = await chrome.windows.get(windowId);
  if (window.type !== "normal" || !["normal", "maximized"].includes(window.state)) return;

  const session = await getSession(windowId);
  if (session) {
    await chrome.storage.local.set({ enabled: false });
    if (session.mode === "hidden" && sameBounds(window, session.hidden)) {
      // Move a snapped window back without asking Windows to restore its show state.
      await slide(window, session.placement.revealed, session.placement.workArea, "off", 0)
        .catch(() => {});
    }
    positionHosts.get(windowId)?.close();
    await restore(windowId, session);
    await saveSession(windowId, null);
  } else if (await enableWindow(window, tab)) {
    await chrome.storage.local.set({ enabled: true });
  }
}

function sessionBounds(session) {
  return session.mode === "hidden" ? session.hidden : session.placement.revealed;
}

function scheduleReconcile(windowId, delay = RECONCILE_DELAY_MS) {
  if (windowId < 0) return;
  clearTimeout(reconcileTimers.get(windowId));
  reconcileTimers.set(windowId, setTimeout(() => {
    reconcileTimers.delete(windowId);
    void inWindow(windowId, () => reconcileWindow(windowId));
  }, delay));
}

async function reconcileWindow(windowId) {
  let window = await chrome.windows.get(windowId).catch(() => null);
  if (!window || window.type !== "normal" || window.state === "minimized") return;
  const session = await getSession(windowId);
  if (window.state === "fullscreen") {
    if (session && !session.fullscreen) await saveSession(windowId, { ...session, fullscreen: true });
    return;
  }
  const tab = await activeTab(windowId);
  if (!tab) return;
  if (!session) {
    if (window.focused && (await chrome.storage.local.get("enabled")).enabled) {
      await enableWindow(window, tab);
    }
    return;
  }

  const target = sessionBounds(session);
  if (session.fullscreen) {
    if ((await sendToPage(tab.id, "measure-toolbar"))?.fullscreen) return;
    window = await chrome.windows.get(windowId);
    if (window.state === "fullscreen" || window.state === "minimized") return;
    if (window.state === "maximized") {
      window = await chrome.windows.update(windowId, { state: "normal" });
    }
    // Windows may cap the restored height after leaving fullscreen. Repair the
    // whole rectangle and re-arm the existing helper on the same native window.
    const { workArea } = session.placement;
    if (!positionHosts.has(windowId) && window.focused) connectPositionHost(windowId);
    const repaired = await slide(window, target, workArea, session.mode,
      workArea.top - session.hidden.top, true);
    await saveSession(windowId, { ...session, fullscreen: false,
      hidden: session.mode === "hidden" ? repaired : session.hidden });
  } else if (window.focused && (window.state === "maximized" || !sameBounds(window, target))) {
    // A manual resize or Windows Snap changes the window's baseline.
    try {
      await enableWindow(window, tab, session);
    } catch (error) {
      await saveSession(windowId, null);
      throw error;
    }
  } else if (session.mode === "hidden" && window.state === "normal") {
    const hidden = await hiddenBounds(tab.id, session.placement, session.hidden);
    if (hidden && !sameBounds(hidden, session.hidden)) {
      const { workArea } = session.placement;
      const updated = await slide(window, hidden, workArea, "hidden", workArea.top - hidden.top);
      await saveSession(windowId, { ...session, hidden: updated });
    }
  }
}

async function changeMode(windowId, mode, senderTabId) {
  const session = await getSession(windowId);
  if (!session || session.fullscreen || session.mode === mode) return session;

  const window = await chrome.windows.get(windowId);
  const tab = await activeTab(windowId);
  const nativeHover = senderTabId === undefined;
  const shown = session.placement.revealed;
  const current = sessionBounds(session);
  if ((!nativeHover && (!window.focused || tab?.id !== senderTabId))
      || (nativeHover && !positionHosts.get(windowId)?.watching) || window.state !== "normal" || !tab
      || !sameBounds(window, current)) return session;

  let hidden = session.hidden;
  try {
    const workArea = session.placement.workArea;
    const target = mode === "hidden"
      ? await hiddenBounds(tab.id, session.placement, nativeHover ? hidden : undefined,
        nativeHover && window.focused)
      : shown;
    if (!target) return session;
    const toolbarHeight = workArea.top - (mode === "hidden" ? target.top : hidden.top);
    const updated = await slide(window, target, workArea, mode, toolbarHeight);
    if (mode === "hidden") hidden = updated;
  } catch (error) {
    const actual = await chrome.windows.get(windowId);
    if (actual.state === "normal" && !sameBounds(actual, current)) scheduleReconcile(windowId);
    throw error;
  }
  const next = { ...session, mode, hidden };
  await saveSession(windowId, next);
  return next;
}

chrome.action.onClicked.addListener(tab => {
  void inWindow(tab.windowId, async () => {
    let errorMessage = "";
    try {
      await toggle(tab);
    } catch (error) {
      errorMessage = error.message;
    }
    await chrome.action.setBadgeText({ tabId: tab.id, text: errorMessage ? "!" : "" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: errorMessage || "Toggle Chrome Toolbar Minimiser"
    });
  });
});

chrome.windows.onRemoved.addListener(id => {
  clearTimeout(reconcileTimers.get(id));
  reconcileTimers.delete(id);
  positionHosts.get(id)?.close();
  void inWindow(id, () => chrome.storage.session.remove(sessionKey(id)));
});

chrome.windows.onBoundsChanged.addListener(window => {
  if (window.state === "fullscreen") {
    void inWindow(window.id, async () => {
      const session = await getSession(window.id);
      if (session && !session.fullscreen) {
        await saveSession(window.id, { ...session, fullscreen: true });
        scheduleReconcile(window.id);
      }
    });
  } else {
    scheduleReconcile(window.id);
  }
});
chrome.windows.onFocusChanged.addListener(id => scheduleReconcile(id));
chrome.windows.onCreated.addListener(window => {
  if (window.type === "normal") scheduleReconcile(window.id);
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  syncTabIcon(tabId, windowId);
  scheduleReconcile(windowId);
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (tab.active && change.status === "complete") {
    syncTabIcon(id, tab.windowId);
    scheduleReconcile(tab.windowId);
  }
});
async function reconcileLastFocusedWindow() {
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (window) scheduleReconcile(window.id);
}

chrome.runtime.onStartup.addListener(reconcileLastFocusedWindow);
chrome.runtime.onInstalled.addListener(reconcileLastFocusedWindow);

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.frameId !== 0 || !sender.tab) return;
  if (message === "fullscreen-entered" || message === "fullscreen-exited") {
    const { windowId, id } = sender.tab;
    if (message === "fullscreen-entered") {
      void inWindow(windowId, async () => {
        const session = await getSession(windowId);
        if (session && (await activeTab(windowId))?.id === id && !session.fullscreen) {
          await saveSession(windowId, { ...session, fullscreen: true });
        }
      });
    }
    scheduleReconcile(windowId);
    return;
  }
  if (message === "toolbar-page-ready") {
    if (sender.tab.active) scheduleReconcile(sender.tab.windowId);
    return;
  }
  let task;
  if (message === "get-toolbar-mode") {
    task = getSession(sender.tab.windowId);
  } else if (message === "reveal-toolbar" || message === "hide-toolbar") {
    const mode = message === "reveal-toolbar" ? "revealed" : "hidden";
    task = inWindow(sender.tab.windowId, () => positionHosts.get(sender.tab.windowId)?.watching
      ? getSession(sender.tab.windowId)
      : changeMode(sender.tab.windowId, mode, sender.tab.id));
  } else {
    return;
  }
  const reply = session => respond(session
    ? {
      mode: session.fullscreen || positionHosts.get(sender.tab.windowId)?.watching ? null : session.mode,
      screenTop: session.placement.workArea.top
    }
    : null);
  task.then(reply, () => getSession(sender.tab.windowId).then(reply, () => respond(null)));
  return true;
});
