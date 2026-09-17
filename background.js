/* GradFill — service worker. Owns the badge and the first-run redirect. */

/* Open GradFill as Chrome's native right-side panel instead of a small popup. */
async function enableActionSidePanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    /* Older Chrome builds may not support this yet. */
  }
}

enableActionSidePanel();
chrome.runtime.onStartup.addListener(enableActionSidePanel);

chrome.runtime.onInstalled.addListener(function (details) {
  chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
  }
});

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (msg.type === "GF_CORRECTION_CANDIDATE") {
    var candidate = Object.assign({}, msg.candidate || {});
    candidate.tabId = sender && sender.tab ? sender.tab.id : candidate.tabId;
    candidate.frameId = sender && typeof sender.frameId === "number" ? sender.frameId : candidate.frameId;
    chrome.storage.local.get("gfPendingCorrections").then(function (store) {
      var list = Array.isArray(store.gfPendingCorrections) ? store.gfPendingCorrections : [];
      var key = String(candidate.tabId || "") + "|" + String(candidate.matchText || candidate.question || candidate.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "") ;
      list = list.filter(function (x) {
        var xkey = String(x.tabId || "") + "|" + String(x.matchText || x.question || x.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        return xkey !== key;
      });
      list.unshift(candidate);
      list = list.slice(0, 20);
      return chrome.storage.local.set({ gfPendingCorrections: list });
    }).then(function () {
      try { chrome.runtime.sendMessage({ type: "GF_CORRECTION_AVAILABLE", candidate: candidate }).catch(function () {}); } catch (e) {}
      respond({ ok: true });
    }).catch(function () { respond({ ok: false }); });
    return true;
  }
  if (msg.type === "GF_BADGE") {
    var tabId = msg.tabId;
    var text = msg.count > 0 ? String(msg.count) : "";
    chrome.action.setBadgeBackgroundColor({ color: msg.count > 0 ? "#b45309" : "#1f6f5c" });
    chrome.action.setBadgeText({ tabId: tabId, text: text });
    respond({ ok: true });
    return true;
  }
});

/* A new page is a fresh form — drop the old count. */
chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status === "loading") {
    chrome.action.setBadgeText({ tabId: tabId, text: "" });
  }
});

/* Session/correction cleanup when an application tab is closed. */
chrome.tabs.onRemoved.addListener(function (tabId) {
  chrome.storage.local.get(["gfApplicationSessions", "gfPendingCorrections"]).then(function (store) {
    var sessions = store.gfApplicationSessions || {};
    delete sessions[String(tabId)];
    var pending = Array.isArray(store.gfPendingCorrections) ? store.gfPendingCorrections.filter(function (x) { return Number(x.tabId) !== Number(tabId); }) : [];
    return chrome.storage.local.set({ gfApplicationSessions: sessions, gfPendingCorrections: pending });
  }).catch(function () {});
});
