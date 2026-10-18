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
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
    stdio: "inherit",
  });
}

// 예상 가능한 fallback 확인용 git 명령은 stderr 를 숨겨 rebase 로그를 어지럽히지 않는다.
function gitQuietOk(args) {
  try {
    cp.execFileSync("git", args, {
      cwd: process.env.GSC_REPO_ROOT || process.cwd(),
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
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

/**
 * Git이 넘긴 메시지 파일과 같은 metadata directory에 속하는 절대 경로 hint만 사용한다.
 * - 다른 worktree나 오래된 세션의 hint는 무시해 기존 Git 경로 조회로 복귀한다.
 * @returns 소유가 일치하면 정규화한 Git directory. hint가 없거나 확인할 수 없으면 undefined.
 */
function messageGitDir() {
  const hint = process.env.GSC_REBASE_GIT_DIR;
  if (!hint || !path.isAbsolute(hint) || !targetFile) {
    return undefined;
  }
  try {
    const cwd = process.env.GSC_REPO_ROOT || process.cwd();
    const gitDir = fs.realpathSync(hint);
    const messageDir = fs.realpathSync(path.dirname(path.resolve(cwd, targetFile)));
    return gitDir === messageDir ? gitDir : undefined;
  } catch (error) {
    return undefined;
  }
}

// 현재 메시지 파일의 worktree에서 live done을 새로 읽어 마지막 commit action을 반환한다.
function currentRebaseAction() {
  const gitDir = messageGitDir();
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const donePath = gitDir ? path.join(gitDir, dir, "done") : gitPath(`${dir}/done`);
    if (!fs.existsSync(donePath)) {
      continue;
    }
    const lines = fs.readFileSync(donePath, "utf8").split(/\r?\n/).reverse();
    for (const line of lines) {
      const match = /^\s*(pick|reword|edit|squash|fixup|drop)\s+[0-9a-f]{4,64}\b/i.exec(line);
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

/** 부모/인덱스 경로를 NUL 안전하게 읽는다. 이름의 줄바꿈이나 pathspec 문법을 경로 그대로 취급한다. */
function gitOutput(args, input) {
  return cp.execFileSync("git", args, {
    cwd: process.env.GSC_REPO_ROOT || process.cwd(),
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
    input,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** 경로 목록을 argv 대신 NUL stdin으로 전달해 파일 수가 많아도 OS 인자 한도를 넘지 않는다. */
function gitWithPaths(args, paths) {
  gitOutput([...args, "--pathspec-from-file=-", "--pathspec-file-nul"], Buffer.from(paths.join("\0") + "\0"));
}

/** ls-tree/ls-files처럼 stdin pathspec을 받지 않는 조회는 경로 수와 UTF-8 바이트로 나눈다. */
function pathBatches(paths) {
  const batches = [];
  let batch = [], bytes = 0;
  for (const entry of paths) {
    const size = Buffer.byteLength(entry) + 1;
    if (batch.length && (batch.length >= 192 || bytes + size > 24 * 1024)) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(entry); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * 모든 제외/이동 source 경로를 함께 부모 상태로 되돌린다.
 * - 부모 또는 인덱스에 있는 경로만 넘겨 history 제외의 미존재 경로를 조용히 보존한다.
 * - restore는 추가 파일 삭제와 삭제 파일 복구를 한 번에 처리한다. rename은 old/new 경로를 같이 넘긴다.
 * - 오래된 Git의 미지원 명령/옵션만 기존 개별 복원으로 대체하고 실제 IO/충돌 오류는 rebase를 멈춘다.
 */
function restoreFileChanges(ops) {
  const paths = Array.from(new Set(ops.flatMap(op => [op.oldPath, op.path]).filter(Boolean)));
  if (!paths.length) return;
  const parent = gitOutput(["rev-list", "--parents", "-n", "1", "HEAD"]).toString("ascii").trim().split(/\s+/)[1];
  try {
    if (!parent) {
      gitWithPaths(["rm", "-r", "-f", "--ignore-unmatch"], paths);
      return;
    }
    const known = new Set();
    for (const batch of pathBatches(paths)) {
      for (const command of [["ls-tree", "--name-only", "-r", "-z", parent], ["ls-files", "--cached", "-z"]]) {
        const output = gitOutput([...command, "--", ...batch]).toString("utf8");
        for (const entry of output.split("\0")) if (entry) known.add(entry);
      }
    }
    if (known.size) gitWithPaths(["restore", "--source", parent, "--staged", "--worktree"], Array.from(known));
  } catch (error) {
    const reason = String(error.stderr || error.message || "");
    if (!/unknown (?:option|switch)\W+pathspec-(?:from-file|file-nul)|git: ['"]restore['"] is not a git command/i.test(reason)) throw error;
    for (const op of ops) restoreFileChange(op);
  }
}

// --3way는 --index를 포함하므로 patch 경로만 바로 stage된다. rename의 사라진 oldPath에 add를 다시 실행하지 않는다.
function applyMovePatch(op) {
  git(["apply", "--3way", "--recount", "--binary", op.patchPath]);
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
    restoreFileChanges(ops.files);
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
