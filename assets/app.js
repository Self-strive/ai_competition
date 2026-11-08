/*
 * app.js —— 页面交互主流程（页面分离版）
 * 首页 = 主功能区（输入 + 采集器）；每次分析结果独立成页；置顶导航随时切换。
 * 批次命名：采集器/主输入区填了商品名就用它，否则默认「商品1/商品2/…」自动递增。
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var inputEl = $("input");
  var productEl = $("product");
  var runBtn = $("runBtn");
  var scanner = $("scanner");
  var homeView = $("homeView");
  var resultView = $("resultView");
  var resultTitle = $("resultTitle");
  var verdictEl = $("verdict");
  var pieWrap = $("pieWrap");
  var rankList = $("rankList");
  var detailTitle = $("detailTitle");
  var detailBody = $("detailBody");
  var navHome = $("navHome"), navTabs = $("navTabs");

  /* ---------- 批次状态 ---------- */
  var batches = [];        // {id,name,product,rows,total,selectedDim}
  var currentBatchId = null;
  var currentView = "home"; // home | result
  var defaultSeq = 0;      // 「商品N」自增计数
  var seq = 0;

  function defaultName() { defaultSeq += 1; return "商品" + defaultSeq; }

  function findBatch(id) {
    for (var i = 0; i < batches.length; i++) if (batches[i].id === id) return batches[i];
    return null;
  }
  function activeBatch() { return findBatch(currentBatchId); }

  /* ---------- 视图切换 ---------- */
  function showView(v) {
    currentView = v;
    homeView.style.display = v === "home" ? "" : "none";
    resultView.style.display = v === "result" ? "" : "none";
    renderNav();
    window.scrollTo(0, 0);
  }
  function showHome() { currentBatchId = null; showView("home"); }
  function showBatch(id) {
    var b = findBatch(id);
    if (!b) { showHome(); return; }
    currentBatchId = id;
    showView("result");
    resultTitle.textContent = "📊 「" + b.name + "」· 分析结果";
    renderBatchResult(b);
    window.scrollTo(0, 0);
    // 批量检测完成 → 触发一次边框葡萄雨 / 流星（仅当本次由提交触发）
    if (window.GrapeFX && window.GrapeFX.ready && pendingBurst) {
      window.GrapeFX.borderBurst(pendingBurst.s, pendingBurst.shower);
      pendingBurst = null;
    }
  }

  /* ---------- 置顶导航渲染 ---------- */
  function renderNav() {
    navTabs.innerHTML = "";
    batches.forEach(function (b) {
      var el = document.createElement("div");
      el.className = "nav-item nav-batch" + (currentView === "result" && b.id === currentBatchId ? " active" : "");
      var s = document.createElement("span");
      s.className = "nav-name"; s.textContent = b.name; s.title = b.name;
      el.appendChild(s);
      var x = document.createElement("span");
      x.className = "nav-close"; x.textContent = "×"; x.title = "关闭该批次结果页";
      x.addEventListener("click", function (e) { e.stopPropagation(); closeBatch(b.id); });
      el.appendChild(x);
      el.addEventListener("click", function () { showBatch(b.id); });
      navTabs.appendChild(el);
    });
    navHome.className = "nav-item nav-home" + (currentView === "home" ? " active" : "");
  }

  function closeBatch(id) {
    var idx = -1;
    for (var i = 0; i < batches.length; i++) if (batches[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    batches.splice(idx, 1);
    if (currentBatchId === id) {
      currentBatchId = null;
      if (batches.length) showBatch(batches[Math.min(idx, batches.length - 1)].id);
      else showHome();
    } else {
      renderNav();
    }
  }

  if (navHome) navHome.addEventListener("click", showHome);

  /* ---------- 结果渲染（批次页共用一套 DOM，切换时按批次重绘） ---------- */
  function renderBatchResult(b) {
    verdictEl.innerHTML = "";
    pieWrap.innerHTML = "";
    rankList.innerHTML = "";
    detailTitle.textContent = "维度详情";
    detailBody.innerHTML = "";

    if (!b.rows || !b.rows.length) {
      verdictEl.innerHTML = "在 <b>" + b.total + "</b> 条评论中，没有识别出任何商品维度关键词" +
        "（新鲜度/口感/大小/份量/包装/物流/服务/价格/性价比）。<br>" +
        "<span style='color:var(--txt-dim);font-size:13px'>请检查输入是否为评论文本；若刚导入文件，可能是编码问题——本页已自动识别 UTF-8/GBK，如仍异常请用文本编辑器确认文件能正常显示中文。</span>";
      return;
    }

    var srcTag = b.source === "doubao" ? ' <span class="tag tag-cloud">☁ 豆包云端分析</span>' : '';

    var alertDims = b.rows.filter(function (r) { return r.alert; }).map(function (r) { return r.dim; });
    var warn = alertDims.length
      ? ' <span class="tag">⚠ 预警维度：' + alertDims.join("、") + "</span>"
      : "";
    var totalNeg = 0;
    b.rows.forEach(function (r) { totalNeg += r.neg; });
    var top = b.rows[0];
    var topPct = totalNeg > 0 ? (top.neg / totalNeg * 100).toFixed(1) : "0.0";

    // 无任何负面提及：结论改为好评，饼图由 chart.js 渲染为浅绿整圆，详情显示"继续保持"
    if (totalNeg === 0) {
      verdictEl.innerHTML =
        "结论：" + srcTag + "在 <b>" + b.total + "</b> 条评论中，共识别出 <b>" + b.rows.length +
        "</b> 个商品维度的提及，<b style='color:var(--green)'>未发现任何负面评论</b>——商品品质很好，继续保持！✅" +
        "<br><span style='color:var(--txt-dim);font-size:13px'>各维度提及均为正面或中性；可持续采集新批次评论进行监控。</span>";
      PieChart.render(pieWrap, b.rows, { onSelect: selectDim });
      renderRank(b.rows, true);
      showSatisfiedDetail(b);
      return;
    }

    verdictEl.innerHTML =
      "结论：" + srcTag + "在 <b>" + b.total + "</b> 条评论中，共识别出 <b>" + totalNeg +
      "</b> 条负面维度提及。其中 <b>" + b.product + "</b> 的<b>" + top.dim +
      "</b> 维度负面占比最高，达到 <b style='color:#ff4757'>" + topPct +
      "%</b>，已在饼图中突出显示。" + warn +
      "<br><span style='color:var(--txt-dim);font-size:13px'>饼图以各维度负面提及数占总负面提及数的百分比为权重；点击任意扇区可查看该维度的真实评论证据与改进建议。</span>";

    PieChart.render(pieWrap, b.rows, { onSelect: selectDim });
    renderRank(b.rows);
    if (b.selectedDim) selectDim(b.selectedDim);
    else selectDim(b.rows[0].dim);
  }

  // 无负面时的详情面板：总体好评 + 各维度正面构成
  function showSatisfiedDetail(b) {
    detailTitle.innerHTML = "🎉 总体评价" +
      ' <span class="pill">全部提及均为正面/中性</span>';
    var dimLines = b.rows.map(function (r) {
      return "<li><b>" + esc(r.dim) + "</b>：提及 " + r.mention + " 次，正面 " + r.pos + " 次" +
        (r.neu ? "，中性 " + r.neu + " 次" : "") + "，负面 0 次</li>";
    }).join("");
    detailBody.innerHTML =
      "<div class='kb-card' style='border-left-color:var(--green)'>" +
      "<div style='font-size:16px;font-weight:800;color:var(--green)'>✅ 商品品质很好，继续保持！</div>" +
      "<div style='margin-top:6px'>本批 " + b.total + " 条评论中未检测到负面维度提及，当前无需改进项。</div></div>" +
      "<div class='kb-title'>📌 各维度提及构成（均为正面/中性）</div>" +
      "<ul class='evi'>" + dimLines + "</ul>";
    detailBody.classList.remove("pop"); void detailBody.offsetWidth; detailBody.classList.add("pop");
  }

  function renderRank(rows, satisfied) {
    rankList.innerHTML = "";
    var maxRate = 0;
    rows.forEach(function (r) { if (r.neg_rate > maxRate) maxRate = r.neg_rate; });
    if (maxRate === 0) maxRate = 1;
    rows.forEach(function (r) {
      var kanoCls = satisfied ? "kano-charm" : (r.alert ? "kano-must" : (r.neg_rate >= 0.15 ? "kano-exp" : "kano-charm"));
      var kanoText = satisfied ? "满意" : r.kano;
      var rate = (r.neg_rate * 100).toFixed(1);
      var color = satisfied ? "var(--green)" : (r.alert ? "var(--red)" : (r.neg_rate >= 0.15 ? "var(--orange)" : "var(--green)"));
      var row = document.createElement("div");
      row.className = "rank-row";
      row.dataset.dim = r.dim;
      row.innerHTML =
        '<div class="rank-no">' + r.rank + '</div>' +
        '<div class="rank-body">' +
          '<div class="rank-name"><span>' + r.dim + '</span>' +
            '<span class="kano ' + kanoCls + '">' + kanoText + '</span></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:0%;background:' + color + '"></div></div>' +
        '</div>' +
        '<div class="rank-rate"><b>' + rate + '%</b><br><span style="font-size:11px">负面 ' + r.neg + '/' + r.mention + '</span></div>';
      row.addEventListener("click", function () {
        if (satisfied) { var b = activeBatch(); if (b) showSatisfiedDetail(b); }
        else selectDim(r.dim);
      });
      rankList.appendChild(row);
      setTimeout(function () {
        row.querySelector(".bar-fill").style.width = (satisfied ? 100 : (r.neg_rate / maxRate * 100)) + "%";
      }, 60);
    });
  }

  function selectDim(dim, hoverOnly) {
    var b = activeBatch();
    if (!b || !b.rows) return;
    var r = null;
    for (var i = 0; i < b.rows.length; i++) {
      if (b.rows[i].dim === dim) { r = b.rows[i]; break; }
    }
    if (!r) return;
    Array.prototype.forEach.call(rankList.children, function (el) {
      el.classList.toggle("active", el.dataset.dim === dim && !hoverOnly);
    });
    if (hoverOnly) return;
    b.selectedDim = dim;

    detailTitle.innerHTML = r.rank + " " + r.dim +
      ' <span class="pill' + (r.alert ? " alert" : "") + '">紧迫度 ' + r.score.toFixed(3) + "</span>" +
      ' <span class="pill' + (r.alert ? " alert" : "") + '">' + r.kano + "</span>";

    var evi = r.samples.length
      ? "<ul class='evi'>" + r.samples.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ul>"
      : "<div class='empty-tip'>该维度暂无典型负面评论样本</div>";

    var kbHtml = "";
    if (r.kb && r.kb.length) {
      kbHtml = r.kb.slice(0, 4).map(function (k) {
        return "<div class='kb-card'>" +
          "<div><b>痛点：</b><span class='c'>" + esc(k.complaint) + "</span>" +
          (k.evidence ? " <span style='color:var(--txt-dim)'>（" + esc(k.evidence) + "）</span>" : "") + "</div>" +
          "<div><b>给果农：</b><span class='m'>" + esc(k.measure) + "</span></div>" +
          "<div><b>给顾客话术：</b><span class='s'>" + esc(k.script) + "</span></div>" +
          "</div>";
      }).join("");
    } else {
      kbHtml = "<div class='empty-tip'>该维度暂未配置改进知识库条目</div>";
    }

    detailBody.innerHTML =
      "<div class='evi-title'>📌 真实负面评论证据（可追溯，非 AI 编造 · " + r.neg + "/" + r.mention + " 条负面）</div>" +
      evi +
      "<div class='kb-title'>🔧 改进建议（来自农产品改进措施知识库）</div>" +
      kbHtml;
    detailBody.classList.remove("pop"); void detailBody.offsetWidth; detailBody.classList.add("pop");
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------- 建批次并跳转 ---------- */
  function createBatch(comments, name, preset) {
    var res = preset || Engine.analyze(comments, name);
    var b = {
      id: "b" + Date.now() + "_" + (++seq),
      name: name, product: name,
      rows: res.rows, total: res.total, selectedDim: null,
      source: res.source || "local"
    };
    batches.push(b);
    return b;
  }

  // 进度控制器：豆包是一次性（或分批）HTTP 请求，调用期间没有真实进度信号，
  // 因此进度条只作「缓慢耐心指示」——匀速慢爬、封顶 92%，绝不提前虚标 99%；
  // 只有豆包真正返回（done）才跳 100%。真实进度由「已等待秒数」体现，多批时叠加真实台阶。
  function makeProgress(span, fill) {
    var k = 0, total = 1, done = false, displayed = 0, timer = null;
    var t0 = Date.now();
    var PACE = 0.2;     // 每 120ms 约 +0.2%（≈1.7%/秒），缓慢匀速上升
    var CAP = 92;       // 分析中封顶 92%，永不在完成前到 99%
    function fmt() {
      var sec = Math.round((Date.now() - t0) / 1000);
      if (done) return "✅ 豆包分析完成 · 100%";
      return "☁ 豆包分析中 · " + Math.round(displayed) + "%（第 " + Math.min(k + 1, total) + "/" + total + " 批 · 已 " + sec + " 秒）";
    }
    function paint() {
      if (span) span.textContent = fmt();
      if (fill) { fill.style.animation = "none"; fill.style.width = displayed + "%"; }
    }
    timer = setInterval(function () {
      if (done) { displayed = 100; paint(); clearInterval(timer); timer = null; return; }
      var target = Math.min(CAP, Math.round((k + 1) / total * 100)); // 真实下一档（单批时为 92）
      var floor = Math.round(k / total * 100);                        // 已完成批数对应的真实底线
      displayed = Math.min(target, displayed + PACE);
      if (displayed < floor) displayed = floor;
      paint();
    }, 120);
    return {
      update: function (p) {
        if (typeof p.total === "number" && p.total > 0) total = p.total;
        if (typeof p.done === "number") k = p.done;
        if (p.done >= p.total) done = true;
      },
      stop: function () { if (timer) { clearInterval(timer); timer = null; } }
    };
  }

  // 统一分析入口：云端开启且配置完整 → 调豆包；否则（或云端失败）→ 本地规则引擎兜底
  function doAnalyze(comments, name) {
    comments = (comments || []).filter(function (c) { return c && String(c).trim(); });
    if (!comments.length) { alert("请先粘贴、上传或截图识别评论内容。"); return; }
    name = name || defaultName();
    scanner.style.display = "flex";
    var span = scanner.querySelector("span");
    var fill = scanner.querySelector(".bar i");
    if (fill) { fill.style.animation = ""; fill.style.width = ""; } // 复位：本地模式用默认滑动动画
    span && (span.textContent = "AI 正在解析维度与情感…");

    if (window.Settings && window.Settings.isCloudOn() && window.CloudAnalyzer) {
      span && (span.textContent = "☁ 豆包准备中…");
      var prog = makeProgress(span, fill);
      window.CloudAnalyzer.analyzeComments(comments, name, function (p) { prog.update(p); }).then(function (res) {
        prog.stop();
        scanner.style.display = "none";
        var b = createBatch(comments, name, res);
        showBatch(b.id);
      }).catch(function (e) {
        prog.stop();
        scanner.style.display = "none";
        var b = createBatch(comments, name);   // 回退本地
        showBatch(b.id);
        window.toast && window.toast("云端分析失败，已自动改用本地引擎：" + (e && e.message ? e.message : "未知错误"), "err");
      });
    } else {
      setTimeout(function () {
        var b = createBatch(comments, name);
        scanner.style.display = "none";
        showBatch(b.id);
      }, 900);
    }
  }

  /* ---------- 提交（葡萄按钮接管：先播动画，落点再跑分析） ---------- */
  // 汇总评论：主输入框文本 + 采集器已解析 / 已 OCR 的评论（两处入口合一）
  function gatherComments() {
    var comments = [];
    var text = inputEl.value.trim();
    if (text) comments = Engine.parseInput(text);
    if (window.Collector && typeof window.Collector.getComments === "function") {
      (window.Collector.getComments() || []).forEach(function (t) {
        t = (t || "").trim();
        if (t && comments.indexOf(t) < 0) comments.push(t);
      });
    }
    return comments;
  }
  // 依据情感模型给出整体倾向（用于葡萄结尾差异化 + 边框动效基调）
  function dominantSentiment(list) {
    var p = 0, n = 0, u = 0;
    list.forEach(function (t) {
      var s = (window.Engine && typeof window.Engine.sentimentOf === "function") ? window.Engine.sentimentOf(t) : "";
      if (s === "pos") p++; else if (s === "neg") n++; else u++;
    });
    if (n >= p && n >= u) return "neg";
    if (p >= n && p >= u) return "pos";
    return "neu";
  }

  var lastSentiment = "neu";
  var posStreak = 0;
  var pendingBurst = null;

  // 真正的分析：交给统一入口 doAnalyze（本地 / 云端自动选择）
  function runAnalysis() {
    var comments = gatherComments();
    doAnalyze(comments, productEl.value.trim());
  }

  // 提交入口：交给葡萄动效模块；若动效不可用则直接分析
  function requestSubmit() {
    var comments = gatherComments();
    if (!comments.length) {
      if (window.GrapeFX && window.GrapeFX.ready) window.GrapeFX.nudgeEmpty();
      else runAnalysis();
      return;
    }
    lastSentiment = dominantSentiment(comments);
    if (lastSentiment === "pos") posStreak += 1; else posStreak = 0; // 连续 3 条以上好评 → 迷你雨
    var shower = posStreak >= 3;
    pendingBurst = { s: lastSentiment, shower: shower };
    if (window.GrapeFX && window.GrapeFX.ready) {
      window.GrapeFX.pick(lastSentiment, function () { runAnalysis(); }, shower);
    } else {
      runAnalysis();
    }
  }
  runBtn.addEventListener("click", requestSubmit);

  // 暴露给采集器「🚀 直接分析」：用采集器「商品名称」，空则默认「商品N」；分析完独立成页并跳转
  window.App = {
    analyzeInTab: function (comments, name) {
      if (!window.Engine) return;
      var finalName = (name && name.trim()) || defaultName();
      doAnalyze(comments, finalName);
    },
    runAnalysis: runAnalysis
  };

  /* ---------- 初始化 ---------- */
  showHome();

  // 载入示例
  $("loadDemo").addEventListener("click", function () {
    inputEl.value = (window.APP_DATA.DEMO || []).join("\n");
    productEl.value = "示例·山东阳光玫瑰葡萄";
  });

  // 导出结果报告 HTML：生成自包含静态报告（内联 SVG 饼图 + 排行 + 证据 + 建议）
  // 产物可离线打开、直接发送、打印为 PDF，或上传到静态托管变成可分享网址
  var exportReportBtn = $("exportReportBtn");
  if (exportReportBtn) exportReportBtn.addEventListener("click", function () {
    var b = activeBatch();
    if (!b || !b.rows || !b.rows.length) {
      window.toast && window.toast("请先生成分析结果，再导出报告", "err");
      return;
    }
    if (!window.ReportExport) {
      window.toast && window.toast("报告组件未加载：请确认 assets/report_export.js 存在", "err");
      return;
    }
    try {
      window.ReportExport.download(b);
      window.toast && window.toast("✅ 结果报告 HTML 已下载，可直接打开或上传分享", "ok");
    } catch (e) {
      window.toast && window.toast("导出失败：" + (e && e.message ? e.message : "未知错误"), "err");
    }
  });

  // 分享结果：调用系统分享 / 复制一句推广文案（注意：不导出结果图表），并触发一次边框葡萄雨 / 流星
  var shareBtn = $("shareBtn");
  if (shareBtn) shareBtn.addEventListener("click", function () {
    var b = activeBatch();
    var txt = "用「AI 商品维度洞察引擎」分析了" + (b ? "「" + b.name + "」" : "商品") + "的评论，自动算出了最该改进的维度～";
    if (navigator.share) { try { navigator.share({ title: "商品评论洞察", text: txt }); } catch (e) {} }
    else if (navigator.clipboard && navigator.clipboard.writeText) { try { navigator.clipboard.writeText(txt); shareBtn.textContent = "✅ 已复制"; setTimeout(function () { shareBtn.textContent = "🔗 分享结果（复制文案）"; }, 1500); } catch (e) {} }
    if (window.GrapeFX && window.GrapeFX.ready) window.GrapeFX.borderBurst(lastSentiment, true);
  });

  // 文件上传（自动识别 UTF-8 / GBK 等编码，兼容 Excel 另存的 CSV）
  $("fileInput").addEventListener("change", function (e) {
    var file = e.target.files[0];
    if (!file) return;
    function apply(text) {
      var comments = Engine.parseInput(text, file.name);
      inputEl.value = comments.join("\n");
      if (!productEl.value) productEl.value = file.name.replace(/\.[^.]+$/, "");
      if (!comments.length) {
        alert("未能从文件中解析出评论。\n请确认：CSV 需含「评论/评价」列，TXT 需每行一条评论。");
      }
    }
    if (window.Engine && window.Engine.readTextFile) {
      window.Engine.readTextFile(file).then(apply);
    } else {
      var reader = new FileReader();
      reader.onload = function (ev) { apply(ev.target.result); };
      reader.readAsText(file, "utf-8");
    }
  });

  // 采集器「一键清空」联动：清首页输入（已生成的批次结果页保留，可从导航回看）
  document.addEventListener("collector:clearall", function () {
    inputEl.value = "";
    productEl.value = "";
  });

  /* ---------- 明暗主题切换（白天 / 夜间，像番茄小说） ---------- */
  var themeBtn = $("themeToggle");
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    if (themeBtn) {
      themeBtn.querySelector(".ico").textContent = (t === "light") ? "☀️" : "🌙";
      themeBtn.querySelector(".lbl").textContent = (t === "light") ? "日间" : "夜间";
    }
    try { localStorage.setItem("app_theme", t); } catch (e) {}
  }
  function initTheme() {
    var t = "dark";
    try { t = localStorage.getItem("app_theme") || "dark"; } catch (e) {}
    applyTheme(t);
  }
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(cur === "light" ? "dark" : "light");
    });
  }
  initTheme();

  /* ---------- 桌面软件模式心跳：窗口关闭即退出本地服务器 ---------- */
  if (/[?&]app=1\b/.test(location.search)) {
    function ping() {
      try { fetch("/__hb__", { cache: "no-store" }).catch(function () {}); } catch (e) {}
    }
    ping();
    setInterval(ping, 4000);
    window.addEventListener("pagehide", function () {
      try { navigator.sendBeacon("/__bye__"); } catch (e) {}
    });
  }
})();
