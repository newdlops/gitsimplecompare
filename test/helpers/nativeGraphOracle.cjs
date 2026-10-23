// 제품 모듈을 불러오지 않는 Native Git 기준. 무거운 이력 검증은 별도 프로세스에서 끝까지 회수한다.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** Native stdout만 받으며 optional 쓰기·lazy fetch를 끄고 전체 실행 기한 안에서 자식을 wait한다. */
function reader(root) {
  const deadline = Date.now() + 120000;
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return (args, input) => {
    const remaining = deadline - Date.now(); assert.ok(remaining > 0, 'Native Graph oracle exceeded its deadline');
    return execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root, env, encoding: 'utf8', input, timeout: Math.min(remaining, 30000), maxBuffer: 64 * 1024 * 1024,
    });
  };
}

/** Native full decoration을 UI의 HEAD·branch·tag 이름으로만 정규화한다. 제품 파서를 사용하지 않는다. */
function decorations(raw) {
  const result = [];
  for (const part of raw ? raw.split(', ') : []) {
    const name = value => value.replace(/^refs\/(heads|remotes)\//, '');
    if (part === 'HEAD') result.push('HEAD');
    else if (part.startsWith('HEAD -> ')) result.push('HEAD', name(part.slice(8)));
    else if (part.startsWith('tag: refs/tags/')) result.push('tag:' + part.slice(15));
    else if (part !== 'refs/stash' && part !== 'grafted' && part !== 'replaced') result.push(name(part));
  }
  return result;
}

/**
 * ref별 포함/제외 집합을 Native rev-list로 직접 읽는다. 제품의 DAG 비트 전파·ahead 추론은 쓰지 않는다.
 * @param root 검증할 소유 저장소 @param limit 모든 local tip을 포함한 topo-order 첫 페이지의 실커밋 수
 * @returns 독립 Native 커밋·표시 기준. 필터/offset이 있는 임의 구간의 검증기로 사용하지 않는다.
 */
function graph(root, limit) {
  assert.ok(path.isAbsolute(root) && Number.isInteger(limit) && limit > 0 && limit <= 30000);
  const git = reader(root), oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const refArgs = ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream)'];
  const beforeRefs = git(refArgs), beforeHead = git(['rev-parse', '--verify', 'HEAD']);
  const refs = beforeRefs.split('\n').filter(Boolean).map(line => {
    const fields = line.split('\0'); assert.equal(fields.length, 4); assert.match(fields[2], oid);
    return { full: fields[0], name: fields[1], hash: fields[2], upstream: fields[3] };
  });
  const byFull = new Map(refs.map(ref => [ref.full, ref.hash]));
  const remotes = [...new Set(refs.filter(ref => ref.full.startsWith('refs/remotes/')).map(ref => ref.hash))].sort();
  // NUL로 필드와 record를 고정해 subject 안의 Unit Separator도 원문대로 읽는다.
  const raw = git(['log', '--topo-order', '--decorate=full', '--no-color', '--no-patch', '--no-show-signature', '--encoding=UTF-8',
    '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s', '-z', `-n${limit}`, '--branches', '--remotes', '--tags']);
  const fields = raw.split('\0'); if (fields.at(-1) === '') fields.pop(); assert.equal(fields.length % 7, 0);
  const commits = [];
  for (let index = 0; index < fields.length; index += 7) {
    const [hash, parents, authorName, authorEmail, dateIso, decoration, subject] = fields.slice(index, index + 7);
    assert.match(hash, oid); assert.ok(Number.isFinite(Date.parse(dateIso)));
    const parentHashes = parents ? parents.split(' ') : []; for (const parent of parentHashes) assert.match(parent, oid);
    commits.push({ hash, parents: parentHashes, authorName, authorEmail, dateIso, refs: decorations(decoration), subject });
  }
  const visible = new Map(commits.map(commit => [commit.hash, commit]));
  const queried = new Map(); let rangeQueries = 0;
  for (const branch of refs.filter(ref => ref.full.startsWith('refs/heads/'))) {
    // 모든 local tip을 포함한 topo-order의 첫 페이지다. 보이는 조상에 도달하는 tip은 반드시 그보다 앞에 있다.
    // tip이 페이지 밖이면 그 branch의 조상도 페이지 밖이므로 표시 결과에 기여할 Native 범위가 없다.
    if (!visible.has(branch.hash)) continue;
    const upstream = branch.upstream && byFull.get(branch.upstream);
    const excludes = upstream ? [upstream] : remotes;
    // 포함 tip 자체가 제외 tip이면 Native 집합 차는 공집합이다. 나머지는 각 정확한 tip 차를 직접 읽는다.
    if (excludes.includes(branch.hash)) continue;
    const key = JSON.stringify([branch.hash, excludes]); let hashes = queried.get(key);
    if (!hashes) {
      rangeQueries++;
      hashes = git(['rev-list', '--stdin'], [branch.hash, ...excludes.map(hash => '^' + hash)].join('\n') + '\n').trim().split('\n').filter(Boolean);
      for (const hash of hashes) assert.match(hash, oid);
      queried.set(key, hashes);
    }
    for (const hash of hashes) {
      const commit = visible.get(hash);
      if (commit) (commit.localOnlyBranches ??= []).push(branch.name);
    }
  }
  assert.equal(git(refArgs), beforeRefs, 'Refs/upstreams changed during the Native oracle');
  assert.equal(git(['rev-parse', '--verify', 'HEAD']), beforeHead, 'HEAD changed during the Native oracle');
  return { commits, rangeQueries, productModulesUsed: false };
}

try {
  const result = graph(process.argv[2], Number(process.argv[3]));
  const output = JSON.stringify(result); assert.ok(Buffer.byteLength(output) <= 32 * 1024 * 1024, 'Native oracle output is too large');
  process.stdout.write(output);
} catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
