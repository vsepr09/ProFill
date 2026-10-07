#!/usr/bin/env python3
"""나이스(NEIS) 교육정보 개방 포털에서 급식 정보를 받아 data/meals.json으로 저장한다.

환경 변수
  NEIS_KEY     나이스 인증키 (GitHub Secrets에 넣기)
  SCHOOL_NAME  학교 이름 (기본: 인천과학예술영재학교)
  ATPT_CODE    시도교육청 코드 (기본: E10 인천광역시교육청)
  SCHOOL_CODE  표준학교코드 (비워 두면 학교 이름으로 자동 검색)
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
KEY = os.environ.get("NEIS_KEY", "").strip()
SCHOOL_NAME = os.environ.get("SCHOOL_NAME", "인천과학예술영재학교")
ATPT = os.environ.get("ATPT_CODE", "E10")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "meals.json")
BASE = "https://open.neis.go.kr/hub/"


def call(service, **params):
    q = {"Type": "json", "pIndex": 1, "pSize": 100, **params}
    if KEY:
        q["KEY"] = KEY
    url = BASE + service + "?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": "protein-tracker"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    if service not in data:
        res = data.get("RESULT", {})
        if res.get("CODE") == "INFO-200":  # 해당 데이터 없음
            return []
        raise RuntimeError(f"{service}: {res.get('CODE')} {res.get('MESSAGE')}")
    for part in data[service]:
        if "row" in part:
            return part["row"]
    return []


def school_code():
    code = os.environ.get("SCHOOL_CODE", "").strip()
    if code:
        return code
    rows = call("schoolInfo", ATPT_OFCDC_SC_CODE=ATPT, SCHUL_NM=SCHOOL_NAME)
    if not rows:
        raise RuntimeError(f"학교를 찾지 못했어요: {SCHOOL_NAME}")
    return rows[0]["SD_SCHUL_CODE"]


def clean_dish(s):
    s = re.sub(r"\(\s*[\d.,\s]+\)", "", s)   # 알레르기 번호 (1.2.5.)
    s = re.sub(r"(\d+\.)+\d*\s*$", "", s)     # 끝에 붙은 1.2.5.
    s = s.replace("*", "").replace("#", "")
    return re.sub(r"\s+", " ", s).strip()


def parse_protein(ntr):
    m = re.search(r"단백질\s*\(g\)\s*:\s*([\d.]+)", ntr or "")
    return round(float(m.group(1)), 1) if m else None


def parse_rows(rows):
    days = {}
    for r in rows:
        day = r["MLSV_YMD"]
        code = str(r["MMEAL_SC_CODE"])  # 1 조식, 2 중식, 3 석식
        dishes = [clean_dish(x) for x in re.split(r"<br\s*/?>", r.get("DDISH_NM", ""))]
        days.setdefault(day, {})[code] = {
            "dishes": [d for d in dishes if d],
            "protein": parse_protein(r.get("NTR_INFO")),
        }
    return days


def load_old():
    try:
        with open(OUT, encoding="utf-8") as f:
            return json.load(f).get("days", {})
    except Exception:
        return {}


def main():
    today = datetime.now(KST)
    start = (today - timedelta(days=7)).strftime("%Y%m%d")
    end = (today + timedelta(days=10)).strftime("%Y%m%d")
    days = {k: v for k, v in load_old().items() if k >= start}
    try:
        code = school_code()
        rows = call("mealServiceDietInfo", ATPT_OFCDC_SC_CODE=ATPT, SD_SCHUL_CODE=code,
                    MLSV_FROM_YMD=start, MLSV_TO_YMD=end)
        days.update(parse_rows(rows))
        print(f"급식 {len(rows)}끼를 받았어요 (학교 코드 {code})")
    except Exception as e:  # 실패해도 사이트 배포는 계속
        print(f"급식 정보를 받지 못했어요: {e}", file=sys.stderr)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"school": SCHOOL_NAME, "updated": today.isoformat(timespec="minutes"),
                   "days": dict(sorted(days.items()))}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
