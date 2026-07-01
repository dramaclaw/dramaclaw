/**
 * 导出独立 HTML 播放器的静态资源:样式 + vanilla 运行逻辑。
 * 逻辑移植自 src/components/canvas/StoryPlayerOverlay.tsx + storyRuntimeStore.advanceToClip。
 * 运行时依赖:全局 `inkjs`(vendored UMD)与 `window.__STORY__`(由 buildPlayerHtml 注入)。
 */

export const PLAYER_STYLE = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; background: #000; color: #fff; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
#app, .stage { position: fixed; inset: 0; }
.stage { display: flex; align-items: center; justify-content: center; overflow: hidden; }
.fallback { padding: 24px; text-align: center; color: rgba(255,255,255,.8); }
.video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
.hud { position: absolute; left: 16px; top: 16px; z-index: 10; display: flex; flex-direction: column; gap: 4px; background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.15); border-radius: 10px; padding: 8px 12px; font-size: 14px; }
.hud-row { display: flex; justify-content: space-between; gap: 12px; }
.hud-label { color: rgba(255,255,255,.7); }
.hud-val { font-variant-numeric: tabular-nums; font-weight: 600; }
.choices { position: absolute; left: 0; right: 0; bottom: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 112px 24px 64px; background: linear-gradient(to top, rgba(0,0,0,.85), rgba(0,0,0,.35), transparent); }
.choice { width: 100%; max-width: 36rem; padding: 12px 24px; font-size: 18px; font-weight: 500; color: rgba(255,255,255,.95); background: transparent; border: 1px solid transparent; border-radius: 10px; cursor: pointer; text-shadow: 0 1px 12px rgba(0,0,0,.9); transition: all .2s; }
.choice:hover { border-color: rgba(255,255,255,.25); background: rgba(255,255,255,.1); text-shadow: none; }
.badge { margin-left: 8px; font-size: 11px; font-weight: 400; color: rgba(255,255,255,.7); border: 1px solid rgba(255,255,255,.3); border-radius: 999px; padding: 2px 6px; }
.bar { width: 100%; max-width: 36rem; height: 4px; background: rgba(255,255,255,.15); border-radius: 999px; overflow: hidden; margin-bottom: 8px; }
.bar-fill { height: 100%; width: 100%; background: rgba(255,255,255,.8); border-radius: 999px; }
.ending { position: absolute; inset: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 24px; text-align: center; background: rgba(0,0,0,.55); }
.ending-title { font-size: 30px; font-weight: 600; max-width: 40rem; text-shadow: 0 2px 16px rgba(0,0,0,.8); }
.ending-vars { display: flex; flex-wrap: wrap; gap: 4px 24px; justify-content: center; font-size: 14px; color: rgba(255,255,255,.75); }
.restart { margin-top: 8px; padding: 10px 32px; font-size: 16px; font-weight: 500; color: rgba(255,255,255,.95); background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.3); border-radius: 999px; cursor: pointer; }
.restart:hover { background: rgba(255,255,255,.15); }
`;

export const PLAYER_SCRIPT = `
(function () {
  var D = window.__STORY__ || {};
  var app = document.getElementById('app');
  var L = D.labels || {};
  if (!window.inkjs || !D.storyJson) {
    var fb = el('div', 'fallback'); fb.textContent = L.loadError || '故事加载失败'; app.appendChild(fb);
    return;
  }
  var story = new inkjs.Story(D.storyJson);
  var st = { clipUrl: null, choices: [], ending: null, phase: 'playing', timeSec: null, defaultIdx: null };
  var videoEnded = false;
  var timer = null;

  function clearTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function readVars() {
    return (D.variables || []).map(function (v) {
      var raw = story.variablesState[v.name];
      var n = typeof raw === 'number' ? raw : Number(raw == null ? 0 : raw);
      return { label: v.label, value: n };
    });
  }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function showChoices() { return videoEnded || st.phase === 'ended' || !st.clipUrl; }

  function advance() {
    if (story.canContinue) story.Continue();
    var tags = story.currentTags || [];
    var nodeId = null;
    for (var i = 0; i < tags.length; i++) {
      var tg = String(tags[i]);
      if (tg.indexOf('clip:') === 0) { nodeId = tg.slice(5).trim(); break; }
    }
    st.clipUrl = (nodeId && D.clips[nodeId]) ? D.clips[nodeId] : null;
    st.choices = story.currentChoices.map(function (c) { return { index: c.index, text: c.text }; });
    st.phase = st.choices.length > 0 ? 'playing' : 'ended';
    var lim = nodeId ? D.choiceTime[nodeId] : undefined;
    st.timeSec = (st.choices.length > 0 && typeof lim === 'number' && lim > 0) ? lim : null;
    var di = nodeId ? D.defaultChoice[nodeId] : undefined;
    st.defaultIdx = (st.choices.length > 0 && typeof di === 'number') ? di : null;
    st.ending = (st.phase === 'ended' && nodeId) ? (D.endings[nodeId] || null) : null;
    videoEnded = false;
    render();
  }
  function choose(i) { if (st.phase === 'ended') return; clearTimer(); story.ChooseChoiceIndex(i); advance(); }
  function restart() { clearTimer(); story.ResetState(); advance(); }

  function renderHud(stage) {
    var vars = readVars();
    if (!vars.length) return;
    var hud = el('div', 'hud');
    vars.forEach(function (v) {
      var row = el('div', 'hud-row');
      row.appendChild(el('span', 'hud-label', v.label));
      row.appendChild(el('span', 'hud-val', String(v.value)));
      hud.appendChild(row);
    });
    stage.appendChild(hud);
  }

  function render() {
    clearTimer();
    app.innerHTML = '';
    var stage = el('div', 'stage');
    renderHud(stage);

    if (st.clipUrl) {
      var v = el('video', 'video');
      v.src = st.clipUrl; v.autoplay = true; v.controls = false;
      v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      v.addEventListener('ended', function () { videoEnded = true; render(); });
      stage.appendChild(v);
    }

    if (showChoices() && st.choices.length > 0) {
      var box = el('div', 'choices');
      if (st.timeSec != null) {
        var barWrap = el('div', 'bar'); var bar = el('div', 'bar-fill'); barWrap.appendChild(bar); box.appendChild(barWrap);
        var total = st.timeSec * 1000; var start = Date.now();
        timer = setInterval(function () {
          var frac = Math.max(0, 1 - (Date.now() - start) / total);
          bar.style.width = (frac * 100) + '%';
          if (frac <= 0) { clearTimer(); var idx = (st.defaultIdx != null) ? st.defaultIdx : (st.choices[0] ? st.choices[0].index : 0); choose(idx); }
        }, 50);
      }
      st.choices.forEach(function (c) {
        var b = el('button', 'choice', c.text);
        if (c.index === st.defaultIdx) b.appendChild(el('span', 'badge', L.defaultChoice || '默认'));
        b.addEventListener('click', function () { choose(c.index); });
        box.appendChild(b);
      });
      stage.appendChild(box);
    }

    if (showChoices() && st.choices.length === 0) {
      var end = el('div', 'ending');
      if (st.ending && st.ending.label) end.appendChild(el('span', 'badge', (L.endingBadge || '结局') + ' · ' + st.ending.label));
      end.appendChild(el('h2', 'ending-title', (st.ending && st.ending.title && st.ending.title.trim()) || (L.endingFallback || '全剧终')));
      var vs = readVars();
      if (vs.length) { var rec = el('div', 'ending-vars'); vs.forEach(function (v) { rec.appendChild(el('span', null, v.label + ': ' + v.value)); }); end.appendChild(rec); }
      var rb = el('button', 'restart', L.restart || '重新开始'); rb.addEventListener('click', restart); end.appendChild(rb);
      stage.appendChild(end);
    }

    app.appendChild(stage);
  }

  advance();
})();
`;
