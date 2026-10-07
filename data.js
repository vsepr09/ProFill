// 목표별 체중 1kg당 하루 단백질(g)
// 근거
// - ISSN 단백질 입장문(2017): 운동하는 사람 대부분은 1.4–2.0 g/kg/일이면 충분, 감량기엔 2.3–3.1 g/kg가 필요할 수 있음
// - Morton 외(2018) 메타분석: 약 1.6 g/kg/일(1.62)을 넘으면 근육 증가 효과가 더 커지지 않음 (신뢰구간 상한 약 2.2)
// - Helms 외(2014): 감량 중인 근력 운동인은 제지방 1kg당 2.3–3.1 g
export const GOALS = {
  maintain: {
    label: "유지",
    factor: 1.4,
    desc: "지금 근육량을 유지하면서 운동해요",
  },
  bulk: {
    label: "근육 증가",
    factor: 1.6,
    desc: "벌크업, 근육을 키우는 시기예요",
  },
  cut: {
    label: "체지방 감량",
    factor: 2.2,
    desc: "먹는 양을 줄이면서 근육을 지켜요",
  },
};

// 흡수 속도 종류: 추천 시간 배치에 쓰임
export const KINDS = {
  normal: "일반",
  fast: "빠른 흡수 (쉐이크 등, 운동 직후 추천)",
  slow: "천천히 흡수 (우유, 요거트 등, 자기 전 추천)",
};

// 기본 식품 목록 (대략적인 값)
export const DEFAULT_FOODS = [
  { id: "d-chicken", name: "닭가슴살", serving: "1팩 (100g)", protein: 23, kind: "normal" },
  { id: "d-egg", name: "계란", serving: "1개", protein: 6, kind: "normal" },
  { id: "d-shake", name: "프로틴 쉐이크", serving: "1스쿱", protein: 24, kind: "fast" },
  { id: "d-casein", name: "카제인 프로틴", serving: "1스쿱", protein: 24, kind: "slow" },
  { id: "d-milk", name: "우유", serving: "1팩 (200ml)", protein: 6, kind: "slow" },
  { id: "d-greek", name: "그릭요거트", serving: "1컵 (100g)", protein: 9, kind: "slow" },
  { id: "d-soymilk", name: "두유", serving: "1팩 (190ml)", protein: 7, kind: "normal" },
  { id: "d-tofu", name: "두부", serving: "반 모 (150g)", protein: 13, kind: "normal" },
  { id: "d-tuna", name: "참치캔", serving: "1캔 (100g)", protein: 15, kind: "normal" },
  { id: "d-beef", name: "소고기 살코기", serving: "100g", protein: 21, kind: "normal" },
  { id: "d-pork", name: "돼지 안심", serving: "100g", protein: 22, kind: "normal" },
  { id: "d-salmon", name: "연어", serving: "100g", protein: 20, kind: "normal" },
  { id: "d-sausage", name: "닭가슴살 소시지", serving: "1개", protein: 10, kind: "normal" },
  { id: "d-bar", name: "단백질바", serving: "1개", protein: 15, kind: "normal" },
  { id: "d-cheese", name: "슬라이스 치즈", serving: "1장", protein: 4, kind: "normal" },
  { id: "d-almond", name: "아몬드", serving: "한 줌 (30g)", protein: 6, kind: "normal" },
];
