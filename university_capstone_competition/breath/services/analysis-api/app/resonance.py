"""Estimate a displacement-response peak from measured linear acceleration.

The BNO085 measures acceleration, whose magnitude rises with frequency squared
even when the physical displacement stays constant.  Sweep selection must
therefore compare a/(2*pi*f)^2, never raw acceleration alone.
"""
from math import isfinite, pi, sqrt
from statistics import median


MIN_CURRENT_A = 0.001


def displacement_rms_m(hz: float, acceleration_rms: float) -> float:
    """Convert sinusoidal acceleration RMS (m/s²) to displacement RMS (m)."""
    return acceleration_rms / (2 * pi * hz) ** 2


def acceleration_model(hz: float, mass: float, damping: float, stiffness: float, force: float) -> float:
    """Ideal mass-spring-damper acceleration. INA226 supply current is NOT coil current."""
    values = (hz, mass, damping, stiffness, force)
    if not all(isfinite(value) for value in values) or hz <= 0 or mass <= 0 or stiffness <= 0 or damping < 0 or force < 0:
        raise ValueError("Invalid physical model parameters.")
    omega = 2 * pi * hz
    denominator = sqrt((stiffness - mass * omega**2) ** 2 + (damping * omega) ** 2)
    if denominator == 0:
        raise ValueError("An undamped model is singular at its natural frequency.")
    return omega**2 * force / denominator


def analyse_sweep(samples: list[dict]) -> dict:
    if len(samples) < 3:
        raise ValueError("At least three distinct frequencies are required.")
    ordered = sorted(samples, key=lambda sample: sample["hz"])
    if len({sample["hz"] for sample in ordered}) != len(ordered):
        raise ValueError("Duplicate frequencies are not allowed; aggregate RMS windows first.")
    for sample in ordered:
        if not isfinite(sample["hz"]) or not 25 <= sample["hz"] <= 40:
            raise ValueError("Frequencies must be finite and between 25 and 40 Hz.")
        if not isfinite(sample["accelerationRms"]) or sample["accelerationRms"] < 0:
            raise ValueError("Acceleration RMS must be finite and nonnegative.")
    displacements = [displacement_rms_m(sample["hz"], sample["accelerationRms"]) for sample in ordered]
    if max(displacements) <= 0:
        raise ValueError("No measurable vibration response was recorded.")

    # INA226 reads amplifier supply current, not the coil RMS current. It does
    # not participate in candidate ranking. Compare the velocity component.
    scores = [sample["accelerationRms"] / (2 * pi * sample["hz"]) for sample in ordered]
    interior = [index for index in range(1, len(ordered) - 1) if scores[index] > scores[index - 1] and scores[index] > scores[index + 1]]
    peak_index = max(interior, key=lambda index: scores[index]) if interior else None
    display_index = peak_index if peak_index is not None else max(range(len(ordered)), key=lambda index: scores[index])
    peak = ordered[display_index]
    peak_acceleration = peak["accelerationRms"]
    peak_displacement = displacements[display_index]
    peak_score = scores[display_index]
    prominence = max(0.0, (peak_score - median(scores)) / peak_score)
    warnings = ["이 값은 장치·패널·접촉부를 포함한 측정 시스템의 응답 피크이며, 인체 흉벽의 고유 공진으로 검증된 값은 아닙니다."]
    if peak_index is None:
        warnings.append("내부 피크는 확인되지 않았습니다. 측정 범위 안의 최대 응답을 표시합니다.")
    if prominence < 0.1:
        warnings.append("응답 곡선이 평탄하여 뚜렷한 피크를 확인하기 어렵습니다.")
    if sum(abs(score - peak_score) <= max(peak_score, 1e-12) * 1e-6 for score in scores) > 1:
        warnings.append("같은 보정 점수의 피크가 여러 개입니다. 가장 낮은 주파수를 표시합니다.")
    if ordered[0]["hz"] != 25 or ordered[-1]["hz"] != 40:
        warnings.append("25–40 Hz 전체 범위가 수집되지 않았습니다.")
    warnings.append("INA226 앰프 공급 전류는 코일 전류가 아니므로 후보 점수에 사용하지 않았습니다.")
    return {
        "estimatedResonanceHz": peak["hz"],
        "peakKind": "interior" if peak_index is not None else "boundary",
        "peakAccelerationRms": round(peak_acceleration, 6),
        "peakDisplacementRmsM": peak_displacement,
        "peakScore": peak_score,
        "peakProminence": round(prominence, 4),
        "method": "velocity-rms",
        "warnings": warnings,
        "samples": ordered,
    }
