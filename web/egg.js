// flightlah Easter egg: tapping the "LUQ TECH." credit plays /pressure.mp4 full-screen
// with sound. The tap is the user gesture, so play() with sound is allowed. Nothing is
// fetched until the first tap (the overlay and the video's src are created then), and
// the service worker never caches the video.
(function () {
  var credit = document.getElementById("egg");
  if (!credit) return;
  var overlay = null, video = null, lastFocus = null;

  function build() {
    overlay = document.createElement("div");
    overlay.className = "egg";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "LUQ TECH.");
    overlay.hidden = true;
    overlay.innerHTML =
      '<button type="button" class="egg-close" aria-label="Close">×</button>' +
      '<video class="egg-video" playsinline preload="none"></video>';
    video = overlay.querySelector("video");
    overlay.querySelector(".egg-close").addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    video.addEventListener("ended", close);
    document.body.appendChild(overlay);
  }

  function open() {
    if (!overlay) build();
    if (!overlay.hidden) return;
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.addEventListener("keydown", onKey);
    video.src = "/pressure.mp4";
    video.muted = false;
    var p = video.play();
    if (p && p.catch) p.catch(function () { video.controls = true; }); // blocked: let them press play
    overlay.querySelector(".egg-close").focus();
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    video.pause();
    try { video.currentTime = 0; } catch (e) { /* not loaded yet */ }
    video.removeAttribute("src"); // stop downloading too
    video.load();
    video.controls = false;
    overlay.hidden = true;
    document.removeEventListener("keydown", onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function onKey(e) { if (e.key === "Escape") close(); }

  credit.addEventListener("click", open);
  credit.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
})();
