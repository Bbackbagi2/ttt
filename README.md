# TTT 게시물 준비

화장실 타일 테마의 개인 인스타그램 채널 TTT(The Thinker's Toilet)를 위한 아이폰 웹앱입니다. 인스타그램에 올리기 직전에 게시물 한 묶음(표지 + 본문 사진 + 캡션)을 준비합니다.

## 하는 일

- 라이브러리의 **표지 구성**을 고르고 제목만 넣어 1080×1440 표지를 만듭니다. AI는 쓰지 않습니다.
- 본문 사진을 테마 없이 3:4로 맞춥니다(자르기 / 여백).
- 캡션을 쓰고 복사합니다.
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
| `assets/plaque-*.png`, `assets/glaze/` | 제목 타일 테두리와 유약 오버레이 |
| `assets/title.woff` | 제목 서체 |
| `tools/bake.py` | Mac에서 위 자원을 굽는 스크립트 |

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
