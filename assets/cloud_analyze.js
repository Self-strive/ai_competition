/*
 * cloud_analyze.js —— 调用豆包（火山方舟）实现评论维度识别与图像识别
 * 设计：把豆包返回映射成与本地 Engine.analyze 完全一致的结果结构（rows 字段相同），
 *       这样前端渲染（饼图 / 紧迫度 / 维度详情 / KB 建议）完全不用改。
 *       KB 改进建议仍来自本地知识库（KB[r.dim]），保证建议质量与离线一致。
 */
(function (global) {
  "use strict";

  var D = global.APP_DATA || { DIM_ORDER: [], KB: {} };
  var KB = D.KB || {};
  var DIM_ORDER = D.DIM_ORDER || [];

  function dimHints() {
    return {
      "产品品质": "新鲜度/坏果/腐烂/品质/品相/产地/正宗/货不对板/发霉/生果/卖相",
      "口感味道": "甜/酸/好吃/难吃/多汁/口感/风味/清甜/酸涩/化渣/糖度",
      "大小规格": "个头/颗粒/大小/均匀/果径/规格/整齐",
      "重量份量": "重量/份量/缺斤少两/斤两/克数/缩水",
      "包装": "包装/礼盒/泡沫/破损/漏气/简陋",
      "物流运输": "物流/快递/发货/配送/时效/运输破损/慢",
      "服务": "客服/售后/态度/回复/退换/推诿",
      "价格": "价格/贵/便宜/划算/涨价/定价",
      "性价比": "性价比/值不值/物有所值/实惠"
    };
  }

  function buildSystemPrompt() {
    var hints = dimHints();
    var lines = DIM_ORDER.map(function (d, i) {
      return (i + 1) + ". " + d + "：" + (hints[d] || "");
    }).join("\n");
    return "你是一个电商商品评论维度分析器。给定一批消费者评论，请：\n" +
      "1) 判断每条评论涉及上述哪些维度（可多选）；\n" +
      "2) 对每条评论在每个所涉维度上判定情感：neg(负面)/pos(正面)/neu(中性)；\n" +
      "3) 仅输出 JSON，不要任何解释，也不要用 markdown 代码块包裹。\n\n" +
      "九个维度及关键词提示：\n" + lines + "\n\n" +
      "输出 JSON 结构：\n" +
      '{"rows":[{"dim":"维度名","mention":整数,"neg":整数,"pos":整数,"neu":整数,"samples":["负面评论原文1","负面评论原文2"...最多6条]}],"unmatched":整数}\n' +
      "规则：\n" +
      "- 只输出 mention>0 的维度；\n" +
      "- 一条评论在某个维度上只计一次情感（neg/pos/neu 三选一）；\n" +
      "- samples 为该维度下最具代表性的负面评论原文（逐字引用输入，单批最多3条，多批合并后去重至6条）；\n" +
      "- unmatched 为未命中任何维度的评论条数。";
  }

  function mapToRows(cloudRows, total) {
    var rows = [];
    var maxNeg = 1;
    (cloudRows || []).forEach(function (r) {
      r.mention = +r.mention || 0; r.neg = +r.neg || 0; r.pos = +r.pos || 0; r.neu = +r.neu || 0;
      r.samples = Array.isArray(r.samples) ? r.samples.slice(0, 6) : [];
      if (r.mention === 0) return;
      if (r.neg > maxNeg) maxNeg = r.neg;
      rows.push(r);
    });
    var maxRate = 0;
    rows.forEach(function (r) { var nr = r.neg / r.mention; if (nr > maxRate) maxRate = nr; });
    if (maxRate === 0) maxRate = 1;
    rows.forEach(function (r) {
      r.neg_rate = r.neg / r.mention;
      var impact = r.neg / maxNeg;
      var severity = r.neg_rate / maxRate;
      r.score = Math.round((0.6 * impact + 0.4 * severity) * 10000) / 10000;
    });
    rows.sort(function (a, b) { return b.score - a.score; });
    rows.forEach(function (r, i) {
      r.rank = i + 1;
      if (r.neg_rate >= 0.30) { r.kano = "必备型(必须改)"; r.alert = true; }
      else if (r.neg_rate >= 0.15) { r.kano = "期望型(应该改)"; r.alert = false; }
      else { r.kano = "魅力型(锦上添花)"; r.alert = false; }
      r.kb = KB[r.dim] || [];
    });
    var mentioned = rows.reduce(function (s, r) { return s + r.mention; }, 0);
    return { product: "", total: total, mentioned: mentioned, rows: rows, source: "doubao" };
  }

  function extractJSON(text) {
    if (!text) return null;
    text = String(text).trim();
    var m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m) text = m[1].trim();
    var s = text.indexOf("{"); var e = text.lastIndexOf("}");
    if (s >= 0 && e > s) text = text.slice(s, e + 1);
    try { return JSON.parse(text); } catch (err) { return null; }
  }

  // 单批失败自动重试一次（仅限非超时类错误，超时不再叠加等待）
  function isTimeoutErr(e) {
    return !!(e && e.message && /超时|timeout/i.test(e.message));
  }
  function callWithRetry(fn) {
    var tries = 0;
    function attempt() {
      return fn().catch(function (e) {
        tries += 1;
        if (tries < 2 && !isTimeoutErr(e)) return attempt();
        throw e;
      });
    }
    return attempt();
  }

  // 分批调用豆包：每批 50 条，逐批汇报真实进度（done/total/percent）
  function analyzeComments(comments, name, onProgress) {
    return new Promise(function (resolve, reject) {
      var cfg = global.Settings.get();
      comments = (comments || []).filter(function (c) { return c && String(c).trim(); });
      if (!comments.length) { reject(new Error("没有评论")); return; }
      var capped = comments.slice(0, 200);
      var BATCH = 50;
      var chunks = [];
      for (var i = 0; i < capped.length; i += BATCH) chunks.push(capped.slice(i, i + BATCH));
      var total = chunks.length;
      if (onProgress) onProgress({ stage: "准备", done: 0, total: total, percent: 0 });

      var acc = {}; // dim -> {dim, mention, neg, pos, neu, samples:[]}
      var chain = Promise.resolve();

      chunks.forEach(function (chunk, idx) {
        chain = chain.then(function () {
          return callWithRetry(function () {
            var start = idx * BATCH + 1;
            var end = idx * BATCH + chunk.length;
            var numbered = chunk.map(function (c, i) { return (i + 1) + ". " + c; }).join("\n");
            var sys = buildSystemPrompt();
            var user = "以下是商品「" + (name || "该商品") + "」的 " + capped.length +
              " 条评论，本批为第 " + (idx + 1) + "/" + total + " 批（第 " + start + "–" + end + " 条）：\n" +
              numbered + "\n\n请按系统要求输出 JSON。";
          return global.Doubao.callChat(
            [{ role: "system", content: sys }, { role: "user", content: user }],
            { model: cfg.textModel, apiKey: cfg.apiKey, proxy: cfg.proxy, temperature: 0.1, max_tokens: 1600, timeoutMs: 120000 }
          );
          }).then(function (res) {
            var ex = global.Doubao.extractText(res);
            if (!ex.ok) throw new Error(ex.error || "豆包返回错误");
            var json = extractJSON(ex.text);
            if (!json || !json.rows) throw new Error("第 " + (idx + 1) + " 批豆包返回格式无法解析，请重试或改用本地规则引擎");
            (json.rows || []).forEach(function (r) {
              var d = r.dim; if (!d) return;
              if (!acc[d]) acc[d] = { dim: d, mention: 0, neg: 0, pos: 0, neu: 0, samples: [] };
              acc[d].mention += (+r.mention || 0);
              acc[d].neg += (+r.neg || 0);
              acc[d].pos += (+r.pos || 0);
              acc[d].neu += (+r.neu || 0);
              (Array.isArray(r.samples) ? r.samples : []).forEach(function (s) {
                if (s && acc[d].samples.indexOf(s) < 0 && acc[d].samples.length < 6) acc[d].samples.push(s);
              });
            });
            if (onProgress) onProgress({ stage: "豆包分析中", done: idx + 1, total: total, percent: Math.round((idx + 1) / total * 100) });
          });
        });
      });

      chain.then(function () {
        var rowsArr = Object.keys(acc).map(function (k) { return acc[k]; });
        var result = mapToRows(rowsArr, comments.length);
        result.product = name || "该商品";
        resolve(result);
      }).catch(function (e) { reject(e); });
    });
  }

  function analyzeImage(dataUrl, prompt) {
    return new Promise(function (resolve, reject) {
      var cfg = global.Settings.get();
      var userContent = [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: prompt || "请识别这张图片：描述图中商品/场景，提取可见文字（如评论、标签、说明），并指出可能的问题点（如坏果、包装破损、信息不符）。用中文分条列出。" }
      ];
      global.Doubao.callChat(
        [{ role: "user", content: userContent }],
        { model: cfg.visionModel, apiKey: cfg.apiKey, proxy: cfg.proxy, temperature: 0.3, max_tokens: 800, timeoutMs: 120000 }
      ).then(function (res) {
        var ex = global.Doubao.extractText(res);
        if (!ex.ok) { reject(new Error(ex.error || "视觉识别失败")); return; }
        resolve(ex.text);
      }).catch(function (e) { reject(e); });
    });
  }

  global.CloudAnalyzer = {
    analyzeComments: analyzeComments,
    analyzeImage: analyzeImage,
    mapToRows: mapToRows
  };
})(window);
