/*
 * doubao_client.js —— 豆包 / 火山方舟 API 调用封装
 * 调用策略：
 *   1) 当页面由本地服务器托管（http/https）时，优先走同源代理 /api/doubao，
 *      API Key 只发往本机 127.0.0.1，再由本地服务器转发给方舟，避免 Key 暴露在公网前端。
 *   2) 当以 file:// 直接打开时，无同源代理可用，改直连方舟接口
 *      （此时浏览器可能因 CORS 拦截，建议通过「启动本地服务器」运行以启用云端能力）。
 */
(function (global) {
  "use strict";

  var ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

  // 火山方舟错误结构可能是 {error: {message,code,...}} 对象，统一转成可读字符串
  function normError(j) {
    if (!j) return null;
    var e = j.error || j.error_msg || (j.data && j.data.error);
    if (!e) return null;
    if (typeof e === "string") return e;
    if (typeof e === "object") {
      if (e.message) return String(e.message);
      try { return JSON.stringify(e); } catch (_) {}
    }
    return null;
  }

  function servedByServer() {
    return location.protocol === "http:" || location.protocol === "https:";
  }

  function proxyCall(body, apiKey, proxy) {
    return fetch("/api/doubao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: body.model,
        messages: body.messages,
        api_key: apiKey,
        proxy: proxy || "",
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        thinking: body.thinking
      })
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) {}
        // 静态托管（GitHub Pages 等）没有 /api/doubao 后端：404 或返回非 JSON 时，自动改浏览器直连方舟（方舟支持 CORS）。
        if (r.status === 404 || !j) { return directCall(body, apiKey); }
        if (!r.ok || j.error) {
          return { ok: false, status: r.status, data: { error: normError(j) || "本地代理未返回有效结果（请确认已使用最新版本地服务器）" } };
        }
        return { ok: true, status: r.status, data: j };
      });
    }).catch(function () {
      // 本地无服务器（如纯静态托管）或代理不可达时，退回浏览器直连方舟
      return directCall(body, apiKey);
    });
  }

  function directCall(body, apiKey) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) {}
        if (!r.ok || !j || j.error) {
          return { ok: false, status: r.status, data: { error: normError(j) || ("方舟接口返回 " + r.status) } };
        }
        return { ok: true, status: r.status, data: j };
      });
    }).catch(function () {
      return { ok: false, data: { error: "直连方舟失败（可能被浏览器 CORS 拦截）。请改用『启动本地服务器』运行，以便走本地代理。" } };
    });
  }

  function callChat(messages, opts) {
    opts = opts || {};
    var body = {
      model: opts.model || "doubao-seed-2-1-lite-260915",
      messages: messages,
      temperature: (typeof opts.temperature === "number") ? opts.temperature : 0.2,
      max_tokens: (typeof opts.max_tokens === "number") ? opts.max_tokens : 1500,
      stream: false,
      // 关闭「深度思考」：该模型默认先思考再回答，分析 50 条评论要 30~60 秒；
      // 关闭后 2~3 秒直接出 JSON，速度提升 10 倍以上，分析质量不受影响。
      thinking: opts.thinking || { type: "disabled" }
    };
    var core = servedByServer() ? proxyCall(body, opts.apiKey || "", opts.proxy || "") : directCall(body, opts.apiKey || "");
    // 超时兜底：连接测试默认 25 秒；评论/图像分析可传更大 timeoutMs（模型冷启动较慢时避免被过早判失败）
    var timeoutMs = (typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) ? opts.timeoutMs : 25000;
    var timeoutP = new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ ok: false, data: { error: servedByServer()
          ? "连接本地代理超时（" + (timeoutMs / 1000) + " 秒无响应）。可能原因：① 模型冷启动较慢，请重试一次；② 校园网/公司网络需走系统代理而本地服务器未识别（已自动读取 Windows 代理，若仍失败可检查网络，或在服务器目录放置 doubao_config.json 写入 api_key 后重试）。"
          : "直连方舟超时（多半被浏览器 CORS 拦截）。请改用『启动本地服务器.bat』打开本软件，以便走本地代理。" } });
      }, timeoutMs);
    });
    return Promise.race([core, timeoutP]);
  }

  function extractText(res) {
    if (!res || !res.ok) {
      var msg = normError(res && res.data) || (res && res.status ? ("方舟接口返回 " + res.status) : "调用失败");
      return { ok: false, error: msg };
    }
    var c = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message;
    var text = "";
    if (c) text = (typeof c.content === "string") ? c.content : (c.content && c.content.text ? c.content.text : "");
    return { ok: true, text: text };
  }

  global.Doubao = { callChat: callChat, extractText: extractText, ENDPOINT: ENDPOINT };
})(window);
