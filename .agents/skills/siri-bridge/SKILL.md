---
name: siri-bridge
description: OpenClaw-Siri 브릿지 서버 기능 추가/수정. Express + cloudflared 터널.
argument-hint: "[기능 설명 - 예: 새 Siri 단축어 커맨드 추가]"
---

## Siri 브릿지 기능 추가

대상: **$ARGUMENTS**

### Agent 지침 동기화
- 이 저장소는 Claude와 Codex 지침을 함께 유지한다.
- 한쪽 파일을 수정하면 같은 커밋에서 다른 쪽도 함께 갱신한다.
- 대상 파일: `.claude/skills/siri-bridge/SKILL.md`, `.agents/skills/siri-bridge/SKILL.md`

### 프로젝트 구조
- `server.js` — Express HTTP 서버 (OpenClaw 바이너리 연동)
- `siri-bridge.sh` — cloudflared 터널 관리
- `generate-shortcut.js` — iOS 단축어 생성기

### 워크플로우
1. `server.js`에 새 라우트/핸들러 추가
2. 필요 시 `generate-shortcut.js`에 새 단축어 템플릿 추가
3. 인증 토큰 검증 로직 유지

### 실행
```bash
node server.js           # 로컬 서버 시작
./siri-bridge.sh start   # 터널 시작
```
