// inject.js — MAIN world, document_start.
// Sole responsibility: intercept X's GraphQL network responses (both
// XMLHttpRequest and fetch) and relay each response body — as a plain string —
// to the isolated world via a CustomEvent. No JSON parsing / tweet extraction
// here (that logic lives in testable lib/* modules used by content_main.js).
//
// Why both transports: X uses XHR for most timeline queries but may issue some
// requests (notably the initial TweetDetail on a hard page load) via fetch.
// Hooking only XHR left directly-opened tweet pages with zero captured data.
(function () {
  // Matches the v2 GraphQL endpoint path ("/i/api/graphql/..."). Note this
  // deliberately does NOT match "/i/api/1.1/graphql/viewer_context.json"
  // (there is no "/api/graphql" substring in "/api/1.1/graphql").
  var GRAPHQL_MARKER = "/api/graphql";

  function isGraphqlUrl(url) {
    return typeof url === "string" && url.indexOf(GRAPHQL_MARKER) !== -1;
  }

  function relay(body) {
    try {
      if (typeof body === "string" && body.length > 0) {
        document.dispatchEvent(new CustomEvent("xmc:graphql", { detail: body }));
        window.postMessage({ source: "xmc", type: "graphql", body: body }, "*");
      }
    } catch (e) {
      // Never let a relay failure break the page.
    }
  }

  // --- XMLHttpRequest hook ---
  try {
    var OriginalXHR = window.XMLHttpRequest;

    var ProxiedXHR = new Proxy(OriginalXHR, {
      construct: function (Target, args) {
        var xhr = new Target(...args);
        try {
          xhr.addEventListener("load", function () {
            try {
              if (isGraphqlUrl(this.responseURL)) {
                var body =
                  typeof this.response === "string"
                    ? this.response
                    : JSON.stringify(this.response);
                relay(body);
              }
            } catch (innerErr) {
              // ignore
            }
          });
        } catch (listenerErr) {
          // Ignore — worst case this request isn't observed.
        }
        return xhr;
      },
    });

    window.XMLHttpRequest = ProxiedXHR;
  } catch (err) {
    // Never let this script break the host page.
  }

  // --- fetch hook ---
  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function () {
        var fetchArgs = arguments;
        var requestUrl = "";
        try {
          var first = fetchArgs[0];
          requestUrl =
            typeof first === "string"
              ? first
              : first && typeof first.url === "string"
              ? first.url
              : "";
        } catch (argErr) {
          requestUrl = "";
        }

        return originalFetch.apply(this, fetchArgs).then(function (response) {
          try {
            // response.url is the resolved URL; fall back to the request arg.
            var url =
              response && typeof response.url === "string" && response.url
                ? response.url
                : requestUrl;
            if (isGraphqlUrl(url)) {
              // clone() so the page still reads the original body stream.
              response
                .clone()
                .text()
                .then(relay)
                .catch(function () {});
            }
          } catch (respErr) {
            // ignore
          }
          return response;
        });
      };
    }
  } catch (fetchHookErr) {
    // Never let this script break the host page.
  }
})();
