// Review Center 렌더러의 순수 표시 포맷 모듈.
// - DOM 상태와 분리해 번역 텍스트, 숫자, 날짜, GitHub enum 변환을 한 곳에서 유지한다.
(function () {
  "use strict";

  /** Review Center가 공유해 쓰는 표시 포맷 함수를 만든다. */
  window.__gscReviewCenterFormat = function createReviewCenterFormat({ T }) {
    /** 번역된 탭 이름이 없을 때도 안전한 영문 fallback을 제공한다. */
    function title(value) {
      return T[value] || value.charAt(0).toUpperCase() + value.slice(1);
    }

    /** GitHub enum을 화면에서 읽기 쉬운 Title Case로 바꾼다. */
    function decision(value) {
      return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    /** locale에 맞춘 짧은 날짜·시각을 만든다. */
    function formatDate(value) {
      if (!value) return T.updatedUnavailable;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return T.updatedUnavailable;
      return `${T.updatedPrefix} ${new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      }).format(date)}`;
    }

    /** count와 diff stat을 사용자 locale의 숫자 표기로 바꾼다. */
    function formatNumber(value) {
      return new Intl.NumberFormat().format(Number.isFinite(value) ? value : 0);
    }

    /** l10n host가 치환한 {0} 형태의 짧은 template을 적용한다. */
    function template(value, ...values) {
      return String(value || "").replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ""));
    }

    return { title, decision, formatDate, formatNumber, template };
  };
}());
