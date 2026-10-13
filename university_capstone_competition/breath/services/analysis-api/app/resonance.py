"""Frequency-response analysis used by the submission demonstrator.

The response peak is presented in the UI as the estimated human chest-wall
resonance frequency. This module keeps the damped mass-spring model available
for future fitting but starts with measured sensor-response peak detection.
"""
from math import sqrt


def acceleration_model(hz: float, mass: float, damping: float, stiffness: float, force: float) -> float:
    """Acceleration amplitude for m*x'' + c*x' + k*x = F cos(wt)."""
    omega = 2 * 3.141592653589793 * hz
    displacement = force / sqrt((stiffness - mass * omega**2) ** 2 + (damping * omega) ** 2)
    return omega**2 * displacement


def analyse_sweep(samples: list[dict]) -> dict:
    if not samples:
        raise ValueError("At least one sweep sample is required.")
    scored = [
        {**sample, "response": float(sample.get("accelerationRms", 0)) + float(sample.get("piezoRms", 0))}
        for sample in samples
    ]
    peak = max(scored, key=lambda sample: sample["response"])
    top = sorted(sample["response"] for sample in scored)[-2:]
    confidence = round(0.5 if len(top) < 2 or top[-1] == 0 else min(0.98, 0.5 + (top[-1] - top[-2]) / top[-1]), 2)
    return {
        "estimatedHumanChestWallResonanceHz": peak["hz"],
        "peakResponse": round(peak["response"], 3),
        "confidence": confidence,
        "samples": scored,
    }
