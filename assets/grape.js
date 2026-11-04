/*
 * grape.js —— 葡萄趣味交互动效模块（v2，自包含 / 离线可跑）
 * 职责：把「分析」按钮变成一串玻璃质感葡萄（Idle 葡萄），点击触发「摘葡萄」序列并联动结果反馈；
 *       日间葡萄雨 / 夜间流星边框特效；支持明暗主题、趣味动效开关、减少动态效果偏好。
 * 关键修复：① 葡萄配色用 SVG 渐变（不再依赖 data-theme CSS 变量，杜绝"灰葡萄"）；
 *          ② GSAP 本地优先（assets/gsap.min.js），缺失时自动降级为 CSS / Web Animations + 直接提交；
 *          ③ 增加「分析中 · 逐颗点亮」加载态，贴合"本地计算中"的观感。
 * 仅使用 transform / opacity / filter 动画属性。
 * 与 app.js 契约：点击时 app.js 调用 window.GrapeFX.pick(sentiment, onDone, shower)；
 *                 空输入时调用 window.GrapeFX.nudgeEmpty()；批次完成时调用 window.GrapeFX.borderBurst(s, shower)。
 */
(function () {
  "use strict";

  /* ===================== 核心可调参数 ===================== */
  var CONFIG = {
    idle: { breathDur: 3.4, wobbleMin: 2.1, wobbleMax: 3.0, sheenDur: 4.2 },
    pick: { handIn: 0.42, pinch: 0.18, load: 0.62, burst: 0.18, detach: 0.5, fly: 0.85,
            landBounce: 0.2, wither: 0.5, settle: 0.32 },
    border: { dayCount: 26, nightCount: 18, miniMul: 1.8, mobileMul: 0.5, maxParticles: 60 },
    burst: { sparks: 12 }
  };

  /* ===================== 运行态 ===================== */
  var btn, inputEl, fxFly, fxBorder, fxBtn, cluster, berries, hand, targetBerry;
  var hasGSAP = !!window.gsap;
  var reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var fxOff = false, busy = false, ready = false;

  function isNight() { return (document.documentElement.getAttribute("data-theme") || "dark") !== "light"; }
  function isMobile() { return !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function computeReady() { return !fxOff && !reducedMotion; }
  function refreshReady() { ready = computeReady(); if (window.GrapeFX) window.GrapeFX.ready = ready; }

  /* ===================== 葡萄串布局（viewBox 0 0 120 150） ===================== */
  // i = 加载态点亮顺序（自上而下）
  var BERRIES = [
    { x: 60, y: 34, r: 15, i: 0 },
    { x: 44, y: 53, r: 15, i: 1 }, { x: 60, y: 51, r: 15, i: 2 }, { x: 76, y: 53, r: 15, i: 3 },
    { x: 38, y: 73, r: 14, i: 4 }, { x: 54, y: 71, r: 14, i: 5 }, { x: 70, y: 71, r: 14, i: 6 }, { x: 84, y: 75, r: 14, i: 7 },
    { x: 48, y: 93, r: 13, i: 8 }, { x: 64, y: 93, r: 13, i: 9 }, { x: 78, y: 95, r: 13, i: 10 },
    { x: 60, y: 114, r: 12, i: 11 }
  ];

  function buildGrape(el) {
    var defs =
      '<defs>' +
        // 紫葡萄玻璃质感：中心亮紫 → 边缘深紫
        '<radialGradient id="grapeBody" cx="36%" cy="30%" r="78%">' +
          '<stop offset="0%" stop-color="#d9b6f2"/>' +
          '<stop offset="42%" stop-color="#9b4dd1"/>' +
          '<stop offset="100%" stop-color="#4f2275"/>' +
        '</radialGradient>' +
        // 中性（绿色）葡萄
        '<radialGradient id="grapeBodyGreen" cx="36%" cy="30%" r="78%">' +
          '<stop offset="0%" stop-color="#bff0cf"/>' +
          '<stop offset="45%" stop-color="#3fb56b"/>' +
          '<stop offset="100%" stop-color="#1d6b3a"/>' +
        '</radialGradient>' +
        // 高光镜面
        '<radialGradient id="grapeSheen" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>' +
          '<stop offset="60%" stop-color="#ffffff" stop-opacity="0.25"/>' +
          '<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>' +
        '</radialGradient>' +
      '</defs>';

    var grapes = "";
    BERRIES.forEach(function (b) {
      var wd = (CONFIG.idle.wobbleMin + (b.i % 3) * 0.32).toFixed(2) + "s";
      var sd = (CONFIG.idle.sheenDur + (b.i % 4) * 0.5).toFixed(2) + "s";
      grapes +=
        '<g transform="translate(' + b.x + ',' + b.y + ')">' +
          '<g class="berry" style="--i:' + b.i + ';--wd:' + wd + ';--sd:' + sd + '">' +
            '<circle class="body" r="' + b.r + '" fill="url(#grapeBody)" stroke="rgba(40,12,64,.55)" stroke-width="1.1"/>' +
            '<ellipse class="sheen" cx="' + (-b.r * 0.3) + '" cy="' + (-b.r * 0.36) + '" rx="' + (b.r * 0.42) + '" ry="' + (b.r * 0.58) + '" transform="rotate(-26)" fill="url(#grapeSheen)"/>' +
          '</g>' +
        '</g>';
    });

    var leaf =
      '<path class="leaf" d="M60 14 C58 2 70 2 74 10 C80 4 90 8 88 18 C80 22 70 20 64 24 C62 20 60 18 60 14 Z" ' +
      'fill="#4e9a3c" stroke="#2f6b22" stroke-width="0.8"/>' +
      '<path class="vine" d="M60 16 C60 0 62 -6 64 -10" stroke="#5a9a3c" stroke-width="2.4" fill="none" stroke-linecap="round"/>';

    var hand =
      '<svg class="grape-hand" viewBox="0 0 70 92" aria-hidden="true">' +
        '<g stroke="#d9c7ad" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">' +
          '<path fill="#ffffff" d="M28 6 c-5 0 -8 4 -8 9 v22 c0 3 -1 5 -4 6 c-5 2 -8 6 -8 12 c0 9 5 16 14 16 h22 ' +
          'c9 0 15 -6 15 -15 c0 -4 -1 -6 -3 -9 c1 -2 2 -4 2 -7 c0 -5 -4 -9 -9 -9 c-2 0 -3 1 -4 2 c-1 -5 -5 -8 -10 -8 c-1 0 -2 0 -3 0 c0 -5 -3 -9 -7 -9 z"/>' +
        '</g>' +
      '</svg>';

    el.innerHTML =
      '<span class="grape-label" aria-hidden="true">🚀 进行分析</span>' +
      '<svg class="grape-svg" viewBox="0 0 120 150" aria-hidden="true">' +
        defs +
        '<g class="grape-cluster">' + leaf + grapes + '</g>' +
      '</svg>' +
      hand;

    cluster = el.querySelector(".grape-cluster");
    berries = Array.prototype.slice.call(el.querySelectorAll(".berry"));
    targetBerry = berries[berries.length - 1];
    hand = el.querySelector(".grape-hand");
  }

  /* ===================== 状态 ===================== */
  function hasInput() {
    var t = inputEl && inputEl.value.trim();
    var c = (window.Collector && typeof window.Collector.getComments === "function") ? window.Collector.getComments() : [];
    return !!(t || (c && c.length));
  }
  function updateState() {
    if (!btn) return;
    var disabled = !hasInput();
    btn.classList.toggle("disabled", disabled);
    btn.classList.toggle("idle", ready && !busy); // 待机葡萄始终呼吸，不因未输入而变灰/停摆
    // 动效开启 → 显示葡萄；关闭 / 减少动态 → 显示原「🚀 进行分析」按钮
    btn.classList.toggle("show-grape", ready);
    btn.classList.toggle("show-label", !ready);
    btn.classList.remove("loading", "picking");
  }

  /* ===================== 空输入轻晃 ===================== */
  function nudgeEmpty() {
    if (!btn) return;
    if (btn.animate) btn.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-7px)" },
       { transform: "translateX(7px)" }, { transform: "translateX(0)" }],
      { duration: 320, easing: "ease-in-out" });
    // 提示文案同步轻晃，引导用户先去输入评论
    var hint = document.getElementById("grapeHint");
    if (hint) {
      hint.classList.remove("nudge"); void hint.offsetWidth; hint.classList.add("nudge");
      setTimeout(function () { hint.classList.remove("nudge"); }, 450);
    }
  }

  /* ===================== 金色星爆 + 闪光 ===================== */
  function spawnBurst(cx, cy, sentiment) {
    if (!fxFly) return;
    var flash = document.createElement("div");
    flash.className = "grape-flash-burst";
    flash.style.left = cx + "px"; flash.style.top = cy + "px";
    fxFly.appendChild(flash);
    if (hasGSAP) gsap.fromTo(flash, { scale: 0.2, opacity: 0.9 },
      { scale: 2.4, opacity: 0, duration: 0.5, ease: "power2.out", onComplete: function () { flash.remove(); } });
    else { flash.animate([{ transform: "scale(.2)", opacity: .9 }, { transform: "scale(2.4)", opacity: 0 }],
      { duration: 500 }).onfinish = function () { flash.remove(); }; }

    var col = isNight() ? "#ffe9a8" : (sentiment === "neg" ? "#ff9d5c" : "#ffd86b");
    var n = CONFIG.burst.sparks;
    for (var k = 0; k < n; k++) {
      var p = document.createElement("div");
      p.className = "grape-spark";
      p.textContent = isNight() ? "✦" : "·";
      p.style.left = cx + "px"; p.style.top = cy + "px"; p.style.color = col;
      p.style.fontSize = (isNight() ? 13 : 11) + "px";
      fxFly.appendChild(p);
      var ang = (Math.PI * 2 * k) / n + rand(-0.3, 0.3), dist = rand(26, 54);
      var dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
      if (hasGSAP) gsap.fromTo(p, { x: 0, y: 0, opacity: 1, scale: 0.5 },
        { x: dx, y: dy, opacity: 0, scale: 1, duration: 0.55, ease: "power1.out", onComplete: function () { p.remove(); } });
      else p.animate([{ transform: "translate(0,0)", opacity: 1 }, { transform: "translate(" + dx + "px," + dy + "px)", opacity: 0 }],
        { duration: 550 }).onfinish = function () { p.remove(); };
    }
  }

  /* ===================== 摘葡萄序列 ===================== */
  function pick(sentiment, onDone, shower) {
    if (!btn) { if (onDone) onDone(); return; }
    if (busy) { if (onDone) onDone(); return; }
    busy = true;
    btn.classList.remove("idle");
    btn.classList.add("picking");

    // 降级分支：无 GSAP → 闪光反馈后直接出结果；动效关闭 / 减少动态 → 干净直接提交（无动效）
    if (!hasGSAP || fxOff || reducedMotion) {
      if (!fxOff && !reducedMotion) {
        var r0 = btn.getBoundingClientRect();
        spawnBurst(r0.left + r0.width / 2, r0.top + r0.height / 2, sentiment);
      }
      if (onDone) onDone();
      busy = false; updateState();
      return;
    }

    var rect = btn.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

    var tl = gsap.timeline({
      onComplete: function () {
        if (hasGSAP) {
          var clearTargets = [btn.querySelector(".grape-svg"), cluster, hand].filter(Boolean);
          if (clearTargets.length) gsap.set(clearTargets, { clearProps: "transform,opacity" });
        }
        busy = false; updateState();
      }
    });

    // 1) 手型滑入并"捏住"葡萄
    tl.fromTo(hand, { x: 120, y: 40, opacity: 0, rotation: 18 },
                    { x: 6, y: -6, opacity: 1, rotation: -10, duration: CONFIG.pick.handIn, ease: "power2.out" });
    // 2) 指尖挤压果粒
    tl.to(targetBerry, { scaleX: 1.2, scaleY: 0.8, duration: CONFIG.pick.pinch, transformOrigin: "50% 40%", yoyo: true, repeat: 1, ease: "power1.inOut" }, ">");
    // 3) 分析中 · 逐颗点亮（加载态）
    tl.add(function () { btn.classList.add("loading"); }, ">");
    tl.to({}, { duration: CONFIG.pick.load });
    tl.add(function () { btn.classList.remove("loading"); }, ">");
    // 4) 摘下：汁水 / 星爆（紫色闪光反馈）—— 不再让葡萄飞向画面中央
    tl.add(function () { spawnBurst(cx, cy - 6, sentiment); }, ">");
    tl.to(cluster, { y: 12, scale: 0.93, duration: CONFIG.pick.detach, ease: "back.in(2)" }, "<");
    tl.to(hand, { x: 60, y: 30, opacity: 0, duration: 0.4, ease: "power1.in" }, "<");
    // 5) 触发分析（showBatch 切换结果页）
    tl.add(function () { if (onDone) onDone(); }, ">");
  }

  /* ===================== 边框：日间葡萄雨 / 夜间流星 ===================== */
  function borderBurst(sentiment, mini) {
    if (!btn || fxOff || reducedMotion || !fxBorder) return;
    sentiment = sentiment || "neu";
    var base = isNight() ? CONFIG.border.nightCount : CONFIG.border.dayCount;
    if (mini) base = Math.round(base * CONFIG.border.miniMul);
    if (isMobile()) base = Math.round(base * CONFIG.border.mobileMul);
    base = Math.min(base, CONFIG.border.maxParticles);
    for (var i = 0; i < base; i++) {
      if (isNight()) spawnMeteor(fxBorder, sentiment);
      else spawnGrapeRain(fxBorder, sentiment);
    }
  }

  /* 紫色葡萄雨：用自包含 SVG（自带紫色径向渐变），避免 emoji 在不同系统渲染成绿色 */
  function rainGrapeSVG() {
    var id = "rg" + (Math.random().toString(36).slice(2, 8));
    return '<svg class="rg-svg" viewBox="0 0 36 40" width="24" height="27" aria-hidden="true">' +
      '<defs><radialGradient id="' + id + '" cx="36%" cy="30%" r="78%">' +
        '<stop offset="0%" stop-color="#e3c4f5"/><stop offset="42%" stop-color="#9b4dd1"/><stop offset="100%" stop-color="#4f2275"/>' +
      '</radialGradient></defs>' +
      '<g stroke="rgba(40,12,64,.5)" stroke-width="1">' +
        '<circle cx="18" cy="9" r="6" fill="url(#' + id + ')"/>' +
        '<circle cx="11" cy="18" r="6" fill="url(#' + id + ')"/>' +
        '<circle cx="25" cy="18" r="6" fill="url(#' + id + ')"/>' +
        '<circle cx="18" cy="27" r="6" fill="url(#' + id + ')"/>' +
      '</g></svg>';
  }

  function spawnGrapeRain(layer, sentiment) {
    var el = document.createElement("div");
    var wither = (sentiment === "neg");
    el.className = "fx-grape" + (wither ? " wither" : "");
    el.innerHTML = rainGrapeSVG();
    var W = window.innerWidth, H = window.innerHeight, edge = Math.random();
    var sx, sy, ex, ey;
    if (edge < 0.75) { sx = Math.random() * W; sy = -30; ex = sx + rand(-30, 30); ey = H * 0.92; }
    else if (edge < 0.875) { sx = -20; sy = Math.random() * H * 0.6; ex = W * 0.06; ey = sy + H * 0.3; }
    else { sx = W + 20; sy = Math.random() * H * 0.6; ex = W * 0.94; ey = sy + H * 0.3; }
    layer.appendChild(el);
    var dur = (wither ? 1.1 : 1.8) + Math.random() * 0.8, delay = Math.random() * 0.6, rot = rand(0, 360);
    if (hasGSAP) {
      gsap.set(el, { x: sx, y: sy, rotation: rot, opacity: 0 });
      var tw = gsap.timeline({ delay: delay, onComplete: function () { el.remove(); } });
      tw.to(el, { opacity: 1, duration: 0.25 }, 0);
      tw.to(el, { x: ex, y: ey, rotation: rot + 160, duration: dur, ease: "linear" }, 0);
      if (!wither) tw.to(el, { y: ey - 18, duration: 0.16, yoyo: true, repeat: 1, ease: "power1.out" }, ">-0.12");
      tw.to(el, { opacity: 0, duration: 0.3 }, ">-0.2");
    } else {
      el.style.left = sx + "px"; el.style.top = sy + "px"; el.style.opacity = "0";
      el.style.transition = "transform " + dur + "s linear, opacity .4s";
      requestAnimationFrame(function () {
        el.style.opacity = "1";
        el.style.transform = "translate(" + (ex - sx) + "px," + (ey - sy) + "px) rotate(" + (rot + 160) + "deg)";
      });
      setTimeout(function () { el.remove(); }, (dur + delay) * 1000 + 600);
    }
  }

  function spawnMeteor(layer, sentiment) {
    var el = document.createElement("div");
    el.className = "fx-meteor";
    var c = sentiment === "pos" ? "#e9c46a" : sentiment === "neg" ? "#7b86c9" : "#dfe9ff";
    el.style.setProperty("--meteor-c", c);
    var W = window.innerWidth, H = window.innerHeight;
    var sx = Math.random() * W * 0.9, sy = -10 - Math.random() * H * 0.2;
    var ang = 28 + Math.random() * 18, len = 160 + Math.random() * 160;
    layer.appendChild(el);
    var dur = 0.9 + Math.random() * 0.7, delay = Math.random() * 0.8;
    var dx = Math.cos(ang * Math.PI / 180) * len * 2.2, dy = Math.sin(ang * Math.PI / 180) * len * 2.2;
    if (hasGSAP) {
      gsap.set(el, { x: sx, y: sy, rotation: ang, opacity: 0, transformOrigin: "right center" });
      var tw = gsap.timeline({ delay: delay, onComplete: function () { el.remove(); } });
      tw.to(el, { opacity: 1, duration: 0.2 }, 0);
      tw.to(el, { x: sx + dx, y: sy + dy, duration: dur, ease: "power1.in" }, 0);
      tw.to(el, { opacity: 0, duration: 0.3 }, ">-0.2");
    } else {
      el.style.left = sx + "px"; el.style.top = sy + "px";
      el.style.transform = "rotate(" + ang + "deg)"; el.style.opacity = "0";
      el.style.transition = "transform " + dur + "s linear, opacity .4s";
      requestAnimationFrame(function () {
        el.style.opacity = "1";
        el.style.transform = "rotate(" + ang + "deg) translate(" + dx + "px," + dy + "px)";
      });
      setTimeout(function () { el.remove(); }, (dur + delay) * 1000 + 600);
    }
  }

  /* ===================== 趣味动效开关 ===================== */
  function updateFxLabel() {
    if (!fxBtn) return;
    fxBtn.querySelector(".lbl").textContent = fxOff ? "动效关" : "动效";
    fxBtn.querySelector(".ico").textContent = fxOff ? "🚫" : "🍇";
  }
  function onFxToggle() {
    fxOff = !fxOff;
    document.documentElement.setAttribute("data-fx", fxOff ? "off" : "on");
    try { localStorage.setItem("app_fx", fxOff ? "off" : "on"); } catch (e) {}
    refreshReady(); updateState(); updateFxLabel();
    if (fxOff && fxBorder) fxBorder.innerHTML = "";
  }

  /* ===================== 初始化 ===================== */
  function init() {
    btn = document.getElementById("runBtn");
    if (!btn) return;
    inputEl = document.getElementById("input");
    fxFly = document.getElementById("fxFly");
    fxBorder = document.getElementById("fxBorder");
    fxBtn = document.getElementById("fxToggle");

    try { if (localStorage.getItem("app_fx") === "off") fxOff = true; } catch (e) {}
    document.documentElement.setAttribute("data-fx", fxOff ? "off" : "on"); // 初始即同步，按钮模式下提示文案才不会残留
    if (reducedMotion) document.documentElement.classList.add("reduced");

    buildGrape(btn);
    if (fxBtn) { updateFxLabel(); fxBtn.addEventListener("click", onFxToggle); }
    refreshReady();

    if (inputEl) inputEl.addEventListener("input", updateState);
    var cp = document.getElementById("collectPreview");
    if (cp && window.MutationObserver) new MutationObserver(updateState).observe(cp, { childList: true, subtree: true });
    updateState();

    window.GrapeFX = { ready: ready, pick: pick, nudgeEmpty: nudgeEmpty, borderBurst: borderBurst };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
