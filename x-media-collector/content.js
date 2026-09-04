// content.js — ISOLATED world, document_start, classic script.
// Buffers "xmc:graphql" events until content_main.js finishes loading (so the
// initial timeline payload isn't lost), then hands off buffering/subscription
// to the ESM body via a dynamic import.
(function () {
  var buffer = [];
  var subscriber = null;
  var recentSignatures = [];

  function signature(detail) {
    return String(detail.length) + ":" + detail.slice(0, 80) + ":" + detail.slice(-80);
  }

  function enqueue(detail) {
    if (typeof detail !== "string" || detail.length === 0) return;
    var sig = signature(detail);
    if (recentSignatures.indexOf(sig) !== -1) return;
    recentSignatures.push(sig);
    if (recentSignatures.length > 50) recentSignatures.shift();

    if (subscriber) {
      subscriber(detail);
    } else {
      buffer.push(detail);
    }
  }

  document.addEventListener("xmc:graphql", function (event) {
    enqueue(event.detail);
  });

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== "xmc" || data.type !== "graphql") return;
    enqueue(data.body);
  });

  function subscribe(fn) {
    subscriber = fn;
  }

  var contentMainUrl =
    chrome.runtime.getURL("content_main.js") + "?xmc_ts=" + Date.now();

  import(contentMainUrl)
    .then(function (mod) {
      mod.start(buffer, subscribe, {
        sendMessage: function (message, callback) {
          chrome.runtime.sendMessage(message, callback);
        },
        getLastError: function () {
          return chrome.runtime.lastError;
        },
      });
    })
    .catch(function (err) {
      console.error("[xmc] failed to load content_main.js", err);
    });
})();
