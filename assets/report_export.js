/*
 * report_export.js —— 「导出结果报告 HTML」生成器
 *
 * 目标：把当前批次的分析结果打包成一份完全自包含的静态 HTML 报告。
 *   · 无外部 CSS / JS / 图片 / 字体依赖，饼图用内联 SVG 现画；
 *   · 双击即可离线打开，可直接发送、打印为 PDF，或上传到任意静态托管变成网址；
 *   · 所有评论原文均做 HTML 转义，避免内容里的尖括号破坏报告结构。
 *
 * 对外接口：
 *   window.ReportExport.buildHTML(batch) -> 完整 HTML 字符串
 *   window.ReportExport.download(batch)  -> 触发浏览器下载 .html 文件
 *   window.ReportExport.preview(batch)  -> 新窗口预览（可选）
 */
(function (global) {
  "use strict";

  /* ---------------- 基础工具 ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : (d || 0);
  }

  function pct(v) { return (num(v) * 100).toFixed(1); }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function nowText() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function dateTag() {
    var d = new Date();
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  function safeFileName(name) {
    var s = String(name || "商品").replace(/[\\/:*?"<>|\r\n\t]/g, "_").trim();
    if (s.length > 40) s = s.slice(0, 40);
    if (!s) s = "商品";
    return "AI商品维度洞察引擎_结果报告_" + s + "_" + dateTag() + ".html";
  }

  // 与 chart.js 保持一致的维度配色
  var DIM_COLORS = {
    "产品品质": "#e5484d",
    "口感味道": "#f0733c",
    "大小规格": "#f59e0b",
    "重量份量": "#e3b341",
    "包装": "#22b8cf",
    "物流运输": "#3b6ef5",
    "服务": "#8b5cf6",
    "价格": "#22a06b",
    "性价比": "#0ea5a5"
  };
  function colorFor(dim) { return DIM_COLORS[dim] || "#64748b"; }

  /* ---------------- 内联 SVG 饼图 ---------------- */

  function polar(cx, cy, radius, deg) {
    var rad = (deg - 90) * Math.PI / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  }

  function arcPath(cx, cy, radius, startDeg, endDeg) {
    var s = polar(cx, cy, radius, endDeg);
    var e = polar(cx, cy, radius, startDeg);
    var large = (endDeg - startDeg) <= 180 ? 0 : 1;
    return "M " + cx + " " + cy +
      " L " + s[0].toFixed(2) + " " + s[1].toFixed(2) +
      " A " + radius + " " + radius + " 0 " + large + " 0 " + e[0].toFixed(2) + " " + e[1].toFixed(2) + " Z";
  }

  // 返回 {svg, legend}，rows 需已含 neg 字段
  function pieSVG(rows) {
    var active = rows.filter(function (r) { return num(r.neg) > 0; });
    var totalNeg = 0;
    active.forEach(function (r) { totalNeg += num(r.neg); });
    if (totalNeg <= 0) return satisfiedPie(rows);

    // 占比只存在局部数组，不写回 batch.rows，避免导出动作污染页面当前数据
    var pcts = active.map(function (r) { return num(r.neg) / totalNeg; });
    var maxIdx = 0;
    pcts.forEach(function (p, i) { if (p > pcts[maxIdx]) maxIdx = i; });
    var top = active[maxIdx];
    var topPct = pcts[maxIdx];

    var SIZE = 460, C = SIZE / 2, R = 150, EXPLODE = 22;
    var parts = [];
    parts.push('<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" class="pie" role="img" aria-label="各维度负面提及占比饼图" xmlns="http://www.w3.org/2000/svg">');
    parts.push('<defs><filter id="ds" x="-40%" y="-40%" width="180%" height="180%">' +
      '<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#0f172a" flood-opacity="0.18"/>' +
      '</filter></defs>');
    parts.push('<circle cx="' + C + '" cy="' + C + '" r="' + (R + 8) + '" fill="#ffffff" filter="url(#ds)"/>');

    var start = 0;
    active.forEach(function (r, idx) {
      var ang = pcts[idx] * 360;
      if (ang > 359.99) ang = 359.99;
      var end = start + ang;
      var mid = start + ang / 2;
      var off = (idx === maxIdx) ? EXPLODE : 0;
      var cc = polar(C, C, off, mid);
      var col = colorFor(r.dim);
      parts.push('<path d="' + arcPath(cc[0], cc[1], R, start, end) + '" fill="' + col +
        '" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>');

      // 仅大扇区在内部标注一个百分比；维度名与全部占比统一放右侧图例。
      // 小扇区（<40°）不写字，避免相邻标签互相压叠——这是静态打印报告，清爽比堆字重要。
      if (ang >= 40 && ang < 300) {
        var lr = (idx === maxIdx) ? R * 0.62 : R * 0.70;
        var lp = polar(cc[0], cc[1], lr, mid);
        parts.push('<text x="' + lp[0].toFixed(2) + '" y="' + (lp[1] + 5).toFixed(2) +
          '" text-anchor="middle" class="pl-pct">' + pct(pcts[idx]) + '%</text>');
      }
      start = end;
    });

    // 中心白底标签块：保证中心文字在任何配色下都清晰
    parts.push('<circle cx="' + C + '" cy="' + C + '" r="74" fill="#ffffff" opacity="0.96"/>');
    parts.push('<circle cx="' + C + '" cy="' + C + '" r="74" fill="none" stroke="#e2e8f0" stroke-width="1.5"/>');
    parts.push('<text x="' + C + '" y="' + (C - 24) + '" text-anchor="middle" class="pc-top">首要改进</text>');
    parts.push('<text x="' + C + '" y="' + (C + 6) + '" text-anchor="middle" class="pc-dim">' + esc(top.dim) + '</text>');
    parts.push('<text x="' + C + '" y="' + (C + 32) + '" text-anchor="middle" class="pc-pct">' +
      pct(topPct) + '% 占全部负面</text>');
    parts.push('</svg>');

    // 图例：完整列出每个维度（含小扇区）的名称、占比与负面条数
    var legend = ['<div class="legend">'];
    active.forEach(function (r, i) {
      var col = colorFor(r.dim);
      legend.push('<div class="lg-item' + (i === maxIdx ? ' lg-top' : '') + '">' +
        '<i style="background:' + col + '"></i>' +
        '<span class="lg-name">' + esc(r.dim) + '</span>' +
        '<span class="lg-val">' + pct(pcts[i]) + '% · 负面 ' + num(r.neg) + ' 条</span>' +
        '</div>');
    });
    legend.push('</div>');

    return { svg: parts.join(""), legend: legend.join(""), totalNeg: totalNeg, top: top };
  }

  function satisfiedPie(rows) {
    var C = 230;
    var svg = '<svg viewBox="0 0 460 460" class="pie" role="img" aria-label="未发现负面评论" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="' + C + '" cy="' + C + '" r="150" fill="#d7f2e3" stroke="#ffffff" stroke-width="3"/>' +
      '<circle cx="' + C + '" cy="' + C + '" r="112" fill="#ffffff"/>' +
      '<text x="' + C + '" y="' + (C - 18) + '" text-anchor="middle" class="pc-top">检测结果</text>' +
      '<text x="' + C + '" y="' + (C + 16) + '" text-anchor="middle" class="ok-dim">品质令人满意</text>' +
      '<text x="' + C + '" y="' + (C + 44) + '" text-anchor="middle" class="pc-pct">未发现负面维度提及</text>' +
      '</svg>';
    var legend = '<div class="legend">' + rows.map(function (r) {
      return '<div class="lg-item"><i style="background:#86d9ae"></i>' +
        '<span class="lg-name">' + esc(r.dim) + '</span>' +
        '<span class="lg-val">提及 ' + num(r.mention) + ' 次 · 正面 ' + num(r.pos) + '</span></div>';
    }).join("") + '</div>';
    return { svg: svg, legend: legend, totalNeg: 0, top: null };
  }

  /* ---------------- 各区块渲染 ---------------- */

  function metricCards(b, pie) {
    var dimCount = (b.rows || []).length;
    var alertCount = (b.rows || []).filter(function (r) { return r.alert; }).length;
    var items = [
      { k: "分析评论", v: num(b.total), u: "条" },
      { k: "负面维度提及", v: pie.totalNeg, u: "条" },
      { k: "识别维度", v: dimCount, u: "个" },
      { k: "预警维度", v: alertCount, u: "个" }
    ];
    return '<div class="metrics">' + items.map(function (it) {
      return '<div class="metric"><div class="m-k">' + it.k + '</div>' +
        '<div class="m-v">' + it.v + '<small>' + it.u + '</small></div></div>';
    }).join("") + '</div>';
  }

  function verdictBlock(b, pie) {
    if (!pie.totalNeg) {
      return '<div class="verdict ok"><span class="v-tag">结论</span>' +
        '在 <b>' + num(b.total) + '</b> 条评论中，共识别 <b>' + (b.rows || []).length +
        '</b> 个维度提及，<b>未发现任何负面评论</b> —— 商品品质很好，继续保持。✅' +
        '<div class="v-note">各维度提及均为正面或中性；可持续采集新批次评论进行监控。</div></div>';
    }
    var alerts = (b.rows || []).filter(function (r) { return r.alert; }).map(function (r) { return r.dim; });
    var topPct = pie.totalNeg > 0 ? (num(pie.top.neg) / pie.totalNeg * 100).toFixed(1) : "0.0";
    return '<div class="verdict"><span class="v-tag">结论</span>' +
      '在 <b>' + num(b.total) + '</b> 条评论中，共识别出 <b>' + pie.totalNeg +
      '</b> 条负面维度提及。其中 <b>' + esc(b.product || b.name) + '</b> 的 <b>' + esc(pie.top.dim) +
      '</b> 维度负面提及最多，占全部负面提及的 <b class="hi">' + topPct + '%</b>（' +
      num(pie.top.neg) + '/' + pie.totalNeg + ' 条），为当前首要改进项。' +
      (alerts.length ? '<div class="warn">⚠ 预警维度（必备型 · 必须改）：' + esc(alerts.join("、")) + '</div>' : '') +
      '<div class="v-note">口径说明：此处与饼图的百分比是「该维度负面数 ÷ 总负面数」；排行表中的「负面占比」是「该维度负面数 ÷ 该维度提及数」，两者含义不同。紧迫度再叠加负面绝对数量与负面占比计算。</div>' +
      '</div>';
  }

  function rankBlock(rows, satisfied) {
    var maxRate = 0;
    rows.forEach(function (r) { if (num(r.neg_rate) > maxRate) maxRate = num(r.neg_rate); });
    if (maxRate <= 0) maxRate = 1;

    var body = rows.map(function (r) {
      var rate = num(r.neg_rate);
      var rateTxt = pct(rate) + "%";
      var w = satisfied ? 100 : Math.max(2, rate / maxRate * 100);
      var cls = satisfied ? "ok" : (r.alert ? "must" : (rate >= 0.15 ? "exp" : "charm"));
      var kano = satisfied ? "满意" : (r.kano || "—");
      var color = satisfied ? "#22a06b" : (r.alert ? "#e5484d" : (rate >= 0.15 ? "#f59e0b" : "#22a06b"));
      return '<tr>' +
        '<td class="c-rank">' + num(r.rank) + '</td>' +
        '<td class="c-dim"><b>' + esc(r.dim) + '</b></td>' +
        '<td><span class="kano ' + cls + '">' + esc(kano) + '</span></td>' +
        '<td class="c-rate"><b>' + rateTxt + '</b><span class="sub">负面 ' + num(r.neg) + '/' + num(r.mention) + '</span></td>' +
        '<td class="c-bar"><div class="track"><i style="width:' + w.toFixed(1) + '%;background:' + color + '"></i></div></td>' +
        '<td class="c-score">' + (isFinite(num(r.score, NaN)) ? num(r.score).toFixed(3) : "—") + '</td>' +
        '</tr>';
    }).join("");

    return '<section class="card"><h2><span class="h-ico">02</span>改进紧迫度排行</h2>' +
      '<p class="lead">紧迫度 = 0.6 × 负面绝对数量（归一化）+ 0.4 × 负面占比（归一化）。' +
      '因此「负面占比高但提及少」的维度不会挤到最前，避免被个别极端评价带偏。</p>' +
      '<table class="rank-tb"><thead><tr>' +
      '<th>排名</th><th>维度</th><th>KANO 分组</th><th>负面占比</th><th>相对水平</th><th>紧迫度</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></section>';
  }

  function evidenceBlock(rows) {
    var blocks = rows.map(function (r) {
      var samples = Array.isArray(r.samples) ? r.samples.filter(Boolean) : [];
      var evi = samples.length
        ? '<ul class="evi">' + samples.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join("") + '</ul>'
        : '<p class="empty">该维度暂无典型负面评论样本。</p>';
      var kb = Array.isArray(r.kb) ? r.kb.slice(0, 4) : [];
      var kbHtml = kb.length
        ? kb.map(function (k) {
          return '<div class="kb">' +
            '<div class="kb-row"><span class="kb-lb">痛点</span><span>' + esc(k.complaint) +
            (k.evidence ? ' <em>（' + esc(k.evidence) + '）</em>' : '') + '</span></div>' +
            '<div class="kb-row"><span class="kb-lb">给果农</span><span>' + esc(k.measure) + '</span></div>' +
            '<div class="kb-row"><span class="kb-lb">顾客话术</span><span>' + esc(k.script) + '</span></div>' +
            '</div>';
        }).join("")
        : '<p class="empty">该维度暂未配置改进知识库条目。</p>';

      return '<div class="dim-block">' +
        '<div class="dim-head"><span class="dim-no">' + num(r.rank) + '</span>' +
        '<h3>' + esc(r.dim) + '</h3>' +
        '<span class="dim-stat">负面 ' + num(r.neg) + ' / 提及 ' + num(r.mention) +
        ' · 占比 ' + pct(r.neg_rate) + '% · 紧迫度 ' +
        (isFinite(num(r.score, NaN)) ? num(r.score).toFixed(3) : "—") + '</span></div>' +
        '<div class="dim-cols"><div class="dim-col">' +
        '<h4>📌 真实负面评论证据</h4>' +
        '<p class="col-note">逐字引用输入评论，可追溯，非生成内容。</p>' + evi +
        '</div><div class="dim-col"><h4>🔧 改进建议</h4>' +
        '<p class="col-note">来自农产品改进措施知识库与冷链 / 分级国标。</p>' + kbHtml +
        '</div></div></div>';
    }).join("");

    return '<section class="card"><h2><span class="h-ico">03</span>逐维度证据与改进建议</h2>' +
      '<p class="lead">每个维度同时给出「消费者原话」与「可执行动作」，便于商家核对结论、直接落地整改。</p>' +
      blocks + '</section>';
  }

  function methodBlock(b) {
    var srcTxt = b.source === "doubao"
      ? "豆包 Seed 2.1 Lite（火山方舟云端语义通道）"
      : "本地规则引擎（字符 1–4 元文法 + 对数几率权重词表）";
    return '<section class="card"><h2><span class="h-ico">04</span>计算方法与数据说明</h2>' +
      '<div class="method-grid">' +
      '<div class="m-item"><h4>分析链路</h4><p>评论输入 → 清洗去噪 → 情感判定 → 维度归类 → 紧迫度计算 → 生成证据与建议。全程五步，结论可逐条回溯到原始评论。</p></div>' +
      '<div class="m-item"><h4>九维度体系</h4><p>产品品质、口感味道、大小规格、重量份量、包装、物流运输、服务、价格、性价比。参考郭之昊等(2026)《农业工程学报》葡萄电商评论标注方案。</p></div>' +
      '<div class="m-item"><h4>KANO 分级</h4><p>负面占比 ≥ 30% 判为「必备型(必须改)」并预警；15%–30% 为「期望型(应该改)」；&lt; 15% 为「魅力型(锦上添花)」。</p></div>' +
      '<div class="m-item"><h4>本次识别通道</h4><p>' + esc(srcTxt) +
      '。软件默认本地优先、断网可跑；启用云端后由大模型做语义判定，失败自动回退本地引擎。</p></div>' +
      '<div class="m-item"><h4>数据与隐私</h4><p>评论数据在本机浏览器内处理，不上传服务器。评测集由团队自建标注，训练语料取自 GitHub 开源中文电商评论集；报告不含账号、订单等个人标识信息。</p></div>' +
      '<div class="m-item"><h4>复算说明</h4><p>将同一批评论重新粘贴进工具即可得到一致结果；报告为静态快照，不含可交互脚本，适合归档、打印与评审留档。</p></div>' +
      '</div></section>';
  }

  /* ---------------- 组装完整 HTML ---------------- */

  var CSS = [
    '*{box-sizing:border-box}',
    'html,body{margin:0;padding:0}',
    'body{background:#eef2f7;color:#1e293b;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '.page{max-width:1040px;margin:0 auto;background:#fff;box-shadow:0 6px 30px rgba(15,23,42,.08)}',
    '.hero{background:linear-gradient(120deg,#1e3a5f 0%,#2b4f8a 55%,#5b4bb7 100%);color:#fff;padding:38px 46px 34px}',
    '.hero .eyebrow{font-size:12px;letter-spacing:2px;opacity:.8;margin-bottom:10px}',
    '.hero h1{margin:0 0 8px;font-size:30px;letter-spacing:1px}',
    '.hero .sub{margin:0;font-size:14px;opacity:.88}',
    '.hero .meta{margin-top:22px;display:flex;flex-wrap:wrap;gap:10px}',
    '.hero .meta span{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);border-radius:20px;padding:5px 13px;font-size:12.5px}',
    '.body{padding:30px 46px 46px}',
    '.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}',
    '.metric{background:#f7f9fc;border:1px solid #e6ecf3;border-radius:12px;padding:14px 16px}',
    '.m-k{font-size:12px;color:#64748b;margin-bottom:4px}',
    '.m-v{font-size:26px;font-weight:800;color:#1e3a5f;line-height:1.2}',
    '.m-v small{font-size:12px;font-weight:600;color:#64748b;margin-left:4px}',
    '.verdict{background:#fff7f7;border:1px solid #f7d7d9;border-left:4px solid #e5484d;border-radius:10px;padding:16px 20px;margin-bottom:26px;font-size:15px}',
    '.verdict.ok{background:#f2fbf6;border-color:#c8ecd8;border-left-color:#22a06b}',
    '.v-tag{display:inline-block;background:#e5484d;color:#fff;font-size:12px;font-weight:700;border-radius:5px;padding:2px 9px;margin-right:8px}',
    '.verdict.ok .v-tag{background:#22a06b}',
    '.verdict .hi{color:#e5484d;font-size:17px}',
    '.v-note{color:#64748b;font-size:12.5px;margin-top:8px}',
    '.warn{margin-top:10px;background:#fff0f0;border-radius:6px;padding:7px 11px;color:#c0392b;font-size:13.5px;font-weight:600}',
    'section.card{margin:0 0 26px;border:1px solid #e6ecf3;border-radius:14px;padding:22px 24px;break-inside:avoid}',
    'section.card h2{margin:0 0 6px;font-size:19px;color:#1e3a5f;display:flex;align-items:center;gap:10px}',
    '.h-ico{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;background:#1e3a5f;color:#fff;font-size:12px;font-weight:700;letter-spacing:0}',
    '.lead{margin:0 0 18px;color:#64748b;font-size:13px}',
    '.pie-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:center}',
    '.pie{width:100%;max-width:400px;height:auto;display:block;margin:0 auto}',
    '.pl-dim{fill:#fff;font-size:13px;font-weight:700;paint-order:stroke;stroke:rgba(15,23,42,.55);stroke-width:3px;stroke-linejoin:round}',
    '.pl-pct{fill:#fff;font-size:14px;font-weight:800;paint-order:stroke;stroke:rgba(15,23,42,.55);stroke-width:3px;stroke-linejoin:round}',
    '.pc-top{fill:#64748b;font-size:13px;letter-spacing:2px}',
    '.pc-dim{fill:#1e3a5f;font-size:21px;font-weight:800}',
    '.pc-pct{fill:#64748b;font-size:12px;font-weight:600}',
    '.ok-dim{fill:#15803d;font-size:21px;font-weight:800}',
    '.legend{display:grid;grid-template-columns:1fr;gap:7px}',
    '.lg-item{display:flex;align-items:center;gap:9px;font-size:13px;padding:6px 9px;border-radius:7px;background:#f7f9fc}',
    '.lg-top{background:#fff1f1;font-weight:700}',
    '.lg-item i{width:11px;height:11px;border-radius:3px;flex:none}',
    '.lg-name{flex:1}',
    '.lg-val{color:#64748b;font-size:12px}',
    'table.rank-tb{width:100%;border-collapse:collapse;font-size:13.5px}',
    'table.rank-tb th{background:#f7f9fc;color:#475569;font-size:12px;font-weight:700;text-align:left;padding:10px 10px;border-bottom:1px solid #e6ecf3;white-space:nowrap}',
    'table.rank-tb td{padding:11px 10px;border-bottom:1px solid #f0f3f8;vertical-align:middle}',
    'table.rank-tb tr:last-child td{border-bottom:none}',
    '.c-rank{width:44px;color:#94a3b8;font-weight:800;font-size:16px}',
    '.c-dim{white-space:nowrap}',
    '.c-rate{white-space:nowrap;width:96px}',
    '.c-rate .sub{display:block;color:#94a3b8;font-size:11px;font-weight:400}',
    '.c-score{width:70px;color:#64748b;font-variant-numeric:tabular-nums}',
    '.c-bar{width:28%}',
    '.track{height:8px;background:#eef2f7;border-radius:5px;overflow:hidden}',
    '.track i{display:block;height:100%;border-radius:5px}',
    '.kano{display:inline-block;font-size:11.5px;font-weight:700;border-radius:5px;padding:3px 8px;white-space:nowrap}',
    '.kano.must{background:#fdecec;color:#c0392b}',
    '.kano.exp{background:#fff4e2;color:#b45309}',
    '.kano.charm{background:#e8f6ef;color:#15803d}',
    '.kano.ok{background:#e8f6ef;color:#15803d}',
    '.dim-block{border-top:1px solid #eef2f7;padding-top:18px;margin-top:18px;break-inside:avoid}',
    '.dim-block:first-of-type{border-top:none;margin-top:0;padding-top:0}',
    '.dim-head{display:flex;align-items:center;gap:11px;margin-bottom:12px;flex-wrap:wrap}',
    '.dim-no{width:26px;height:26px;border-radius:7px;background:#1e3a5f;color:#fff;font-size:13px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none}',
    '.dim-head h3{margin:0;font-size:16.5px;color:#1e3a5f}',
    '.dim-stat{font-size:12px;color:#64748b;background:#f7f9fc;border-radius:5px;padding:4px 9px}',
    '.dim-cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}',
    '.dim-col h4{margin:0 0 3px;font-size:13.5px;color:#334155}',
    '.col-note{margin:0 0 9px;font-size:11.5px;color:#94a3b8}',
    'ul.evi{margin:0;padding-left:18px}',
    'ul.evi li{margin-bottom:6px;font-size:13px;color:#334155;background:#f7f9fc;border-radius:6px;padding:7px 10px;list-style:disc}',
    '.empty{font-size:12.5px;color:#94a3b8;background:#f7f9fc;border-radius:6px;padding:9px 11px;margin:0}',
    '.kb{background:#f7f9fc;border-left:3px solid #3b6ef5;border-radius:6px;padding:9px 12px;margin-bottom:8px;font-size:12.5px}',
    '.kb-row{display:flex;gap:8px;margin:2px 0}',
    '.kb-lb{flex:none;width:58px;color:#3b6ef5;font-weight:700}',
    '.kb-row em{color:#94a3b8;font-style:normal;font-size:11.5px}',
    '.method-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
    '.m-item{background:#f7f9fc;border-radius:9px;padding:13px 15px}',
    '.m-item h4{margin:0 0 5px;font-size:13.5px;color:#1e3a5f}',
    '.m-item p{margin:0;font-size:12.5px;color:#475569;line-height:1.65}',
    '.foot{border-top:1px solid #e6ecf3;padding:18px 46px 26px;color:#94a3b8;font-size:12px;line-height:1.7;background:#fafbfd}',
    '.foot b{color:#475569}',
    '@media(max-width:760px){.hero,.body{padding-left:22px;padding-right:22px}.foot{padding-left:22px;padding-right:22px}.metrics{grid-template-columns:1fr 1fr}.pie-grid,.dim-cols,.method-grid{grid-template-columns:1fr}}',
    '@media print{body{background:#fff}.page{box-shadow:none;max-width:none}section.card,.dim-block,.metric{break-inside:avoid}@page{margin:14mm}}'
  ].join("\n");

  function buildHTML(b) {
    b = b || {};
    var rows = Array.isArray(b.rows) ? b.rows : [];
    var pie = pieSVG(rows);
    var satisfied = pie.totalNeg === 0;
    var srcLabel = b.source === "doubao" ? "☁ 豆包云端语义分析" : "⚙ 本地规则引擎";
    var name = b.product || b.name || "商品";
    var time = nowText();

    var html = [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<meta name="generator" content="AI 商品维度洞察引擎 · 结果报告导出">',
      '<title>结果报告 · ' + esc(name) + ' · AI 商品维度洞察引擎</title>',
      '<style>' + CSS + '</style>',
      '</head>',
      '<body>',
      '<div class="page">',
      '<header class="hero">',
      '<div class="eyebrow">AI · 营销传播赛道三 · 商品评论洞察</div>',
      '<h1>商品维度洞察 · 分析结果报告</h1>',
      '<p class="sub">输入商品评论 → 自动计算「最需要改进的维度」→ 饼图高亮 + 改进建议 + 真实评论证据</p>',
      '<div class="meta">',
      '<span>📦 ' + esc(name) + '</span>',
      '<span>🕒 生成时间 ' + esc(time) + '</span>',
      '<span>🔍 ' + esc(srcLabel) + '</span>',
      '<span>📄 静态报告 · 可离线查看 / 打印</span>',
      '</div>',
      '</header>',
      '<div class="body">',
      metricCards(b, pie),
      verdictBlock(b, pie),
      '<section class="card"><h2><span class="h-ico">01</span>维度改进分布</h2>',
      '<p class="lead">饼图以各维度负面提及数占总负面提及数的百分比为权重；占比最大的维度向外突出，即当前首要改进项。</p>',
      '<div class="pie-grid"><div>' + pie.svg + '</div><div>' + pie.legend + '</div></div>',
      '</section>',
      rankBlock(rows, satisfied),
      evidenceBlock(rows),
      methodBlock(b),
      '</div>',
      '<footer class="foot">',
      '<b>AI 商品维度洞察引擎</b> · 结果报告（静态快照，不含交互脚本，可归档、打印与评审留档）<br>',
      '维度体系参考郭之昊等(2026)《农业工程学报》葡萄电商评论标注方案；改进建议来自农产品改进知识库与冷链 / 分级国标。<br>',
      '报告中的评论原文均逐字引自输入数据；情感与维度判定按本报告「计算方法与数据说明」所列口径复算。生成时间：' + esc(time) + '。',
      '</footer>',
      '</div>',
      '</body>',
      '</html>'
    ].join("\n");

    return html;
  }

  function download(b) {
    var html = buildHTML(b);
    // 前置 UTF-8 BOM：保证用记事本 / Word / 部分 Windows 浏览器打开时中文不乱码
    var blob = new Blob(["\ufeff" + html], { type: "text/html;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = safeFileName(b && (b.product || b.name));
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
    return a.download;
  }

  function preview(b) {
    var w = window.open("", "_blank");
    if (!w) return false;
    // 预览用 document.write 直接注入，不产生外部请求
    w.document.open();
    w.document.write(buildHTML(b));
    w.document.close();
    return true;
  }

  global.ReportExport = {
    buildHTML: buildHTML,
    download: download,
    preview: preview,
    fileName: function (b) { return safeFileName(b && (b.product || b.name)); }
  };
})(window);
