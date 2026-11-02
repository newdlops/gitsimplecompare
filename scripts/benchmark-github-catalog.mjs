// P6 읽기 전용 실험. 토큰·저장소 원문은 메모리에만 두고 집계만 기록한다.
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

if (!process.argv.includes('--live')) {
  console.error('Usage: node scripts/benchmark-github-catalog.mjs --live [--affiliations] [--out FILE]');
  process.exit(1);
}
const outputIndex = process.argv.indexOf('--out');
const output = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
if (outputIndex >= 0 && (!output || output.startsWith('--'))) throw new Error('Missing output file.');
const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
if (!token || /[\r\n\0]/.test(token)) throw new Error('No usable existing GitHub credential.');
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const restPath = page => '/user/repos?' + new URLSearchParams({ per_page: '100', page: String(page), sort: 'updated', direction: 'desc', affiliation: 'owner,collaborator,organization_member' });
const query = `query($cursor: String) { viewer { repositories(first: 100, after: $cursor,
  affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
  orderBy: {field: UPDATED_AT, direction: DESC}) {
    totalCount nodes { nameWithOwner description isPrivate isArchived updatedAt isFork owner { __typename } }
    pageInfo { hasNextPage endCursor }
  } } rateLimit { cost remaining } }`;
const minimalQuery = `query { viewer { repositories(first: 100,
  affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
  orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { nameWithOwner description isPrivate isArchived } pageInfo { hasNextPage endCursor }
  } } rateLimit { cost remaining } }`;

