import { NextRequest, NextResponse } from "next/server";
import { displacementRmsM, type SweepSample } from "../../../../lib/analysis";

type SweepResult = {
  estimatedResonanceHz: number;
  peakAccelerationRms: number;
  peakDisplacementRmsM: number;
  peakScore: number;
  peakProminence: number;
  method: "displacement-rms" | "supply-current-normalized-displacement-rms";
  warnings: string[];
  samples: SweepSample[];
};

const warning = "이 값은 장치·패널·접촉부를 포함한 측정 시스템의 응답 피크이며, 인체 흉벽의 고유 공진으로 검증된 값은 아닙니다.";
const sampleKeys = new Set(["hz", "accelerationRms", "busVoltageV", "currentA", "powerW", "windowCount", "sampleCount", "sampleRateHz"]);

function finiteNumber(value: unknown, minimum = -Infinity, maximum = Infinity): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function nullableFiniteNumber(value: unknown, minimum = -Infinity): value is number | null {
  return value === null || finiteNumber(value, minimum);
}

function validSample(value: unknown): value is SweepSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as Record<string, unknown>;
  if (Object.keys(sample).some((key) => !sampleKeys.has(key))) return false;
  return finiteNumber(sample.hz, 15, 50) && finiteNumber(sample.accelerationRms, 0) &&
    finiteNumber(sample.windowCount, 2) && Number.isInteger(sample.windowCount) &&
    finiteNumber(sample.sampleCount, 1) && Number.isInteger(sample.sampleCount) &&
    finiteNumber(sample.sampleRateHz, 200) && nullableFiniteNumber(sample.busVoltageV, 0) &&
    nullableFiniteNumber(sample.currentA, 0) && nullableFiniteNumber(sample.powerW, 0);
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function analyseSweep(samples: SweepSample[]): SweepResult {
  const ordered = [...samples].sort((a, b) => a.hz - b.hz);
  if (new Set(ordered.map((sample) => sample.hz)).size !== ordered.length) {
    throw new Error("Duplicate frequencies are not allowed; aggregate RMS windows first.");
  }
  const displacements = ordered.map(displacementRmsM);
  if (Math.max(...displacements) <= 0) throw new Error("No measurable vibration response was recorded.");
  const hasCurrent = ordered.every((sample) => sample.currentA !== null && sample.currentA >= 0.001);
  const scores = hasCurrent ? displacements.map((displacement, index) => displacement / (ordered[index].currentA as number)) : displacements;
  const peakIndex = scores.reduce((best, score, index) => score > scores[best] ? index : best, 0);
  const peak = ordered[peakIndex];
  const peakDisplacement = displacements[peakIndex];
  const peakScore = scores[peakIndex];

  const prominence = Math.max(0, (peakScore - median(scores)) / peakScore);
  const warnings = [warning];
  if (peak.hz === ordered[0].hz || peak.hz === ordered[ordered.length - 1].hz) warnings.push("피크가 스윕 범위의 끝에 있어 범위 밖의 피크를 구분할 수 없습니다.");
  if (prominence < 0.1) warnings.push("응답 곡선이 평탄하여 뚜렷한 피크를 확인하기 어렵습니다.");
  if (scores.filter((score) => Math.abs(score - peakScore) <= Math.max(peakScore, 1e-12) * 1e-6).length > 1) warnings.push("같은 보정 점수의 피크가 여러 개입니다. 가장 낮은 주파수를 표시합니다.");
  if (ordered[0].hz !== 15 || ordered[ordered.length - 1].hz !== 50) warnings.push("15–50 Hz 전체 범위가 수집되지 않았습니다.");
  if (hasCurrent) warnings.push("INA226은 앰프 공급 전류를 읽습니다. 이 점수는 코일 힘이 아닌 공급전류로 정규화한 효율 지표입니다.");
  else warnings.push("일부 INA226 전류값이 없거나 너무 작아 전류 정규화를 생략하고, 주파수 제곱 보정 변위로 피크를 계산했습니다.");

  return {
    estimatedResonanceHz: peak.hz,
    peakAccelerationRms: round(peak.accelerationRms, 6),
    peakDisplacementRmsM: peakDisplacement,
    peakScore,
    peakProminence: round(prominence, 4),
    method: hasCurrent ? "supply-current-normalized-displacement-rms" : "displacement-rms",
    warnings,
    samples: ordered,
  };
}

export async function POST(request: NextRequest) {
  try {
    const payload: unknown = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SyntaxError();
    const samples = (payload as Record<string, unknown>).samples;
    if (!Array.isArray(samples) || samples.length < 3 || samples.length > 100 || !samples.every(validSample)) {
      return NextResponse.json({ error: "분석 입력이 올바르지 않습니다." }, { status: 422 });
    }
    return NextResponse.json(analyseSweep(samples));
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "올바른 JSON 요청이 필요합니다." }, { status: 400 });
    if (error instanceof Error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "스윕 분석에 실패했습니다." }, { status: 500 });
  }
}
