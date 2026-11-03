/*
 * 숨결톡톡 | Arduino IDE (ESP32 + BNO085) 공진 후보 측정 예제
 * 2026-11-03 / 로그 스케일+속도 보정 통합 측정 코드
 * 중요: 사용자 고유 구동 스케치가 아니며 구동 기능이 없는 측정 전용 예제
 *
 * 목적: 기존 웹 그래프 X=Frequency(Hz), Y=Acceleration(m/s^2) 유지
 *  - 종전의 전체 RMS 대신 구동 주파수 f 성분의 가속도 RMS 추출
 *  - 고주파 끝점 최대를 공진으로 자동 확정하지 않음
 *  - 내부 최대가 발견되면 '예비 후보'만 출력 (입력 가진력 미계측)
 *
 * 중요: 현재 구동 회로/핀/음원 PWM 코드가 제공되지 않았으므로
 *       이 예제는 트랜스듀서를 구동하거나 출력 설정을 변경하지 않는다.
 *       반드시 기존 구동 코드에서 주파수를 먼저 설정하고 안전 확인 후
 *       'M,<실제 구동 주파수>' 명령을 보낼 것.
 *       구동 제어를 통합하려면 해당 장치에 맞는 명령 확인/안정화/정지 로직 필요.
 *
 * 의존성: Arduino IDE, ESP32 core, Adafruit BNO08x 라이브러리
 *  - 측정축은 흉벽에 수직인 축으로 설정 (X/Y/Z 확인 필수)
 *  - 캘리브레이티드 가속도(SH2_ACCELEROMETER) 사용.
 *  - b0(DC)를 회귀로 제거하므로 중력 DC 오프셋은 영향 제한.
 *  - 데이터 유효 대역 및 실제 보고율을 별도 검증.
 *
 * SERIAL: 115200
 * M,30    : 기존 구동 장치를 30 Hz로 안정화한 후 측정 시작
 * RESULTS : DATA,frequencyHz,accelRmsMps2,displacementRmsMm,samples,rateHz,R2,quality
 * S       : 가속도->속도 보정 후 내부 피크 후보 탐색
 * L       : 저장된 각 주파수의 로그 스케일 및 속도 지표 출력
 * C       : 저장한 결과 초기화
 * X       : 측정 취소(트랜스듀서 정지는 기존 구동 코드에서 별도 처리!)
 */

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BNO08x.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static constexpr uint32_t SERIAL_BAUD = 115200;
static constexpr uint32_t SENSOR_INTERVAL_US = 4000; // 목표 250Hz, 실제값은 계측 확인
static constexpr uint32_t SETTLE_MS = 800; // 실험 조건에 따라 검증 필요
static constexpr uint32_t MEASURE_MS = 1600;
static constexpr size_t MAX_SAMPLES = 800;
static constexpr size_t MAX_POINTS = 48;
static constexpr float MIN_F_HZ = 20.0f; // 현재 검증된 탐색 범위로 제한
static constexpr float MAX_F_HZ = 45.0f;
static constexpr char MEASURE_AXIS = 'Z'; // 반드시 실제 흉벽 법선 축 확인
static constexpr double PI_D = 3.14159265358979323846;
// 로그 레벨은 반드시 참조량을 함께 기록한다.
static constexpr double ACC_REF_MPS2 = 1.0;    // 0 dB re 1 m/s^2
static constexpr double VEL_REF_MPS = 0.001;   // 0 dB re 1 mm/s
static constexpr double F_REF_HZ = 30.0;       // 주파수 환산 비교 기준

// 아래 계산은 단일 정현파의 가속도 RMS에만 적용한다.
double velocityRms(double aRms, double fHz) {
  if (!isfinite(aRms) || !isfinite(fHz) || aRms <= 0 || fHz <= 0) return NAN;
  return aRms / (2.0 * PI_D * fHz);
}

double accelDb(double aRms) {
  if (!isfinite(aRms) || aRms <= 0) return NAN;
  return 20.0 * log10(aRms / ACC_REF_MPS2);
}