/** 동일 HTTPS 풀과 압축 조건으로 요청하고 wire/decoded body 크기와 JSON 파싱을 분리한다. */
function request(path, body, conditional) {
  const encoded = body ? Buffer.from(JSON.stringify(body)) : undefined, start = performance.now();
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path, method: encoded ? 'POST' : 'GET', agent,
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'GitSimpleCompare-readonly-P6-experiment',
        Accept: 'application/vnd.github+json', 'Accept-Encoding': 'gzip, br', 'X-GitHub-Api-Version': '2022-11-28',
        ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}),
        ...(conditional ? { 'If-None-Match': conditional } : {}) } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) req.destroy(new Error('Response exceeded experiment bound.')); else chunks.push(chunk); });
      response.on('error', () => reject(new Error('Response transport failed.')));
      response.on('end', () => {
        try {
          const raw = Buffer.concat(chunks), encoding = response.headers['content-encoding'];
          const decoded = encoding === 'gzip' ? gunzipSync(raw) : encoding === 'br' ? brotliDecompressSync(raw) : encoding === 'deflate' ? inflateSync(raw) : raw;
          const parseStart = performance.now(), value = decoded.length ? JSON.parse(decoded.toString('utf8')) : undefined;
          resolve({ status: response.statusCode, headers: response.headers, value, wireBytes: raw.length,
            decodedBytes: decoded.length, elapsedMs: performance.now() - start, parseMs: performance.now() - parseStart,
            text: decoded.toString('utf8') });
        } catch { reject(new Error('Response could not be decoded.')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Experiment request deadline exceeded.')), 30_000);
    req.once('close', () => clearTimeout(timer)); req.once('error', () => reject(new Error('Experiment HTTPS request failed.')));
    if (encoded) req.write(encoded); req.end();
  });
}

/** 이름·설명·공개 여부·보관 여부를 제품의 REST DTO와 같은 순서와 의미로 정규화한다. */
function dto(row, graphql = false) {
  const name = graphql ? row.nameWithOwner : row.full_name;
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid repository shape.');
  return { nameWithOwner: name, cloneUrl: 'https://github.com/' + name.split('/').map(encodeURIComponent).join('/') + '.git',
    description: typeof row.description === 'string' ? row.description : '', isPrivate: graphql ? row.isPrivate === true : row.private === true,
    archived: graphql ? row.isArchived === true : row.archived === true };
}

/** 소수 live 표본은 관측값만 요약하며 서비스 일반 성능으로 확대하지 않는다. */
function summarize(values) {
  const quantile = (key, p) => values.map(x => x[key]).sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  return { samples: values.length, statuses: values.map(x => x.status), wireBytes: values.map(x => x.wireBytes), decodedBytes: values.map(x => x.decodedBytes),
    latencyMs: { p50: quantile('elapsedMs', .5), p95: quantile('elapsedMs', .95) }, jsonParseMs: { p50: quantile('parseMs', .5), p95: quantile('parseMs', .95) } };
}


if (process.argv.includes('--affiliations')) {
const result = { observedAtUtc: new Date().toISOString(), variants: [], extraDetails: [], privateNamesPersisted: false };
try {
  const rest = await request(restPath(1));
  if (rest.status !== 200 || !Array.isArray(rest.value) || /rel="next"/.test(rest.headers.link ?? '')) throw new Error('Follow-up requires a complete single REST page.');
  const restDtos = rest.value.map(x => dto(x)), names = new Set(restDtos.map(x => x.nameWithOwner));
  const all = query.replace('nameWithOwner description', 'nameWithOwner viewerPermission description');
  const variants = [ ['allAffiliationsBoth', all],
    ['defaultOwnerAffiliations', all.replace(', ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]', '')],
    ['defaultViewerAffiliations', all.replace('affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ', '')] ];
  for (const [label, candidate] of variants) {
    const graph = await request('/graphql', {query: candidate});
    const connection = graph.value?.data?.viewer?.repositories;
    if (graph.status !== 200 || graph.value?.errors?.length || !Array.isArray(connection?.nodes) || connection.pageInfo.hasNextPage) throw new Error('Follow-up GraphQL page incomplete.');
    const rows = connection.nodes, normalized = rows.map(x => dto(x, true)), other = new Set(normalized.map(x => x.nameWithOwner));
    result.variants.push({label, repositories: rows.length, missing: restDtos.filter(x => !other.has(x.nameWithOwner)).length,
      extra: normalized.filter(x => !names.has(x.nameWithOwner)).length,
      orderedIntersectionEqual: JSON.stringify(restDtos.filter(x => other.has(x.nameWithOwner)).map(x => x.nameWithOwner)) === JSON.stringify(normalized.filter(x => names.has(x.nameWithOwner)).map(x => x.nameWithOwner)),
      restRevalidationStatus: (await request(restPath(1),undefined,rest.headers.etag)).status});
    if (label === 'allAffiliationsBoth') {
      for (const row of rows.filter(x => !names.has(x.nameWithOwner))) {
        const direct = await request('/repos/' + row.nameWithOwner.split('/').map(encodeURIComponent).join('/'));
        result.extraDetails.push({ownerType: row.owner.__typename, isFork: row.isFork, isPrivate: row.isPrivate,
          archived: row.isArchived, viewerPermission: row.viewerPermission, directRestStatus: direct.status,
          directRestPullAllowed: direct.value?.permissions?.pull === true, directRestDisabled: direct.value?.disabled === true});
      }
    }
  }
} catch (error) { result.failure = {message: error instanceof Error ? error.message : 'Follow-up failed.'}; }
finally { agent.destroy(); }
if (output) await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

} else {
const result = { observedAtUtc: new Date().toISOString(), mode: 'live read-only, one existing gh credential, controlled shared HTTPS/1.1 pool; no product OAuth session is substituted',
  apiVersion: '2022-11-28', query, minimalQuery, sources: ['https://docs.github.com/en/graphql/reference/users#user',
    'https://docs.github.com/en/graphql/reference/repos#repositoryaffiliation', 'https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user'],
  limitations: ['One credential/account cannot prove every OAuth app restriction or every organization/team access configuration.', 'No repository names, responses, credentials or ETags are persisted.', 'Live samples include variable network/server time; p95 of seven samples is the largest observed sample.'] };

try {
  const restRows = [], restPages = [], graphRows = [], graphPages = []; let cursor;
  for (let page = 1; page <= 32; page++) {
    const response = await request(restPath(page)); if (response.status !== 200 || !Array.isArray(response.value)) throw new Error('REST page was not successful.');
    restRows.push(...response.value); restPages.push(response);
    if (!/rel="next"/.test(response.headers.link ?? '')) break;
    if (page === 32) throw new Error('REST page bound reached before completeness.');
  }
  result.rest = { pages: restPages.length, repositories: restRows.length, firstStatus: restPages[0].status, firstWireBytes: restPages[0].wireBytes,
    firstDecodedBytes: restPages[0].decodedBytes, hasETag: !!restPages[0].headers.etag,
    coverage: { private: restRows.filter(x => x.private).length, archived: restRows.filter(x => x.archived).length,
      fork: restRows.filter(x => x.fork).length, organization: restRows.filter(x => x.owner?.type === 'Organization').length,
      privateOrganization: restRows.filter(x => x.private && x.owner?.type === 'Organization').length } };
  const seen = new Set();
  for (let page = 1; page <= 32; page++) {
    const response = await request('/graphql', { query, variables: cursor ? { cursor } : {} }); graphPages.push(response);
    if (response.status !== 200 || response.value?.errors?.length) {
      result.graphqlFailure = { status: response.status, errorCount: response.value?.errors?.length ?? 0,
        types: [...new Set((response.value?.errors ?? []).map(error => error.type ?? error.extensions?.code ?? 'unspecified'))] }; break;
    }
    const connection = response.value?.data?.viewer?.repositories;
    if (!Array.isArray(connection?.nodes) || connection.nodes.some(x => !x) || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw new Error('GraphQL page incomplete.');
    graphRows.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor) || page === 32) throw new Error('GraphQL cursor did not complete safely.');
    seen.add(cursor);
  }
  result.graphql = { pages: graphPages.length, repositories: graphRows.length, firstStatus: graphPages[0].status,
    firstWireBytes: graphPages[0].wireBytes, firstDecodedBytes: graphPages[0].decodedBytes, hasETag: !!graphPages[0].headers.etag };
  if (!result.graphqlFailure) {
    const left = restRows.map(row => dto(row)), right = graphRows.map(row => dto(row, true));
    const a = new Map(left.map(row => [row.nameWithOwner, row])), b = new Map(right.map(row => [row.nameWithOwner, row]));
    const missing = [...a.keys()].filter(name => !b.has(name)), extra = [...b.keys()].filter(name => !a.has(name));
    const fields = Object.keys(left[0] ?? {}), fieldMismatches = Object.fromEntries(fields.map(field => [field, [...a].filter(([name, value]) => b.has(name) && value[field] !== b.get(name)[field]).length]));
    result.parity = { missing: missing.length, extra: extra.length, dtoFieldMismatches: fieldMismatches,
      orderedNamesEqual: JSON.stringify(left.map(x => x.nameWithOwner)) === JSON.stringify(right.map(x => x.nameWithOwner)),
      restDuplicates: left.length - a.size, graphDuplicates: right.length - b.size };
    const bracket = [];
    for (let i = 0; i < restPages.length; i++) bracket.push((await request(restPath(i + 1), undefined, restPages[i].headers.etag)).status);
    result.restRevalidationAfterGraphql = bracket;
    const coldRest = [], coldGraph = [], warmRest = [], warmGraph = [];
    let graphETag;
    for (let i = 0; i < 7; i++) {
      coldRest.push(await request(restPath(1)));
      const g = await request('/graphql', { query: minimalQuery }); coldGraph.push(g); graphETag = g.headers.etag;
      warmRest.push(await request(restPath(1), undefined, coldRest.at(-1).headers.etag));
      warmGraph.push(await request('/graphql', { query: minimalQuery }, graphETag));
    }
    result.minimalGraphqlETagPresent = !!graphETag;
    result.cold = { rest: summarize(coldRest), graphql: summarize(coldGraph) };
    result.warm = { rest: summarize(warmRest), graphql: summarize(warmGraph) };
    result.rateLimit = { restResource: restPages[0].headers['x-ratelimit-resource'], restRemaining: Number(restPages[0].headers['x-ratelimit-remaining']),
      graphqlCost: graphPages.at(-1).value.data.rateLimit.cost, graphqlRemaining: graphPages.at(-1).value.data.rateLimit.remaining };
  }
} catch (error) { result.failure = { message: error instanceof Error ? error.message : 'Experiment failed.' }; }
finally { agent.destroy(); }
if (output) await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

}
