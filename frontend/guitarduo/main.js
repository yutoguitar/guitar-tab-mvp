/* ==========================================================================
   Latin Jazz Guitar Duo — /guitarduo
   Client-side JS: smooth-scroll nav, footer year, inquiry form handler.
   No framework. Works as a plain static bundle.
   ========================================================================== */

// TODO: set this to the real inquiry address once the user confirms it.
// This is the only place the email address is hard-coded.
const INQUIRY_EMAIL = "TODO_EMAIL@example.com";

// ---- YouTube videos shown in the "Watch" section -------------------------
// Paste full YouTube URLs or just the 11-character video IDs.
// Empty strings render a styled "Add video" placeholder card.
// Examples that work:
//   "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
//   "https://youtu.be/dQw4w9WgXcQ"
//   "dQw4w9WgXcQ"
const VIDEOS = [
  "", // TODO: YouTube URL or ID for clip 1
  "", // TODO: YouTube URL or ID for clip 2
  "", // TODO: YouTube URL or ID for clip 3
];
// --------------------------------------------------------------------------

// ---- optional Formspree / backend endpoint -------------------------------
// To switch from the mailto: fallback to a real POST endpoint, set
// FORMSPREE_ENDPOINT to something like "https://formspree.io/f/xxxxxxx"
// (or a Node/Express route). If it's non-empty, the form will POST to it
// instead of opening the user's mail client.
const FORMSPREE_ENDPOINT = "";
// --------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  setFooterYear();
  enableSmoothNav();
  renderVideos();
  wireInquiryForm();
});

function extractYouTubeId(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (!s) return "";
  // Already an 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  // Try to parse URL variants
  try {
    const u = new URL(s);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      // /embed/<id> or /shorts/<id>
      const m = u.pathname.match(/\/(embed|shorts)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch (_) { /* not a URL, fall through */ }
  return "";
}

function renderVideos() {
  const grid = document.getElementById("video-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const items = (typeof VIDEOS !== "undefined" && Array.isArray(VIDEOS) && VIDEOS.length)
    ? VIDEOS
    : ["", "", ""];

  items.forEach((raw, i) => {
    const card = document.createElement("div");
    card.className = "video-card";
    const id = extractYouTubeId(raw);
    if (id) {
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube-nocookie.com/embed/${id}?rel=0`;
      iframe.title = `Live performance video ${i + 1}`;
      iframe.loading = "lazy";
      iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.allowFullscreen = true;
      card.appendChild(iframe);
    } else {
      const empty = document.createElement("div");
      empty.className = "video-empty";
      empty.innerHTML = `
        <div class="play" aria-hidden="true">▶</div>
        <strong>Add YouTube video</strong>
        <span>Edit <code>VIDEOS</code> in <code>main.js</code> and paste a URL.</span>
      `;
      card.appendChild(empty);
    }
    grid.appendChild(card);
  });
}

function setFooterYear() {
  const el = document.getElementById("year");
  if (el) el.textContent = String(new Date().getFullYear());
}

function enableSmoothNav() {
  // Browsers already honour `html { scroll-behavior: smooth }`, but this
  // also closes the mobile nav (if we later add one) and is a safe no-op
  // if the target is missing.
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href").slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", `#${id}`);
    });
  });
}

function wireInquiryForm() {
  const form = document.getElementById("inquiry-form");
  if (!form) return;
  const status = document.getElementById("form-status");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("");

    if (!form.checkValidity()) {
      form.reportValidity();
      setStatus("Please fill in the required fields.", "err");
      return;
    }

    const data = Object.fromEntries(new FormData(form).entries());

    if (FORMSPREE_ENDPOINT) {
      try {
        setStatus("Sending…");
        const res = await fetch(FORMSPREE_ENDPOINT, {
          method: "POST",
          headers: { Accept: "application/json" },
          body: new FormData(form),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        form.reset();
        setStatus("Thanks — we’ll be in touch within 24 hours.", "ok");
      } catch (err) {
        console.error(err);
        setStatus(
          "Couldn’t send right now. Please email us directly.",
          "err"
        );
      }
      return;
    }

    // ---- default path: open the user's mail client with a prefilled body --
    const subject = `Booking inquiry — ${data["event-type"] || "Event"} on ${
      data["event-date"] || "TBD"
    }`;
    const bodyLines = [
      `Name: ${data.name || ""}`,
      `Email: ${data.email || ""}`,
      `Phone: ${data.phone || ""}`,
      `Event date: ${data["event-date"] || ""}`,
      `Venue / location: ${data.venue || ""}`,
      `Event type: ${data["event-type"] || ""}`,
      `Duration: ${data.duration || ""}`,
      ``,
      `Message:`,
      `${data.message || ""}`,
    ];
    const href =
      `mailto:${encodeURIComponent(INQUIRY_EMAIL)}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(bodyLines.join("\n"))}`;

    window.location.href = href;
    setStatus("Opening your mail app…", "ok");
  });

  function setStatus(msg, kind) {
    if (!status) return;
    status.textContent = msg;
    status.classList.remove("ok", "err");
    if (kind) status.classList.add(kind);
  }
}
