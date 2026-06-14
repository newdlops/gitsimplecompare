// git 의 시퀀스 에디터/커밋 에디터를 대체하는 헬퍼 스크립트.
// - git 이 `node rebaseEditor.js <mode> <file>` 형태로 호출한다.
//   mode="seq": rebase todo 파일을 우리가 만든 내용(GSC_TODO)으로 덮어쓴다.
//   mode="msg": reword/squash 커밋 메시지를 큐(GSC_MSG_QUEUE)에서 꺼내 써넣는다.
// - VS Code 확장 호스트(Electron)를 ELECTRON_RUN_AS_NODE=1 로 node 처럼 실행해 구동한다.
const fs = require("fs");
const cp = require("child_process");

const mode = process.argv[2];
const targetFile = process.argv[3];

// git 명령을 현재 rebase 저장소에서 실행한다. 실패하면 rebase 가 멈추도록 예외를 그대로 올린다.
function git(args) {
  cp.execFileSync("git", args, {
    cwd: process.env.GSC_REPO_ROOT || process.cwd(),
    stdio: "inherit",
  });
}

// 실패해도 다음 fallback 을 시도할 수 있는 git 명령을 실행한다.
function gitOk(args) {
  try {
    git(args);
    return true;
  } catch (err) {
    return false;
  }
}

// 현재 커밋에서 path 변경을 제거하기 위해 부모 커밋의 상태로 되돌린다.
function restorePathFromParent(path) {
  if (gitOk(["cat-file", "-e", `HEAD^:${path}`])) {
    git(["checkout", "HEAD^", "--", path]);
    return;
  }
  gitOk(["rm", "-r", "-f", "--", path]);
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
    const ops = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    const paths = Array.isArray(ops.excludePaths) ? ops.excludePaths : [];
    for (const path of paths) {
      restorePathFromParent(String(path));
    }
    if (hasStagedChanges()) {
      git(["commit", "--amend", "--no-edit", "--allow-empty"]);
    }
  }
} catch (err) {
  // 실패 시 비정상 종료해 rebase 가 중단되도록 한다.
  process.stderr.write("rebaseEditor failed: " + (err && err.message) + "\n");
  process.exit(1);
}
