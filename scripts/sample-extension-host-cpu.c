#include <errno.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

static mach_timebase_info_data_t timebase;

/**
 * 전달받은 시계의 값을 나노초로 반환해 CPU 시간과 벽시계를 구분한다.
 * @param clock_id 조회할 POSIX 시계. 실제 시간·단조 시간·자체 CPU 시계를 각각 사용한다.
 * @return 나노초 값. 시계를 읽을 수 없으면 잘못된 표본 대신 종료 코드 2로 중단한다.
 */
static uint64_t now_ns(clockid_t clock_id) {
    struct timespec t;
    if (clock_gettime(clock_id, &t) != 0) { perror("clock_gettime"); exit(2); }
    return (uint64_t)t.tv_sec * 1000000000ULL + t.tv_nsec;
}

/**
 * 지정 PID의 누적 자원을 읽으며 다른 프로세스나 작업트리는 변경하지 않는다.
 * @param pid 읽을 프로세스 ID. out에는 호출 전 0으로 초기화한 v4 자원 정보를 쓴다.
 * @return 성공하면 0, 실패하면 -1. 실패 원인은 errno로 전달한다.
 */
static int read_usage(pid_t pid, struct rusage_info_v4 *out) {
    memset(out, 0, sizeof(*out));
    return proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)out);
}

/**
 * 인수 없이 자기 CPU 시계와 rusage 증가량을 대조하고 검증 결과를 JSON에 출력한다.
 * Mach timebase 변환 후 허용 범위를 벗어나면 이후 표본 없이 종료 코드 2로 중단한다.
 * 반환값은 없고 자체 단위 검증의 약 50ms 작업은 관찰 구간 전에 수행한다.
 */
static void print_calibration(void) {
    struct rusage_info_v4 a, b;
    if (read_usage(getpid(), &a) != 0) { perror("self rusage"); exit(2); }
    uint64_t cpu_before = now_ns(CLOCK_PROCESS_CPUTIME_ID);
    uint64_t wall_before = now_ns(CLOCK_MONOTONIC);
    volatile uint64_t value = 1;
    do {
        for (int i = 0; i < 10000; i++) value = value * 1664525ULL + 1013904223ULL;
    } while (now_ns(CLOCK_MONOTONIC) - wall_before < 50000000ULL);
    uint64_t cpu_after = now_ns(CLOCK_PROCESS_CPUTIME_ID);
    if (read_usage(getpid(), &b) != 0) { perror("self rusage"); exit(2); }
    uint64_t usage_delta = (b.ri_user_time + b.ri_system_time) - (a.ri_user_time + a.ri_system_time);
    double converted_ns = (double)usage_delta * timebase.numer / timebase.denom;
    double ratio = converted_ns / (double)(cpu_after - cpu_before);
    printf("\"calibration\":{\"processCpuClockNs\":%llu,\"rusageDeltaTicks\":%llu,\"ratio\":%.6f},",
        (unsigned long long)(cpu_after - cpu_before), (unsigned long long)usage_delta, ratio);
    if (!isfinite(ratio) || ratio < 0.95 || ratio > 1.05) { fputs("CPU time unit mismatch\n", stderr); exit(2); }
}

/**
 * 호스트 tick과 대상 PID의 누적 CPU·메모리를 JSON 표본 하나로 출력한다.
 * @param count pids 배열의 길이. pids는 읽을 PID 목록이며 함수에서 변경하지 않는다.
 * 반환값은 없다. 실패한 PID에는 오류를 기록하며 시작시각으로 PID 재사용을 판별한다.
 */
static void print_snapshot(int count, const pid_t *pids) {
    host_cpu_load_info_data_t cpu;
    mach_msg_type_number_t size = HOST_CPU_LOAD_INFO_COUNT;
    kern_return_t result = host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, (host_info_t)&cpu, &size);
    if (result != KERN_SUCCESS) { fputs("host_statistics failed\n", stderr); exit(2); }
    double loads[3];
    if (getloadavg(loads, 3) != 3) { fputs("getloadavg failed\n", stderr); exit(2); }
    printf("{\"wallNs\":%llu,\"monotonicNs\":%llu,\"hostTicks\":[%u,%u,%u,%u],\"loadAverage\":[%.4f,%.4f,%.4f],\"processes\":[",
        (unsigned long long)now_ns(CLOCK_REALTIME), (unsigned long long)now_ns(CLOCK_MONOTONIC),
        cpu.cpu_ticks[CPU_STATE_USER], cpu.cpu_ticks[CPU_STATE_SYSTEM], cpu.cpu_ticks[CPU_STATE_IDLE], cpu.cpu_ticks[CPU_STATE_NICE],
        loads[0], loads[1], loads[2]);
    for (int i = 0; i < count; i++) {
        if (i) putchar(',');
        struct rusage_info_v4 r;
        if (read_usage(pids[i], &r) != 0) {
            printf("{\"pid\":%d,\"error\":%d}", pids[i], errno);
            continue;
        }
        printf("{\"pid\":%d,\"startAbs\":%llu,\"userTicks\":%llu,\"systemTicks\":%llu,\"residentBytes\":%llu,\"physicalFootprintBytes\":%llu}",
            pids[i], (unsigned long long)r.ri_proc_start_abstime, (unsigned long long)r.ri_user_time,
            (unsigned long long)r.ri_system_time, (unsigned long long)r.ri_resident_size, (unsigned long long)r.ri_phys_footprint);
    }
    printf("]}");
    fflush(stdout);
}

/**
 * argv의 PID 인수를 검증하고 5초 간격의 5개 표본을 읽는다.
 * 대상 앱 신호·UI 입력 없이 측정하며 자체 단위 검증 50ms는 관찰 구간에서 제외한다.
 * @param argc 실행 파일을 포함한 인수 개수. argv에는 1~64개의 양의 PID를 전달한다.
 * @return JSON을 출력하면 0, 잘못된 인수나 측정 환경이면 2를 반환한다.
 */
int main(int argc, char **argv) {
    if (argc < 2 || argc > 65) { fputs("usage: gsc-passive-host-cpu PID...\n", stderr); return 2; }
    pid_t pids[64];
    for (int i = 1; i < argc; i++) {
        char *end = NULL;
        long n = strtol(argv[i], &end, 10);
        if (!*argv[i] || *end || n < 1 || n > INT32_MAX) { fputs("invalid PID\n", stderr); return 2; }
        pids[i - 1] = (pid_t)n;
    }
    if (mach_timebase_info(&timebase) != KERN_SUCCESS) return 2;
    printf("{\"machTimebase\":{\"numer\":%u,\"denom\":%u},", timebase.numer, timebase.denom);
    printf("\"schemaVersion\":1,\"logicalCpuCount\":%ld,\"nativeUiInput\":false,\"forcedReload\":false,\"signalsSent\":false,", sysconf(_SC_NPROCESSORS_ONLN));
    print_calibration();
    printf("\"samples\":[");
    for (int sample = 0; sample < 5; sample++) {
        if (sample) {
            struct timespec duration = {5, 0}, remaining;
            while (nanosleep(&duration, &remaining) != 0 && errno == EINTR) duration = remaining;
            putchar(',');
        }
        print_snapshot(argc - 1, pids);
    }
    puts("]}");
    return 0;
}
