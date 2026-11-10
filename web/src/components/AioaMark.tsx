import { Triangle } from "lucide-react";

export function AioaMark({ className, title }: { className?: string; title?: string }) {
  return <Triangle className={className} aria-label={title} />;
}
