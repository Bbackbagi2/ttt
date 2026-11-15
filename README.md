# TTT 게시물 준비

화장실 타일 테마의 개인 인스타그램 채널 TTT(The Thinker's Toilet)를 위한 아이폰 웹앱입니다. 인스타그램에 올리기 직전에 게시물 한 묶음(표지 + 본문 사진 + 캡션)을 준비합니다.

## 하는 일

- 라이브러리의 **표지 구성**을 고르고 제목만 넣어 1080×1440 표지를 만듭니다. AI는 쓰지 않습니다.
- **창 타일(가칭)**: 그림 타일 대신 벽에 1×1~7×7칸 크기의 통유리창을 냅니다. 창은 구멍처럼 다음 장(본문 첫 사진)의 같은 자리를 보여 주므로, 표지에서 넘기면 사진이 이어집니다. 창은 미리보기에서 끌거나 위치 버튼으로 옮깁니다. 창은 큰 유리 한 장이고, 유리는 두 가지 중에서 고릅니다(Tile: 투명 유리 타일 사진, Block: 유리블록 창 사진의 한 칸). 실제 사진을 창 크기로 키워 가장자리와 표면의 입체를 그대로 쓰고(`assets/window/glass-*.png`), 그 앞면에 김 서림(`fog.png`)과 물방울·흘러내린 자국(`drops.png`)이 맺힙니다. 물방울은 렌즈처럼 뒤 풍경을 비춥니다.
- 제목 타일 길이(2~7칸)와 글자 크기(자동 또는 14~80px)를 조절합니다.
- 표지 설정을 바꾼 뒤 **되돌리기**로 이전 상태로 돌아갈 수 있습니다(편집 중에만 기억).
- 본문 사진을 테마 없이 3:4로 맞춥니다(자르기 / 여백).
- 캡션을 쓰고 복사합니다. 인스타그램처럼 게시물 하나에 캡션 하나(Single caption) 또는 슬라이드마다 캡션(Multiple captions)을 고를 수 있습니다.
- 위쪽 눈 아이콘으로 피드(넘기기·캡션)와 프로필 격자에서 보일 모습을 미리 봅니다.
- 게시를 마치면 확인을 받아 표지 그림을 '사용함'으로 표시합니다. 사용한 그림은 목록 끝으로 가고 체크가 붙으며, 무작위 선택에서도 뒤로 밀립니다. 이 표시는 이 기기 브라우저에만 저장됩니다.
- 표지와 사진을 공유 시트로 사진 앱에 저장합니다.
- 초안은 최대 3개까지 **이 기기의 브라우저(IndexedDB)에만** 보관합니다. 게시 완료하면 지웁니다.

## 개인정보

- 사진·제목·캡션은 기기 밖으로 나가지 않습니다. 합성은 모두 브라우저 캔버스에서 합니다.
- `index.html`의 CSP가 외부 연결과 외부 스크립트를 막습니다.
- 이 저장소에는 앱 코드와 라이브러리 자원만 둡니다. 개인 사진·제목·캡션은 커밋하지 않습니다.

## 구조

| 경로 | 내용 |
|---|---|
| `index.html`, `style.css`, `js/` | 앱. `render.js`가 표지 합성, `store.js`가 초안 저장 |
| `assets/catalog.json` | 표지 구성 목록과 색 규칙 |
| `assets/tiles.png` | 작은 타일 사진 120개의 유약 반사·모양·그림자를 담은 지도 (R=반사+128, G=타일 모양, B=그림자) |
| `assets/pictures/` | 그림 타일 450×450. 벽 조명을 뺀 상태로 굽습니다 |
| `assets/plaque/` | 제목 타일(가로·세로 2~7칸)과 창(1~7칸 정사각) 테두리 |
| `assets/glaze/` | 유약 오버레이 (가로·세로·정사각) |
| `assets/title.woff` | 제목 서체 |
| `tools/bake.py` | Mac에서 위 자원을 굽는 스크립트 |
| `tools/glass_tile.py` | 사진 한 칸으로 창 유리 레이어를 굽는 스크립트. Tile은 타일 라이브러리의 `tile-104.png`(`--tile tile-104.png --name glass-tile`), Block은 [Glass block window - Arlington, MA - 04.jpg](https://commons.wikimedia.org/wiki/File:Glass_block_window_-_Arlington,_MA_-_04.jpg)(Daderot, CC0)의 한 칸(`--photo <원본> --box 1572,966,1822,1222 --name glass-block`) |
| `tools/condensation.py` | 창 유리의 습기·물방울 레이어(`assets/window/`)를 굽는 스크립트. 같은 채널 규칙을 지키면 실제 사진 기반 레이어로 바꿀 수 있습니다 |
| `tools/icons.py` | 라이브러리 획·타일로 앱 아이콘 후보를 만드는 스크립트. `--only app`은 채택한 아이콘(C6 코발트)을 `icon-1024.png`와 `icon-<해시>-180.png`·`icon-<해시>-512.png`로 씁니다. iOS가 홈 화면 아이콘을 강하게 캐시하므로 파일 이름에 내용 해시를 넣고, 새 이름을 `index.html`과 `manifest.webmanifest`에 반영합니다 |

## 자원 굽기 (Mac)

```bash
python3 tools/bake.py --project "<Proj-TheThinker'sToilet 폴더>" --generated 24
```

numpy, scipy, Pillow, fontTools가 필요합니다. v14 표지 12장에서 그림 타일을 가져오고, 붓·기하학 기호로 새 구성 24개를 만듭니다. Mac의 AI(Codex·Claude)가 새 구성을 만들 때도 `assets/pictures/`에 450×450 그림 타일을 넣고 `catalog.json`의 `compositions`에 항목을 추가하면 됩니다.

코드를 바꾸면 `index.html`과 `js/app.js`의 `?v=` 숫자를 올려 브라우저 캐시를 넘깁니다.

## 로컬 확인

```bash
python3 -m http.server 8765
```
