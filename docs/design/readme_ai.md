# 프로젝트 마스터 README: 초고속 글로벌 기후·에너지 벤치마크 플랫폼

AI 코딩 에이전트는 본 문서와 직전 생성된 상세 설계서(`project_master_plan.md`, `single_viewport_ui_spec.md`, `rust_backend_spec.md`)를 기준으로 모노레포 환경을 구축하고 개발을 시작합니다.

---

## 1. 프로젝트 개요 및 목표
* **프로젝트명:** 10만~30만 행 × 28열 대용량 기후·에너지 데이터 가상화 및 벤치마크 플랫폼
* **핵심 기술 스택:** 
  * **Backend:** Rust (Axum 0.7 + Tokio + rmp-serde + rust_xlsxwriter)
  * **Frontend:** SolidJS + @tanstack/solid-virtual + HTML5 Canvas + Web Worker
  * **Deploy (100% 무과금):** Koyeb Free Eco (Backend) + Cloudflare Pages (Frontend)
* **최우수 성능 지표:**
  * 단일 뷰포트(`100vw × 100vh`) 내 제로 페이지 스크롤 및 3단 분할 레이아웃
  * DOM 셀 개수 항상 300개 미만 유지, 60 FPS 방어
  * 파일 추출(CSV/TSV/Excel) 브라우저 렉 0ms (Web Worker & 서버 스트리밍)

---

## 2. 모노레포 디렉토리 구조

```
/bench-100k
├── backend/                  # Rust Axum 백엔드 (Koyeb 배포 타겟)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs           # Axum 라우터 및 미들웨어
│       ├── model.rs          # ClimateRecord 28개 컬럼 구조체
│       ├── store.rs          # 인메모리 부스터 및 선형 보간 엔진
│       └── excel.rs          # rust_xlsxwriter 스트리밍 생성기
├── frontend/                 # SolidJS 프론트엔드 (Cloudflare Pages 배포 타겟)
│   ├── package.json
│   └── src/
│       ├── App.tsx           # 3단 셸 레이아웃 및 실시간 텔레메트리
│       ├── state/
│       │   └── gridSchema.ts # 28개 컬럼 메타데이터 및 타입 정의
│       ├── components/
│       │   ├── ZoneBChartCluster.tsx # 4대 Canvas 멀티 차트 & 브러싱
│       │   └── ZoneCVirtualGrid.tsx  # 2D(행+열) 교차 가상화 그리드
│       ├── worker/
│       │   └── dataEngine.worker.ts  # 워커 파싱, 집계, 교차 필터링, CSV 빌더
│       └── styles/
│           └── viewport.css  # 100vw x 100vh 뷰포트 격리 스타일
└── README.md                 # 본 에이전트 작업 지침서
```

---

## 3. 에이전트 즉시 실행 명령어 (Quickstart Guide)

### ① Backend (Rust)
```bash
cd backend
cargo build --release
cargo run --release
# 서버 기동 확인: http://localhost:8000/health
```

### ② Frontend (SolidJS)
```bash
cd frontend
npm install
npm run dev
# 클라이언트 접속: http://localhost:3000 (Vite 개발 서버)
```

---

## 4. 에이전트 필수 구현 및 검증 체크리스트
1. **메모리 방어:** Rust 서버 RSS RAM 점유율이 30만 건 적재 시에도 80MB를 넘지 않는지 확인.
2. **무블로킹 통신:** 프론트엔드 Web Worker에서 MessagePack 디코딩 및 차트 사전 집계가 메인 스레드 락 없이 수행되는지 검증.
3. **2D 가상화 DOM 제어:** 그리드 스크롤 시 `.grid-cell` 엘리먼트 개수가 항상 350개 미만으로 고정되는지 확인.
4. **파일 추출:** 10만 건 이상의 CSV/TSV/Excel 파일이 UI 프리징 없이 즉시 다운로드되는지 테스트.