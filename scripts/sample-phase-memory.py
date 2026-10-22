"""벤치마크 소유 프로세스의 작업 구간 RSS만 표본 수집한다. 생산 확장에서는 실행하지 않는다."""
import json
import os
import select
import subprocess
import sys
import time

# 제어 입력은 실제 benchmark 부모와 시작 시점에 확인한 Chromium PID만 받는다.
root_pid = int(sys.argv[1])
browser_roots = set(json.loads(sys.argv[2]))
interval = float(sys.argv[3])
if root_pid <= 1 or not 0.02 <= interval <= 1 or any(pid <= 1 for pid in browser_roots):
    raise SystemExit("Invalid memory sampler input")
started = time.monotonic()
samples = []
errors = []


def descendants(roots, rows):
    """현재 process table에서 부모 관계가 증명되는 자손만 폐쇄적으로 모은다."""
    owned = set(roots)
    while True:
        found = {pid for pid, (parent, _) in rows.items() if parent in owned}
        if found <= owned:
            return owned
        owned |= found


def sample():
    """관찰자와 ps를 제외하고 같은 시점의 Node·Chromium·다른 소유 자손 RSS를 더한다."""
    at = time.monotonic()
    output = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,rss="], timeout=2).decode("utf8")
    rows = {}
    for line in output.splitlines():
        values = line.split()
        if len(values) != 3:
            raise ValueError("Incomplete process memory output")
        pid, parent, rss = map(int, values)
        if pid <= 0 or parent < 0 or rss < 0:
            raise ValueError("Invalid process memory row")
        rows[pid] = (parent, rss * 1024)
    if root_pid not in rows:
        raise RuntimeError("Benchmark root process disappeared")
    ignored = descendants({os.getpid()}, rows)
    browser = descendants(browser_roots & rows.keys(), rows) - ignored
    owned = (descendants({root_pid}, rows) | browser) - ignored
    visible = owned & rows.keys()
    node = rows[root_pid][1]
    chrome = sum(rows[pid][1] for pid in visible & browser)
    other = sum(rows[pid][1] for pid in visible - browser - {root_pid})
    samples.append({"afterStartMs": round((at-started)*1000, 3), "scanMs": round((time.monotonic()-at)*1000, 3),
                    "nodeRssBytes": node, "chromiumRssBytes": chrome, "otherOwnedRssBytes": other,
                    "sumRssBytes": node+chrome+other, "pids": sorted(visible)})


def guarded_sample():
    """권한/시간 제한 실패는 누락으로 남겨 불완전한 관측을 성공 결과로 보이지 않게 한다."""
    try:
        sample()
    except Exception as error:
        errors.append(f"{type(error).__name__}: {str(error)[:256]}")


guarded_sample()
print(json.dumps({"ready": True, "initialSampleComplete": not errors}), flush=True)
while time.monotonic()-started < 240 and len(samples) < 16384:
    readable, _, _ = select.select([sys.stdin], [], [], interval)
    if readable:
        command = sys.stdin.readline()
        if command.strip() == "stop" or not command:
            guarded_sample()
            break
    guarded_sample()
else:
    errors.append("SamplerLimitReached")
print(json.dumps({"complete": not errors, "rootPid": root_pid, "observerPid": os.getpid(), "intervalMs": interval*1000, "samples": samples, "errors": errors,
                  "scope": "Sampled simultaneous process RSS; observer/ps excluded. Includes benchmark Node, known Chromium and other owned descendants. Short-lived children or peaks between samples may be missed; summed RSS can double-count shared pages and is not physical/retained heap."}), flush=True)
