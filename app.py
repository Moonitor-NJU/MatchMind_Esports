import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_FILE = ROOT / "data" / "tournaments.json"
PORT = int(os.environ.get("PORT", "3000"))


def read_data():
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def get_tournament(tournament_id):
    tournaments = read_data()["tournaments"]
    return next((item for item in tournaments if item["id"] == tournament_id), tournaments[0])


def build_standings(tournament, scenario=None):
    scenario = scenario or {}
    rows = []
    for team in tournament["teams"]:
        rows.append({
            "id": team["id"],
            "name": team["name"],
            "region": team["region"],
            "wins": 0,
            "losses": 0,
            "mapWins": 0,
            "mapLosses": 0,
            "differential": 0,
            "remaining": 0,
            "played": 0,
            "form": []
        })
    by_id = {row["id"]: row for row in rows}

    for match in tournament["matches"]:
        result = scenario.get(match["id"]) or match.get("result")
        left = by_id[match["teams"][0]]
        right = by_id[match["teams"][1]]
        if not result or result.get("left") is None or result.get("right") is None:
            left["remaining"] += 1
            right["remaining"] += 1
            continue

        left["played"] += 1
        right["played"] += 1
        left["mapWins"] += result["left"]
        left["mapLosses"] += result["right"]
        right["mapWins"] += result["right"]
        right["mapLosses"] += result["left"]
        left["differential"] = left["mapWins"] - left["mapLosses"]
        right["differential"] = right["mapWins"] - right["mapLosses"]
        if result["left"] > result["right"]:
            left["wins"] += 1
            right["losses"] += 1
            left["form"].append("W")
            right["form"].append("L")
        else:
            right["wins"] += 1
            left["losses"] += 1
            right["form"].append("W")
            left["form"].append("L")

    rows.sort(key=lambda row: (-row["wins"], -row["differential"], -row["mapWins"], row["name"]))
    for index, row in enumerate(rows, 1):
        row["rank"] = index
        row["form"] = row["form"][-5:]
    return rows


def qualification_status(tournament, standings):
    advance_slots = tournament["rules"]["advanceSlots"]
    elimination_slots = tournament["rules"].get("eliminationSlots", 0)
    result = []
    for row in standings:
        max_wins = row["wins"] + row["remaining"]
        teams_able_to_pass = len([other for other in standings if other["id"] != row["id"] and other["wins"] + other["remaining"] >= row["wins"]])
        teams_already_ahead = len([other for other in standings if other["id"] != row["id"] and other["wins"] > max_wins])
        status = "悬念中"
        tone = "watch"
        if row["rank"] <= advance_slots and teams_able_to_pass < advance_slots:
            status = "已锁定晋级"
            tone = "safe"
        elif teams_already_ahead >= advance_slots:
            status = "理论淘汰"
            tone = "danger"
        elif row["rank"] <= advance_slots:
            status = "晋级主动权"
            tone = "safe"
        elif row["rank"] > len(standings) - elimination_slots:
            status = "高危边缘"
            tone = "danger"

        target = standings[max(0, advance_slots - 1)]
        wins_needed = max(0, target["wins"] + 1 - row["wins"])
        item = dict(row)
        item["maxWins"] = max_wins
        item["status"] = status
        item["tone"] = tone
        item["note"] = f"{row['name']} 当前 {row['wins']}-{row['losses']}，剩余 {row['remaining']} 场，最高可到 {max_wins} 胜。"
        item["note"] += f"保守估计还需要 {wins_needed} 场胜利冲击晋级线。" if wins_needed else "目前已处在晋级线附近。"
        result.append(item)
    return result


def key_matches(tournament, standings):
    by_id = {row["id"]: row for row in standings}
    advance_slots = tournament["rules"]["advanceSlots"]
    matches = []
    for match in tournament["matches"]:
        if match["status"] == "finished":
            continue
        left = by_id[match["teams"][0]]
        right = by_id[match["teams"][1]]
        rank_pressure = abs(left["rank"] - advance_slots) + abs(right["rank"] - advance_slots)
        importance = "高" if rank_pressure <= 2 else "中" if rank_pressure <= 5 else "低"
        tag = "晋级关键战" if importance == "高" else "排名影响战" if importance == "中" else "常规赛程"
        matches.append({
            "id": match["id"],
            "startsAt": match["startsAt"],
            "left": left["name"],
            "right": right["name"],
            "importance": importance,
            "tag": tag,
            "reason": f"{left['name']} 排名第 {left['rank']}，{right['name']} 排名第 {right['rank']}。这场比赛会影响晋级线附近的胜场差和小分。"
        })
    return sorted(matches, key=lambda item: item["startsAt"])


