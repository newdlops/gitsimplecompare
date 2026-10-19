// 실제 Code Vision 갱신이 사용하는 Monaco 접근자에서 편집기 참조를 한 번 얻는다.
// - 기존 메서드의 인자/this/반환값/예외는 그대로 유지하며, 성공 또는 800ms 만료 시 원래 descriptor로 복원한다.

/**
 * editor prototype에 설치할 일회성 관찰 함수를 조립한다. 함수 실행만으로 메서드나 UI 동작을 호출하지 않는다.
 * @param bindEditorFunction 정확한 URI·가시성을 검증하고 editor/service 약한 참조를 저장하는 함수 문자열
 * @returns Runtime.callFunctionOn의 this로 prototype, 첫 인자로 대상 URI를 받는 renderer 함수
 */
export function nativeBlameEditorCaptureFunction(bindEditorFunction: string): string {
  return `function(uri) {
    var prototype = this, previous = window.__gscNativeBlameEditorCapture;
    if (previous && previous.uri === uri && !previous.settled) return 'editor-observing:' + uri;
    if (previous && previous.cancel) previous.cancel();
    var originals = [], resolving, timer, capturing = false;
    var state = {uri:uri,settled:false,ready:new Promise(function(resolve){resolving=resolve;})};
    // 성공·취소·만료를 한 번만 완료하고, 우리 wrapper인 경우에만 원래 메서드 descriptor로 되돌린다.
    function finish(found) {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(timer);
      originals.forEach(function(item){
        try {
          var current = Object.getOwnPropertyDescriptor(prototype, item.name);
          if (current && current.value === item.wrapper) Object.defineProperty(prototype, item.name, item.descriptor);
        } catch (_) {}
      });
      if (window.__gscNativeBlameEditorCapture === state) delete window.__gscNativeBlameEditorCapture;
      if (found && window.__gscNativeBlameEditorRef) delete window.__gscNativeBlameEditor;
      resolving(found);
    }
    state.cancel = function(){finish(false);};
    ['getModel','getDomNode','getLayoutInfo'].forEach(function(name){
      var descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || !descriptor.configurable || typeof descriptor.value !== 'function') return;
      var original = descriptor.value;
      var wrapper = function(){
        var value = Reflect.apply(original, this, arguments);
        if (!capturing && !state.settled) {
          capturing = true;
          try { if (/^editor-bound:/.test((${bindEditorFunction}).call([this], uri))) finish(true); }
          catch (_) {} finally { capturing = false; }
        }
        return value;
      };
      try {
        Object.defineProperty(prototype, name, Object.assign({}, descriptor, {value:wrapper}));
        originals.push({name:name,descriptor:descriptor,wrapper:wrapper});
      } catch (_) {}
    });
    if (!originals.length) { finish(false); return 'editor-observer-unavailable'; }
    window.__gscNativeBlameEditorCapture = state;
    // 종료/탭 이동이 있어도 renderer 자체의 짧은 timer가 원본 메서드를 복원한다.
    timer = setTimeout(function(){finish(false);if(window.__gscNativeBlameEditorCapture===state)delete window.__gscNativeBlameEditorCapture;},800);
    return 'editor-observing:' + uri;
  }`;
}
