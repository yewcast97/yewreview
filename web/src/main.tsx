/**
 * The entry point.
 *
 * The three shared stylesheets are imported here and in cascade order — the font faces, then the
 * tokens that assume they exist, then the element defaults and shell that read them — so that order
 * is a fact about this file rather than something the bundler decided. Every panel imports its OWN
 * stylesheet from its own component; see the convention at the top of `styles/base.css`.
 */

import { createRoot } from "react-dom/client";

import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";

import { App } from "./App.tsx";

const host = document.getElementById("app");
if (!host) throw new Error("YewReview: the page has no #app element to mount into");

/*
 * StrictMode is deliberately absent. Its double-invoked effects would run `initStore` twice on
 * mount, and the second one opens a second socket — which on this backend means a second observer
 * attaching to a live agent. That is real work against a real conversation, not a rehearsal.
 */
createRoot(host).render(<App />);
