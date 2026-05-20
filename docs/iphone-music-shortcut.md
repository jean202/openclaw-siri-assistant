# iPhone Hands-Free Music Shortcut

이 문서는 iPhone에서 잠금 해제 없이 음악 재생까지 가기 위한 Shortcut 구성입니다.

## 전제

- Melon에 `음악검색하기`만 보이면 Melon 자동 재생은 불가능합니다.
- 완전 핸즈프리 재생은 iOS의 `음악` 앱, 즉 Apple Music의 `Play Music` 액션을 사용합니다.
- `POST /music`는 음성 명령을 Apple Music이 찾기 쉬운 `query`로 바꿉니다.
- 서비스 전환은 서버의 `MUSIC_SERVICE`로 관리합니다. `apple_music`은 자동 재생, `melon`은 현재 검색 액션까지만 가능합니다.

## 서비스 전환

현재 Melon 구독이면 `.env`에 아래처럼 설정합니다.

```bash
MUSIC_SERVICE=melon
```

나중에 Apple Music 구독으로 바꾸면 아래처럼 바꾼 뒤 브릿지를 재시작합니다.

```bash
MUSIC_SERVICE=apple_music
```

iPhone 단축어를 하나로 유지하려면 `/music` 응답에서 `service` 값을 추가로 꺼내서 분기하세요.

- `service`가 `apple_music`: `query`를 `음악 재생` 액션에 연결
- `service`가 `melon`: `query`를 Melon의 `음악검색하기` 액션에 연결

Melon이 `재생` 액션을 제공하기 전까지는 이 분기의 Melon 쪽을 자동 재생으로 만들 수 없습니다.

## Shortcut 구성

자동 생성 파일을 쓰는 방법:

1. Mac에서 `node generate-music-shortcut.js` 실행
2. 생성된 `PlayOpenClawMusic.shortcut`을 iPhone으로 전송
3. iPhone 단축어 앱에서 가져온 뒤 원하는 Siri 호출 이름으로 변경
4. 단축어 안의 마지막 액션이 `음악 재생`인지 확인

자동 생성 단축어는 `query` 값을 `음악 재생` 액션의 입력으로 직접 연결합니다.
만약 iOS가 텍스트 검색어를 음악 항목으로 자동 변환하지 못하면 아래 수동 구성을 사용하세요.

Shortcut 이름 예시: `음악 틀어줘`

1. `기기 세부사항 가져오기`
   - 항목: `기기 이름`
2. `입력 요청` 또는 `텍스트 받아쓰기`
   - 프롬프트: `무슨 음악 틀까요?`
   - 입력 유형: `텍스트`
3. `URL 내용 가져오기`
   - URL: `https://YOUR_TUNNEL_URL/music`
   - 방식: `POST`
   - 요청 본문: `JSON`
   - JSON 필드:
     - `secret`: `.secret` 값
     - `message`: 2번에서 받은 입력
     - `session_id`: 1번의 기기 이름
4. `사전 값 가져오기`
   - 키: `query`
   - 입력: 3번의 응답
5. `음악 재생`
   - 앱: `음악`
   - Music Item 또는 검색어 입력 칸에 4번의 `query` 변수를 넣습니다.
   - iOS가 텍스트 변수를 직접 받지 않으면, 중간에 Apple Music 검색/찾기 액션을 추가하고 그 결과를 `음악 재생`에 넘깁니다.

## 호출 예시

```text
시리야, 음악 틀어줘
무슨 음악 틀까요?
뉴진스 ETA 틀어줘
```

서버 응답 예시:

```json
{
  "service": "apple_music",
  "action": "play_top_hit",
  "intent": "play",
  "query": "뉴진스 ETA",
  "reply": "뉴진스 ETA 재생할게요."
}
```

## 주의

- 이 방식은 iPhone 보안을 우회하지 않습니다. 앱을 여는 액션은 잠금 해제를 요구할 수 있습니다.
- `음악 재생`처럼 앱을 전면으로 열지 않는 미디어 액션을 써야 잠금 상태에서 성공할 가능성이 높습니다.
- 임시 Cloudflare URL은 재시작마다 바뀝니다. 안정적으로 쓰려면 Named Tunnel을 설정하세요.
