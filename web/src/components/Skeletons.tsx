/* Loading skeletons used by every view. They mirror the real layout closely
 * so the transition from loading -> data is unobtrusive. */
import { Card } from "@/components/ui/card";

const SHIMMER = "animate-pulse bg-muted/60 rounded";

export function SkelBoardTile() {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className={`${SHIMMER} h-4 w-2/3`} />
        <div className={`${SHIMMER} h-4 w-12`} />
      </div>
      <div className={`${SHIMMER} h-3 w-1/3 mt-2`} />
      <div className="mt-4 space-y-1.5">
        <div className={`${SHIMMER} h-1.5 w-full`} />
        <div className="flex justify-between">
          <div className={`${SHIMMER} h-3 w-12`} />
          <div className={`${SHIMMER} h-3 w-8`} />
        </div>
      </div>
    </Card>
  );
}

export function SkelOverview() {
  return (
    <>
      <div className={`${SHIMMER} h-7 w-48 mb-2`} />
      <div className={`${SHIMMER} h-4 w-72 mb-7`} />
      <div className={`${SHIMMER} h-3 w-24 mb-3`} />
      <div className="mb-8"><SkelBoardTile /></div>
      <div className={`${SHIMMER} h-3 w-24 mb-3`} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {Array.from({ length: 6 }, (_, i) => <SkelBoardTile key={i} />)}
      </div>
    </>
  );
}

export function SkelToday() {
  return (
    <>
      <div className={`${SHIMMER} h-7 w-40 mb-1.5`} />
      <div className={`${SHIMMER} h-4 w-64 mb-7`} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="p-5">
            <div className={`${SHIMMER} h-3 w-24 mb-4`} />
            {Array.from({ length: 3 }, (_, j) => (
              <div key={j} className="flex items-start gap-3 py-2 border-b border-border/40 last:border-0">
                <div className={`${SHIMMER} h-3 w-3 rounded-full mt-1`} />
                <div className="flex-1">
                  <div className={`${SHIMMER} h-3.5 w-3/4 mb-1.5`} />
                  <div className={`${SHIMMER} h-2.5 w-1/3`} />
                </div>
              </div>
            ))}
          </Card>
        ))}
      </div>
    </>
  );
}

export function SkelBoard() {
  return (
    <div className="flex gap-4 overflow-x-auto tinybar pb-3 items-start">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex-1 min-w-0 max-w-[340px]">
          <div className="flex items-center justify-between px-1 mb-2">
            <div className={`${SHIMMER} h-3 w-16`} />
            <div className={`${SHIMMER} h-3 w-4`} />
          </div>
          <div className="rounded-xl border border-border bg-card/40 p-2 flex flex-col gap-2 min-h-[160px]">
            {Array.from({ length: 3 }, (_, j) => (
              <div key={j} className="bg-card border border-border rounded-lg p-2.5 pl-3 flex gap-2.5">
                <div className={`${SHIMMER} h-3.5 w-3.5 rounded shrink-0 mt-0.5`} />
                <div className="flex-1">
                  <div className={`${SHIMMER} h-3 w-full mb-1`} />
                  <div className={`${SHIMMER} h-3 w-3/4`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkelTimeline() {
  return (
    <Card className="p-0 overflow-hidden">
      <div className="h-7 border-b border-border" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="relative h-12 border-b border-border/60 last:border-0">
          <div className={`${SHIMMER} absolute left-3 top-4 h-4 w-32`} />
          <div className={`${SHIMMER} absolute h-5 w-24 rounded-full`} style={{ left: 200 + i * 120, top: 14 }} />
        </div>
      ))}
    </Card>
  );
}
