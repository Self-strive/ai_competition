/*
 * settings.js —— 云端大模型（豆包 / 火山方舟）配置存储
 * 配置仅保存在本机浏览器 localStorage，不上传任何服务器。
 */
(function (global) {
  "use strict";

  var KEY = "app_doubao_v1";
  var DEFAULTS = {
    enabled: false,
    apiKey: "",
    textModel: "doubao-seed-2-1-lite-260915",
    visionModel: "doubao-seed-2-1-lite-260915",
    proxy: ""
  };

  var MIGRATE = {
    "doubao-seed-2-1-lite": "doubao-seed-2-1-lite-260915",
    "doubao-seed-2-1-pro": "doubao-seed-2-1-pro-260915",
    "doubao-seed-2-0-mini-260428": "doubao-seed-2-1-lite-260915"
  };
  function migrate(o) {
    if (MIGRATE[o.textModel]) o.textModel = MIGRATE[o.textModel];
    if (MIGRATE[o.visionModel]) o.visionModel = MIGRATE[o.visionModel];
    return o;
  }
  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      var o = JSON.parse(raw);
      return migrate(Object.assign({}, DEFAULTS, o));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function write(o) {
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {}
  }

  global.Settings = {
    get: read,
    set: function (patch) {
      var o = read();
      Object.assign(o, patch);
      write(o);
      return o;
    },
    isCloudOn: function () {
      var o = read();
      return !!o.enabled && !!o.apiKey;
    },
    clear: function () { try { localStorage.removeItem(KEY); } catch (e) {} }
  };
})(window);
