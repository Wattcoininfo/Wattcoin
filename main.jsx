import { StrictMode, Component } from "react";
import { createRoot } from "react-dom/client";
import AppTabs from "./AppTabs.jsx";

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", background: "#060e06", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, padding: 32 }}>
          <div style={{ color: "#ef4444", fontWeight: 700, fontSize: 20 }}>Something went wrong</div>
          <div style={{ color: "#9bb09b", fontSize: 13, fontFamily: "monospace", maxWidth: 600, wordBreak: "break-all", textAlign: "center" }}>
            {this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)}
          </div>
          <button
            onClick={() => { this.setState({ error: null }); }}
            style={{ background: "#4ade80", color: "#060e06", border: "none", borderRadius: 6, padding: "8px 24px", fontWeight: 700, fontSize: 14, cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppTabs />
    </AppErrorBoundary>
  </StrictMode>
);