double velocityDb(double aRms, double fHz) {
  double v = velocityRms(aRms, fHz);
  if (!isfinite(v) || v <= 0) return NAN;
  return 20.0 * log10(v / VEL_REF_MPS);
}

// 가속도를 기준 주파수 F_REF_HZ로 환산한 보정 로그 레벨.
// v = a/(2*pi*f)에 고정 상수를 곱한 것이므로 피크 위치는 velocityDb와 같다.
double correctedDb(double aRms, double fHz) {
  if (!isfinite(fHz) || fHz <= 0) return NAN;
  double aLevel = accelDb(aRms);
  if (!isfinite(aLevel)) return NAN;
  return aLevel - 20.0 * log10(fHz / F_REF_HZ);
}


Adafruit_BNO08x bno08x(-1);
sh2_SensorValue_t sensorValue;

enum Phase { IDLE, SETTLING, CAPTURING };
Phase phase = IDLE;
uint32_t phaseStartMs = 0;
float targetHz = 0.0f;

struct Sample { uint64_t timeUs; float a; };
Sample samples[MAX_SAMPLES];
size_t sampleCount = 0;
uint64_t lastTimeUs = 0;
uint32_t nonmonotonicTime = 0;
uint32_t droppedEvents = 0;
uint8_t prevSequence = 0;
bool hasPrevSequence = false;

struct Point {
  float hz;
  float meanRms;
  float sumRms;
  float sumRmsSq;
  uint8_t trials;
};
Point points[MAX_POINTS];
size_t pointCount = 0;

bool getAxisAcceleration(const sh2_SensorValue_t &ev, float &out) {
  if (ev.sensorId != SH2_ACCELEROMETER) return false;
  switch (MEASURE_AXIS) {
    case 'X': out = ev.un.accelerometer.x; break;
    case 'Y': out = ev.un.accelerometer.y; break;
    case 'Z': out = ev.un.accelerometer.z; break;
    default: return false;
  }
  return isfinite(out);
}

// 3x3 연립방정식을 부분 피벗팅 가우스 소거로 풀이.
// x(t)=b0+bC*cos(2*pi*f*t)+bS*sin(2*pi*f*t)
bool solve3x3(double aug[3][4], double x[3]) {
  for (int k = 0; k < 3; ++k) {
    int best = k;
    for (int r = k + 1; r < 3; ++r)
      if (fabs(aug[r][k]) > fabs(aug[best][k])) best = r;
    if (fabs(aug[best][k]) < 1.e-9) return false;
    for (int j = k; j < 4; ++j) {
      double v = aug[k][j]; aug[k][j] = aug[best][j]; aug[best][j] = v;
    }
    double d = aug[k][k];
    for (int j = k; j < 4; ++j) aug[k][j] /= d;
    for (int r = 0; r < 3; ++r) if (r != k) {
      double q = aug[r][k];
      for (int j = k; j < 4; ++j) aug[r][j] -= q * aug[k][j];
    }
  }
  for (int k = 0; k < 3; ++k) x[k] = aug[k][3];
  return true;
}

struct FitResult {
  bool ok;
  double rms;
  double r2;
  double sampleRate;
  double displacementMm;
};