def local_analysis(tournament, scenario=None):
    standings = build_standings(tournament, scenario)
    teams = qualification_status(tournament, standings)
    matches = key_matches(tournament, standings)
    safe = "、".join([team["name"] for team in teams if team["tone"] == "safe"][:3]) or "暂无"
    danger = "、".join([team["name"] for team in teams if team["tone"] == "danger"][:3]) or "暂无"
    focus = matches[0] if matches else None
    lines = [
        f"{tournament['name']} 当前晋级线为前 {tournament['rules']['advanceSlots']} 名。{safe} 处在较有利位置，{danger} 需要尽快抢分。"
    ]
    if focus:
        lines.append(f"下一场重点关注 {focus['left']} vs {focus['right']}，系统判断为{focus['tag']}，原因是双方排名和晋级线距离较近。")
    else:
        lines.append("目前没有未结束比赛，晋级形势基本定型。")
    lines.append("AI 建议优先观察胜场、小分和直接交手结果；当胜场接近时，一场 2:0 往往比 2:1 更能改变排序。")
    return {
        "standings": standings,
        "teams": teams,
        "keyMatches": matches,
        "summary": "\n".join(lines)
    }


def answer_locally(question, tournament, analysis):
    question_lower = question.lower()
    mentioned = next((team for team in analysis["teams"] if team["name"].lower() in question_lower or team["id"].lower() in question_lower), None)
    if mentioned:
        next_match = next((match for match in tournament["matches"] if match["status"] != "finished" and mentioned["id"] in match["teams"]), None)
        if next_match:
            names = " vs ".join(next(team["name"] for team in tournament["teams"] if team["id"] == item) for item in next_match["teams"])
            next_text = f"下一场对阵 {names}。"
        else:
            next_text = "当前没有剩余赛程。"
        sign = "+" if mentioned["differential"] >= 0 else ""
        return f"{mentioned['name']} 当前排名第 {mentioned['rank']}，战绩 {mentioned['wins']}-{mentioned['losses']}，小分 {sign}{mentioned['differential']}，状态为「{mentioned['status']}」。{mentioned['note']}{next_text}"
    if "关键" in question or "值得看" in question or "焦点" in question:
        focus = analysis["keyMatches"][0] if analysis["keyMatches"] else None
        return f"最值得看的是 {focus['left']} vs {focus['right']}。重要性：{focus['importance']}。{focus['reason']}" if focus else "目前没有未结束比赛，暂时没有新的焦点战。"
    if "晋级" in question or "形势" in question or "排名" in question:
        return analysis["summary"]
    return f"我已读取 {tournament['name']} 的赛程、积分和晋级规则。你可以问某支队伍的晋级条件、今晚哪场最关键，或者“如果某队赢了会怎样”。\n\n{analysis['summary']}"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/tournaments":
            self.send_json(200, read_data())
            return
        if parsed.path == "/api/analyze":
            tournament = get_tournament(query.get("tournament", [None])[0])
            analysis = local_analysis(tournament)
            self.send_json(200, {"tournament": tournament, "analysis": analysis})
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        body = self.read_json_body()
        if parsed.path == "/api/chat":
            tournament = get_tournament(body.get("tournamentId"))
            analysis = local_analysis(tournament, body.get("scenario") or {})
            self.send_json(200, {"answer": answer_locally(body.get("question", ""), tournament, analysis), "analysis": analysis})
            return
        if parsed.path == "/api/scenario":
            tournament = get_tournament(body.get("tournamentId"))
            analysis = local_analysis(tournament, body.get("scenario") or {})
            self.send_json(200, {"tournament": tournament, "analysis": analysis})
            return
        self.send_json(404, {"error": "Not found"})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Esports AI Schedule app running at http://127.0.0.1:{PORT}")
    server.serve_forever()
