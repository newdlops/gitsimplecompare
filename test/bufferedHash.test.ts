import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BufferedHash } from "../src/utils/bufferedHash";

for (const capacity of [1,7,65536]) test(`buffered hash matches crypto across empty, full and multiple ${capacity}-byte blocks`,()=>{
  for(const length of [0,1,6,7,8,65535,65536,65537,131081]){
    const data=Buffer.allocUnsafe(length);for(let i=0;i<length;i++)data[i]=i%251;
    const actual=new BufferedHash(createHash("sha256").update("prefix"),capacity);
    // 조각 크기와 writer 크기가 달라 실제 데이터/블록 경계가 반복해서 교차한다.
    for(let start=0;start<data.length;start+=1237)actual.append(data,start,Math.min(data.length,start+1237));
    assert.equal(actual.digestHex(),createHash("sha256").update("prefix").update(data).digest("hex"));
  }
});

test("reusing mutable metadata buffers cannot change bytes already appended",()=>{
  const scratch=Buffer.alloc(20,7),actual=new BufferedHash(createHash("sha1"),13);
  actual.append(scratch,3,14);scratch.fill(8);actual.append(scratch,4,17);scratch.fill(9);
  const expected=createHash("sha1").update(Buffer.alloc(11,7)).update(Buffer.alloc(13,8)).digest("hex");
  assert.equal(actual.digestHex(),expected);
});

test("invalid ranges and repeated finalization cannot create a partial or padded digest",()=>{
  for(const capacity of [0,-1,NaN,Infinity,1.5])assert.throws(()=>new BufferedHash(createHash("sha256"),capacity),RangeError);
  const actual=new BufferedHash(createHash("sha256"),5),data=Buffer.from("abcdef");
  for(const[start,end]of [[-1,2],[1,7],[4,3],[0.5,2],[0,NaN]])assert.throws(()=>actual.append(data,start,end),RangeError);
  actual.append(data);assert.equal(actual.digestHex(),createHash("sha256").update(data).digest("hex"));
  assert.throws(()=>actual.append(data),/finalized/);assert.throws(()=>actual.digestHex(),/finalized/);
});
