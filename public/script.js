/* =========================================================
   NOOKAA — Coming Soon
   script.js — waitlist submission (POST /api/waitlist)

   Only the submit logic lives here. Every class name, label, timing
   and message below is unchanged from the original build, so the
   rendered page and its animations are identical.
   ========================================================= */

(function () {
  "use strict";

  var form    = document.getElementById("waitlist-form");
  var input   = document.getElementById("email");
  var button  = form ? form.querySelector(".btn--primary") : null;
  var message = document.getElementById("form-message");
  var trap    = document.getElementById("website"); // honeypot
  var counter = document.querySelector(".community__text");

  if (!form || !input || !button || !message) return;

  // Same-origin only. The API is served by the same Express app that serves
  // this page, so there is no base URL, no API key and no sheet id in the
  // client bundle — there is nothing here worth reading.
  var API_BASE = "";

  var REQUEST_TIMEOUT_MS = 15000;

  var DEFAULT_LABEL = button.textContent;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var MAX_EMAIL_LENGTH = 254;
  var submitting = false;

  function setMessage(text, type) {
    message.textContent = text;
    message.className = "waitlist__message" + (type ? " is-" + type : "");
  }

  function setBusy(busy) {
    submitting = busy;
    button.disabled = busy;
    input.disabled = busy;
    button.textContent = busy ? "Joining\u2026" : DEFAULT_LABEL;
  }

  function celebrate(text) {
    button.classList.add("is-success");
    button.textContent = "You're in \u2713";
    setMessage(text, "success");
    input.value = "";

    window.setTimeout(function () {
      button.classList.remove("is-success");
      button.textContent = DEFAULT_LABEL;
      button.disabled = false;
      input.disabled = false;
    }, 4000);
  }

  function fail(text) {
    setBusy(false);
    setMessage(text, "error");
    input.focus();
  }

  // Clear any error state as soon as the user edits the field
  input.addEventListener("input", function () {
    if (message.classList.contains("is-error")) setMessage("", "");
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (submitting) return;

    var value = input.value.trim();

    /* ---- Client-side validation (convenience only; the server
            re-validates every field and trusts none of this) ---- */

    if (value === "") {
      setMessage("Please enter your email address.", "error");
      input.focus();
      return;
    }

    if (value.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(value)) {
      setMessage("That doesn't look like a valid email. Try again.", "error");
      input.focus();
      return;
    }

    setBusy(true);
    setMessage("", "");

    // Abort a stalled request rather than leaving the button spinning.
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller
      ? window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS)
      : null;

    fetch(API_BASE + "/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        email: value,
        website: trap ? trap.value : "",
        source: "website"
      }),
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        return res.json()
          .catch(function () { return {}; })
          .then(function (data) {
            return { status: res.status, data: data || {} };
          });
      })
      .then(function (result) {
        if (timer) window.clearTimeout(timer);
        setBusy(false);

        var data = result.data;
        var succeeded = data.success === true || data.ok === true;

        if (succeeded) {
          celebrate(
            data.message ||
              "Thanks! You're on the Nookaa waitlist \u2014 a free drink awaits on launch day."
          );
          refreshCount();
          return;
        }

        fail(data.message || "Something went wrong. Please try again.");
      })
      .catch(function (err) {
        if (timer) window.clearTimeout(timer);
        fail(
          err && err.name === "AbortError"
            ? "That took too long. Please try again."
            : "We couldn't reach the server. Check your connection and try again."
        );
      });
  });

  /* ---- Live early-bird count ----
     The endpoint is disabled by default (it would leak the size of the
     list). When it is off this fails silently and the static copy in the
     markup stays exactly as authored. */
  function refreshCount() {
    if (!counter) return;

    fetch(API_BASE + "/api/waitlist/count", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (!(data.success === true || data.ok === true)) return;
        if (typeof data.count !== "number" || data.count < 1) return;

        counter.textContent =
          "Be among " + data.count.toLocaleString("en-IN") + "+ early birds";
      })
      .catch(function () { /* keep the static copy */ });
  }

  refreshCount();
})();
