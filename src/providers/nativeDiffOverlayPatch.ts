// workbench renderer 에 주입할 native diff checkbox overlay script 조립 모듈.
// - TypeScript 영역은 문자열을 안전하게 감싸고, 실제 DOM 조작은 renderer 에서 실행된다.
import type { HunkOverlaySnapshot } from "./hunkCheckboxController";
import {
  mainEvalExpression,
  rendererEvalExpression,
  type NativeOverlayWorkspaceHints,
} from "./nativeDiffOverlayMain";

const PATCH_VERSION = 35;
const RENDERER_BINDING = "gscNativeDiffOverlayToggle";
export type { NativeOverlayWorkspaceHints } from "./nativeDiffOverlayMain";

/** renderer patch 설치와 snapshot render 를 main process 에서 수행할 CDP expression 으로 만든다. */
export function injectionExpression(
  rendererScript: string,
  snapshots: HunkOverlaySnapshot[],
  hints: NativeOverlayWorkspaceHints
): string {
  const rendererEval = rendererEvalExpression(rendererScript);
  const snapshotJson = JSON.stringify(snapshots);
      return mainEvalExpression(
    RENDERER_BINDING,
    hints,
    `
      var rendererEval = ${JSON.stringify(rendererEval)};
      var installExpr = '(window.__gscNativeDiffOverlay&&window.__gscNativeDiffOverlay.version===' + ${PATCH_VERSION} + ')?"gsc-native-overlay-installed:${PATCH_VERSION}:cached":' + rendererEval;
      var snapshots = ${snapshotJson};
      var renderExpr = 'window.__gscNativeDiffOverlay&&window.__gscNativeDiffOverlay.render(' + JSON.stringify(snapshots) + ')';
      var out = [];
      for (var i = 0; i < wins.length; i++) {
        var item = await patchWindow(wins[i], installExpr, renderExpr);
        out.push(item);
      }
      return out.join('|');
    `
  );
}

/** renderer 에 남아 있는 overlay DOM 을 제거할 CDP expression 으로 만든다. */
export function cleanupExpression(hints: NativeOverlayWorkspaceHints): string {
  return mainEvalExpression(
    RENDERER_BINDING,
    hints,
    `
      var out = [];
      var cleanupExpr = 'window.__gscNativeDiffOverlay&&window.__gscNativeDiffOverlay.render(null)';
      for (var i = 0; i < wins.length; i++) {
        var item = await evalWindow(wins[i], cleanupExpr);
        out.push(item);
      }
      return out.join('|');
    `
  );
}

