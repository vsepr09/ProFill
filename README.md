# 단백질 채우기

헬스하는 친구들을 위한 하루 단백질 목표 채우기 사이트예요. 무료로 운영돼요.

- GitHub Pages: 사이트를 올려 두는 곳
- Firebase: 계정과 기록 저장
- GitHub Actions: 매일 자정 나이스에서 학교 급식 받아오기

아이패드 Safari만으로 모두 설정할 수 있어요.

## 1. GitHub에 올리기

1. github.com에 가입하고 오른쪽 위 **+ > New repository**로 저장소를 만들어요. 이름 예: `protein`, **Public** 선택.
2. 저장소에서 **Add file > Upload files**를 누르고, 압축을 푼 폴더 안의 파일을 모두 골라 올려요.
   `index.html`, `style.css`, `app.js`, `data.js`, `firebase-config.js`, `fetch_meals.py`, `firestore.rules`, `README.md`
3. `.github` 폴더는 아이패드 파일 앱에서 숨겨져 안 보일 수 있어요. 그래서 직접 만들어요.
   **Add file > Create new file**에서 이름 칸에 `.github/workflows/deploy.yml`을 입력하고, 압축 파일 안의 같은 파일 내용(아래 부록에도 있음)을 붙여 넣고 **Commit changes**.

## 2. Firebase 설정 (계정과 저장)

1. console.firebase.google.com에서 **프로젝트 추가** (애널리틱스는 꺼도 돼요).
2. **빌드 > Authentication > 시작하기 > 이메일/비밀번호 > 사용 설정 > 저장**.
   (사이트에서는 아이디만 쓰지만, 안에서는 `아이디@iasa-protein.app` 형식으로 저장돼요. 메일은 보내지 않아요.)
3. **빌드 > Firestore Database > 데이터베이스 만들기**. 위치는 `asia-northeast3 (서울)`, **프로덕션 모드**.
4. Firestore의 **규칙** 탭에 `firestore.rules` 내용을 붙여 넣고 **게시**.
5. 프로젝트 설정(톱니바퀴) > **내 앱 > 웹(</>)** 으로 앱을 등록하면 `firebaseConfig` 값이 나와요.
   GitHub에서 `firebase-config.js`를 열고 연필 아이콘으로 수정해서 값을 붙여 넣은 뒤 커밋해요.
6. **Authentication > 설정 > 승인된 도메인 > 도메인 추가**에 `내GitHub아이디.github.io`를 넣어요.

## 3. 나이스 급식 인증키

1. open.neis.go.kr에 가입하고 **마이페이지 > 인증키 발급**을 받아요 (무료).
2. GitHub 저장소 **Settings > Secrets and variables > Actions > New repository secret**
   - Name: `NEIS_KEY`
   - Secret: 발급받은 인증키

학교는 `인천과학예술영재학교`(인천광역시교육청)로 자동 검색돼요.

## 4. 사이트 켜기

1. 저장소 **Settings > Pages > Build and deployment > Source**를 **GitHub Actions**로 바꿔요.
2. **Actions** 탭 > `급식 받고 사이트 배포` > **Run workflow**.
3. 초록색 체크가 뜨면 `https://내GitHub아이디.github.io/protein/` 주소로 들어가요.
4. Safari 공유 버튼 > **홈 화면에 추가**를 하면 앱처럼 쓸 수 있어요.

이후로는 매일 00:05와 06:00(한국 시간)에 급식을 새로 받아 자동으로 다시 배포돼요.

## 알아 두기

- **비밀번호 찾기가 없어요.** 친구가 비밀번호를 잊으면 Firebase 콘솔 > Authentication에서 그 사용자를 삭제하고, Firestore에서 같은 UID 문서를 지운 뒤 다시 가입하면 돼요.
- **급식이 안 보이면** Actions 탭에서 최근 실행 기록을 눌러 `급식 정보 받기` 단계의 메시지를 확인해요. 인증키가 틀렸거나, 학교가 나이스에 그날 급식을 올리지 않은 경우예요. 급식 파일(`data/meals.json`)은 배포할 때마다 새로 만들어져서 저장소에는 보이지 않는 게 정상이에요.
- 학교 홈페이지 급식표는 나이스와 같은 자료를 쓰지만, 혹시 나이스에 아침·저녁이 빠져 있다면 알려 줘요. 학교 홈페이지에서 직접 읽어 오는 방식으로 바꿀 수 있어요.
- GitHub는 저장소에 60일 동안 변화가 없으면 예약 실행을 멈춰요. 멈추면 Actions 탭에서 다시 켜 주세요.
- 기본 식품 목록은 `data.js`에서 고칠 수 있어요.
- 목표 계산 기준과 출처는 사이트의 **추천 기준** 버튼에 있어요.

## 부록: `.github/workflows/deploy.yml`

```yaml
name: 급식 받고 사이트 배포

on:
  push:
    branches: [main]
  schedule:
    - cron: "5 15 * * *"   # 매일 00:05 (한국 시간)
    - cron: "0 21 * * *"   # 매일 06:00 (한국 시간) 한 번 더
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: 급식 정보 받기
        run: python fetch_meals.py
        env:
          NEIS_KEY: ${{ secrets.NEIS_KEY }}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - id: deployment
        uses: actions/deploy-pages@v4
```
