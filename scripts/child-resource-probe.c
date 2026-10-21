// 벤치마크 전용 Node-API 모듈. 새 프로세스 없이 종료·wait된 자식의 누적 자원만 읽는다.
#include <node_api.h>
#include <sys/resource.h>

/** OS 누적 카운터를 JS Number 속성에 옮기며 Node-API 오류를 성공 값으로 숨기지 않는다. */
static int number(napi_env env, napi_value object, const char *name, double value) {
  napi_value result;
  return napi_create_double(env, value, &result) == napi_ok &&
    napi_set_named_property(env, object, name, result) == napi_ok;
}

/** 현재 Node가 wait한 자식 CPU와 page-fault 합계를 반환한다. 살아 있는 자식의 RSS/CPU는 추측하지 않는다. */
static napi_value capture(napi_env env, napi_callback_info info) {
  (void) info;
  struct rusage usage;
  napi_value result;
  if (getrusage(RUSAGE_CHILDREN, &usage) != 0 || napi_create_object(env, &result) != napi_ok ||
      !number(env, result, "userCpuMs", usage.ru_utime.tv_sec * 1000.0 + usage.ru_utime.tv_usec / 1000.0) ||
      !number(env, result, "systemCpuMs", usage.ru_stime.tv_sec * 1000.0 + usage.ru_stime.tv_usec / 1000.0) ||
      !number(env, result, "minorFaults", usage.ru_minflt) || !number(env, result, "majorFaults", usage.ru_majflt)) {
    napi_throw_error(env, NULL, "Cannot read waited-child resource counters.");
    return NULL;
  }
  return result;
}

/** 읽기 함수 하나만 공개한다. 환경·파일·프로세스 실행 정책은 변경하지 않는다. */
static napi_value initialize(napi_env env, napi_value exports) {
  napi_value method;
  if (napi_create_function(env, "capture", NAPI_AUTO_LENGTH, capture, NULL, &method) != napi_ok ||
      napi_set_named_property(env, exports, "capture", method) != napi_ok) {
    napi_throw_error(env, NULL, "Cannot initialize child resource probe.");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(gsc_child_resource_probe, initialize)
