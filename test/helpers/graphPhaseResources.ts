// 실제 클릭 구간의 Node·종료된 native 자식·Chromium CPU를 wrapper 프로세스 없이 관측한다.
import assert from "node:assert/strict";
import type { GraphLiveRenderer, BrowserCpuProcess } from "./graphLiveRenderer";
import { loadChildResourceProbe, type ChildResourceCounters } from "./childResourceProbe";

/** 명시적인 opt-in에서만 counter를 읽는다. 기본 실행 경로·Git executable·환경은 바꾸지 않는다. */
export class GraphPhaseResources {
  private start?: { label:string; input:"click"|"service"; at:number; browser:BrowserCpuProcess[]; memory:NodeJS.MemoryUsage; children:ChildResourceCounters };

  /** 같은 Node의 OS 누적 카운터를 읽는 함수만 보관한다. 별도 프로세스·timer·polling은 만들지 않는다. */
  private constructor(private readonly children:()=>ChildResourceCounters) {}

  /**
   * 클릭 전에 소유 fixture에서 모듈 빌드를 완료한다. 빌드 비용은 실행 구간에 포함하지 않는다.
   * @param directory 작업트리 바깥의 소유 scenario 디렉터리 @returns 다른 fixture와 공유하지 않는 계측 수명
   */
  static async create(directory:string):Promise<GraphPhaseResources>{
    return new GraphPhaseResources(await loadChildResourceProbe(directory));
  }

  /** 초기 로드 뒤 같은 renderer의 counter를 고정한다. input으로 실제 클릭과 직접 서비스 호출을 구분한다. */
  async begin(renderer:GraphLiveRenderer,label:string,input:"click"|"service"="click"):Promise<void>{
    assert.equal(this.start,undefined);const browser=await renderer.readCpuProcesses();
    this.start={label,input,at:Date.now(),browser,memory:process.memoryUsage(),children:this.children()};
  }

  /**
   * 사후 Native oracle 전에 종료한다. 종료된 짧은 자식도 OS가 wait한 누적 합계로 수집한다.
   * @param renderer 같은 Chromium @param nodeCpu 실제 클릭부터 settle까지의 Node CPU
   * @param expectedGitCalls 공통 실행기에서 관측한 명령 수 @returns scope와 원시 process counter를 포함한 결과
   */
  async finish(renderer:GraphLiveRenderer,nodeCpu:NodeJS.CpuUsage,expectedGitCalls:number){
    assert.ok(this.start);const start=this.start;this.start=undefined;
    const finishedAt=Date.now(),memory=process.memoryUsage(),childrenAfter=this.children();
    const browser=await renderer.readCpuProcesses(),before=new Map(start.browser.map(row=>[row.id,row]));
    const missing=start.browser.filter(row=>!browser.some(next=>next.id===row.id)).map(row=>row.id);
    const browserRows=browser.map(row=>({...row,deltaCpuMs:(row.cpuTime-(before.get(row.id)?.cpuTime??0))*1000}));
    const browserComplete=missing.length===0&&browserRows.every(row=>row.deltaCpuMs>=0&&(!before.has(row.id)||before.get(row.id)?.type===row.type));
    const childDeltas=Object.fromEntries(Object.keys(start.children).map(key=>[key,
      childrenAfter[key as keyof ChildResourceCounters]-start.children[key as keyof ChildResourceCounters]])) as unknown as ChildResourceCounters;
    assert.ok(Object.values(childDeltas).every(value=>Number.isFinite(value)&&value>=0),"Child counters must be finite and monotonic");
    const nodeCpuMs=(nodeCpu.user+nodeCpu.system)/1000,childCpuMs=childDeltas.userCpuMs+childDeltas.systemCpuMs;
    const browserCpuMs=browserRows.reduce((sum,row)=>sum+row.deltaCpuMs,0);
    return {label:start.label,input:start.input,startedAt:start.at,finishedAt,elapsedMs:finishedAt-start.at,nodeCpuMs,childCpuMs,browserCpuMs,browserComplete,
      ownedCpuMs:browserComplete?nodeCpuMs+childCpuMs+browserCpuMs:null,registeredGitCalls:expectedGitCalls,
      nodeHeapAfterAwaitDelta:memory.heapUsed-start.memory.heapUsed,nodeRssAfterAwaitDelta:memory.rss-start.memory.rss,
      nodeMemoryBefore:start.memory,nodeMemoryAfter:memory,
      childrenBefore:start.children,childrenAfter,childDeltas,browserBefore:start.browser,browserAfter:browserRows,missingBrowserPids:missing,
      scope:`Instrumented ${start.input}-to-settled counter windows only; fixture setup, Native oracle, screenshots and probe build excluded. Node includes Playwright transport; children includes all OS-accounted terminated/waited native work, not per-Git attribution. Chromium root remains alive until after these counters, so its descendants are not also counted as waited children. Chromium deltas are complete only if all starting PIDs remain with monotonic same-type counters. Probe overhead remains; use separate uninstrumented latency evidence.`,
      memoryScope:"Node after-await deltas only; not retained heap, aggregate memory or a process-tree peak. Cumulative child maxRSS is deliberately not subtracted or presented as a phase peak."};
  }

  /** 완료하지 않은 수명만 버린다. 소유 모듈 파일은 caller의 fixture cleanup이 회수한다. */
  dispose():void{this.start=undefined;}
}
