export type SweepSample = {
  hz: number; accelerationRms: number; busVoltageV: number | null; currentA: number | null;
  powerW: number | null; windowCount: number; sampleCount: number; sampleRateHz: number;
};
export type SweepResult = {
  estimatedResonanceHz: number | null; peakAccelerationRms: number; peakDisplacementRmsM: number; peakScore: number; peakProminence: number;
  warnings: string[]; samples: SweepSample[]; method: string;
};

// For sinusoidal motion, a = (2*pi*f)^2 * x.  Comparing raw acceleration
// would systematically favour the last, highest-frequency sweep point.
export function displacementRmsM(sample: Pick<SweepSample, "hz" | "accelerationRms">): number {
  return sample.accelerationRms / (2 * Math.PI * sample.hz) ** 2;
}

export function hasUsableSupplyCurrent(samples: SweepSample[]): boolean {
  return samples.every((sample) => sample.currentA !== null && sample.currentA >= 0.001);
}

export function responseScore(sample: SweepSample, normalizeBySupplyCurrent: boolean): number {
  // The candidate rule uses the fundamental velocity component. INA226 reads
  // amplifier supply current, not coil current, so it must not alter ranking.
  void normalizeBySupplyCurrent;
  return sample.accelerationRms / (2 * Math.PI * sample.hz);
}

export function peakResponseIndex(samples: SweepSample[]): number {
  const normalizeBySupplyCurrent = hasUsableSupplyCurrent(samples);
  return samples.reduce((best, sample, index) => responseScore(sample, normalizeBySupplyCurrent) > responseScore(samples[best], normalizeBySupplyCurrent) ? index : best, 0);
}
export async function analyseSweep(samples: SweepSample[], signal: AbortSignal): Promise<SweepResult> {
  const response = await fetch("/api/resonance/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ samples }), signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "스윕 분석에 실패했습니다.");
  return result as SweepResult;
}
