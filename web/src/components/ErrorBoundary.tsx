/* Catches render errors so a single broken view doesn't blank the whole app.
 * Resets when its key prop (route) changes — switching views recovers. */
import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AlertTriangle, RefreshCw } from "lucide-react";

type Props = { children: ReactNode };
type State = { err: Error | null; info: string };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null, info: "" };

  static getDerivedStateFromError(err: Error) {
    return { err, info: "" };
  }
  componentDidCatch(err: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack || "" });
    console.error("[ErrorBoundary]", err, info);
  }
  retry = () => this.setState({ err: null, info: "" });

  render() {
    if (!this.state.err) return this.props.children;
    return (
      
      <div data-error-boundary="" className="max-w-xl mx-auto py-12">
        <Card className="p-6">
          <div className="flex items-center gap-2 text-destructive mb-2">
            <AlertTriangle size={18} />
            <span className="font-semibold">Something broke in this view</span>
          </div>
          <p className="text-[13px] text-muted-foreground mb-4">
            The rest of the app is still fine — switch to another view or retry.
            If it keeps happening, copy the error and check the console.
          </p>
          <pre className="text-[11px] bg-secondary/50 rounded p-3 overflow-x-auto max-h-48 nums">
            {this.state.err.message}
            {this.state.info && "\n\n" + this.state.info.split("\n").slice(0, 12).join("\n")}
          </pre>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={this.retry}>
              <RefreshCw size={13} /> Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }
}
