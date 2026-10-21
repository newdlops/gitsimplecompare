import json
import os
import signal
import subprocess
import sys
import time

report_path, *command = sys.argv[1:]
source = json.loads(os.environ["GSC_BENCH_SOURCE"])
if not command:
    raise SystemExit("Usage: profile-benchmark-resources.py OUTPUT COMMAND [ARGS...]")

# 목표 Node의 자손만 합산한다. 이 observer와 ps 자체는 대상 밖에 둔다.
def sample_tree(root_pid):
    raw = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,rss="], timeout=5).decode("utf8")
    rows = {}
    for line in raw.splitlines():
        values = line.split()
        if len(values) == 3:
            pid, parent, rss = map(int, values)
            rows[pid] = (parent, rss)
    owned = {root_pid}
    while True:
        descendants = {pid for pid, (parent, _) in rows.items() if parent in owned}
        grown = owned | descendants
        if grown == owned:
            break
        owned = grown
    visible = owned & rows.keys()
    return {"at": round(time.time() * 1000), "rssBytes": sum(rows[pid][1] for pid in visible) * 1024,
            "pids": sorted(visible)}

if command:
    process = subprocess.Popen(command, start_new_session=True)
    started = time.monotonic()
    samples = []
    timed_out = False
    usage = None
    try:
        while True:
            pid, status, resource = os.wait4(process.pid, os.WNOHANG)
            if pid:
                usage = resource
                process.returncode = os.waitstatus_to_exitcode(status)
                break
            if time.monotonic() - started > 240:
                timed_out = True
                os.killpg(process.pid, signal.SIGTERM)
                _, status, usage = os.wait4(process.pid, 0)
                process.returncode = os.waitstatus_to_exitcode(status)
                break
            samples.append(sample_tree(process.pid))
            time.sleep(0.05)
    finally:
        if process.returncode is None:
            os.killpg(process.pid, signal.SIGTERM)
            _, status, usage = os.wait4(process.pid, 0)
            process.returncode = os.waitstatus_to_exitcode(status)

result = {"source": source, "code": process.returncode, "timedOut": timed_out,
          "scope": "Actual benchmark Node and currently visible descendants only; includes fixture setup, capture and verification. Build/archive excluded. No Chromium. Observer/ps excluded.",
          "rssScope": "Sum of simultaneous ps RSS samples (shared pages may count repeatedly); 50ms plus ps runtime, short children/peaks may be missed.",
          "wait4Scope": "OS wait4 user/system accounting for the completed benchmark Node and its children; setup/capture/verification included, not per-operation CPU attribution.",
          "elapsedMs": (time.monotonic() - started) * 1000,
          "userCpuMs": usage.ru_utime * 1000, "systemCpuMs": usage.ru_stime * 1000,
          "wait4MaxRssRaw": usage.ru_maxrss,
          "wait4MaxRssUnit": "Raw platform value; do not use as aggregate tree RSS. ps RSS KiB is converted explicitly for the separate tree samples.",
          "sampledTreePeakRssBytes": max((sample["rssBytes"] for sample in samples), default=0),
          "sampleIntervalAfterPsMs": 50, "samples": samples}
with open(report_path, "w") as output:
    json.dump(result, output, indent=2)
    output.write("\n")
print(json.dumps({key: value for key, value in result.items() if key != "samples"}))
sys.exit(process.returncode if process.returncode >= 0 else 1)
