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
    basis: "운동하는 사람 대부분은 하루 1.4–2.0g/kg이면 근육을 지키는 데 충분해요.",
    source: "ISSN, 2017",
  },
  bulk: {
    label: "근육 증가",
    factor: 1.6,
    desc: "벌크업, 근육을 키우는 시기예요",
    basis: "49개 연구를 모은 분석에서 약 1.6g/kg을 넘기면 근육이 더 늘지 않았어요.",
    source: "Morton 외, 2018",
  },
  cut: {
    label: "체지방 감량",
    factor: 2.2,
    desc: "먹는 양을 줄이면서 근육을 지켜요",
    basis: "덜 먹는 시기엔 근손실을 막으려 더 필요해요. 권장량(제지방 1kg당 2.3–3.1g)을 몸무게 기준으로 바꾼 값이에요.",
    source: "Helms 외 2014, ISSN 2017",
  },
};

// 흡수 속도 종류: 추천 시간 배치에 쓰임
export const KINDS = {
  normal: "일반",
  fast: "빠른 흡수",
  slow: "천천히 흡수",
};

// 기본 식품은 두지 않음 (각자 직접 추가)
export const DEFAULT_FOODS = [];
