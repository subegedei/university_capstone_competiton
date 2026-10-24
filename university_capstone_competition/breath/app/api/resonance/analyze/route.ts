import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const base = (process.env.ANALYSIS_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
    const response = await fetch(base + "/api/resonance/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000), cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) return NextResponse.json({ error: typeof data.detail === "string" ? data.detail : "분석 입력이 올바르지 않습니다.", detail: data.detail }, { status: response.status });
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "올바른 JSON 요청이 필요합니다." }, { status: 400 });
    return NextResponse.json({ error: "분석 서버에 연결할 수 없습니다. services/analysis-api에서 uvicorn app.main:app --port 8000을 실행하세요. 수집한 데이터는 화면에 유지됩니다." }, { status: 503 });
  }
}
