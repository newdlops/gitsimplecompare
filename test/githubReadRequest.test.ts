import assert from "node:assert/strict";
import test from "node:test";
import { graphqlRead, restRead } from "../src/git/githubReadRequest";
import { GitHubApiError, graphQLResult } from "../src/git/githubApiError";

test("typed GraphQL preserves CLI fields and typed scalar variables", () => {
  const read = graphqlRead("query($owner:String!,$n:Int!){repository(owner:$owner,name:\"repo\"){pullRequest(number:$n){number}}}",
    { owner: "owner", n: 7 }, { cliVariables: { owner: "{owner}", n: 7 } });
  assert.deepEqual(read.args.slice(0, 2), ["api", "graphql"]);
  assert(read.args.includes("owner={owner}"));
  assert.deepEqual(read.request.variables, { owner: "owner", n: 7 });
});

test("read AST rejects writes, subscriptions, invalid and ambiguous documents", () => {
  for (const document of ["mutation{deleteRepository(input:{repositoryId:\"x\"}){clientMutationId}}",
    "subscription{event}", "query A{viewer{login}} query B{viewer{login}}", "query{"]) {
    assert.throws(() => graphqlRead(document));
  }
  assert.equal(graphqlRead("# mutation in a comment\n query{viewer{login}}").request.kind, "graphql");
  assert.throws(() => graphqlRead("query A{viewer{login}} mutation B{x}", {}, { operationName: "B" }));
  assert.equal(graphqlRead("query A{viewer{login}} query B{viewer{id}}", {}, { operationName: "A" }).request.operationName, "A");
});

test("REST reads cannot carry an arbitrary URL, body or write method", () => {
  assert.equal(restRead("/repos/owner/repo/pulls?state=open").request.path, "/repos/owner/repo/pulls?state=open");
  for (const path of ["https://other.example/token", "//other.example/token", "/../token", "/x#fragment", "/x\r\na:b"]) {
    assert.throws(() => restRead(path));
  }
});

test("safe API errors retain internal partial data without diagnostic disclosure", () => {
  const partial = { data: { privateTitle: "fixture-secret" }, errors: [{ type: "NOT_FOUND" }] };
  const error = new GitHubApiError("graphql", "pr-search", 200, undefined, partial);
  assert.deepEqual(graphQLResult(error), partial);
  assert(!JSON.stringify(error).includes("fixture-secret"));
  assert(!String(error).includes("fixture-secret"));
  assert.equal("stdout" in error, false);
  assert.equal("cause" in error, false);
});
