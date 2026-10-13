from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .resonance import analyse_sweep

app = FastAPI(title="Breath Tok-Tok Analysis API", version="0.1.0")


class SweepSample(BaseModel):
    hz: float = Field(ge=15, le=50)
    accelerationRms: float = Field(ge=0)
    piezoRms: float = Field(ge=0)


class SweepRequest(BaseModel):
    samples: list[SweepSample] = Field(min_length=1)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/resonance/analyze")
def analyse(request: SweepRequest):
    try:
        return analyse_sweep([sample.model_dump() for sample in request.samples])
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
