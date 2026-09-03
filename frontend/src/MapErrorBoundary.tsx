import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class MapErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Deliberately silent: the map must not take down the planning workspace.
    void error;
    void info;
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="map-render-error">
          Map visualization encountered a rendering error. Switch to 2D to
          continue planning.
        </div>
      );
    }
    return this.props.children;
  }
}
