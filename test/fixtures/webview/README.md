# Webview UI Test Fixtures

이 디렉터리는 PR-00의 browser/visual/a11y smoke가 사용하는 synthetic webview state다.
실제 GitHub 계정, 조직, 저장소, Pull Request 본문, token, 로컬 파일 경로를 넣지 않는다.

## 공통 schema

```json
{
  "schemaVersion": 1,
  "surface": "changes | reviews | review-workspace",
  "state": "small | large | error | populated",
  "locale": "en | ko",
  "viewport": { "width": 1280, "height": 900 },
  "payload": {}
}
```

- `payload`는 해당 renderer가 받는 message payload를 synthetic 값으로 보관한다.
- `large` fixture는 generator 또는 compact template을 우선 사용한다. 대형 실데이터를
  복사하거나 giant JSON을 무조건 commit하지 않는다.
- 새 surface는 small·error와 한국어 또는 long-text 대표 fixture를 함께 추가한다.
- 실제 screenshot matrix는 이 fixture 이름, viewport, theme, state를 artifact metadata에
  기록한다. PR-00은 대표 smoke만 제공하며 full matrix는 각 feature slice와 PR-14가 소유한다.
