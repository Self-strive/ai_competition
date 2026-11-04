/*
 * chart.js —— 负面维度占比饼图
 * 设计目标：从评论中提取负面评论，计算九个维度在负面评论中的占比，
 * 用饼图直观展示；占比最大的维度向外突出，并带科技风高亮。
 */
(function (global) {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";

  // 科技感配色板：每个维度固定一种醒目颜色
  var DIM_COLORS = {
    "产品品质": "#ff4757", // 红
    "口感味道": "#ff7f50", // 珊瑚橙
    "大小规格": "#ff943c", // 橙
    "重量份量": "#ffd659", // 黄
    "包装": "#38e1ff",     // 青
    "物流运输": "#2b7bff", // 蓝
    "服务": "#a78bfa",     // 紫
    "价格": "#2ed573",     // 绿
    "性价比": "#00d2d3"    // 青绿
  };

  function colorFor(dim) {
    return DIM_COLORS[dim] || "#38e1ff";
  }

  function polar(cx, cy, radius, deg) {
    var rad = (deg - 90) * Math.PI / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  }

  function arcPath(cx, cy, radius, startDeg, endDeg) {
    var s = polar(cx, cy, radius, endDeg);
    var e = polar(cx, cy, radius, startDeg);
    var large = (endDeg - startDeg) <= 180 ? 0 : 1;
    return ["M", cx, cy, "L", s[0], s[1], "A", radius, radius, 0, large, 0, e[0], e[1], "Z"].join(" ");
  }

  /*
   * render(container, rows, opts)
   *  rows: 引擎输出 rows（已排序，含 dim/neg/mention/neg_rate/score/alert）
   *  opts: { onSelect: fn(dim), productName: string }
   */
  function render(container, rows, opts) {
    opts = opts || {};
    container.innerHTML = "";
    if (!rows || !rows.length) return;

    // 只取有负面评论的维度
    var activeRows = rows.filter(function (row) { return row.neg > 0; });
    // 无任何负面提及 → 渲染「商品品质令人满意」浅绿整圆（不是空白，也不是红通通）
    if (!activeRows.length) {
      renderSatisfied(container, rows);
      return;
    }

    var totalNeg = 0;
    activeRows.forEach(function (row) { totalNeg += row.neg; });
    if (totalNeg === 0) totalNeg = 1;

    // 计算每个维度在负面评论中的占比
    activeRows.forEach(function (row) {
      row.pct = row.neg / totalNeg;
    });

    // 占比最大者作为突出项
    var maxIdx = 0;
    activeRows.forEach(function (row, i) {
      if (row.pct > activeRows[maxIdx].pct) maxIdx = i;
    });
    var topDim = activeRows[maxIdx].dim;
    var topPct = activeRows[maxIdx].pct;

    var size = 460, cx = size / 2, cy = size / 2, RADIUS = 150;
    var explodeOffset = 26; // 突出偏移距离

    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.setAttribute("class", "pie-svg");

    // 定义滤镜：普通阴影 + 突出扇区的阴影+发光（合并为独立 filter，避免多 filter 串联）
    var defs = document.createElementNS(SVGNS, "defs");
    defs.innerHTML =
      '<filter id="pieShadow" x="-50%" y="-50%" width="200%" height="200%">' +
      '  <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur"/>' +
      '  <feOffset in="blur" dx="3" dy="5" result="offset"/>' +
      '  <feComponentTransfer in="offset" result="shadow">' +
      '    <feFuncA type="linear" slope="0.45"/>' +
      '  </feComponentTransfer>' +
      '  <feMerge>' +
      '    <feMergeNode in="shadow"/>' +
      '    <feMergeNode in="SourceGraphic"/>' +
      '  </feMerge>' +
      '</filter>' +
      '<filter id="pieActive" x="-60%" y="-60%" width="220%" height="220%">' +
      '  <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur"/>' +
      '  <feOffset in="blur" dx="3" dy="5" result="offset"/>' +
      '  <feComponentTransfer in="offset" result="shadow">' +
      '    <feFuncA type="linear" slope="0.45"/>' +
      '  </feComponentTransfer>' +
      '  <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="glow"/>' +
      '  <feMerge>' +
      '    <feMergeNode in="shadow"/>' +
      '    <feMergeNode in="glow"/>' +
      '    <feMergeNode in="SourceGraphic"/>' +
      '  </feMerge>' +
      '</filter>';
    svg.appendChild(defs);

    // 绘制饼图扇区
    var start = 0;
    activeRows.forEach(function (row, idx) {
      var ang = row.pct * 360;
      // 单维度独占 360° 时，路径起止点完全重合，按 SVG 规范整段圆弧会被省略 → 饼图消失。
      // 收敛到 359.99°，保证满圆也能画出来（与 renderSatisfied 的处理保持一致）。
      if (ang > 359.99) ang = 359.99;
      var end = start + ang;
      var mid = start + ang / 2;
      var exploded = (idx === maxIdx);
      var off = exploded ? explodeOffset : 0;
      var cc = polar(cx, cy, off, mid);
      var col = colorFor(row.dim);

      // 扇区路径
      var path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", arcPath(cc[0], cc[1], RADIUS, start, end));
      path.setAttribute("fill", col);
      path.setAttribute("stroke", "none");
      path.setAttribute("stroke-width", "0");
      path.setAttribute("class", "pie-slice");
      path.style.opacity = "0";
      path.style.transformOrigin = cc[0] + "px " + cc[1] + "px";
      path.dataset.dim = row.dim;
      if (exploded) {
        path.setAttribute("filter", "url(#pieActive)");
        path.classList.add("slice-exploded");
      } else {
        path.setAttribute("filter", "url(#pieShadow)");
      }

      // 交互
      path.addEventListener("mouseenter", function () {
        path.style.transform = "scale(1.05)";
        showTip(row, mid);
      });
      path.addEventListener("mouseleave", function () {
        path.style.transform = "";
        hideTip();
      });
      path.addEventListener("click", function () {
        if (opts.onSelect) opts.onSelect(row.dim);
      });

      svg.appendChild(path);

      // 入场动画
      (function (p, i) {
        setTimeout(function () { p.style.opacity = "1"; }, 70 * i + 100);
      })(path, idx);

      // 扇区标签（维度名 + 百分比）；满圆扇区（单维度 100%）不再画内部标签——中心注释已显示
      if (ang < 300) {
        var labelR = exploded ? RADIUS * 0.62 : RADIUS * 0.68;
        var lp = polar(cc[0], cc[1], labelR, mid);
        var label = document.createElementNS(SVGNS, "text");
        label.setAttribute("x", lp[0]);
        label.setAttribute("y", lp[1] - 6);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("class", "pie-label-dim");
        label.style.opacity = "0";
        label.textContent = row.dim;
        svg.appendChild(label);

        var pctText = document.createElementNS(SVGNS, "text");
        pctText.setAttribute("x", lp[0]);
        pctText.setAttribute("y", lp[1] + 14);
        pctText.setAttribute("text-anchor", "middle");
        pctText.setAttribute("class", "pie-label-pct");
        pctText.style.opacity = "0";
        pctText.textContent = (row.pct * 100).toFixed(1) + "%";
        svg.appendChild(pctText);

        // 小扇区标签可能重叠：当角度 < 20 度时只显示百分比
        if (ang < 20) {
          label.style.display = "none";
          pctText.setAttribute("y", lp[1] + 4);
        }

        // 标签淡入
        (function (l, p, i) {
          setTimeout(function () { l.style.opacity = "1"; p.style.opacity = "1"; }, 90 * i + 300);
        })(label, pctText, idx);
      }

      start = end;
    });

    // 中心注释：最大维度名称 + 占比
    var centerTop = document.createElementNS(SVGNS, "text");
    centerTop.setAttribute("x", cx); centerTop.setAttribute("y", cy - 10);
    centerTop.setAttribute("text-anchor", "middle");
    centerTop.setAttribute("class", "pie-center-top");
    centerTop.textContent = "首要改进";
    svg.appendChild(centerTop);

    var centerDim = document.createElementNS(SVGNS, "text");
    centerDim.setAttribute("x", cx); centerDim.setAttribute("y", cy + 16);
    centerDim.setAttribute("text-anchor", "middle");
    centerDim.setAttribute("class", "pie-center-dim");
    centerDim.textContent = topDim;
    svg.appendChild(centerDim);

    var centerPct = document.createElementNS(SVGNS, "text");
    centerPct.setAttribute("x", cx); centerPct.setAttribute("y", cy + 40);
    centerPct.setAttribute("text-anchor", "middle");
    centerPct.setAttribute("class", "pie-center-pct");
    centerPct.textContent = (topPct * 100).toFixed(1) + "% 负面占比";
    svg.appendChild(centerPct);

    container.appendChild(svg);

    // 图例
    var legend = document.createElement("div");
    legend.className = "pie-legend";
    activeRows.forEach(function (row) {
      var item = document.createElement("div");
      item.className = "legend-item" + ((row.dim === topDim) ? " legend-top" : "");
      var col = colorFor(row.dim);
      item.innerHTML =
        '<span class="legend-dot" style="background:' + col +
        (row.dim === topDim ? ';box-shadow:0 0 10px ' + col : '') + '"></span>' +
        '<span class="legend-name">' + row.dim + '</span>' +
        '<span class="legend-val">' + (row.pct * 100).toFixed(1) + '% · 负面 ' + row.neg + '</span>';
      item.addEventListener("click", function () { if (opts.onSelect) opts.onSelect(row.dim); });
      item.addEventListener("mouseenter", function () { if (opts.onSelect) opts.onSelect(row.dim, true); });
      legend.appendChild(item);
    });
    container.appendChild(legend);

    // 悬停提示框
    var tip = document.createElement("div");
    tip.className = "pie-tip";
    tip.style.display = "none";
    container.appendChild(tip);

    function showTip(row, deg) {
      tip.style.display = "block";
      tip.innerHTML =
        '<b>' + row.dim + '</b><br>' +
        '负面占比 <span style="color:' + colorFor(row.dim) + ';font-weight:700">' + (row.pct * 100).toFixed(1) + '%</span><br>' +
        '负面 ' + row.neg + ' 条 / 总负面 ' + totalNeg + ' 条';
    }
    function hideTip() { tip.style.display = "none"; }
  }

  // 无负面提及：浅绿色完整圆 + 「商品品质 / 令人满意」中心注释
  // 圆本身是浅绿色，两种主题下中心文字都用深绿，保证可读
  function renderSatisfied(container, rows) {
    var size = 460, cx = size / 2, cy = size / 2, RADIUS = 150;
    var green = "#4ade80", greenSoft = "#a7f3c6", greenInk = "#14532d";

    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.setAttribute("class", "pie-svg");

    var defs = document.createElementNS(SVGNS, "defs");
    defs.innerHTML =
      '<radialGradient id="pieOk" cx="50%" cy="42%" r="65%">' +
      '  <stop offset="0%" stop-color="' + greenSoft + '"/>' +
      '  <stop offset="100%" stop-color="' + green + '"/>' +
      '</radialGradient>' +
      '<filter id="pieOkShadow" x="-50%" y="-50%" width="200%" height="200%">' +
      '  <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur"/>' +
      '  <feOffset in="blur" dx="3" dy="5" result="offset"/>' +
      '  <feComponentTransfer in="offset" result="shadow">' +
      '    <feFuncA type="linear" slope="0.45"/>' +
      '  </feComponentTransfer>' +
      '  <feMerge>' +
      '    <feMergeNode in="shadow"/>' +
      '    <feMergeNode in="SourceGraphic"/>' +
      '  </feMerge>' +
      '</filter>';
    svg.appendChild(defs);

    // 完整圆（一个 360° 扇区）
    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", arcPath(cx, cy, RADIUS, 0, 359.99));
    path.setAttribute("fill", "url(#pieOk)");
    path.setAttribute("stroke", "none");
    path.setAttribute("stroke-width", "0");
    path.setAttribute("filter", "url(#pieOkShadow)");
    path.setAttribute("class", "pie-slice");
    path.style.opacity = "0";
    svg.appendChild(path);
    setTimeout(function () { path.style.opacity = "1"; }, 120);

    // 中心注释：商品品质 / 令人满意
    var centerTop = document.createElementNS(SVGNS, "text");
    centerTop.setAttribute("x", cx); centerTop.setAttribute("y", cy - 14);
    centerTop.setAttribute("text-anchor", "middle");
    centerTop.setAttribute("class", "pie-center-top");
    centerTop.style.fill = greenInk;
    centerTop.textContent = "商品品质";
    svg.appendChild(centerTop);

    var centerDim = document.createElementNS(SVGNS, "text");
    centerDim.setAttribute("x", cx); centerDim.setAttribute("y", cy + 18);
    centerDim.setAttribute("text-anchor", "middle");
    centerDim.setAttribute("class", "pie-center-dim");
    centerDim.style.fill = greenInk;
    centerDim.textContent = "令人满意";
    svg.appendChild(centerDim);

    var centerPct = document.createElementNS(SVGNS, "text");
    centerPct.setAttribute("x", cx); centerPct.setAttribute("y", cy + 44);
    centerPct.setAttribute("text-anchor", "middle");
    centerPct.setAttribute("class", "pie-center-pct");
    centerPct.style.fill = "#166534";
    centerPct.textContent = "100% 满意";
    svg.appendChild(centerPct);

    container.appendChild(svg);

    // 图例：单个满意项
    var legend = document.createElement("div");
    legend.className = "pie-legend";
    var item = document.createElement("div");
    item.className = "legend-item legend-top";
    item.innerHTML =
      '<span class="legend-dot" style="background:' + green + ';box-shadow:0 0 10px ' + green + '"></span>' +
      '<span class="legend-name">商品品质</span>' +
      '<span class="legend-val">100% · 满意</span>';
    legend.appendChild(item);    container.appendChild(legend);
  }

  window.PieChart = { render: render };
})(window);
