import { render } from "preact";
import { App } from "./App";
import "./styles.css";

const mount = document.getElementById("app");
if (mount) {
  render(<App />, mount);
}
