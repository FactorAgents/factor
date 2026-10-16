/* Pay with Factor: the button.
 *
 * Put a plain link to a Pay with Factor checkout on your page, with data-factor-pay on it, and this script beside it:
 *
 *   <a href="https://factoragents.fun/pay/..." data-factor-pay>Pay with Factor</a>
 *   <script src="https://factoragents.fun/pay/button.js" async></script>
 *
 * The script dresses each such link as a button and opens the checkout in a new tab. That is all it does: it loads
 * nothing else, sets no cookie, stores nothing and tells nobody that the page was seen. A page that runs no script
 * keeps the plain link, which works the same. Only links to the checkout on the site this script came from are
 * touched. */
(function () {
  "use strict";
  // the site this script was loaded from: factoragents.fun itself, or a copy of it someone runs to try it
  var ORIGIN = "https://factoragents.fun";
  try {
    if (document.currentScript && document.currentScript.src) ORIGIN = new URL(document.currentScript.src).origin;
  } catch {
    /* keep factoragents.fun */
  }
  function ok(a) {
    try {
      var u = new URL(a.href, document.baseURI);
      return u.origin === ORIGIN && /^\/pay\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(u.pathname);
    } catch {
      return false;
    }
  }
  function dress(a) {
    if (a.getAttribute("data-factor-ready") === "1" || !ok(a)) return;
    a.setAttribute("data-factor-ready", "1");
    a.target = "_blank";
    a.rel = "noopener";
    var label = (a.textContent || "").trim();
    a.textContent = "";
    var mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    mark.style.cssText = "display:inline-block;width:9px;height:9px;border:2px solid #cdb27f;border-radius:50%;margin-right:10px;vertical-align:-1px;box-sizing:border-box";
    var words = document.createElement("span");
    words.textContent = label || "Pay with Factor";
    a.appendChild(mark);
    a.appendChild(words);
    a.style.cssText = "display:inline-flex;align-items:center;height:44px;padding:0 20px;border-radius:3px;background:#0e0f11;color:#ece7de;border:1px solid #cdb27f;font:500 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-decoration:none;white-space:nowrap;cursor:pointer";
    a.title = "Pays into Factor's contract on Robinhood Chain: held until the work is delivered";
  }
  function all() {
    var list = document.querySelectorAll("a[data-factor-pay]");
    for (var i = 0; i < list.length; i++) dress(list[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", all);
  else all();
})();
