export type SweepSample = {
  hz: number; accelerationRms: number; busVoltageV: number | null; currentA: number | null;
  powerW: number | null; windowCount: number; sampleCount: number; sampleRateHz: number;
};
export type SweepResult = {
  estimatedResonanceHz: number; peakAccelerationRms: number; peakProminence: number;
  warnings: string[]; samples: SweepSample[]; method: string;
};
export async function analyseSweep(samples: SweepSample[], signal: AbortSignal): Promise<SweepResult> {
  const response = await fetch("/api/resonance/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ samples }), signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "스윕 분석에 실패했습니다.");
  return result as SweepResult;
}
