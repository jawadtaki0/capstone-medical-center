import { Component } from "react";

// Keep workspace navigation available if an unexpected request-screen render
// error occurs. Do not log props, request bodies or patient details.
export default class RequestScreenBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <section role="alert" className="request-error">
          <h1>Website requests could not be displayed</h1>
          <p>
            Your saved work is retained. Retry this screen or use another
            section.
          </p>
          <button
            className="staff-button"
            onClick={() => this.setState({ failed: false })}
          >
            Retry requests
          </button>
        </section>
      );
    return this.props.children;
  }
}