FitResult fitFrequency(float f) {
  FitResult result = {false, NAN, NAN, NAN, NAN};
  if (sampleCount < 64 || !(f > 0)) return result;
  uint64_t t0 = samples[0].timeUs;
  uint64_t t1 = samples[sampleCount-1].timeUs;
  if (t1 <= t0) return result;
  double dt = ((double)(t1 - t0)) * 1.e-6;
  if (dt < 1.0) return result;
  result.sampleRate = (sampleCount - 1) / dt;
  double sum[3][3] = {{0}}, rhs[3] = {0};
  for (size_t i = 0; i < sampleCount; ++i) {
    double t = ((double)(samples[i].timeUs - t0))*1.e-6;
    double ang = 2.0 * PI_D * (double)f * t;
    double x[3] = {1.0, cos(ang), sin(ang)};
    for (int r=0; r<3; ++r) {
      rhs[r] += x[r] * samples[i].a;
      for (int c=0; c<3; ++c) sum[r][c] += x[r]*x[c];
    }
  }
  double aug[3][4];
  for (int r=0; r<3; ++r) {
    for (int c=0; c<3; ++c) aug[r][c] = sum[r][c];
    aug[r][3] = rhs[r];
  }
  double b[3];
  if (!solve3x3(aug,b)) return result;
  double mean = 0;
  for (size_t i=0;i<sampleCount;i++) mean += samples[i].a;
  mean /= sampleCount;
  double sse=0,sst=0;
  for (size_t i=0;i<sampleCount;i++) {
    double t=((double)(samples[i].timeUs-t0))*1.e-6;
    double ang=2.0*PI_D*(double)f*t;
    double fitted=b[0]+b[1]*cos(ang)+b[2]*sin(ang);
    double e=(double)samples[i].a-fitted;
    sse+=e*e;
    double centered=(double)samples[i].a-mean;
    sst+=centered*centered;
  }
  result.r2 = sst > 1.e-12 ? 1.0 - sse/sst : NAN;
  double peak=sqrt(b[1]*b[1]+b[2]*b[2]);
  result.rms=peak/sqrt(2.0);
  result.displacementMm=1000.0*result.rms/pow(2.0*PI_D*f,2);
  result.ok=isfinite(result.rms) && isfinite(result.r2);
  return result;
}

void addPoint(float f, float rms) {
  size_t at=pointCount;
  for (size_t i=0;i<pointCount;++i)
    if (fabs(points[i].hz-f)<0.01f) {at=i;break;}
  if (at==pointCount) {
    if (pointCount>=MAX_POINTS) { Serial.println("ERR,POINT_TABLE_FULL"); return; }
    points[at]={f,0,0,0,0}; pointCount++;
  }
  Point &p=points[at];
  if (p.trials==255) { Serial.println("ERR,TRIAL_LIMIT");return; }
  p.sumRms+=rms; p.sumRmsSq+=rms*rms; p.trials++;
  p.meanRms=p.sumRms/p.trials;
}

void reportFit() {
  FitResult r=fitFrequency(targetHz);
  bool rateOK = r.ok && r.sampleRate >= 5.0*targetHz;
  bool timeOK = (nonmonotonicTime==0);
  bool fitOK = r.ok && r.r2>=0.60; // 연구용 예시, 보편적 인증 기준 아님
  bool valid = rateOK && timeOK && fitOK && droppedEvents==0;
  const char *quality = !r.ok ? "INVALID_FIT" :
     !timeOK ? "BAD_TIMESTAMP" :
     !rateOK ? "LOW_SAMPLE_RATE" :
     droppedEvents ? "DROPPED_SAMPLES" :
     !fitOK ? "LOW_FIT_R2" : "MEASURE_OK";
  Serial.print("DATA,"); Serial.print(targetHz,3);
  Serial.print(','); Serial.print(r.rms,6);
  Serial.print(','); Serial.print(r.displacementMm,6);
  Serial.print(','); Serial.print(sampleCount);
  Serial.print(','); Serial.print(r.sampleRate,2);
  Serial.print(','); Serial.print(r.r2,3);
  Serial.print(','); Serial.println(quality);
  // 결과가 유효할 때만 '예비 후보' 판정에 포함
  if (valid) addPoint(targetHz,(float)r.rms);
  phase=IDLE;
  Serial.println("STATE,IDLE");
}

