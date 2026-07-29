# Webview UI Test Fixtures

이 디렉터리는 surviving Changes와 staged Pull Request Preview의 browser/visual/a11y smoke가 사용하는 synthetic webview state다.
실제 GitHub 계정, 조직, 저장소, Pull Request 본문, token, 로컬 파일 경로를 넣지 않는다.

## 공통 schema

```json
{
  "schemaVersion": 1,
  "surface": "changes | pr-preview",
  "state": "small | populated | loading | error | no-target | existing-pr",
  "locale": "en | ko",
  "viewport": { "width": 1280, "height": 900 },
  "payload": {}
}
```

- `payload`는 해당 renderer가 받는 message payload를 synthetic 값으로 보관한다.
- fixture 이름은 단일 JSON 파일 이름만 허용하며, loader는 traversal·잘못된 schema·배열 payload를 거부한다.
- 새 상태는 loading·error·no-target·existing-pr 중 적절한 대표 fixture와 함께 추가한다.
- 실제 screenshot matrix는 이 fixture 이름, viewport, theme, state를 artifact metadata에
  기록한다. PR-00은 대표 smoke만 제공하며 full matrix는 각 feature slice와 PR-14가 소유한다.
