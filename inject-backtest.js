/**
 * inject-backtest.js
 * backtest-engine.js 를 동적으로 로드합니다.
 * index.html의 </body> 직전에 이 파일을 추가하면 됩니다.
 * 단, 이 파일 자체가 </body> 직전 <script src="inject-backtest.js"></script>로
 * 이미 삽입되어 있다면 자동 실행됩니다.
 */
(function () {
  'use strict';

  function loadScript(src, onLoad) {
    const s = document.createElement('script');
    s.src = src;
    s.defer = true;
    if (onLoad) s.onload = onLoad;
    document.body.appendChild(s);
  }

  // DOM 완전 로드 후 실행
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    // 이미 로드되어 있으면 스킵
    if (window.__backtestEngineLoaded) return;
    window.__backtestEngineLoaded = true;
    loadScript('./backtest-engine.js', function () {
      console.log('[inject-backtest] backtest-engine.js 로드 완료 ✅');
    });
  }
})();
