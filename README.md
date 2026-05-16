# OpenClaw Siri Assistant

iPhone Siri에서 음성으로 OpenClaw AI에 질문하고 답변을 음성으로 들을 수 있는 브릿지 서버입니다.

```
iPhone Siri → Shortcut → cloudflared 터널 → localhost:3456 → OpenClaw CLI → AI 응답 → Siri 음성 출력
```

## 주요 기능

- Siri 음성 입력/출력으로 OpenClaw 사용
- 대화 이어가기 (한 세션에서 최대 20턴 연속 대화)
- 디바이스별 세션 자동 분리 + 30분 무활동 시 세션 리셋
- 서버 에러 시 음성으로 안내
- macOS 부팅 시 자동 시작 (LaunchAgent)
- 터널 URL 변경 시 Shortcut 자동 재생성
- Named Tunnel 지원으로 고정 URL 사용 가능

## 사전 요구사항

- macOS
- [Node.js](https://nodejs.org/)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) — `brew install cloudflared`
- [OpenClaw CLI](https://openclaw.dev/) — `openclaw` 명령이 PATH에 있어야 함

## 빠른 시작

```bash
# 1. 서버 + 터널 시작 (포그라운드)
./start.sh

# 2. 생성된 AskOpenClaw.shortcut을 iPhone으로 전송
#    (AirDrop, iCloud Drive, 이메일 등)

# 3. iPhone에서 "Hey Siri, Ask OpenClaw"
```

```bash
# smoke test 실행
npm test
```

## 설치 & 설정

### 기본 설정

```bash
# .env 파일 생성 (선택사항 — 없으면 기본값 사용)
cp .env.example .env
```

주요 설정 (`env`):

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3456` | HTTP 서버 포트 |
| `API_SECRET` | 자동 생성 | API 인증 키 (.secret에 저장) |
| `TIMEOUT_SEC` | `120` | OpenClaw 응답 타임아웃 |
| `MAX_BODY_BYTES` | `32768` | `POST /ask` JSON 바디 최대 크기 (bytes) |
| `SESSION_TIMEOUT_MIN` | `30` | 세션 만료 시간 (분) |
| `TUNNEL_NAME` | (없음) | Named Tunnel 이름 (고정 URL용) |
| `TUNNEL_HOSTNAME` | (없음) | Named Tunnel 커스텀 도메인 |

### macOS 자동 시작

```bash
# 설치 (로그인 시 자동 시작)
./install-launchagent.sh

# 제거
./install-launchagent.sh uninstall
```

관리 명령어:

```bash
# 상태 확인
launchctl print gui/$(id -u)/com.openclaw.siri-bridge

# 로그 보기
tail -f logs/bridge.log

# 재시작
launchctl kickstart -k gui/$(id -u)/com.openclaw.siri-bridge

# 정지
launchctl bootout gui/$(id -u)/com.openclaw.siri-bridge
```

### 고정 URL (Named Tunnel)

기본적으로 cloudflared는 임시 URL을 발급하며, 재시작마다 변경됩니다.
고정 URL을 원하면 Named Tunnel을 설정하세요:

```bash
# 1. Named Tunnel 생성 (Cloudflare 로그인 필요)
./setup-tunnel.sh siri-assistant siri.yourdomain.com

# 2. .env에 추가
echo "TUNNEL_NAME=siri-assistant" >> .env
echo "TUNNEL_HOSTNAME=siri.yourdomain.com" >> .env

# 3. 재시작
./start.sh
```

`./setup-tunnel.sh`는 `~/.cloudflared/config-<tunnel-name>.yml`을 만들고,
`./start.sh` / `siri-bridge.sh`는 그 파일을 자동으로 찾아 `cloudflared tunnel --config ... run`으로 실행합니다.

## Siri Shortcut 설치

### 자동 생성

서버 시작 시 자동으로 `AskOpenClaw.shortcut`이 생성됩니다.
수동으로 재생성하려면:

```bash
node generate-shortcut.js
```

### iPhone 전송 방법

1. **AirDrop** — Finder에서 `AskOpenClaw.shortcut` 파일을 AirDrop
2. **iCloud Drive** — 파일을 iCloud Drive에 복사 후 iPhone에서 탭
3. **이메일** — 첨부파일로 전송 후 iPhone에서 열기

### 사용법

- "Hey Siri, Ask OpenClaw" — 대화 시작
- 질문하면 AI가 음성으로 답변
- 이어서 추가 질문 가능 (최대 20턴)
- Siri 취소하면 대화 종료

## 프로젝트 구조

```
.
├── server.js              # HTTP 브릿지 서버 (POST /ask, GET /health)
├── start.sh               # 포그라운드 시작 스크립트
├── siri-bridge.sh          # 백그라운드 데몬 스크립트
├── generate-shortcut.js    # Siri Shortcut 파일 생성기
├── install-launchagent.sh  # macOS LaunchAgent 설치/제거
├── setup-tunnel.sh         # Named Tunnel 설정 헬퍼
├── check-url.sh            # 현재 터널 URL/상태 확인
├── .env.example            # 설정 템플릿
├── .secret                 # API 키 (자동 생성, git 제외)
├── .tunnel-url             # 현재 터널 URL (자동 갱신, git 제외)
├── logs/                   # 로그 디렉토리
│   ├── bridge.log          # 서버/터널 로그
│   ├── requests.log        # API 요청 로그
│   └── tunnel.log          # cloudflared 로그
└── docs/
    └── siri-setup-guide.html
```

## AI Agent 운영 방침

이 저장소는 Claude와 Codex를 모두 사용합니다.

- Claude용 지침은 `.claude/skills/siri-bridge/SKILL.md`에 둡니다.
- Codex용 지침은 `.agents/skills/siri-bridge/SKILL.md`에 둡니다.
- 두 파일은 같은 작업 흐름을 설명해야 하며, 한쪽을 수정하면 같은 커밋에서 다른 쪽도 함께 갱신합니다.
- 시크릿, 로그, 런타임 상태, 로컬 캐시는 커밋하지 않습니다.

## API

### POST /ask

```json
{
  "secret": "your-api-secret",
  "message": "오늘 날씨 어때?",
  "session_id": "my-iphone"
}
```

응답:

```json
{
  "reply": "오늘 서울 날씨는...",
  "session_id": "my-iphone-m1abc2d3"
}
```

잘못된 JSON, 객체가 아닌 payload, 비어 있거나 문자열이 아닌 `message`는 `400`으로 거부됩니다.
`MAX_BODY_BYTES`를 넘는 요청은 `413`을 반환합니다.

### GET /health

```json
{ "ok": true }
```

### GET /usage

Protected endpoint for usage history and token totals.

Pass the same `API_SECRET` used by `POST /ask` via either:

- query string: `/usage?secret=...`
- header: `X-API-Secret: ...`
- header: `Authorization: Bearer ...`

### GET /dashboard

Protected HTML dashboard for the same usage data.

Example:

```text
http://127.0.0.1:3456/dashboard?secret=YOUR_API_SECRET
```

## 문제 해결

| 증상 | 해결 |
|------|------|
| "서버에 연결할 수 없습니다" | `./check-url.sh`로 터널 상태 확인 |
| 터널 URL 변경 후 Shortcut 안됨 | Shortcut이 자동 재생성됨 — iPhone에 다시 전송 |
| LaunchAgent 시작 안됨 | `tail logs/launchagent-stderr.log` 확인 |
| OpenClaw 응답 없음 | `openclaw` CLI가 직접 동작하는지 확인 |
