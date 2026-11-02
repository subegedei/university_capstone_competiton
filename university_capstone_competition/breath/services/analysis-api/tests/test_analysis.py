import unittest
from fastapi.testclient import TestClient
from app.main import app
from app.resonance import analyse_sweep, acceleration_model, displacement_rms_m

def sample(hz, rms, current=0.1):
    return dict(hz=hz, accelerationRms=rms, busVoltageV=20, currentA=current, powerW=2,
                windowCount=5, sampleCount=250, sampleRateHz=250)

class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_peak_uses_frequency_squared_corrected_displacement(self):
        response = self.client.post("/api/resonance/analyze", json={"samples": [sample(15, 0.2, 99), sample(29, 1.2), sample(50, 0.3)]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["estimatedResonanceHz"], 29)
        self.assertNotIn("confidence", response.json())

    def test_high_frequency_acceleration_does_not_automatically_win(self):
        # 45 Hz has the largest acceleration, but 30 Hz has the largest
        # inferred displacement once a = (2*pi*f)^2*x is reversed.
        result = analyse_sweep([sample(20, 0.5), sample(30, 2.0), sample(45, 4.0)])
        self.assertEqual(result["estimatedResonanceHz"], 30)
        self.assertEqual(result["method"], "supply-current-normalized-displacement-rms")
        self.assertAlmostEqual(displacement_rms_m(30, 2.0), 2.0 / (2 * 3.141592653589793 * 30) ** 2)

    def test_missing_current_falls_back_to_displacement_not_raw_acceleration(self):
        result = analyse_sweep([sample(20, 0.5, None), sample(30, 2.0, None), sample(45, 4.0, None)])
        self.assertEqual(result["estimatedResonanceHz"], 30)
        self.assertEqual(result["method"], "displacement-rms")

    def test_flat_and_boundary_response_have_warnings(self):
        result = analyse_sweep([sample(15, 1), sample(30, 1), sample(50, 1)])
        self.assertTrue(any("평탄" in text for text in result["warnings"]))
        self.assertTrue(any("끝" in text for text in result["warnings"]))

    def test_invalid_samples_rejected(self):
        for samples in ([sample(15, 1)], [sample(15, -1), sample(30, 1), sample(50, 1)],
                        [{**sample(15, 1), "sampleRateHz": 50}, sample(30, 1), sample(50, 1)]):
            self.assertEqual(self.client.post("/api/resonance/analyze", json={"samples": samples}).status_code, 422)
        duplicate = [sample(15, 1), sample(15, 2), sample(50, 1)]
        self.assertEqual(self.client.post("/api/resonance/analyze", json={"samples": duplicate}).status_code, 400)

    def test_zero_signal_has_no_fake_resonance(self):
        with self.assertRaises(ValueError):
            analyse_sweep([sample(15, 0), sample(30, 0), sample(50, 0)])

    def test_nonfinite_values_rejected(self):
        response = self.client.post("/api/resonance/analyze", content='{"samples":[{"hz":15,"accelerationRms":1e999,"windowCount":2,"sampleCount":50,"sampleRateHz":250},{"hz":30,"accelerationRms":1,"windowCount":2,"sampleCount":50,"sampleRateHz":250},{"hz":50,"accelerationRms":1,"windowCount":2,"sampleCount":50,"sampleRateHz":250}]}', headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 422)

    def test_health_and_model(self):
        self.assertEqual(self.client.get("/health").json()["protocolVersion"], 3)
        self.assertGreater(acceleration_model(30, 1, 1, 10000, 1), 0)
        with self.assertRaises(ValueError):
            acceleration_model(30, 0, 1, 10000, 1)

if __name__ == "__main__":
    unittest.main()
