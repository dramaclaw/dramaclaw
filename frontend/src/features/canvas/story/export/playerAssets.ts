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
.placeholder { position: absolute; inset: 0 24px 11rem; z-index: 8; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px 24px; text-align: center; pointer-events: none; }
.placeholder-badge { padding: 4px 10px; border: 1px solid rgba(255,255,255,.2); border-radius: 999px; color: rgba(255,255,255,.65); background: rgba(255,255,255,.06); font-size: 12px; letter-spacing: .08em; }
.placeholder-label { color: rgba(255,255,255,.62); font-size: 14px; }
.placeholder-text { max-width: 46rem; color: rgba(255,255,255,.92); font-size: clamp(18px, 2.4vw, 28px); font-weight: 500; line-height: 1.6; overflow-wrap: anywhere; text-shadow: 0 2px 18px rgba(0,0,0,.9); }
.outcome-feedback { position: absolute; top: max(4.5rem, calc(env(safe-area-inset-top, 0px) + 3.5rem)); left: 24px; right: 24px; z-index: 30; display: flex; justify-content: center; padding: 0 24px; text-align: center; pointer-events: none; }
.outcome-feedback-content { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.outcome-state-changes { display: flex; max-width: 36rem; flex-wrap: wrap; justify-content: center; gap: 6px; }
.outcome-state { border: 1px solid; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; letter-spacing: .04em; backdrop-filter: blur(8px); }
.outcome-state.up { border-color: rgba(165,243,252,.25); color: rgb(207,250,254); background: rgba(165,243,252,.1); }
.outcome-state.down { border-color: rgba(253,230,138,.25); color: rgb(254,243,199); background: rgba(253,230,138,.1); }
.outcome-feedback-text { max-width: 36rem; color: rgba(255,255,255,.8); font-size: clamp(14px, 1.4vw, 18px); font-weight: 600; line-height: 1.5; letter-spacing: .04em; overflow-wrap: anywhere; text-shadow: 0 2px 14px rgba(0,0,0,.95); }
.choices { position: absolute; left: 0; right: 0; bottom: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 112px 24px 64px; background: linear-gradient(to top, rgba(0,0,0,.85), rgba(0,0,0,.35), transparent); }
.choice { width: 100%; max-width: 36rem; padding: 12px 24px; font-size: 18px; font-weight: 500; color: rgba(255,255,255,.95); background: transparent; border: 1px solid transparent; border-radius: 10px; cursor: pointer; text-shadow: 0 1px 12px rgba(0,0,0,.9); transition: all .2s; }
.choice:hover { border-color: rgba(255,255,255,.25); background: rgba(255,255,255,.1); text-shadow: none; }
.anchored-choice { position: absolute; z-index: 20; min-width: 8rem; transform: translate(-50%, -50%); padding: 8px 16px; color: rgba(255,255,255,.95); font-size: 14px; font-weight: 600; line-height: 1.35; text-align: center; cursor: pointer; outline: none; }
.anchored-choice:focus-visible { outline: 2px solid rgba(255,255,255,.95); outline-offset: 3px; }
.anchored-choice.glass { border: 1px solid rgba(255,255,255,.3); border-radius: 12px; background: rgba(0,0,0,.35); box-shadow: 0 12px 30px rgba(0,0,0,.4); backdrop-filter: blur(12px); }
.anchored-choice.tag { width: 52px; min-width: 0; height: 52px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: transparent; }
.tech-hit-highlight { position: absolute; left: 6px; top: 6px; z-index: 1; width: 40px; height: 40px; border-radius: 50%; background: transparent; pointer-events: none; transition: background-color .15s ease-out, box-shadow .15s ease-out, transform .15s ease-out; }
.anchored-choice.tag:hover .tech-hit-highlight, .anchored-choice.tag:focus-visible .tech-hit-highlight { transform: scale(1.05); background: rgba(207,250,254,.2); box-shadow: 0 0 18px rgba(207,250,254,.55); }
.anchored-choice.tag:hover [data-tech-target], .anchored-choice.tag:focus-visible [data-tech-target] { transform: scale(1.05); border-color: #fff; box-shadow: 0 0 0 1px rgba(207,250,254,.32), 0 0 14px rgba(207,250,254,.72); }
.anchored-choice.warning { border: 1px solid rgba(253,230,138,.45); border-radius: 12px; background: rgba(120,53,15,.65); box-shadow: 0 10px 26px rgba(120,53,15,.42); backdrop-filter: blur(12px); }
.anchored-choice.baked { min-width: 44px; min-height: 44px; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: transparent; }
.anchored-choice.baked:focus-visible { border-color: rgba(255,255,255,.6); background: rgba(0,0,0,.4); color: rgba(255,255,255,.95); }
@keyframes anchor-fade-in { from { opacity: 0; transform: translate(-50%, -50%) scale(.95); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@keyframes anchor-pop-in { 0% { opacity: 0; transform: translate(-50%, -50%) scale(.7); } 70% { transform: translate(-50%, -50%) scale(1.06); } 100% { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@keyframes anchor-pulse { 0%, 100% { box-shadow: 0 10px 26px rgba(0,0,0,.4); } 50% { box-shadow: 0 0 0 6px rgba(255,255,255,.12), 0 10px 26px rgba(0,0,0,.4); } }
.anchored-choice.motion-fade { animation: anchor-fade-in .3s ease-out both; }
.anchored-choice.motion-pop { animation: anchor-pop-in .3s ease-out both; }
.anchored-choice.motion-pulse { animation: anchor-fade-in .3s ease-out both, anchor-pulse 1.8s ease-in-out .3s infinite; }
@keyframes branch-fade { from { opacity: 1; } to { opacity: 0; } }
@keyframes branch-flash { 0% { opacity: 1; } 100% { opacity: 0; } }
.branch-transition { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.branch-transition.fade { background: #000; animation: branch-fade .6s ease-out both; }
.branch-transition.flash { background: #fff; animation: branch-flash .26s ease-out both; }
.badge { margin-left: 8px; font-size: 11px; font-weight: 400; color: rgba(255,255,255,.7); border: 1px solid rgba(255,255,255,.3); border-radius: 999px; padding: 2px 6px; }
.bar { width: 100%; max-width: 36rem; height: 4px; background: rgba(255,255,255,.15); border-radius: 999px; overflow: hidden; margin-bottom: 8px; }
.bar-fill { height: 100%; width: 100%; background: rgba(255,255,255,.8); border-radius: 999px; }
.ending { position: absolute; inset: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 24px; text-align: center; background: rgba(0,0,0,.55); }
.ending-title { font-size: 30px; font-weight: 600; max-width: 40rem; text-shadow: 0 2px 16px rgba(0,0,0,.8); }
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
  var st = { nodeId: null, clipUrl: null, choices: [], ending: null, placeholder: null, phase: 'playing', timeSec: null, defaultIdx: null };
  var videoEnded = false;
  var timer = null;
  var feedbackPending = false;
  var pendingTransition = null;

  function clearTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function showChoices() { return videoEnded || st.phase === 'ended' || !st.clipUrl; }
  function positionAnchors(stage, video) {
    if (!stage || !video || !video.videoWidth || !video.videoHeight) return;
    var cw = stage.clientWidth; var ch = stage.clientHeight;
    if (!cw || !ch) return;
    var scale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
    var renderedWidth = video.videoWidth * scale;
    var renderedHeight = video.videoHeight * scale;
    var offsetX = (cw - renderedWidth) / 2;
    var offsetY = (ch - renderedHeight) / 2;
    stage.querySelectorAll('.anchored-choice[data-anchor-x][data-anchor-y]').forEach(function (button) {
      var x = Math.max(0, Math.min(1, Number(button.getAttribute('data-anchor-x'))));
      var y = Math.max(0, Math.min(1, Number(button.getAttribute('data-anchor-y'))));
      button.style.left = (offsetX + x * renderedWidth) + 'px';
      button.style.top = (offsetY + y * renderedHeight) + 'px';
      if (button.classList.contains('baked')) {
        var hotspotWidth = Math.max(.02, Math.min(1, Number(button.getAttribute('data-anchor-width'))));
        var hotspotHeight = Math.max(.02, Math.min(1, Number(button.getAttribute('data-anchor-height'))));
        button.style.width = Math.max(44, hotspotWidth * renderedWidth) + 'px';
        button.style.height = Math.max(44, hotspotHeight * renderedHeight) + 'px';
      }
    });
  }
  function outcomeForChoice(choice) {
    var tags = choice.tags || [];
    for (var i = 0; i < tags.length; i++) {
      var tag = String(tags[i]);
      if (tag.indexOf('choice-feedback:') !== 0) continue;
      var feedbackId = tag.slice('choice-feedback:'.length).trim();
      var text = D.choiceFeedback && D.choiceFeedback[feedbackId];
      return {
        feedbackText: typeof text === 'string' ? text.trim() : '',
        stateChanges: D.choiceStateChanges && Array.isArray(D.choiceStateChanges[feedbackId]) ? D.choiceStateChanges[feedbackId] : []
      };
    }
    return { feedbackText: '', stateChanges: [] };
  }
  function interactionForChoice(choice) {
    var tags = choice.tags || [];
    for (var i = 0; i < tags.length; i++) {
      var tag = String(tags[i]);
      if (tag.indexOf('choice-interaction:') !== 0) continue;
      var interactionId = tag.slice('choice-interaction:'.length).trim();
      var interaction = D.choiceInteraction && D.choiceInteraction[interactionId];
      if (interaction && typeof interaction === 'object') return interaction;
    }
    return null;
  }

  function advance() {
    if (story.canContinue) story.Continue();
    var tags = story.currentTags || [];
    var nodeId = null;
    for (var i = 0; i < tags.length; i++) {
      var tg = String(tags[i]);
      if (tg.indexOf('clip:') === 0) { nodeId = tg.slice(5).trim(); break; }
    }
    st.nodeId = nodeId;
    st.clipUrl = (nodeId && D.clips[nodeId]) ? D.clips[nodeId] : null;
    st.choices = story.currentChoices.map(function (c) {
      var outcome = outcomeForChoice(c);
      return { index: c.index, text: c.text, feedbackText: outcome.feedbackText, stateChanges: outcome.stateChanges, interaction: interactionForChoice(c) };
    });
    st.phase = st.choices.length > 0 || story.canContinue ? 'playing' : 'ended';
    var placeholder = (nodeId && D.placeholders) ? D.placeholders[nodeId] : null;
    st.placeholder = (!st.clipUrl && st.choices.length > 0) ? (placeholder || { label: '', text: '' }) : null;
    var lim = nodeId ? D.choiceTime[nodeId] : undefined;
    st.timeSec = (st.choices.length > 0 && typeof lim === 'number' && lim > 0) ? lim : null;
    var di = nodeId ? D.defaultChoice[nodeId] : undefined;
    st.defaultIdx = (st.choices.length > 0 && typeof di === 'number') ? di : null;
    st.ending = (st.phase === 'ended' && nodeId) ? (D.endings[nodeId] || null) : null;
    videoEnded = false;
    if (!st.clipUrl && st.choices.length === 0 && story.canContinue) { window.setTimeout(advance, 0); return; }
    render();
  }
  function choose(i) {
    if (st.phase === 'ended' || feedbackPending) return;
    clearTimer();
    var selected = st.choices.find(function (choice) { return choice.index === i; });
    var feedbackText = selected && selected.feedbackText;
    var stateChanges = selected && selected.stateChanges || [];
    var transition = selected && selected.interaction && selected.interaction.transition;
    var advanceAfterChoice = function () { feedbackPending = false; pendingTransition = transition === 'flash' || transition === 'cut' ? transition : 'fade'; story.ChooseChoiceIndex(i); advance(); };
    if (!feedbackText && stateChanges.length === 0) { advanceAfterChoice(); return; }
    feedbackPending = true;
    var feedback = el('div', 'outcome-feedback');
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    var feedbackContent = el('div', 'outcome-feedback-content');
    if (stateChanges.length > 0) {
      var states = el('div', 'outcome-state-changes');
      stateChanges.forEach(function (change) {
        var isUp = change && change.direction === 'up';
        var isOn = change && change.direction === 'on';
        var isOff = change && change.direction === 'off';
        var label = change && String(change.label || '').trim();
        if (!label) return;
        var positive = isUp || isOn;
        var suffix = isOn ? '开启' : isOff ? '关闭' : isUp ? '↑' : '↓';
        var state = el('span', 'outcome-state ' + (positive ? 'up' : 'down'), label + ' ' + suffix);
        state.setAttribute('aria-label', label + suffix);
        states.appendChild(state);
      });
      if (states.childElementCount > 0) feedbackContent.appendChild(states);
    }
    if (feedbackText) feedbackContent.appendChild(el('p', 'outcome-feedback-text', feedbackText));
    feedback.appendChild(feedbackContent);
    app.appendChild(feedback);
    window.setTimeout(advanceAfterChoice, 1500);
  }
  function restart() { clearTimer(); pendingTransition = null; story.ResetState(); advance(); }
  function revealChoicesAtTailFrame(video) {
    if (videoEnded) return;
    if (!Number.isFinite(video.duration) || video.duration <= .15) return;
    if (video.currentTime < Math.max(0, video.duration - .15)) return;
    video.pause(); videoEnded = true;
    if (st.choices.length === 0 && story.canContinue) { advance(); return; }
    render();
  }

  function render() {
    clearTimer();
    var choiceLoopUrl = showChoices() && st.choices.length > 0 && st.nodeId && D.choiceLoops
      ? D.choiceLoops[st.nodeId]
      : null;
    var activeClipUrl = choiceLoopUrl || st.clipUrl;
    // 冻结主视频尾帧时保留同一个元素，避免重新建 video 后黑闪、重缓冲再 seek 回尾帧。
    var reusableVideo = null;
    var previousVideo = app.querySelector('video.video');
    if (previousVideo && videoEnded && !choiceLoopUrl && previousVideo.getAttribute('data-player-src') === String(activeClipUrl || '')) {
      previousVideo.parentNode.removeChild(previousVideo);
      reusableVideo = previousVideo;
    }
    app.innerHTML = '';
    var stage = el('div', 'stage');
    if (activeClipUrl) {
      var v = reusableVideo || el('video', 'video');
      if (!reusableVideo) {
        v.src = activeClipUrl; v.autoplay = !!choiceLoopUrl || !videoEnded; v.controls = false;
        v.loop = !!choiceLoopUrl;
        v.setAttribute('data-player-src', String(activeClipUrl));
        v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
        v.addEventListener('loadedmetadata', function () { positionAnchors(stage, v); });
        if (!choiceLoopUrl && videoEnded) {
          v.addEventListener('loadedmetadata', function () {
            v.currentTime = Math.max(0, v.duration - .05);
            v.pause();
          }, { once: true });
        } else if (!choiceLoopUrl) {
          v.addEventListener('ended', function () {
            v.pause(); videoEnded = true;
            if (st.choices.length === 0 && story.canContinue) { advance(); return; }
            render();
          });
          v.addEventListener('timeupdate', function () { revealChoicesAtTailFrame(v); });
          v.addEventListener('seeked', function () { revealChoicesAtTailFrame(v); });
        }
      }
      stage.appendChild(v);
    }
    if (pendingTransition) {
      if (pendingTransition !== 'cut') stage.appendChild(el('div', 'branch-transition ' + pendingTransition));
      pendingTransition = null;
    }

    if (!st.clipUrl && st.choices.length > 0 && st.placeholder) {
      var placeholderBox = el('div', 'placeholder');
      placeholderBox.appendChild(el('span', 'placeholder-badge', L.placeholderBadge || '占位片段'));
      if (st.placeholder.label) placeholderBox.appendChild(el('span', 'placeholder-label', st.placeholder.label));
      var placeholderText = String(st.placeholder.text || '').trim() || L.placeholderHint || '此片段尚未生成视频,点选下方选项继续试玩';
      placeholderBox.appendChild(el('p', 'placeholder-text', placeholderText));
      stage.appendChild(placeholderBox);
    }

    if (showChoices() && st.choices.length > 0) {
      var anchored = [];
      var overlayChoices = [];
      st.choices.forEach(function (choice) {
        var interaction = choice.interaction || {};
        var anchor = interaction.anchor;
        if (interaction.presentation !== 'overlay' && anchor && typeof anchor.x === 'number' && typeof anchor.y === 'number') anchored.push(choice);
        else overlayChoices.push(choice);
      });
      anchored.forEach(function (choice) {
        var interaction = choice.interaction || {};
        var anchor = interaction.anchor;
        var presentation = interaction.presentation === 'baked-video' ? 'baked' : (interaction.uiStyle || 'glass');
        var motion = interaction.motion === 'pop' || interaction.motion === 'pulse' ? interaction.motion : 'fade';
        var button = el('button', 'anchored-choice ' + presentation + ' motion-' + motion, choice.text);
        if (presentation === 'tag') {
          // 使用实体 DOM 圆环；不依赖 SVG、渐变背景或伪元素。
          button.textContent = '';
          var hitHighlight = el('span', 'tech-hit-highlight');
          hitHighlight.setAttribute('data-tech-hit-highlight', 'true');
          button.appendChild(hitHighlight);
          var outerRing = el('span', '');
          outerRing.setAttribute('data-tech-target', 'true');
          outerRing.style.cssText = 'position:absolute;left:6px;top:6px;display:block;width:40px;height:40px;border:2px solid rgba(255,255,255,.92);border-radius:50%;box-sizing:border-box;box-shadow:0 0 0 1px rgba(165,243,252,.18),0 0 10px rgba(165,243,252,.42);pointer-events:none;z-index:2;transition:border-color .15s ease-out,box-shadow .15s ease-out,transform .15s ease-out;';
          var middleRing = el('span', ''); middleRing.style.cssText = 'position:absolute;left:6px;top:6px;width:24px;height:24px;border:1px solid rgba(207,250,254,.72);border-radius:50%;box-sizing:border-box;'; outerRing.appendChild(middleRing);
          var innerRing = el('span', ''); innerRing.style.cssText = 'position:absolute;left:14px;top:14px;width:8px;height:8px;border:2px solid rgba(255,255,255,.96);border-radius:50%;box-sizing:border-box;box-shadow:0 0 6px rgba(165,243,252,.72);'; outerRing.appendChild(innerRing);
          button.appendChild(outerRing);
        }
        button.style.left = (Math.max(0, Math.min(1, anchor.x)) * 100) + '%';
        button.style.top = (Math.max(0, Math.min(1, anchor.y)) * 100) + '%';
        button.setAttribute('data-anchor-x', String(anchor.x));
        button.setAttribute('data-anchor-y', String(anchor.y));
        if (presentation === 'baked') {
          var hotspotWidth = Math.max(.02, Math.min(1, Number(anchor.width)));
          var hotspotHeight = Math.max(.02, Math.min(1, Number(anchor.height)));
          button.style.width = (hotspotWidth * 100) + '%';
          button.style.height = (hotspotHeight * 100) + '%';
          button.setAttribute('data-anchor-width', String(hotspotWidth));
          button.setAttribute('data-anchor-height', String(hotspotHeight));
        }
        button.setAttribute('aria-label', choice.text);
        if (anchor.objectLabel) button.title = anchor.objectLabel;
        button.addEventListener('click', function () { choose(choice.index); });
        stage.appendChild(button);
      });
      var box = el('div', 'choices');
      if (overlayChoices.length === 0) box.style.cssText = 'pointer-events:none;padding:0 24px 32px;background:transparent;';
      if (st.timeSec != null) {
        var barWrap = el('div', 'bar'); var bar = el('div', 'bar-fill'); barWrap.appendChild(bar); box.appendChild(barWrap);
        var total = st.timeSec * 1000; var start = Date.now();
        timer = setInterval(function () {
          var frac = Math.max(0, 1 - (Date.now() - start) / total);
          bar.style.width = (frac * 100) + '%';
          if (frac <= 0) { clearTimer(); var idx = (st.defaultIdx != null) ? st.defaultIdx : (st.choices[0] ? st.choices[0].index : 0); choose(idx); }
        }, 50);
      }
      overlayChoices.forEach(function (c) {
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
      var rb = el('button', 'restart', L.restart || '重新开始'); rb.addEventListener('click', restart); end.appendChild(rb);
      stage.appendChild(end);
    }

    app.appendChild(stage);
    var activeVideo = stage.querySelector('video.video');
    if (activeVideo) positionAnchors(stage, activeVideo);
  }

  window.addEventListener('resize', function () {
    var stage = app.querySelector('.stage');
    var video = stage && stage.querySelector('video.video');
    if (stage && video) positionAnchors(stage, video);
  });
  advance();
})();
`;
