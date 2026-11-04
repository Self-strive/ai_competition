/*
 * engine.js —— 商品维度「待改进」自动计算引擎（纯前端移植版）
 * 逻辑与 Python engine.py 1:1 对应：
 *   维度归类(关键词命中) → 情感判定(情感词表) → 聚合 → 改进紧迫度 → KANO属性
 * 全部为规则计算，零 API 成本、可复算、可溯源。
 */
(function (global) {
  "use strict";

  var D = global.APP_DATA;
  var DIM_ORDER = D.DIM_ORDER;
  var DIM_TRIGGERS = D.DIM_TRIGGERS;
  var NEG_WORDS = new Set(D.NEG_WORDS);
  var POS_WORDS = new Set(D.POS_WORDS);
  var KB = D.KB;

  // 词表里有不少词同时出现在正/负面表中（新鲜、好吃、甜、很好、不错、便宜、很快…）。
  // 若正负都计数，正面评论会正负打平，被"偏向负面"规则误判为负面（如"无坏果""很新鲜"）。
  // 因此：同时出现在两张表里的词，只按正面计数。
  var NEG_EFFECTIVE = D.NEG_WORDS.filter(function (w) { return !POS_WORDS.has(w); });

  // 提及了哪些维度（关键词命中即算）
  function mentionDims(text) {
    var hits = [];
    for (var i = 0; i < DIM_ORDER.length; i++) {
      var d = DIM_ORDER[i];
      var words = DIM_TRIGGERS[d] || [];
      for (var j = 0; j < words.length; j++) {
        if (words[j] && text.indexOf(words[j]) !== -1) {
          hits.push(d);
          break;
        }
      }
    }
    return hits;
  }

  // ===== 数据驱动情感模型（由 水果通用评论_10000条.csv 训练得到）=====
  // 训练脚本：_build/train_sentiment.py。方法：字符 1~4 元文法 + 对数几率权重 +
  // 人工强负向兜底 + 非对称阈值。模型文件：assets/sentiment_model.js (global.SENT_MODEL)
  var SM = global.SENT_MODEL || { pos_terms: [], neg_terms: [], severe: [], threshold_neg: 0.2, threshold_pos: 1.2 };
  var SM_POS = {}, SM_NEG = {}, SM_SEVERE = {};
  (SM.pos_terms || []).forEach(function (p) { SM_POS[p[0]] = p[1]; });
  (SM.neg_terms || []).forEach(function (p) { SM_NEG[p[0]] = p[1]; });
  (SM.severe || []).forEach(function (w) { SM_SEVERE[w] = true; });
  var SM_TNEG = (typeof SM.threshold_neg === "number") ? SM.threshold_neg : 0.2;
  var SM_TPOS = (typeof SM.threshold_pos === "number") ? SM.threshold_pos : 1.2;

  // 否定前缀（用于翻转紧邻特征的符号，覆盖 不/没/无 + 不怎么/不是很/不是特别/没那么…）
  var NEG_PREFIX1 = ["不", "没", "无", "别", "未", "非"];
  var NEG_PREFIX2 = ["没有", "毫无", "并无", "不曾", "不太", "不很", "不够"];
  var NEG_PREFIX3 = ["不怎么", "不是很", "不是特别", "没有很", "没那么", "不那么", "不十分",
                     "谈不上", "不算很", "不算是", "并不", "也不", "也没"];
  function isNegated(text, i) {
    if (i >= 1 && NEG_PREFIX1.indexOf(text.slice(i - 1, i)) !== -1) return true;
    if (i >= 2 && NEG_PREFIX2.indexOf(text.slice(Math.max(0, i - 2), i)) !== -1) return true;
    if (i >= 3 && NEG_PREFIX3.indexOf(text.slice(Math.max(0, i - 3), i)) !== -1) return true;
    return false;
  }

  // 转折/让步连词：出现在它之前的“正面词”属于客套让步（如“味道还可以，就是有点酸”），
  // 真实态度往往在它之后，故把让步分句里的正面信号打折，避免“看似好评实则差评”被误判为正面。
  var CONTRAST = ["但是", "但", "可是", "可", "不过", "只是", "就是", "就是有点",
                 "可惜", "然而", "反倒", "反而", "话又说回来", "话说回来",
                 "没想到", "谁知道", "谁知", "更气人的是", "更要命的是", "最离谱的是",
                 "岂料", "谁料", "殊不知"];
  function hasContrastAfter(t, i) {
    for (var k = 0; k < CONTRAST.length; k++) {
      var p = t.indexOf(CONTRAST[k], i);
      if (p !== -1 && p >= i) return true;
    }
    return false;
  }

  // 整句级情感判定（加权模型）
  function sentimentOf(text) {
    var t = (text || "").replace(/\s+/g, "");
    // 一档致命负面：出现即强制判负（被否定前缀修饰的除外，如“没有发霉”）
    for (var s in SM_SEVERE) {
      var idx = t.indexOf(s);
      while (idx !== -1) {
        if (!isNegated(t, idx)) return "neg";
        idx = t.indexOf(s, idx + 1);
      }
    }
    var score = 0;
    var n = t.length;
    for (var i = 0; i < n; i++) {
      for (var L = 1; L <= 4; L++) {
        if (i + L > n) continue;
        var g = t.slice(i, i + L);
        // pos_terms 存的是“正面指示”权重（应为负向贡献），neg_terms 存“负面指示”权重（正向贡献）
        var w;
        if (g in SM_NEG) w = SM_NEG[g];
        else if (g in SM_POS) w = -SM_POS[g];
        else continue;
        if (L <= 2 && isNegated(t, i)) w = -w; // 否定翻转符号
        // 让步分句里的正面信号打折（转折词之后才是真实态度）
        if (w < 0 && hasContrastAfter(t, i)) w *= 0.25;
        score += w;
      }
    }
    // 非对称阈值：判“负面”门槛低（利于发现问题），判“正面”门槛高（避免误把负面当正面）
    if (score > SM_TNEG) return "neg";
    if (score < -SM_TPOS) return "pos";
    return "neu";
  }

  // 主分析函数
  function analyze(comments, productName) {
    productName = productName || "该商品";
    var stat = {};
    DIM_ORDER.forEach(function (d) {
      stat[d] = { mention: 0, neg: 0, pos: 0, neu: 0, samples: [] };
    });
    var total = comments.length;
    var mentioned = 0;

    comments.forEach(function (raw) {
      var c = (raw || "").trim();
      if (!c) return;
      var dims = mentionDims(c);
      if (!dims.length) return;
      mentioned++;
      var s = sentimentOf(c);
      dims.forEach(function (d) {
        var o = stat[d];
        o.mention++;
        if (s === "neg") {
          o.neg++;
          if (o.samples.length < 6) o.samples.push(c);
        } else if (s === "pos") {
          o.pos++;
        } else {
          o.neu++;
        }
      });
    });

    var rows = [];
    var maxNeg = 1;
    DIM_ORDER.forEach(function (d) {
      var o = stat[d];
      if (o.mention === 0) return;
      var negRate = o.neg / o.mention;
      if (o.neg > maxNeg) maxNeg = o.neg;
      rows.push({
        dim: d, mention: o.mention, neg: o.neg, pos: o.pos, neu: o.neu,
        neg_rate: negRate, samples: o.samples
      });
    });

    var maxRate = 0;
    rows.forEach(function (r) { if (r.neg_rate > maxRate) maxRate = r.neg_rate; });
    if (maxRate === 0) maxRate = 1;

    rows.forEach(function (r) {
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

    return {
      product: productName,
      total: total,
      mentioned: mentioned,
      rows: rows
    };
  }

  // ---------- 输入解析工具：编码识别 / CSV 切分 / 乱码修复 ----------
  // 中文 Windows 的 Excel「另存为 CSV」默认产出 GBK 无 BOM 文件，直接按 UTF-8 读会全文乱码，
  // 因此读文件必须做编码识别：BOM → UTF-8 严格 → GBK 回退。
  // cp1252 的 0x80-0x9F 区间字符 → 原始字节 的反查表（用于修复被错误解码的乱码文本）
  var CP1252_REV = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };

  // 修复「UTF-8/GBK 字节被当成 cp1252 解码」产生的乱码（如 çš„、ð 之类）
  function repairMojibake(text) {
    text = String(text == null ? "" : text);
    if (!/[ÃÂâ€ðÐÂ€™šœžŸƒ„…†‡ˆ‰Š‹ŒŽ''""•–—˜™›]/.test(text)) return text;
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (CP1252_REV[c] !== undefined) bytes.push(CP1252_REV[c]);
      else if (c <= 255) bytes.push(c);
      else return text; // 含正常中文等高位字符，说明不是纯乱码，不处理
    }
    try {
      var d = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      if (/[\u4e00-\u9fa5]/.test(d)) return d;
    } catch (e) { /* 不是 UTF-8 字节序列，继续试 GBK */ }
    try {
      var d2 = new TextDecoder("gbk").decode(new Uint8Array(bytes));
      if (/[\u4e00-\u9fa5]/.test(d2)) return d2;
    } catch (e2) { /* 保持原样 */ }
    return text;
  }

  // 按 CSV 规则切一行（处理英文双引号包裹、"" 转义）
  function splitCSVRow(line) {
    var cells = [], cur = "", inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (line.charAt(i + 1) === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  }

  // 读取文件为文本，自动识别编码（UTF-8 BOM / UTF-16LE BOM / UTF-8 / GBK）
  function readTextFile(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        var buf = new Uint8Array(ev.target.result || []);
        function strip(s) { return s.replace(/^\uFEFF/, ""); }
        try {
          if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
            resolve(strip(new TextDecoder("utf-8").decode(buf.subarray(3)))); return;
          }
          if (buf[0] === 0xFF && buf[1] === 0xFE) {
            resolve(strip(new TextDecoder("utf-16le").decode(buf.subarray(2)))); return;
          }
          resolve(strip(new TextDecoder("utf-8", { fatal: true }).decode(buf))); return;
        } catch (e) { /* 非 UTF-8，按 GBK 解 */ }
        try { resolve(new TextDecoder("gbk").decode(buf)); return; } catch (e2) { /* 再退 */ }
        resolve(new TextDecoder("utf-8").decode(buf));
      };
      reader.onerror = function () { resolve(""); };
      reader.readAsArrayBuffer(file);
    });
  }

  // 表头标签精确匹配（防止数据行里含"评论"二字被误判为表头）
  var HEADER_LABELS = ["评论", "评论内容", "评论原文", "评价", "评价内容", "评价原文",
    "内容", "留言", "review", "content", "text", "comment"];

  // 判断一行是否像 CSV 表头：某列是精确表头标签，或含「评论/评价」且同行还有「情感/评分/时间/商品」列
  function looksLikeCSVHeader(line) {
    var cells = splitCSVRow(line);
    if (cells.length < 2) return false;
    var hasComment = false, hasMeta = false;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i].trim().toLowerCase();
      if (HEADER_LABELS.indexOf(c) !== -1) return true;
      if (/评论|评价|review|留言/.test(c)) hasComment = true;
      if (/情感|评分|星级|时间|日期|商品|date|time/.test(c)) hasMeta = true;
    }
    return hasComment && hasMeta;
  }

  // 解析输入文本/CSV 字符串为评论数组
  function parseInput(text, fileName) {
    text = repairMojibake(String(text == null ? "" : text)).replace(/^\uFEFF/, "");
    var lines = [];
    var lower = (fileName || "").toLowerCase();
    var firstLine = (text.split(/\r?\n/)[0] || "");
    // .csv 文件按 CSV 解析；粘贴的内容首行像表头时也按 CSV 解析
    var isCSV = lower.endsWith(".csv") || (text.indexOf(",") !== -1 && looksLikeCSVHeader(firstLine));
    if (isCSV) {
      var rows = text.split(/\r?\n/).filter(function (r) { return r.trim(); });
      if (rows.length) {
        var header = splitCSVRow(rows[0]);
        var col = -1, headerHit = false;
        for (var h = 0; h < header.length; h++) {
          if (HEADER_LABELS.indexOf(header[h].trim().toLowerCase()) !== -1) { col = h; headerHit = true; break; }
        }
        if (!headerHit && looksLikeCSVHeader(rows[0])) {
          for (var h2 = 0; h2 < header.length; h2++) {
            if (/评论|评价|review|留言/i.test(header[h2].trim())) { col = h2; headerHit = true; break; }
          }
        }
        var start = 1;
        if (!headerHit) {
          // 无表头：跳过 0 行，取内容总量最大的列（通常是评论列）
          start = 0;
          var totals = [];
          rows.forEach(function (r) {
            splitCSVRow(r).forEach(function (c, i) { totals[i] = (totals[i] || 0) + c.length; });
          });
          col = 0;
          for (var i = 1; i < totals.length; i++) if (totals[i] > totals[col]) col = i;
        }
        for (var r = start; r < rows.length; r++) {
          var v = (splitCSVRow(rows[r])[col] || "").trim();
          if (v) lines.push(v);
        }
      }
    } else {
      // 按换行切分（每行一条）
      text.split(/[\n]+/).forEach(function (l) {
        l = l.trim();
        if (l) lines.push(l);
      });
    }
    return lines;
  }

  global.Engine = {
    analyze: analyze, mentionDims: mentionDims, sentimentOf: sentimentOf, parseInput: parseInput,
    repairMojibake: repairMojibake, splitCSVRow: splitCSVRow, readTextFile: readTextFile
  };
})(window);
