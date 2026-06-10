// git 의 시퀀스 에디터/커밋 에디터를 대체하는 헬퍼 스크립트.
// - git 이 `node rebaseEditor.js <mode> <file>` 형태로 호출한다.
//   mode="seq": rebase todo 파일을 우리가 만든 내용(GSC_TODO)으로 덮어쓴다.
//   mode="msg": reword/squash 커밋 메시지를 큐(GSC_MSG_QUEUE)에서 꺼내 써넣는다.
// - VS Code 확장 호스트(Electron)를 ELECTRON_RUN_AS_NODE=1 로 node 처럼 실행해 구동한다.
const fs = require("fs");

const mode = process.argv[2];
const targetFile = process.argv[3];

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
  }
} catch (err) {
  // 실패 시 비정상 종료해 rebase 가 중단되도록 한다.
  process.stderr.write("rebaseEditor failed: " + (err && err.message) + "\n");
  process.exit(1);
}
