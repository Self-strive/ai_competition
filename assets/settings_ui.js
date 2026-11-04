/*
 * settings_ui.js —— 设置弹窗 UI 与「连接测试」
 * 仅负责界面交互；配置读写走 settings.js（localStorage）。
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  // 全局轻提示
  window.toast = function (msg, kind) {
    var el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show" + (kind ? " " + kind : "");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = "toast"; }, 2600);
  };

  function syncCustom(selectId, inputId) {
    var sel = $(selectId), inp = $(inputId);
    if (!sel || !inp) return;
    function upd() {
      if (sel.value === "__custom__") { inp.style.display = ""; }
      else { inp.style.display = "none"; inp.value = ""; }
    }
    sel.addEventListener("change", upd);
    upd();
  }

  function loadToUI() {
    var cfg = window.Settings.get();
    if ($("setEnabled")) $("setEnabled").checked = !!cfg.enabled;
    if ($("setApiKey")) $("setApiKey").value = cfg.apiKey || "";
    if ($("setProxy")) $("setProxy").value = cfg.proxy || "";
    if ($("setTextModel")) {
      var tm = cfg.textModel, sel = $("setTextModel");
      if ([].some.call(sel.options, function (o) { return o.value === tm; })) sel.value = tm;
      else { sel.value = "__custom__"; $("setTextModelCustom").value = tm; $("setTextModelCustom").style.display = ""; }
    }
    if ($("setVisionModel")) {
      var vm = cfg.visionModel, sel = $("setVisionModel");
      if ([].some.call(sel.options, function (o) { return o.value === vm; })) sel.value = vm;
      else { sel.value = "__custom__"; $("setVisionModelCustom").value = vm; $("setVisionModelCustom").style.display = ""; }
    }
    reflectCloudOn();
  }

  function reflectCloudOn() {
    var btn = $("settingsBtn");
    if (btn) btn.classList.toggle("on", window.Settings.isCloudOn());
  }

  function readFromUI() {
    var enabled = $("setEnabled") ? $("setEnabled").checked : false;
    var apiKey = ($("setApiKey") ? $("setApiKey").value : "").trim();
    var textModel = $("setTextModel") ? $("setTextModel").value : "doubao-seed-2-1-lite-260915";
    if (textModel === "__custom__") textModel = ($("setTextModelCustom") ? $("setTextModelCustom").value : "").trim() || "doubao-seed-2-1-lite-260915";
    var visionModel = $("setVisionModel") ? $("setVisionModel").value : "doubao-seed-2-1-lite-260915";
    if (visionModel === "__custom__") visionModel = ($("setVisionModelCustom") ? $("setVisionModelCustom").value : "").trim() || "doubao-seed-2-1-lite-260915";
    var proxy = ($("setProxy") ? $("setProxy").value : "").trim();
    return { enabled: enabled, apiKey: apiKey, textModel: textModel, visionModel: visionModel, proxy: proxy };
  }

  function setStatus(msg, ok) {
    var el = $("setStatus");
    if (!el) return;
    el.textContent = msg;
    el.className = "set-status" + (ok === true ? " ok" : (ok === false ? " err" : ""));
  }

  function testConnection() {
    var btn = $("setTest");
    if (btn) btn.disabled = true;
    var cfg = readFromUI();
    if (!cfg.apiKey) { setStatus("请先填写 API Key", false); if (btn) btn.disabled = false; return; }
    setStatus("连接测试中…（最多 60 秒）");
    var model = cfg.textModel;
    window.Doubao.callChat(
      [{ role: "user", content: "你好，请只回复两个字：成功" }],
      { model: model, apiKey: cfg.apiKey, proxy: cfg.proxy, temperature: 0, max_tokens: 16, timeoutMs: 60000 }
    ).then(function (res) {
      var ex = window.Doubao.extractText(res);
      if (ex.ok && ex.text) setStatus("✅ 连接成功：" + ex.text.trim().slice(0, 20), true);
      else {
        var msg = ex.error || "调用失败";
        if (/Authentication|Unauthorized|401|api key/i.test(msg)) msg += "（Key 无效或未开通该模型，请到方舟控制台检查 API Key 与模型开通状态）";
        else if (/does not exist|access|not found/i.test(msg)) msg += "（模型未开通或无权限：请到火山方舟控制台『开通管理』开通 doubao-seed-2-1-lite-260915，再点连接测试）";
        else if (/timeout|超时/i.test(msg)) msg += "（若已通过本地服务器打开，可重试；模型冷启动偶尔较慢）";
        else if (/CORS|直连/i.test(msg)) msg += "（请改用『启动本地服务器.bat』打开，不要直接双击 index.html）";
        setStatus("❌ " + msg, false);
      }
    }).catch(function (e) { setStatus("❌ " + (e && e.message ? e.message : "调用失败"), false); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function save() {
    var cfg = readFromUI();
    if (cfg.enabled && !cfg.apiKey) {
      window.toast("启用云端需先填写 API Key", "err");
      setStatus("启用云端需先填写 API Key", false);
      return;
    }
    window.Settings.set(cfg);
    reflectCloudOn();
    window.toast(cfg.enabled ? "已保存，云端大模型已启用 ☁" : "已保存，使用本地规则引擎", "ok");
    setStatus("已保存", true);
    setTimeout(closeModal, 700);
  }

  function openModal() { var m = $("settingsModal"); if (m) m.style.display = "flex"; loadToUI(); }
  function closeModal() { var m = $("settingsModal"); if (m) m.style.display = "none"; setStatus(""); }

  function init() {
    var btn = $("settingsBtn");
    if (btn) btn.addEventListener("click", openModal);
    if ($("settingsClose")) $("settingsClose").addEventListener("click", closeModal);
    var backdrop = $("settingsModal");
    if (backdrop) backdrop.addEventListener("click", function (e) { if (e.target === backdrop) closeModal(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && backdrop && backdrop.style.display === "flex") closeModal(); });
    if ($("setSave")) $("setSave").addEventListener("click", save);
    if ($("setTest")) $("setTest").addEventListener("click", testConnection);
    if ($("setShowKey")) $("setShowKey").addEventListener("click", function () {
      var inp = $("setApiKey"); if (!inp) return;
      if (inp.type === "password") { inp.type = "text"; this.textContent = "隐藏"; }
      else { inp.type = "password"; this.textContent = "显示"; }
    });
    syncCustom("setTextModel", "setTextModelCustom");
    syncCustom("setVisionModel", "setVisionModelCustom");
    reflectCloudOn();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
