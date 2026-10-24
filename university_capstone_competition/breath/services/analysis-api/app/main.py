from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .resonance import analyse_sweep

app = FastAPI(title="Breath Tok-Tok Analysis API", version="3.0.0")


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, error: RequestValidationError):
    # Invalid numeric inputs may contain infinity; do not echo them into JSON.
    details = [{"loc": item["loc"], "msg": item["msg"], "type": item["type"]} for item in error.errors()]
    return JSONResponse(status_code=422, content={"detail": details})


class SweepSample(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    hz: float = Field(ge=15, le=50)
    accelerationRms: float = Field(ge=0)
    busVoltageV: float | None = Field(default=None, ge=0)
    currentA: float | None = None
    powerW: float | None = None
    windowCount: int = Field(ge=2)
    sampleCount: int = Field(ge=1)
    sampleRateHz: float = Field(ge=200)


class SweepRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    samples: list[SweepSample] = Field(min_length=3, max_length=100)


@app.get("/health")
def health():
    return {"status": "ok", "protocolVersion": 3}


@app.post("/api/resonance/analyze")
def analyse(request: SweepRequest):
    try:
        return analyse_sweep([sample.model_dump() for sample in request.samples])
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
