// git 의 시퀀스 에디터/커밋 에디터를 대체하는 헬퍼 스크립트.
// - git 이 `node rebaseEditor.js <mode> <file>` 형태로 호출한다.
//   mode="seq": rebase todo 파일을 우리가 만든 내용(GSC_TODO)으로 덮어쓴다.
//   mode="msg": reword/squash 커밋 메시지를 큐(GSC_MSG_QUEUE)에서 꺼내 써넣는다.
// - VS Code 확장 호스트(Electron)를 ELECTRON_RUN_AS_NODE=1 로 node 처럼 실행해 구동한다.
const fs = require("fs");
const cp = require("child_process");
const path = require("path");

const mode = process.argv[2];
const targetFile = process.argv[3];
const MESSAGE_ACTIONS = new Set(["reword", "squash"]);

// git 명령을 현재 rebase 저장소에서 실행한다. 실패하면 rebase 가 멈추도록 예외를 그대로 올린다.
function git(args) {
  cp.execFileSync("git", args, {
    cwd: process.env.GSC_REPO_ROOT || process.cwd(),
    stdio: "inherit",
  });
}

// 예상 가능한 fallback 확인용 git 명령은 stderr 를 숨겨 rebase 로그를 어지럽히지 않는다.
function gitQuietOk(args) {
  try {
    cp.execFileSync("git", args, {
      cwd: process.env.GSC_REPO_ROOT || process.cwd(),
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    return false;
  }
}

// git metadata 상대 경로를 linked worktree 에서도 유효한 절대 경로로 바꾼다.
function gitPath(relPath) {
  const cwd = process.env.GSC_REPO_ROOT || process.cwd();
  const raw = cp.execFileSync("git", ["rev-parse", "--git-path", relPath], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return path.resolve(cwd, raw);
}

// rebase done 파일의 마지막 commit action 을 읽는다.
function currentRebaseAction() {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const donePath = gitPath(`${dir}/done`);
    if (!fs.existsSync(donePath)) {
      continue;
    }
    const lines = fs.readFileSync(donePath, "utf8").split(/\r?\n/).reverse();
    for (const line of lines) {
      const match = /^\s*(pick|reword|edit|squash|fixup|drop)\s+[0-9a-f]{4,40}\b/i.exec(line);
      if (match) {
        return match[1].toLowerCase();
      }
    }
  }
  return "";
}

// 현재 커밋에서 path 변경을 제거하기 위해 부모 커밋의 상태로 되돌린다.
function restorePathFromParent(relPath) {
  const path = String(relPath || "");
  if (!path) {
    return;
  }
  if (gitQuietOk(["cat-file", "-e", `HEAD^:${path}`])) {
    git(["checkout", "HEAD^", "--", path]);
    return;
  }
  gitQuietOk(["rm", "-r", "-f", "--", path]);
}

// op 파일의 신/구 포맷을 모두 읽어 파일 제외 작업 배열로 정규화한다.
function readAmendOps(file) {
  const ops = JSON.parse(fs.readFileSync(file, "utf8"));
  if (ops.version === 2) {
    return {
      files: Array.isArray(ops.files) ? ops.files.map(normalizeRestoreOp).filter((item) => item.path) : [],
      patches: Array.isArray(ops.patches) ? ops.patches.map(normalizePatchOp).filter((item) => item.patchPath) : [],
    };
  }
  if (Array.isArray(ops.files)) {
    return { files: ops.files.map(normalizeRestoreOp).filter((item) => item.path), patches: [] };
  }
  const paths = Array.isArray(ops.excludePaths) ? ops.excludePaths : [];
  return {
    files: paths.map((path) => ({ path: String(path || ""), oldPath: "" })).filter((item) => item.path),
    patches: [],
  };
}

// 파일 restore 작업을 안전한 문자열 필드만 남긴 형태로 정규화한다.
function normalizeRestoreOp(item) {
  return {
    path: String(item && item.path ? item.path : ""),
    oldPath: item && item.oldPath ? String(item.oldPath) : "",
  };
}

// target 커밋에 적용할 patch 작업을 정규화한다.
function normalizePatchOp(item) {
  const paths = Array.isArray(item && item.paths) ? item.paths : [];
  return {
    patchPath: String(item && item.patchPath ? item.patchPath : ""),
    paths: paths.map((entry) => String(entry || "")).filter(Boolean),
  };
}

// rename 제외처럼 한 파일 변경이 여러 path 를 건드릴 때 중복 없이 순서대로 되돌린다.
function restoreFileChange(op) {
  const paths = [];
  if (op.oldPath) {
    paths.push(op.oldPath);
  }
  paths.push(op.path);
  for (const path of Array.from(new Set(paths))) {
    restorePathFromParent(path);
  }
}

// 저장해 둔 source commit patch 를 현재 target commit 에 적용하고 관련 경로를 stage 한다.
function applyMovePatch(op) {
  git(["apply", "--3way", "--recount", "--binary", op.patchPath]);
  if (op.paths.length > 0) {
    git(["add", "-A", "--", ...op.paths]);
  } else {
    git(["add", "-A"]);
  }
}

// index 에 amend 할 변경이 남아 있는지 확인한다.
function hasStagedChanges() {
  try {
    cp.execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: process.env.GSC_REPO_ROOT || process.cwd(),
      stdio: "ignore",
    });
    return false;
  } catch (err) {
    return true;
  }
}

try {
  if (mode === "seq") {
    // 우리가 작성한 todo 로 rebase 시퀀스를 통째로 교체한다.
    const todo = fs.readFileSync(process.env.GSC_TODO, "utf8");
    fs.writeFileSync(targetFile, todo);
  } else if (mode === "msg") {
    if (!MESSAGE_ACTIONS.has(currentRebaseAction())) {
      process.exit(0);
    }
    // 메시지 큐에서 다음 메시지를 꺼낸다. null 이면 git 기본 메시지를 유지.
    const queueFile = process.env.GSC_MSG_QUEUE;
    let queue = [];
    try {
      queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    } catch (e) {
      queue = [];
    }
    if (queue.length > 0) {
      const message = queue.shift();
      fs.writeFileSync(queueFile, JSON.stringify(queue));
      if (message != null) {
        fs.writeFileSync(targetFile, message);
      }
    }
  } else if (mode === "amend") {
    const ops = readAmendOps(targetFile);
    for (const op of ops.files) {
      restoreFileChange(op);
    }
    for (const op of ops.patches) {
      applyMovePatch(op);
    }
    if (hasStagedChanges()) {
      git(["commit", "--amend", "--no-edit", "--allow-empty", "--no-verify"]);
    }
  }
} catch (err) {
  // 실패 시 비정상 종료해 rebase 가 중단되도록 한다.
  process.stderr.write("rebaseEditor failed: " + (err && err.message) + "\n");
  process.exit(1);
}