// 로그 스케일 출력은 별도 명령(L)에서만 수행해 기존 DATA 포맷을 깨지 않는다.
void printLogTable() {
  if(pointCount==0) { Serial.println("LOG,NO_POINTS"); return; }
  Point arr[MAX_POINTS];
  memcpy(arr, points, sizeof(Point)*pointCount);
  for(size_t i=0;i<pointCount;i++)
    for(size_t j=i+1;j<pointCount;j++)
      if(arr[j].hz<arr[i].hz) { Point t=arr[i]; arr[i]=arr[j]; arr[j]=t; }
  Serial.println("LOG_HEADER,Hz,AccelRMS_mps2,Accel_dB_re_1mps2,VelocityRMS_mmps,Velocity_dB_re_1mmps,Corrected_dB_re_30Hz,Trials");
  for(size_t i=0;i<pointCount;i++) {
    const Point &p=arr[i];
    double v=velocityRms(p.meanRms,p.hz);
    Serial.print("LOG,"); Serial.print(p.hz,3);
    Serial.print(','); Serial.print(p.meanRms,6);
    Serial.print(','); Serial.print(accelDb(p.meanRms),3);
    Serial.print(','); Serial.print(v*1000.0,6);
    Serial.print(','); Serial.print(velocityDb(p.meanRms,p.hz),3);
    Serial.print(','); Serial.print(correctedDb(p.meanRms,p.hz),3);
    Serial.print(','); Serial.println(p.trials);
  }
}

void printCandidates() {
  if (pointCount<3) {Serial.println("SWEEP,INSUFFICIENT_POINTS"); return;}
  Point arr[MAX_POINTS];
  memcpy(arr,points,sizeof(Point)*pointCount);
  for (size_t i=0;i<pointCount;i++)
    for (size_t j=i+1;j<pointCount;j++) if(arr[j].hz<arr[i].hz) {
      Point tmp=arr[i];arr[i]=arr[j];arr[j]=tmp;
    }
  // 기존과 달리 가속도 절대 최대가 아니라 속도 환산값으로 판정한다.
  int best=0;
  for (size_t i=1;i<pointCount;i++)
    if(velocityRms(arr[i].meanRms,arr[i].hz) >
       velocityRms(arr[best].meanRms,arr[best].hz)) best=(int)i;
  if(best==0 || best==(int)pointCount-1)
    Serial.println("SWEEP,BOUNDARY_MAX_NOT_RESONANCE");
  int count=0;
  for(size_t i=1;i+1<pointCount;i++) {
    Point &p=arr[i];
    double vHere=velocityRms(p.meanRms,p.hz);
    double vLeft=velocityRms(arr[i-1].meanRms,arr[i-1].hz);
    double vRight=velocityRms(arr[i+1].meanRms,arr[i+1].hz);
    if(!(isfinite(vHere) && isfinite(vLeft) && isfinite(vRight)) ||
       vHere<=vLeft || vHere<=vRight) continue;
    double cv=INFINITY;
    if(p.trials>=3 && p.meanRms>1e-9) {
      double var=((double)p.sumRmsSq/p.trials-p.meanRms*p.meanRms);
      cv=sqrt(fmax(0.0,var))/p.meanRms;
    }
    Serial.print("CANDIDATE,");Serial.print(p.hz,3);
    Serial.print(',');Serial.print(p.meanRms,6);
    Serial.print(',');Serial.print(p.trials);
    Serial.print(',');Serial.print(cv,3);
    Serial.print(',');Serial.println(cv <= 0.15 ? "REPEATABLE_PRELIMINARY" : "NEEDS_REPEAT");
    Serial.print("V_SCORE,"); Serial.print(p.hz,3);
    Serial.print(',');Serial.print(vHere*1000.0,5);  // mm/s
    Serial.print(',');Serial.println(correctedDb(p.meanRms,p.hz),3);
    count++;
  }
  if(count==0) Serial.println("SWEEP,NO_INTERIOR_PEAK");
  // '공진 확정' 문구를 절대 출력하지 않는다.
}

void startMeasure(float hz) {
  if(phase!=IDLE) { Serial.println("ERR,BUSY");return; }
  if(!isfinite(hz) || hz<MIN_F_HZ || hz>MAX_F_HZ) {
    Serial.println("ERR,FREQUENCY_OUT_OF_VALIDATED_RANGE");return;
  }
  targetHz=hz;
  sampleCount=0; lastTimeUs=0; nonmonotonicTime=0;
  droppedEvents=0; hasPrevSequence=false;
  phase=SETTLING; phaseStartMs=millis();
  Serial.print("STATE,SETTLING,");Serial.println(targetHz,3);
  // 트랜스듀서는 이 펌웨어가 제어하지 않음. 호스트/기존 펌웨어에서 설정 필수!
}