/** workbench renderer 에 상주하는 checkbox overlay patch 본문. */
export function rendererPatchScript(): string {
  return `
    (function () {
      var VERSION = ${PATCH_VERSION};
      var BINDING = ${JSON.stringify(RENDERER_BINDING)};
      var STYLE_ID = 'gsc-native-diff-overlay-style';
      var state = window.__gscNativeDiffOverlayState || {
        snapshot: null,
        localChecked: Object.create(null),
        frame: 0,
        generation: 0,
        scrollTargets: [],
        observedTargets: [],
        repaintTimers: [],
        resizeBound: false,
        documentScrollBound: false
      };
      state.scrollTargets = state.scrollTargets || [];
      state.observedTargets = state.observedTargets || [];
      window.__gscNativeDiffOverlayState = state;

      function ensureStyle() {
        var style = document.getElementById(STYLE_ID);
        if (style && style.getAttribute('data-gsc-version') === String(VERSION)) return;
        if (!style) style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-gsc-version', String(VERSION));
        style.textContent = [
          '.gsc-native-diff-overlay-layer{position:absolute;left:0;top:0;width:22px;height:100%;z-index:80;pointer-events:none;}',
          '.gsc-native-diff-checkbox-wrap{width:16px;display:flex;align-items:center;justify-content:center;pointer-events:auto;}',
          '.gsc-native-diff-checkbox-row{position:absolute;left:2px;z-index:200;}',
          '.gsc-native-diff-checkbox{width:13px;height:13px;margin:0;padding:0;cursor:pointer;accent-color:var(--vscode-focusBorder);}',
          '.gsc-native-diff-checkbox:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:1px;}'
        ].join('\\n');
        if (!style.parentNode) document.head.appendChild(style);
      }

      function cleanup() {
        Array.prototype.slice.call(document.querySelectorAll('.gsc-native-diff-overlay-layer')).forEach(function (el) {
          try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
        });
        Array.prototype.slice.call(document.querySelectorAll('.gsc-native-diff-checkbox-wrap')).forEach(function (el) {
          try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
        });
      }

      function schedulePaint() {
        if (state.frame) return;
        state.frame = requestAnimationFrame(function () {
          state.frame = 0;
          paint();
        });
      }

      function scheduleViewportPaint() { schedulePaint(); setTimeout(schedulePaint, 24); }

      function clearFollowUpPaints() {
        (state.repaintTimers || []).forEach(function (timer) { try { clearTimeout(timer); } catch (_) {} });
        state.repaintTimers = [];
      }

      function scheduleFollowUpPaints() {
        clearFollowUpPaints();
        [40, 120, 300, 700, 1200, 2000, 3500, 5200, 7600, 11000].forEach(function (delay) {
          state.repaintTimers.push(setTimeout(schedulePaint, delay));
        });
      }

      function bindViewportEvents() {
        state.scrollTargets = (state.scrollTargets || []).filter(function (target) {
          return target && target.isConnected;
        });
        var scrollTargets = Array.prototype.slice.call(document.querySelectorAll('.monaco-scrollable-element')).filter(function (target) {
          if (!target || !target.querySelector) return false;
          return !!target.querySelector('.editor.original,.editor.modified,.monaco-diff-editor,.margin-view-overlays');
        });
        scrollTargets.forEach(function (target) {
          if (state.scrollTargets.indexOf(target) >= 0) return;
          state.scrollTargets.push(target);
          target.addEventListener('scroll', scheduleViewportPaint, { passive: true });
          target.addEventListener('wheel', scheduleViewportPaint, { passive: true });
        });
        if (!state.resizeBound) {
          state.resizeBound = true;
          window.addEventListener('resize', schedulePaint, { passive: true });
        }
        if (!state.documentScrollBound) {
          state.documentScrollBound = true;
          document.addEventListener('scroll', function (event) {
            var target = event && event.target;
            if (!target || !target.closest) {
              scheduleViewportPaint();
              return;
            }
            if (target.closest('.monaco-diff-editor,.editor.original,.editor.modified,.margin-view-overlays')) {
              scheduleViewportPaint();
            }
          }, true);
        }
      }

      function isOverlayNode(node) {
        return !!(
          node &&
          node.nodeType === 1 &&
          (
            (node.classList && node.classList.contains('gsc-native-diff-overlay-layer')) ||
            (node.classList && node.classList.contains('gsc-native-diff-checkbox-wrap')) ||
            (node.closest && node.closest('.gsc-native-diff-overlay-layer,.gsc-native-diff-checkbox-wrap'))
          )
        );
      }

      function mutationIsOverlayOnly(mutation) {
        if (isOverlayNode(mutation.target)) return true;
        if (mutation.type !== 'childList') return false;
        var nodes = Array.prototype.slice.call(mutation.addedNodes || []).concat(Array.prototype.slice.call(mutation.removedNodes || []));
        return !!nodes.length && nodes.every(isOverlayNode);
      }

	      function observeEditorDom(editorDom) {
	        if (!editorDom || typeof MutationObserver === 'undefined') return;
	        state.observedTargets = (state.observedTargets || []).filter(function (target) { return target && target.isConnected; });
	        var targets = [editorDom.querySelector('.margin-view-overlays'), editorDom.querySelector('.view-lines')].filter(Boolean);
        targets.forEach(function (target) {
          if (state.observedTargets.indexOf(target) >= 0) return;
          state.observedTargets.push(target);
          var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
              if (!mutationIsOverlayOnly(mutations[i])) {
                scheduleViewportPaint();
                return;
              }
            }
          });
          try {
            observer.observe(target, { childList: true, subtree: false, attributes: true, attributeFilter: ['style', 'class', 'data-line-number'] });
          } catch (_) {}
        });
	      }

      function findEditorDom(side) {
        var selector = side === 'original' ? '.editor.original' : '.editor.modified';
        return Array.prototype.slice.call(document.querySelectorAll(selector)).filter(isVisibleNode)[0] || null;
      }

      function visibleDiffDoms() {
        var nodes = Array.prototype.slice.call(document.querySelectorAll('.monaco-diff-editor'));
        return nodes.flatMap(function (dom) {
          if (!isVisibleNode(dom)) return [];
          if (!dom.querySelector('.editor.original') || !dom.querySelector('.editor.modified')) return [];
          return [{ dom: dom }];
        });
      }

      function isVisibleNode(node) {
        return !!(node && node.isConnected && node.offsetParent !== null && node.clientWidth > 0 && node.clientHeight > 0);
      }

      function fallbackTargets(snapshotIndex, snapshotCount, side) {
        var selector = side === 'original' ? '.editor.original' : '.editor.modified';
        var diffs = visibleDiffDoms();
        if (diffs.length === snapshotCount && diffs[snapshotIndex]) {
          var sideDom = diffs[snapshotIndex].dom.querySelector(selector);
          return sideDom ? [{ editor: null, dom: sideDom, source: 'dom-order' }] : [];
        }
        var dom = snapshotCount === 1 ? findEditorDom(side) : null;
        return dom ? [{ editor: null, dom: dom, source: 'dom-best' }] : [];
      }

      function findTargets(snapshot, side, snapshotIndex, snapshotCount) {
        return fallbackTargets(snapshotIndex, snapshotCount, side);
      }

      function rowLineNumber(row) {
        var lineEl = row.querySelector('.line-numbers');
        var direct = row.getAttribute && row.getAttribute('data-line-number');
        if (direct && /^\\d+$/.test(direct)) return Number(direct);
        var data = lineEl && lineEl.getAttribute && lineEl.getAttribute('data-line-number');
        if (data && /^\\d+$/.test(data)) return Number(data);
        var text = [
          lineEl && lineEl.getAttribute && lineEl.getAttribute('aria-label'),
          lineEl && lineEl.getAttribute && lineEl.getAttribute('title'),
          lineEl && lineEl.textContent,
          lineEl && lineEl.innerText
        ].filter(Boolean).join(' ');
        var match = /(?:^|\\D)(\\d+)(?:\\D|$)/.exec(text);
        return match ? Number(match[1]) : 0;
      }

      function linesForSide(snapshot, side) {
        return (snapshot.lines || []).filter(function (line) {
          return (line.side || 'modified') === side;
        });
      }

      // 라인 표시 문제를 재현할 때 snapshot 의 줄 범위와 체크 상태를 paint 로그에 압축해 남긴다.
      function lineStats(lines) {
        var min = 0, max = 0, checked = 0, ids = 0;
        (lines || []).forEach(function (line) {
          var no = Number(line.line) || 0;
          if (no) { if (!min || no < min) min = no; if (no > max) max = no; }
          if (line.checked) checked++;
          ids += ((line.lineIds || []).length);
        });
        return (lines || []).length + '@' + (min ? (min + '-' + max) : 'none') + ',checked=' + checked + ',ids=' + ids;
      }

      function makeLineMap(snapshot, side) {
        var map = new Map();
        linesForSide(snapshot, side).forEach(function (line) {
          map.set(Number(line.line), line);
        });
        return map;
      }

      function ensureRelative(host) {
        try {
          if (window.getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
          }
        } catch (_) {}
      }

      function createCheckboxWrap(snapshot, line, marker) {
        var wrap = document.createElement('span');
        wrap.className = 'gsc-native-diff-checkbox-wrap';
        var input = document.createElement('input');
        var lineIds = line.lineIds || [];
        input.type = 'checkbox';
        input.className = 'gsc-native-diff-checkbox';
        input.checked = checkedValue(snapshot.uri, line, marker);
        var action = snapshot.action === 'unstage' ? 'Unstage' : 'Stage';
        input.setAttribute('aria-label', action + (line.side === 'original' ? ' this deleted line' : ' this added line'));
        input.title = input.getAttribute('aria-label');
        input.setAttribute('data-line-ids', lineIds.join('\\u0000'));
        input.setAttribute('data-visible-side', line.side || '');
        input.setAttribute('data-visible-line', String(line.line || ''));
        input.setAttribute('data-visible-marker', marker || '');
        input.addEventListener('mousedown', stopEditorEvent, true);
        input.addEventListener('pointerdown', stopEditorEvent, true);
        input.addEventListener('click', function (event) {
          stopEditorClick(event);
        }, true);
        input.addEventListener('change', function (event) {
          stopEditorClick(event);
          line.checked = input.checked;
          rememberLocalChecked(snapshot.uri, line, marker, input.checked);
          notifyToggle(snapshot.uri, lineIds, input.checked, line.side, line.line, marker);
        }, true);
        wrap.appendChild(input);
        return wrap;
      }

      function ensureLayer(host) {
        var layer = host.querySelector('.gsc-native-diff-overlay-layer');
        if (!layer) {
          ensureRelative(host);
          layer = document.createElement('div');
          layer.className = 'gsc-native-diff-overlay-layer';
          host.appendChild(layer);
        }
        return layer;
      }

      function appendCheckboxAtRow(layer, row, snapshot, line, marker) {
        var wrap = createCheckboxWrap(snapshot, line, marker);
        wrap.className += ' gsc-native-diff-checkbox-row';
        wrap.style.top = rowStyleNumber(row, 'top', 0) + 'px';
        wrap.style.height = Math.max(12, rowStyleNumber(row, 'height', 18)) + 'px';
        layer.appendChild(wrap);
      }

      function rowStyleNumber(row, name, fallback) {
        var value = parseFloat(row && row.style && row.style[name] || '');
        return Number.isFinite(value) ? value : fallback;
      }

      function stopEditorEvent(event) {
        try {
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        } catch (_) {}
      }

      function stopEditorClick(event) {
        try {
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        } catch (_) {}
      }

      function notifyToggle(uri, lineIds, checked, side, line, marker) {
        try {
          var fn = window[BINDING];
          if (typeof fn === 'function') {
            fn(JSON.stringify({ uri: uri, lineIds: lineIds, checked: !!checked, side: side, line: line, marker: marker }));
          }
        } catch (_) {}
      }

      function lineKey(uri, line, marker) {
        var lineIds = line.lineIds || [];
        if (lineIds.length) return uri + '\\u0000ids\\u0000' + lineIds.join('\\u0000');
        return uri + '\\u0000visible\\u0000' + (line.side || '') + '\\u0000' + (line.line || '') + '\\u0000' + (marker || '');
      }

      function rememberLocalChecked(uri, line, marker, checked) {
        state.localChecked[lineKey(uri, line, marker)] = {
          checked: !!checked,
          at: Date.now(),
          generation: state.generation || 0
        };
      }

      function checkedValue(uri, line, marker) {
        var key = lineKey(uri, line, marker);
        var local = state.localChecked[key];
        if (local && !!line.checked === !!local.checked) {
          delete state.localChecked[key];
          return !!line.checked;
        }
        if (local && Date.now() - local.at < 3500) {
          return !!local.checked;
        }
        if (local) {
          delete state.localChecked[key];
        }
        return !!line.checked;
      }

      function rowDiffMarker(row) {
        if (!row || !row.querySelector) return '';
        if (row.querySelector('.gutter-insert,.insert-sign,.codicon-diff-insert')) return 'insert';
        if (row.querySelector('.gutter-delete,.delete-sign,.codicon-diff-remove')) return 'delete';
        if (row.querySelector('.gutter-modified,.modified-sign,.codicon-diff-modified')) return 'modified';
        return '';
      }

      function markerMatchesSide(marker, side) {
        if (side === 'modified') return marker === 'insert' || marker === 'modified';
        return marker === 'delete' || marker === 'modified';
      }

      function paintWithDomRows(snapshot, sourceDom, side) {
        var sourceMargin = sourceDom && sourceDom.querySelector('.margin-view-overlays');
        if (!sourceMargin) {
          return { count: 0, rows: 0, range: 'no-margin' };
        }
        var layer = ensureLayer(sourceMargin);
        layer.textContent = '';
        var lineMap = makeLineMap(snapshot, side);
        var rows = Array.prototype.slice.call(sourceMargin.children || []);
        var placed = 0, rowCount = 0, rowMin = 0, rowMax = 0;
        var matched = [];
        var visible = new Set();
        var markerRows = [];
        var markerWithoutLineId = [];
        var lineFallback = [];
        var markerEntries = [];
        var lineRows = [];
        var usedLineNos = new Set();
        var usedRows = new Set();
        rows.forEach(function (row) {
          if (row.classList && row.classList.contains('gsc-native-diff-overlay-layer')) return;
          var lineNo = rowLineNumber(row);
          if (lineNo) { visible.add(lineNo); rowCount++; if (!rowMin || lineNo < rowMin) rowMin = lineNo; if (lineNo > rowMax) rowMax = lineNo; }
          var marker = rowDiffMarker(row);
          var line = lineMap.get(lineNo);
          var info = { row: row, lineNo: lineNo, marker: marker, line: line };
          if (line) lineRows.push(info);
          if (markerMatchesSide(marker, side) && lineNo) {
            markerEntries.push(info);
          }
          if (marker && lineNo && markerRows.length < 24) {
            markerRows.push(lineNo + ':' + marker);
          }
        });
        markerEntries.forEach(function (entry) {
          if (usedRows.has(entry.row)) return;
          var line = entry.line || {
            side: side,
            line: entry.lineNo,
            lineIds: [],
            checked: false
          };
          if (entry.line && usedLineNos.has(entry.lineNo)) {
            usedRows.add(entry.row);
            if (markerWithoutLineId.length < 24) markerWithoutLineId.push(entry.lineNo + ':' + entry.marker + ':duplicate');
            return;
          }
          appendCheckboxAtRow(layer, entry.row, snapshot, line, entry.marker);
          if (entry.line) {
            usedLineNos.add(entry.lineNo);
            if (matched.length < 24) matched.push(String(entry.lineNo));
          } else {
            if (markerWithoutLineId.length < 24) markerWithoutLineId.push(entry.lineNo + ':' + entry.marker + ':visible');
            if (matched.length < 24) matched.push(entry.lineNo + '!');
          }
          usedRows.add(entry.row);
          placed++;
        });
        lineRows.forEach(function (entry) {
          if (usedLineNos.has(entry.lineNo) || usedRows.has(entry.row)) return;
          appendCheckboxAtRow(layer, entry.row, snapshot, entry.line, entry.marker || 'line');
          usedLineNos.add(entry.lineNo);
          usedRows.add(entry.row);
          if (lineFallback.length < 24) lineFallback.push(String(entry.lineNo));
          if (matched.length < 24) matched.push(entry.lineNo + '~');
          placed++;
        });
        var missing = [];
        return {
          count: placed,
          rows: rowCount,
          range: rowMin ? (rowMin + '-' + rowMax) : 'none',
          markers: markerRows.join('/'),
          sample: matched.join('/'),
          missing: missing.slice(0, 24).join('/'),
          markerWithoutLineId: markerWithoutLineId.join('/'),
          lineWithoutMarker: lineFallback.join('/'),
        };
      }

      function paintSideOnTarget(snapshot, sourceTarget, side) {
        var source = (sourceTarget && sourceTarget.source) || 'dom';
        var dom = paintWithDomRows(snapshot, sourceTarget && sourceTarget.dom, side);
        return {
          count: dom.count,
          source: source + '+vscode-marker-first-row(rows=' + dom.rows + ',rowLines=' + dom.range + ',markers=' + dom.markers + ',matched=' + dom.sample + ',missing=' + dom.missing + ',markerNoId=' + dom.markerWithoutLineId + ',lineNoMarker=' + dom.lineWithoutMarker + ')',
        };
      }

      function paint() {
        var snapshots = normalizeSnapshots(state.snapshot);
        if (!snapshots.length) {
          cleanup();
          state.lastPaint = 'paint:none';
          return state.lastPaint;
        }
        ensureStyle();
        bindViewportEvents();
        cleanup();
        var placed = 0;
        var details = [];
        snapshots.forEach(function (snapshot, snapshotIndex) {
          ['original', 'modified'].forEach(function (side) {
            var sideLines = linesForSide(snapshot, side);
            var sourceTargets = findTargets(snapshot, side, snapshotIndex, snapshots.length);
            if (!sourceTargets.length || !sourceTargets[0].dom) {
              details.push(snapshot.path + ':' + side + '[' + lineStats(sideLines) + ']:no-source');
              return;
            }
            observeEditorDom(sourceTargets[0].dom);
            var result = paintSideOnTarget(snapshot, sourceTargets[0], side);
            placed += result.count;
            if (result.count || sideLines.length) {
              details.push(snapshot.path + ':' + side + '[' + lineStats(sideLines) + ']->' + side + ':' + result.source + ':' + result.count + '/' + sideLines.length);
            }
          });
        });
        if (!details.length) {
          cleanup();
          state.lastPaint = 'paint:no-editor';
          return state.lastPaint;
        }
        state.lastPaint = 'paint:native:' + placed + '/' + snapshots.reduce(function (sum, snapshot) { return sum + ((snapshot.lines && snapshot.lines.length) || 0); }, 0) + ':' + details.join(',');
        return state.lastPaint;
      }

      function normalizeSnapshots(snapshot) {
        if (!snapshot) return [];
        return (Array.isArray(snapshot) ? snapshot : [snapshot]).filter(function (item) {
          return item && item.lines;
        });
      }

      window.__gscNativeDiffOverlay = {
        version: VERSION,
        render: function (snapshot) {
          clearFollowUpPaints();
          state.generation = (state.generation || 0) + 1;
          state.snapshot = snapshot || null;
          if (!snapshot) {
            cleanup();
            return 'cleaned';
          }
          var painted = paint();
          schedulePaint();
          scheduleFollowUpPaints();
          return painted || ('render-scheduled:' + normalizeSnapshots(snapshot).length);
        }
      };
      return 'gsc-native-overlay-installed:' + VERSION;
    })()
  `;
}
