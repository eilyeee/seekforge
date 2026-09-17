#!/usr/bin/env node
import { relaunchWithEnvProxy } from "./env-proxy.js";

// Before the bundle loads: a relaunch replaces this process (see env-proxy.js).
relaunchWithEnvProxy();
await import("../dist/index.js");
