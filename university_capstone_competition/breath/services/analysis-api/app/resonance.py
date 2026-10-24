"""Measured linear-acceleration response peak; not a clinical resonance estimator."""
from math import isfinite, pi, sqrt
from statistics import median


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
        if not isfinite(sample["hz"]) or not 15 <= sample["hz"] <= 50:
            raise ValueError("Frequencies must be finite and between 15 and 50 Hz.")
        if not isfinite(sample["accelerationRms"]) or sample["accelerationRms"] < 0:
            raise ValueError("Acceleration RMS must be finite and nonnegative.")
    peak = max(ordered, key=lambda sample: sample["accelerationRms"])
    amplitude = peak["accelerationRms"]
    if amplitude <= 0:
        raise ValueError("No measurable vibration response was recorded.")
    prominence = max(0.0, (amplitude - median(sample["accelerationRms"] for sample in ordered)) / amplitude)
    warnings = ["이 값은 장치·패널·접촉부를 포함한 측정 시스템의 응답 피크이며, 인체 흉벽의 고유 공진으로 검증된 값은 아닙니다."]
    if peak["hz"] in (ordered[0]["hz"], ordered[-1]["hz"]):
        warnings.append("피크가 스윕 범위의 끝에 있어 범위 밖의 피크를 구분할 수 없습니다.")
    if prominence < 0.1:
        warnings.append("응답 곡선이 평탄하여 뚜렷한 피크를 확인하기 어렵습니다.")
    if sum(abs(sample["accelerationRms"] - amplitude) <= amplitude * 1e-6 for sample in ordered) > 1:
        warnings.append("같은 크기의 피크가 여러 개입니다. 가장 낮은 주파수를 표시합니다.")
    if ordered[0]["hz"] != 15 or ordered[-1]["hz"] != 50:
        warnings.append("15–50 Hz 전체 범위가 수집되지 않았습니다.")
    if any(sample.get("currentA") is None or sample.get("powerW") is None for sample in ordered):
        warnings.append("일부 INA226 전류·전력값이 없습니다. 가속도만으로 피크를 계산했습니다.")
    return {
        "estimatedResonanceHz": peak["hz"],
        "peakAccelerationRms": round(amplitude, 6),
        "peakProminence": round(prominence, 4),
        "method": "linear-acceleration-rms-peak",
        "warnings": warnings,
        "samples": ordered,
    }
