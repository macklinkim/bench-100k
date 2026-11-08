# bench-100k — Rust 고속 서버 × 대용량 기후·에너지 데이터 실시간 시각화

> **30만 행 × 28열(840만 셀)** 데이터를 Rust 서버에서 수십 ms 안에 직렬화하고,
> 브라우저에서는 **메인 스레드를 한 번도 50ms 이상 막지 않고** 차트 4종과 2차원 가상화 테이블로 60 FPS 출력하는 벤치마크 서비스입니다.

**🔗 라이브 데모: https://bench-100k.pages.dev** (테이블 전용: https://bench-100k.pages.dev/#table)
API: `https://bench-backend-638796356878.us-west1.run.app` (Google Cloud Run, us-west1)

![대시보드](docs/screenshots/dashboard.png)

---

## 1. 프로젝트 목적

"가장 빠른 축에 드는 서버 언어"와 "그 속도를 화면까지 손실 없이 전달하는 프론트엔드 구조"를 직접 골라 조합하고,
**실측 수치로 증명**하는 것이 목표입니다.

- 서버만 빠르면 끝나지 않습니다. 10만~30만 건을 받으면 **브라우저의 디코딩·복사·렌더링**에서 병목이 생깁니다.
- 그래서 서버 → 전송 포맷 → Web Worker → 메인 스레드 → DOM까지 **모든 구간의 시간을 화면 상단에 실시간 계측**하고, 병목을 찾아 설계를 고쳤습니다(아래 4장).

## 2. 기술 선정과 이유

| 영역 | 선택 | 이유 |
|---|---|---|
| 서버 언어 | **Rust** | 네이티브 컴파일, GC 없음 → 응답 지연이 일정하고 메모리가 예측 가능. 웹 프레임워크 벤치마크(TechEmpower 등)에서 최상위권 생태계 |
| 서버 프레임워크 | **Axum 0.7 + Tokio** | hyper 기반 비동기 서버. 무거운 직렬화/엑셀 생성은 `spawn_blocking`으로 분리해 `/health` 등 다른 요청이 막히지 않음 |
| 직렬화 | **MessagePack (rmp-serde)** vs JSON | 바이너리 포맷 비교 벤치마크. 행을 **필드명 없는 배열**로 보내 크기·디코딩 시간 절감 |
| 엑셀 | **rust_xlsxwriter** | 서버에서 파일 I/O 없이 메모리 버퍼로 `.xlsx` 생성 |
| 압축/CORS | **tower-http** | zstd / br / gzip 자동 협상 |
| 프론트엔드 | **SolidJS** | Virtual DOM 없는 세밀한(fine-grained) 반응성 → 스크롤 시 바뀌는 셀만 갱신. 앱 번들 24.9KB(gzip) |
| 가상화 | **@tanstack/solid-virtual** | 행 + 열 **2차원 가상화**. 좌측 4열·우측 1열 고정 |
| 연산 | **Web Worker + TypedArray** | 디코딩·필터·정렬·집계·CSV 생성을 전부 백그라운드 스레드에서 처리 |
| 차트 | **Canvas 2D / ImageData** | SVG 노드 0개. 산점도는 픽셀 버퍼에 직접 기록 |
| 백엔드 배포 | **Google Cloud Run** (us-west1, 512MiB, 1 vCPU, 0~1 인스턴스) | 6MB `scratch` 이미지라 콜드스타트가 짧고, 요청이 없으면 0대로 줄어 무료 한도 안에서 운영. 원래 계획한 Koyeb는 Mistral 인수 후 신규 무료 플랜이 막혀 변경 |
| 프론트 배포 | **Cloudflare Pages** | 정적 파일 전 세계 CDN 배포, 무료 |

## 3. 사용한 데이터