char commandBuf[48]={0};
size_t commandLen=0;
void dispatchCommand(char *line) {
  if(strcmp(line,"S")==0){printCandidates();return;}
  if(strcmp(line,"L")==0){if(phase==IDLE) printLogTable();
    else Serial.println("ERR,BUSY_LOG_TABLE");return;}
  if(strcmp(line,"C")==0){if(phase==IDLE){pointCount=0;Serial.println("STATE,CLEARED");}return;}
  if(strcmp(line,"X")==0){phase=IDLE;Serial.println("STATE,MEASUREMENT_ABORTED_ONLY");return;}
  if(line[0]=='M' && line[1]==','){
    char *endp=nullptr;
    float hz=strtof(line+2,&endp);
    if(endp==line+2 || *endp!='\0') {Serial.println("ERR,BAD_FREQUENCY");return;}
    startMeasure(hz);return;
  }
  Serial.println("ERR,UNKNOWN_COMMAND");
}

void handleSerial() {
  while(Serial.available()) {
    char c=(char)Serial.read();
    if(c=='\r') continue;
    if(c=='\n') {commandBuf[commandLen]='\0';dispatchCommand(commandBuf);commandLen=0;}
    else if(commandLen+1<sizeof(commandBuf)) commandBuf[commandLen++]=c;
    else {commandLen=0;Serial.println("ERR,COMMAND_TOO_LONG");}
  }
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  Wire.begin(); // 사용 중인 ESP32의 실제 SDA/SCL 핀 설정 유지/확인
  Wire.setClock(400000); // 기판/배선 조건에 따라 변경하고 실제 샘플링 확인
  if (!bno08x.begin_I2C()) {
    Serial.println("ERR,BNO085_NOT_FOUND");
    while(1) {delay(1000);}
  }
  if (!bno08x.enableReport(SH2_ACCELEROMETER,SENSOR_INTERVAL_US)) {
    Serial.println("ERR,CANNOT_ENABLE_ACCELEROMETER");
    while(1) {delay(1000);}
  }
  Serial.println("READY,NO_ACTUATOR_CONTROL,M-S-L-C-X-COMMANDS");
}

void loop() {
  handleSerial();
  if(bno08x.wasReset()) {
    phase=IDLE;pointCount=0;
    if(!bno08x.enableReport(SH2_ACCELEROMETER,SENSOR_INTERVAL_US))
      Serial.println("ERR,BNO085_RESET_REPORT_FAILURE");
    else Serial.println("WARN,BNO085_RESET_SWEEP_CLEARED");
  }

  // 측정 중 데이터가 뒤늦게 들어오는 것을 방지하기 위해 정착 단계에서도 읽어 버림.
  for(int i=0;i<12 && bno08x.getSensorEvent(&sensorValue);++i) {
    float a=0;
    if(!getAxisAcceleration(sensorValue,a)) continue;
    if(phase!=CAPTURING) continue;
    if(sampleCount>=MAX_SAMPLES) continue;
    uint64_t t=sensorValue.timestamp;
    if(t==0 || (sampleCount>0 && t<=lastTimeUs)) {
      nonmonotonicTime++;continue;
    }
    if(hasPrevSequence) {
      uint8_t diff=(uint8_t)(sensorValue.sequence-prevSequence);
      if(diff!=1) droppedEvents+=(diff>0?diff-1:1);
    }
    prevSequence=sensorValue.sequence;hasPrevSequence=true;
    samples[sampleCount++]={t,a};lastTimeUs=t;
  }

  uint32_t now=millis();
  if(phase==SETTLING && (uint32_t)(now-phaseStartMs)>=SETTLE_MS) {
    phase=CAPTURING;phaseStartMs=now;
    sampleCount=0;lastTimeUs=0;nonmonotonicTime=0;
    droppedEvents=0;hasPrevSequence=false;
    Serial.println("STATE,CAPTURING");
  }
  if(phase==CAPTURING && (uint32_t)(now-phaseStartMs)>=MEASURE_MS) reportFit();
}
