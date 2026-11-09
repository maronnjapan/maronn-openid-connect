/**
 * A part of the page that fails to render (data older or newer than the
 * page, a field it lacks) shows why and a way home instead of blanking the
 * whole page; a new `reset` (another view, another test) tries again.
 */
import { Component, type ReactNode } from 'react';

interface State {
  error?: Error | undefined;
  reset: string;
}

export class ErrorBoundary extends Component<{ reset: string; children: ReactNode }, State> {
  state: State = { reset: this.props.reset };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: { reset: string }, state: State): State | null {
    return props.reset === state.reset ? null : { error: undefined, reset: props.reset };
  }

  render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div className="page failed-screen" role="alert">
        <h1>この画面を表示できませんでした</h1>
        <p className="muted">{this.state.error.message}</p>
        <p>
          <a href="#/">ホームへ</a>
        </p>
      </div>
    );
  }
}