- **스키마:** [Our World in Data](https://github.com/owid) `co2-data` + `energy-data` 기반 **28개 컬럼**
  (국가·기간, 인구·GDP, CO₂·메탄·아산화질소, 석탄/석유/가스/시멘트 배출원, 1차 에너지, 재생/화석/원자력 비중, 전력 탄소집약도, 기온 상승 기여도)
- **값:** 현재는 실측 CSV가 아니라 **OWID 스키마를 따르는 결정적(deterministic) 합성 데이터**입니다.
  실제 100개국과 대륙·소득그룹, 2024년 인구 규모를 기준으로 국가별 산업화 곡선·성장률을 모델링했습니다.
- **볼륨:** 100개국 × 250년(1775–2024) = 연간 25,000점 → **월 단위 선형 보간으로 300,000행**
  - 50k = 반기, 100k = 분기, 300k = 월간 (추가 사본 없이 같은 메모리에서 간격만 다르게 선택)
- 실제 OWID CSV 연동은 다음 단계입니다(`backend/src/store.rs`의 `annual_base`만 바꾸면 됨).

## 4. 증명한 것 (실측)

측정 환경: 4.1~4.3은 Windows 11 개발 PC(release 빌드, localhost, Chromium), 4.4는 실서비스입니다. 화면 캡처는 실서비스 화면입니다. 화면 상단 텔레메트리 바에서 같은 값을 실시간으로 볼 수 있습니다.

### 4.1 서버

| 항목 | 결과 |
|---|---|
| 30만 행 상주 메모리(RSS) | **62.8MB** (목표 80MB 미만). 반복 문자열을 `&'static str`로 공유(interning). `String` 사용 시 약 90MB로 추정 |
| 100k 직렬화 | MessagePack **18~23ms** vs JSON 105ms (**약 5배**) |
| 300k 직렬화 | MessagePack **57ms** vs JSON 321ms |
| 100k 전송 크기 | MessagePack 15.5MB → zstd **8.8MB** / JSON 63.8MB |
| Excel 5만 행 생성 | 0.78초, 4.7MB |
| 서버 바이너리 | 3.4MB (LTO + strip) |

### 4.2 브라우저

| 항목 | 결과 |
|---|---|
| 300k 로드 중 메인 스레드 Long Task(50ms 이상) | **0건** (개선 전 591~716ms 멈춤) |
| 워커 디코딩 + 컬럼 변환 | 100k 약 170ms / 300k 약 550ms (워커 안에서 처리, 화면 영향 없음) |
| 필터 + 차트 4종 집계 (1회 순회) | 100k **7~9ms** / 300k **22ms** |
| 2D 가상화 DOM 셀 수 | 대시보드 **266~315개**(목표 350 미만), 테이블 전용 화면 448개 |
| 렌더링 | **60 FPS** |
| CSV 추출 (2.2만 행) | 98ms, UTF-8 BOM 포함 |

### 4.3 병목을 찾아 설계를 고친 과정

처음 설계(행 = 필드명이 붙은 객체)로 300k를 로드하면 화면이 약 0.7초 멈췄습니다. 구간별로 실측해 원인 3가지를 찾았습니다.

| 문제 | 원인 | 개선 | 효과 (300k) |
|---|---|---|---|
| 전송 데이터가 큼 | 행마다 28개 필드명이 반복 | 필드명 없이 **순서 기반 배열**로 전송 (`rmp_serde::to_vec`) | 149MB → **48.6MB**, 서버 직렬화 237ms → **57ms** |
| 디코딩이 느림 | 30만 개 객체 생성 | 순서 기반 배열 디코딩 | 1,129ms → **약 260ms** (워커에서) |
| 화면 멈춤 | 30만 개 객체를 메인 스레드로 복사(structured clone) | 워커에서 **컬럼별 TypedArray + 문자열 사전 인코딩**으로 바꿔 **Transferable(복사 없이 소유권 이전)** 으로 전달. 화면은 보이는 행만 그때그때 조립 | 멈춤 591~716ms → **0ms** |

부수 효과로 필터 연산도 객체 순회 대비 약 6배 빨라졌습니다(19.4ms → 3.0ms, 같은 조건 비교).

배포 사양(저사양 CPU)으로 제한한 컨테이너에서 다시 재 보니, 이번에는 **요청마다 하는 응답 압축**이 병목이었습니다.

| 문제 | 개선 | 효과 |
|---|---|---|
| 0.1 vCPU에서 100k 압축 3.3초, 300k 10초 | 데이터가 고정이므로 zstd/gzip 결과를 볼륨별로 **한 번만 만들어 캐시**(`OnceLock`), 기본 화면용 100k는 서버 시작 단계에서 미리 생성 | 캐시 적중 시 100k **12ms**, 300k **29ms** (0.1 vCPU 기준) |
| 공개 API에서 큰 요청이 몰리면 512MB 초과 위험 | 행 수를 50k/100k/300k로 고정(캐시 크기 상한), JSON 최대 100k, 무거운 요청 동시 2개 제한 | 512MB 제한 컨테이너에서 OOM 없음 |

### 4.4 실서비스 측정 (한국 → Cloud Run us-west1)

| 항목 | 결과 |
|---|---|
| 첫 접속 → 100k 표 표시 | **4.2초** (대부분 8.8MB 전송 시간) |
| 서버 첫 바이트(TTFB, 캐시 적중) | 약 **0.21초** (태평양 왕복 지연 포함) |
| 300k 로드 | 4.2초, **메인 스레드 Long Task 0건** |
| 로드 후 렌더링 | 60 FPS, 콘솔 에러 0건 |

로드 시간의 대부분은 네트워크 전송입니다. 서버 처리와 브라우저 처리 시간은 위 표처럼 수십~수백 ms 수준입니다.

## 5. 화면

### 대시보드 (`/`)
상단: 데이터 볼륨/포맷 선택, 실시간 텔레메트리(서버 직렬화·전송량·네트워크·워커 파싱·필터·DOM 셀 수·FPS), CSV/TSV/Excel 추출
중단: 차트 4종 — ① CO₂ 시계열(드래그로 연도 필터) ② 탄소집약도 히스토그램 ③ 대륙별 에너지 믹스(클릭으로 대륙 필터) ④ 1인당 GDP vs CO₂ 산점도
하단: 2D 가상화 테이블 + 요약 푸터. 차트·검색·정렬이 서로 즉시 연동됩니다.

![대시보드](docs/screenshots/dashboard.png)

### 테이블 전용 (`/#table`)
차트를 숨기고 전체 높이를 테이블에 사용합니다. 상단 `▤ 테이블 전용` 버튼으로 전환합니다.

![테이블 전용](docs/screenshots/table-only.png)

## 6. 실행 방법

```bash
# 백엔드 (http://localhost:8000)
cd backend
cargo run --release

# 프론트엔드 (http://localhost:3000)
cd frontend
npm install
npm run dev
```

API 주소는 `VITE_API_BASE_URL` 환경 변수로 바꿀 수 있습니다(개발 기본값 `http://localhost:8000`, 프로덕션 빌드는 `frontend/.env.production`).

배포:

```bash
# 백엔드 → Cloud Run (이미지는 로컬에서 빌드 후 Artifact Registry로 push)
IMG=us-west1-docker.pkg.dev/<PROJECT_ID>/bench/backend:v1
docker build -t $IMG backend && docker push $IMG
gcloud run deploy bench-backend --image=$IMG --region=us-west1 --allow-unauthenticated \
  --memory=512Mi --cpu=1 --min-instances=0 --max-instances=1 --cpu-boost

# 프론트 → Cloudflare Pages
cd frontend && npm run build
wrangler pages deploy dist --project-name bench-100k --branch main
```

| API | 설명 |
|---|---|
| `GET /health` | 상태 확인 |
| `GET /api/records?rows=50000\|100000\|300000&format=msgpack\|json` | 데이터. `X-Server-Serialize-Ms`(직렬화 시간, 캐시 적중 시 최초 측정값), `X-Cache: HIT\|MISS` 헤더. JSON은 최대 100k |
| `GET /api/export/xlsx?continent=Asia` | Excel 다운로드 (최대 5만 행) |

## 7. 구조

```
backend/   Rust (Axum)
  src/main.rs    라우터, 압축/CORS, 직렬화 타이밍 헤더
  src/model.rs   28컬럼 ClimateRecord (필드 순서 = MessagePack 전송 순서)
  src/store.rs   합성 데이터 생성 + 월 단위 선형 보간 (LazyLock 상주)
  src/excel.rs   rust_xlsxwriter
frontend/  SolidJS + Vite
  src/state/columns.ts            컬럼 스토어(TypedArray + 사전 인코딩)
  src/worker/dataEngine.worker.ts 디코딩·필터·정렬·집계·CSV
  src/components/ZoneBChartCluster.tsx  Canvas 차트 4종
  src/components/ZoneCVirtualGrid.tsx   2D 가상화 테이블
docs/design/   최초 설계서
```

## 8. 한계와 다음 단계

- 데이터 값은 합성입니다 → OWID 실측 CSV 전처리·내장 예정
- 압축 후 전송량(300k zstd 26MB)은 소수 데이터 자체의 정보량 때문에 크게 줄지 않습니다. 실제 인터넷에서는 전송 시간이 주 병목입니다 → 파생 컬럼 클라이언트 계산, 정밀도 조정 검토
- Cloud Run 무료 한도의 전송량은 월 1GB(북미 출발)입니다. 100k 로드 1회가 약 9MB라 초과분은 과금되며, 결제 계정에 예산 알림을 걸어 두었습니다
- 자동화 테스트는 없습니다. 위 수치는 수동 측정 결과입니다
